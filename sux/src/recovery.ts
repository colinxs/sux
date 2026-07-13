// Recovery dead-drop — an out-of-band control channel so the home router (owl-tegu)
// can phone home and pick up recovery commands even when it's unreachable INBOUND
// (WAN down for ingress, port-forwards gone, Tailscale wedged). The box POSTs a
// signed checkin on a timer; the Worker persists its health and hands back any
// queued, Worker-SIGNED commands. The box verifies each command's signature and
// executes it locally. Nothing is executed server-side — this is a dead-drop, not
// a C2: the Worker only stores health and vends signed intents; the box pulls,
// verifies, and acts. Both directions are HMAC-SHA256 authenticated, and checkins
// are replay-protected by a timestamp window plus a single-use nonce.
//
// Routes (all fail-closed on missing secrets, mirroring /admin/tick):
//   POST /recovery/checkin  — box→Worker, HMAC-body-authed. Persist health, return commands.
//   POST /recovery/enqueue  — operator→Worker, bearer-authed. Sign + queue a command for a node.
//   GET  /recovery/status   — operator→Worker, bearer-authed. Read a node's last-seen health.

import type { RtEnv } from "./registry";

// The only actions the box will ever act on. STRINGS ONLY — the Worker never
// interprets them; the box maps each to a local self-heal step. Kept deliberately
// tiny (a recovery lifeline, not a general remote-exec surface): every action is a
// coarse, box-local recovery move an operator would run by hand over a console.
export const RECOVERY_ACTIONS = ["open-wan-ssh", "close-wan-ssh", "restart-tailscale", "restart-dns", "restore-config", "reboot", "noop"] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

// Checkin freshness window (seconds): a signed body whose timestamp is more than
// this far from the Worker's clock (either direction) is rejected as stale/skewed.
// The nonce KV entry outlives the window (×2) so a replayed body is still caught by
// the nonce check even at the far edge of the accepted skew.
const WINDOW_SECONDS = 300;

// Default command lifetime (seconds) when enqueue doesn't specify ttl. A queued
// command past its `expires` is dropped on delivery and refused by the box, so a
// stale "open-wan-ssh" can't fire days later.
const DEFAULT_CMD_TTL = 3600;

// Hard ceilings so a malformed/hostile checkin body can't drive unbounded KV writes
// or memory. The box's health blob is small; commands are few.
const MAX_BODY_BYTES = 16_000;
const MAX_QUEUE = 16;

// A Worker-signed command the box verifies before executing. `sig` is HMAC-SHA256
// (hex) over the canonical string of the other fields; `expires` is unix seconds.
export type SignedCommand = { action: RecoveryAction; args: Record<string, unknown>; nonce: string; expires: number; sig: string };

type StoredStatus = { node_id: string; timestamp: number; health: unknown; received_at: number };

const enc = new TextEncoder();

const json = (obj: unknown, status = 200): Response =>
	new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function hmacHex(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time hex-string compare (avoids leaking the MAC via early-exit timing).
// Both sides are fixed-length hex here, so a length mismatch is itself a rejection.
function timingSafeEq(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// The exact bytes the box signs and the box verifies a command against. Pinning a
// canonical form (not "the JSON") keeps signer and verifier byte-identical without
// depending on key order or whitespace. args is JSON.stringify'd with sorted keys so
// the same logical args always canonicalize the same way.
function commandSigningString(c: Omit<SignedCommand, "sig">): string {
	return `${c.action}\n${stableStringify(c.args)}\n${c.nonce}\n${c.expires}`;
}

// Deterministic JSON for the signing string: object keys sorted recursively so the
// box (busybox `jq -S`) and the Worker produce the same canonical bytes.
function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const keys = Object.keys(v as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

// The command-signing secret: a dedicated RECOVERY_CMD_SECRET when set (so the
// checkin-auth secret and the command-auth secret rotate independently), else the
// shared HMAC secret. Callers only reach here past the HMAC-secret gate, so this is
// always a non-empty string.
const cmdSecret = (env: RtEnv): string => env.RECOVERY_CMD_SECRET || (env.RECOVERY_HMAC_SECRET as string);

const statusKey = (nodeId: string): string => `recovery:status:${nodeId}`;
const queueKey = (nodeId: string): string => `recovery:queue:${nodeId}`;
const nonceKey = (nodeId: string, nonce: string): string => `recovery:nonce:${nodeId}:${nonce}`;

// A node_id must be a short, filesystem/KV-safe slug so it can't smuggle a KV key
// prefix (`:`, `/`) or blow the key length. Rejects anything outside [A-Za-z0-9._-].
const NODE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

async function signCommand(env: RtEnv, action: RecoveryAction, args: Record<string, unknown>, expires: number): Promise<SignedCommand> {
	const nonce = crypto.randomUUID();
	const base = { action, args, nonce, expires };
	return { ...base, sig: await hmacHex(cmdSecret(env), commandSigningString(base)) };
}

async function readQueue(env: RtEnv, nodeId: string): Promise<SignedCommand[]> {
	const raw = await env.OAUTH_KV.get(queueKey(nodeId));
	if (!raw) return [];
	try {
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

// box→Worker checkin. Auth = HMAC-SHA256 of the RAW request body under
// RECOVERY_HMAC_SECRET, presented as `x-sux-signature: <hex>`. Signing the raw bytes
// (not a re-serialized object) means the box and Worker never have to agree on JSON
// formatting for the AUTH check — only the body's own `timestamp`/`nonce` matter for
// replay. On success: persist the latest health keyed by node_id and hand back (then
// clear) the node's queued, pre-signed commands.
async function handleCheckin(request: Request, env: RtEnv): Promise<Response> {
	const raw = await request.text();
	if (raw.length > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);

	const presented = request.headers.get("x-sux-signature") ?? "";
	const expected = await hmacHex(env.RECOVERY_HMAC_SECRET as string, raw);
	if (!presented || !timingSafeEq(presented.toLowerCase(), expected)) return json({ error: "bad_signature" }, 401);

	let body: { node_id?: unknown; timestamp?: unknown; health?: unknown; nonce?: unknown };
	try {
		body = JSON.parse(raw);
	} catch {
		return json({ error: "bad_json" }, 400);
	}

	const nodeId = typeof body.node_id === "string" ? body.node_id : "";
	if (!NODE_ID_RE.test(nodeId)) return json({ error: "bad_node_id" }, 400);
	const timestamp = typeof body.timestamp === "number" ? body.timestamp : NaN;
	const nonce = typeof body.nonce === "string" ? body.nonce : "";
	if (!Number.isFinite(timestamp) || !nonce || nonce.length > 128) return json({ error: "bad_fields" }, 400);

	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - timestamp) > WINDOW_SECONDS) return json({ error: "stale_timestamp", server_time: now }, 401);

	// Replay guard: a (node_id, nonce) may be spent once. The signature covers the
	// whole body including this nonce, so an attacker can't reuse a captured checkin.
	const nkey = nonceKey(nodeId, nonce);
	if (await env.OAUTH_KV.get(nkey)) return json({ error: "replay" }, 409);
	await env.OAUTH_KV.put(nkey, "1", { expirationTtl: WINDOW_SECONDS * 2 });

	const status: StoredStatus = { node_id: nodeId, timestamp, health: body.health ?? null, received_at: now };
	await env.OAUTH_KV.put(statusKey(nodeId), JSON.stringify(status));

	// Deliver-and-consume: return the live (unexpired) queued commands and clear the
	// queue in one shot. A dead-drop is at-most-once by design — the box acts on what
	// it pulled; anything it missed is re-enqueued by the operator, not retried here.
	const queued = await readQueue(env, nodeId);
	const commands = queued.filter((c) => c.expires > now);
	if (queued.length) await env.OAUTH_KV.delete(queueKey(nodeId));

	return json({ ok: true, node_id: nodeId, server_time: now, commands });
}

// operator→Worker enqueue. Bearer-authed by RECOVERY_ADMIN_SECRET. Validates the
// action against the allow-list, mints a Worker-SIGNED command, and appends it to the
// node's queue (bounded, oldest-dropped) for the next checkin to collect.
async function handleEnqueue(request: Request, env: RtEnv): Promise<Response> {
	let body: { node_id?: unknown; action?: unknown; args?: unknown; ttl?: unknown };
	try {
		body = JSON.parse(await request.text());
	} catch {
		return json({ error: "bad_json" }, 400);
	}

	const nodeId = typeof body.node_id === "string" ? body.node_id : "";
	if (!NODE_ID_RE.test(nodeId)) return json({ error: "bad_node_id" }, 400);
	const action = body.action;
	if (typeof action !== "string" || !(RECOVERY_ACTIONS as readonly string[]).includes(action)) {
		return json({ error: "bad_action", allowed: RECOVERY_ACTIONS }, 400);
	}
	const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
	const ttl = typeof body.ttl === "number" && body.ttl > 0 && body.ttl <= 86_400 ? Math.floor(body.ttl) : DEFAULT_CMD_TTL;
	const expires = Math.floor(Date.now() / 1000) + ttl;

	const cmd = await signCommand(env, action as RecoveryAction, args, expires);
	const queue = [...(await readQueue(env, nodeId)), cmd].slice(-MAX_QUEUE);
	await env.OAUTH_KV.put(queueKey(nodeId), JSON.stringify(queue));

	return json({ ok: true, node_id: nodeId, queued: cmd, queue_depth: queue.length });
}

// operator→Worker status read. Bearer-authed. Returns the node's last-seen health +
// timestamp (or not_found), plus the current queue depth so an operator can see
// whether a command is still waiting to be collected.
async function handleStatus(url: URL, env: RtEnv): Promise<Response> {
	const nodeId = url.searchParams.get("node_id") ?? "";
	if (!NODE_ID_RE.test(nodeId)) return json({ error: "bad_node_id" }, 400);
	const raw = await env.OAUTH_KV.get(statusKey(nodeId));
	if (!raw) return json({ error: "not_found", node_id: nodeId }, 404);
	const now = Math.floor(Date.now() / 1000);
	// Parity with readQueue: handleRecovery runs before index.ts's try/catch, so an
	// unguarded throw here escapes as a raw Worker 5xx instead of a clean JSON error.
	let status: StoredStatus;
	try {
		status = JSON.parse(raw) as StoredStatus;
	} catch {
		return json({ error: "corrupt_status", node_id: nodeId }, 500);
	}
	const pending = (await readQueue(env, nodeId)).filter((c) => c.expires > now).length;
	return json({ ok: true, status, pending_commands: pending, server_time: now, age_seconds: now - status.received_at });
}

// Bearer check for the operator routes. Distinct 404 (not 401) when the admin secret
// is unset so an unconfigured deployment leaks nothing about the route's existence —
// same fail-closed shape as /admin/tick.
function adminAuthed(request: Request, env: RtEnv): boolean {
	const secret = env.RECOVERY_ADMIN_SECRET;
	if (!secret) return false;
	const auth = request.headers.get("authorization") ?? "";
	const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	return Boolean(presented) && timingSafeEq(presented, secret);
}

// The dead-drop router. Returns null when the path isn't ours (so index.ts falls
// through to OAuth). The whole feature is gated on RECOVERY_HMAC_SECRET: unset ⇒
// every /recovery/* path 404s, exactly as if the feature didn't exist.
export async function handleRecovery(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (!url.pathname.startsWith("/recovery/")) return null;
	if (!env.RECOVERY_HMAC_SECRET) return new Response("not found", { status: 404 });

	if (url.pathname === "/recovery/checkin" && request.method === "POST") {
		return handleCheckin(request, env);
	}
	if (url.pathname === "/recovery/enqueue" && request.method === "POST") {
		if (!adminAuthed(request, env)) return new Response("not found", { status: 404 });
		return handleEnqueue(request, env);
	}
	if (url.pathname === "/recovery/status" && request.method === "GET") {
		if (!adminAuthed(request, env)) return new Response("not found", { status: 404 });
		return handleStatus(url, env);
	}
	return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
}

// Exported for tests + the box-side reference client: recompute a command's signature
// so a verifier can confirm it matches. (The box does the equivalent in POSIX sh.)
export async function verifyCommand(env: RtEnv, c: SignedCommand): Promise<boolean> {
	const { sig, ...base } = c;
	const expected = await hmacHex(cmdSecret(env), commandSigningString(base));
	return timingSafeEq(sig.toLowerCase(), expected);
}
