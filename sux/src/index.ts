import type OAuthProvider from "@cloudflare/workers-oauth-provider";
import { isAllowedLogin } from "./utils";
import { type CacheMeta, cacheKey, deferCacheWrite, type JsonRpc, parseJsonRpc, sseResponse } from "./mcp-util";
import { unpackFromCache } from "./cache-codec";
import { findFn, frontToolList, type RtEnv, type ToolResult, unwrapFnCall } from "./registry";
import { buildManifest, CONNECTOR_PATHS } from "./connectors";
import { singleFlight } from "./single-flight";
import { weightedRateLimit } from "./rate-limit";
import { hasAI, llm } from "./ai";

// Below this length a result isn't worth an AI round-trip to summarize (the call
// would cost more than the tokens it saves, and may even grow the text).
const SUMMARIZE_MIN_CHARS = 400;
import { FUNCTIONS } from "./fns";
import { LIFE_SKILL_DESCRIPTION, LIFE_SKILL_PROMPT, SUX_SKILL_DESCRIPTION, SUX_SKILL_PROMPT } from "./skill-prompt";
import { selfImproveTick } from "./fns/_self_improve";
import { runSubJob } from "./cron-heartbeat";
import { recordCall } from "./metrics";
import { shipMetricsSnapshot, shipToLoki } from "./grafana";
import { handleObservability } from "./observability";
import { handleRecovery } from "./recovery";
import { normalizeArgs, normalizeText } from "./normalize";

type Props = { login: string; name: string; email: string; accessToken: string };

// The cleaned result deferCacheWrite hands back (noCache stripped). This — not the
// raw run result — is what a coalesced group shares, so every awaiter returns the
// leader's single post-processed value.
type CleanResult = ReturnType<typeof deferCacheWrite>;

// Per-isolate in-flight map for single-flight coalescing (see single-flight.ts).
// Keyed by the content-addressed cache key; entries clear when a run settles. The
// coalesced value is the fully finalized (normalized + optionally summarized +
// cache-scheduled) result, so followers reuse it without redoing the close path.
const inflight = new Map<string, Promise<CleanResult>>();

// Dispatch-path safety rails. These sit on the HOT tools/call path and preserve
// behavior for every normal call — they only engage on pathological inputs or a
// fn that misbehaves:
//   • FN_DEADLINE_MS — no single fn.run may hang the isolate indefinitely.
//   • MAX_OUTPUT_CHARS — a fn result's text can't blow the caller's token budget
//     (or a giant KV value); byte-exact `raw` fns opt out (their bytes are the
//     payload and must not gain a marker).
//   • MAX_ARG_BYTES / MAX_ARG_DEPTH — reject a pathological args blob before it
//     reaches normalizeArgs/run (memory/CPU DoS, or stack blowup on deep nesting).
// The MCP prompts this server advertises: the sux routing SKILL and the life memory
// SKILL, embedded from .claude/skills/{sux,life}/SKILL.md at build time. Reachable via
// prompts/get on any client — mobile/Cowork/Desktop remote connectors carry prompts but
// not the local plugin skills, so this is how they get both guidances. No arguments.
const SUX_PROMPT = { name: "sux", title: "sux routing", description: SUX_SKILL_DESCRIPTION, arguments: [] as const };
const LIFE_PROMPT = { name: "life", title: "life memory", description: LIFE_SKILL_DESCRIPTION, arguments: [] as const };
const PROMPTS = [SUX_PROMPT, LIFE_PROMPT];
const PROMPT_TEXT: Record<string, string> = { sux: SUX_SKILL_PROMPT, life: LIFE_SKILL_PROMPT };

export const FN_DEADLINE_MS = 60_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_ARG_BYTES = 256_000;
const MAX_ARG_DEPTH = 64;

// Race a fn.run against a hard deadline so no fn can hang the isolate. On timeout
// we RESOLVE (not reject) with a clean isError ToolResult and abandon the run
// promise (it may finish in the background; its value is dropped). The timer is
// always cleared so a fast fn doesn't hold the isolate open. A rejection or a
// resolve from run that arrives first wins the race unchanged, so the normal path
// is byte-for-byte identical to a bare `await fn.run(...)`.
export function withDeadline(name: string, ms: number, run: Promise<ToolResult>): Promise<ToolResult> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<ToolResult>((resolve) => {
		timer = setTimeout(() => resolve({ content: [{ type: "text", text: `Tool '${name}' timed out after ${ms}ms` }], isError: true }), ms);
	});
	return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

// Clamp the total text length of a fn result so one fn can't return an
// unbounded payload. Walks the text parts, keeping content up to `max` chars,
// then appends a single truncation marker. Returns the input untouched (same
// reference) when it's already within budget, so the common case allocates
// nothing. Non-text parts pass through unchanged.
export function clampResult(result: ToolResult, max: number): ToolResult {
	if (!Array.isArray(result.content)) return result;
	let total = 0;
	let clamped = false;
	const content = result.content.map((part) => {
		if (part?.type !== "text" || typeof part.text !== "string") return part;
		if (total >= max) {
			clamped = true;
			return { ...part, text: "" };
		}
		const remaining = max - total;
		if (part.text.length > remaining) {
			clamped = true;
			total = max;
			return { ...part, text: part.text.slice(0, remaining) };
		}
		total += part.text.length;
		return part;
	});
	if (!clamped) return result;
	content.push({ type: "text" as const, text: `\n…[sux: output truncated at ${max} chars]` });
	return { ...result, content };
}

// Bounded depth probe: returns the greater of the object's nesting depth and
// (limit + 1) if it's deeper than `limit`. Recursion is capped at `limit`, so a
// pathologically deep (or cyclic) blob can't blow the stack while we measure it.
function exceedsDepth(v: unknown, limit: number): boolean {
	let deep = false;
	const walk = (node: unknown, d: number): void => {
		if (deep) return;
		if (d > limit) {
			deep = true;
			return;
		}
		if (node === null || typeof node !== "object") return;
		for (const val of Object.values(node as Record<string, unknown>)) walk(val, d + 1);
	};
	walk(v, 0);
	return deep;
}

// Reject a pathological args blob before normalizeArgs/run. Depth is checked
// FIRST (bounded, stack-safe) so a deeply-nested payload can't blow the stack in
// JSON.stringify below. Returns a reason string to surface, or null when fine.
export function checkArgs(args: unknown, maxBytes: number, maxDepth: number): string | null {
	if (args !== null && typeof args === "object" && exceedsDepth(args, maxDepth)) {
		return `arguments nested too deep (> ${maxDepth} levels)`;
	}
	let json: string;
	try {
		json = JSON.stringify(args ?? null);
	} catch {
		return "arguments are not serializable";
	}
	if (json.length > maxBytes) return `arguments too large (${json.length} > ${maxBytes} bytes)`;
	return null;
}

// The real tools/call dispatch chain, split out from rtServer.fetch so it can be
// exercised end-to-end in tests without constructing the module-scope
// OAuthProvider or a full Request. rtServer.fetch calls this after the auth gate,
// so the production path and tests run the exact same code.
export async function handleRpc(env: RtEnv, ctx: ExecutionContext, rpc: JsonRpc | undefined): Promise<Response> {
	const method = rpc?.method;
	const id = rpc?.id ?? null;

	if (!method) return new Response(null, { status: 202 });
	if (method === "initialize") {
		return sseResponse({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
				serverInfo: { name: "research-tools", version: "0.1.0" },
			},
		});
	}
	if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
	if (method === "tools/list") {
		// Front-door: advertise only the front verbs (registry FRONT_VERBS). Leaves stay
		// dispatchable (by name or via the `fn` escape) and discoverable (`sux` map) — the
		// list is just legible instead of the full leaf surface.
		return sseResponse({ jsonrpc: "2.0", id, result: { tools: frontToolList(FUNCTIONS) } });
	}
	if (method === "prompts/list") {
		// Two prompts: the sux routing SKILL + the life memory SKILL. No pagination.
		return sseResponse({ jsonrpc: "2.0", id, result: { prompts: PROMPTS } });
	}
	if (method === "prompts/get") {
		const name = rpc?.params?.name ?? "";
		const prompt = PROMPTS.find((p) => p.name === name);
		if (!prompt) {
			return sseResponse({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown prompt: ${name}` } });
		}
		return sseResponse({
			jsonrpc: "2.0",
			id,
			result: {
				description: prompt.description,
				messages: [{ role: "user", content: { type: "text", text: PROMPT_TEXT[name] } }],
			},
		});
	}
	if (method === "tools/call") {
		let name = rpc?.params?.name ?? "";
		// `fn` escape unwrap: fn({name, args}) is rewritten IN PLACE to a call on the
		// named leaf, before findFn/cache/normalize — so a leaf reached through the
		// front-door behaves byte-identically to a direct call (same cache key, same
		// deadline, same weighted cost — the limiter unwraps via the same helper). Only
		// a valid, non-self inner name that resolves to a real leaf is unwrapped;
		// anything else (missing/blank/self/unknown) falls through to the `fn` fn's own
		// run, which returns a typed error. Cache flags ride the inner args.
		const unwrapped = unwrapFnCall(rpc?.params, FUNCTIONS);
		if (unwrapped) {
			name = unwrapped.name;
			(rpc as JsonRpc).params = { name, arguments: unwrapped.args };
		}
		const fn = findFn(FUNCTIONS, name);
		if (!fn) return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });

		// Universal cache-bypass: a truthy `fresh` in the arguments forces a cache
		// miss (skip the READ so the fn runs on live data) while leaving the WRITE
		// path untouched (the fresh result repopulates the same entry). Detect and
		// strip it up front — before cacheKey/normalize/run — so the fn never sees
		// `fresh` (schemas are additionalProperties:false) and the key is computed
		// from the same args a normal call uses, so a fresh call overwrites rather
		// than diverging. Harmless no-op for non-cacheable fns.
		const rawArgs = rpc?.params?.arguments;
		const isArgObject = Boolean(rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs));
		// Strip whenever the KEY is present — even an explicit `fresh:false` must be
		// removed. A truthiness-only check left a falsy flag in place: it then leaked
		// into the fn (schemas are additionalProperties:false) and fragmented the
		// cache key away from an otherwise-identical plain call.
		let fresh = false;
		if (isArgObject && "fresh" in (rawArgs as Record<string, unknown>)) {
			fresh = Boolean((rawArgs as Record<string, unknown>).fresh);
			delete (rawArgs as Record<string, unknown>).fresh;
		}

		// Universal token-saver: a truthy `summarize` runs the fn's text output
		// through Workers AI to compress it before returning (fewer tokens back to
		// the agent). Detected+stripped up front like `fresh`, but it CHANGES the
		// result, so it namespaces the cache key (summarized and raw cache apart).
		let summarize = false;
		if (isArgObject && "summarize" in (rawArgs as Record<string, unknown>)) {
			summarize = Boolean((rawArgs as Record<string, unknown>).summarize);
			delete (rawArgs as Record<string, unknown>).summarize;
		}

		// Arg-size guard: reject a pathological args blob (oversized JSON, or nested
		// past a sane depth) BEFORE normalizeArgs/run — a cheap up-front rejection
		// that protects the recursive normalize walk and the fn from a memory/CPU/
		// stack DoS. Recorded as an error call so rejections show up in observability.
		const argErr = checkArgs(rawArgs, MAX_ARG_BYTES, MAX_ARG_DEPTH);
		if (argErr) {
			const rejectEvent = { tool: name, ms: 0, error: true, err: argErr };
			recordCall(env, ctx, rejectEvent);
			shipToLoki(env, ctx, rejectEvent);
			return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Tool '${name}' rejected: ${argErr}` }], isError: true } });
		}

		// Sane normalization on open: fold styled/fullwidth "font" unicode to ASCII
		// and strip BOM/zero-width/control chars from string inputs. Byte-exact fns
		// (hash/encode/compress/qr/kv/…) opt out via `raw` so their bytes are untouched.
		const args = fn.raw ? rawArgs : normalizeArgs(rawArgs);

		const started = Date.now();
		// Short per-call correlation id, threaded onto env so every downstream
		// smartFetch of this tools/call can tag its egress-audit Loki line with the
		// same reqId — grouping a call's outbound hops in the Loki stream without
		// touching the ~20 smartFetch call sites. Threaded via a PER-REQUEST env clone
		// — a shallow copy where bindings (KV/R2/…) share the one env by reference and
		// only `_egress` is per-request — so two concurrent tools/call requests in the
		// same isolate can't clobber each other's reqId or call ctx.waitUntil on the
		// other's (possibly completed) context, the bug of parking it on the shared
		// env. Inert unless Grafana is configured (shipEgress no-ops otherwise).
		const rtEnv: RtEnv = { ...env, _egress: { ctx, reqId: crypto.randomUUID().slice(0, 8) } };
		const key = fn.cacheable ? await cacheKey(summarize ? `${name}::summarize` : name, args) : null;
		// The close path for one successful run: normalize the text output, optionally
		// summarize it, then schedule the (single) cache write and return the cleaned
		// result. Defined before the read so a stale-while-revalidate hit can drive it as
		// a background refresh. Folded into the single-flight leader below so a coalesced
		// burst runs it EXACTLY once for the whole group — N awaiters share one normalize
		// pass and one KV put instead of each re-normalizing the shared object and
		// scheduling a byte-identical write.
		const finalize = async (ran: ToolResult): Promise<CleanResult> => {
			// Sane normalization on close: same folding/cleanup over text output.
			if (!fn.raw && !ran.isError && Array.isArray(ran.content)) {
				for (const part of ran.content) {
					if (part?.type === "text" && typeof part.text === "string") part.text = normalizeText(part.text);
				}
			}
			let out: ToolResult = ran;
			// Summarize-before-return: compress the (normalized) text output with Workers
			// AI when the caller asked and the result is worth it. Best-effort — on AI
			// failure or when unavailable, the raw result is returned unchanged. The
			// summarized result is what gets cached (under the ::summarize key namespace).
			if (summarize && !fn.raw && !out.isError && Array.isArray(out.content) && hasAI(rtEnv)) {
				const joined = out.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
				if (joined.length >= SUMMARIZE_MIN_CHARS) {
					try {
						const s = await llm(rtEnv, "Summarize this tool result as concisely as possible while preserving key facts, names, numbers, dates, and URLs. Output only the summary — no preamble.", joined.slice(0, 24_000), 512);
						if (s.trim()) out = { content: [{ type: "text", text: s.trim() }], ...(out.noCache ? { noCache: true } : {}) };
					} catch (e) {
						console.warn(`sux summarize failed for '${name}', returning raw: ${String((e as Error).message ?? e)}`);
					}
				}
			}
			// Output byte-cap: clamp the (normalized, maybe-summarized) text before it
			// is returned OR cached, so no fn can blow the caller's token budget or
			// write a giant KV value. Universal at dispatch — but byte-exact `raw` fns
			// opt out (they already own their output and must not gain a marker), and
			// fns that already clamp keep their result unchanged (a no-op when under cap).
			if (!fn.raw) out = clampResult(out, MAX_OUTPUT_CHARS);
			// noCache/isError results are returned but never cached; deferCacheWrite
			// hands back a cleaned clone (noCache stripped) without mutating the shared
			// run result, so coalesced callers can't poison each other's cache decision.
			// The KV write happens off the response path via ctx.waitUntil, and fn.ttl
			// (when set) overrides the global cache lifetime for this fn.
			return deferCacheWrite(rtEnv.OAUTH_KV, ctx, key, out, fn.ttl);
		};
		// Each fn.run is wrapped in a hard per-fn deadline so a hung fn resolves to a
		// clean isError result instead of stalling the isolate (and the group).
		const runGuarded = () => withDeadline(name, FN_DEADLINE_MS, fn.run(rtEnv, args));
		// One expensive run plus its close path. Coalesce concurrent same-key runs
		// (cacheable fns only, keyed by the content-addressed cache key) so a burst of
		// identical calls — or a foreground miss racing a background stale refresh —
		// runs fn.run AND the shared close path (normalize + the single cache write)
		// once; non-cacheable fns (no key) always run directly. Every coalesced awaiter
		// shares the one cleaned result the leader produced.
		const computeAndCache = (): Promise<CleanResult> =>
			key ? singleFlight(inflight, key, async () => finalize(await runGuarded())) : (async () => finalize(await runGuarded()))();

		if (key && !fresh) {
			// Read as bytes so compressed frames (cache-codec) round-trip; unpack
			// reverses packForCache (plain string, or zstd/brotli frame). getWithMetadata
			// carries the soft-TTL marker along in the same read (falling back to get for
			// bindings/mocks without it). Any unpack failure (corrupt/unknown codec) is
			// treated as a miss and recomputed.
			try {
				const kvRead = env.OAUTH_KV as unknown as {
					getWithMetadata?: (k: string, type: "arrayBuffer") => Promise<{ value: ArrayBuffer | null; metadata: CacheMeta | null }>;
					get: (k: string, type: "arrayBuffer") => Promise<ArrayBuffer | null>;
				};
				let raw: ArrayBuffer | null;
				let meta: CacheMeta | null = null;
				if (typeof kvRead.getWithMetadata === "function") {
					const got = await kvRead.getWithMetadata(key, "arrayBuffer");
					raw = got.value;
					meta = got.metadata ?? null;
				} else {
					raw = await kvRead.get(key, "arrayBuffer");
				}
				if (raw) {
					// Stale-while-revalidate: an entry past its soft TTL — but still within the
					// KV hard TTL / stale grace window, since KV would have evicted it otherwise
					// — is served IMMEDIATELY and refreshed in the background via ctx.waitUntil.
					// A legacy entry carries no soft marker and is always treated as fresh.
					// isError/noCache results are never cached, so a stale value is always a
					// success — "never serve stale for noCache/isError" holds by construction.
					const stale = typeof meta?.softExpiresAt === "number" && Date.now() >= meta.softExpiresAt;
					if (stale) ctx.waitUntil(computeAndCache().catch((e) => console.warn(`sux stale refresh failed for '${name}': ${String((e as Error).message ?? e)}`)));
					const hitEvent = { tool: name, ms: Date.now() - started, cache: true, ...(stale ? { stale: true } : {}) };
					recordCall(env, ctx, hitEvent);
					shipToLoki(env, ctx, hitEvent);
					return sseResponse({ jsonrpc: "2.0", id, result: JSON.parse(unpackFromCache(raw)) });
				}
			} catch (e) {
				console.warn(`sux cache read failed for '${name}', recomputing: ${String((e as Error).message ?? e)}`);
			}
		}

		let result: CleanResult;
		let err: string | undefined;
		try {
			result = await computeAndCache();
		} catch (e) {
			err = String((e as Error).message ?? e);
			console.error(`sux tool '${name}' threw: ${(e as Error)?.stack ?? err}`);
			result = { content: [{ type: "text" as const, text: `Tool '${name}' failed: ${err}` }], isError: true };
		}
		// Record WHY a call failed: from the caught exception, or the isError
		// result's first text part for fns that return failures without throwing.
		if (!err && result.isError && Array.isArray(result.content)) {
			const first = result.content.find((p: { type?: string; text?: unknown }) => p?.type === "text" && typeof p.text === "string");
			if (first) err = (first as { text: string }).text;
		}
		const callEvent = { tool: name, ms: Date.now() - started, error: Boolean(result.isError), err };
		recordCall(env, ctx, callEvent);
		shipToLoki(env, ctx, callEvent);
		return sseResponse({ jsonrpc: "2.0", id, result });
	}
	return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}

// Live tool count for the discovery manifest — dynamic-imported so the manifest is
// the only thing that pulls the fns module (it stays lazy for the hot RPC path).
async function connectorCounts(): Promise<Record<string, number>> {
	const fns = await import("./fns");
	return { "/mcp": fns.FUNCTIONS.length };
}

// Exported so the authorization/rate-limit gate can be driven directly in tests
// (index.test.ts covers handleRpc, which is downstream of this gate). Importing
// this module does not eval the OAuth provider — see getOAuthProvider below.
export const rtServer = {
	async fetch(request: Request, env: RtEnv, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
		const login = ctx.props?.login;
		if (!isAllowedLogin(login, env.ALLOWED_GITHUB_LOGIN)) {
			console.warn(`gate: rejected login=${JSON.stringify(login ?? null)}`);
			return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
		}
		if (env.MCP_RATE_LIMITER) {
			// Fail OPEN if the limiter itself throws — an unavailable limiter must never
			// become an outage (matches the intent of the presence check above).
			let allowed = true;
			try {
				allowed = (await env.MCP_RATE_LIMITER.limit({ key: login! })).success;
			} catch (e) {
				console.warn(`rate limiter threw, failing open: ${String((e as Error)?.message ?? e)}`);
			}
			if (!allowed) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } });
		}

		const isBodyless = request.method === "GET" || request.method === "HEAD";
		const bodyText = isBodyless ? undefined : await request.text();
		const rpc = parseJsonRpc(bodyText);
		const pathname = new URL(request.url).pathname;
		// Runtime connector discovery: GET /mcp/connectors self-describes the connector
		// + tool count from the one CONNECTORS source. Authenticated (post-gate) — exposes
		// the namespace name + count, never secrets or tool args.
		if (isBodyless && (pathname === "/mcp/connectors" || pathname === "/connectors")) {
			const url = new URL(request.url);
			const counts = await connectorCounts();
			return new Response(JSON.stringify(buildManifest(url.origin, counts), null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
		}
		// Weighted rate limit: expensive tools (render/Kagi/SerpAPI/Workers AI)
		// consume extra tokens beyond the base 1 charged above, so a burst of paid
		// calls drains the budget faster than free deterministic fns (see Fn.cost).
		const limited = await weightedRateLimit(env, login!, rpc);
		if (limited) return limited;
		return handleRpc(env, ctx, rpc);
	},
};

// Built lazily on first request so that importing this module (e.g. from
// index.test.ts to exercise handleRpc) does not eval @cloudflare/workers-oauth-
// provider / github-handler, which pull in runtime-only `cloudflare:` modules.
// Runtime behavior is unchanged: the provider is a per-isolate singleton.
let oauthProvider: OAuthProvider | undefined;
async function getOAuthProvider(): Promise<OAuthProvider> {
	if (!oauthProvider) {
		const [{ default: OAuthProviderCtor }, { GitHubHandler }] = await Promise.all([
			import("@cloudflare/workers-oauth-provider"),
			import("./github-handler"),
		]);
		oauthProvider = new OAuthProviderCtor({
			apiHandler: rtServer as any,
			apiRoute: CONNECTOR_PATHS,
			authorizeEndpoint: "/authorize",
			clientRegistrationEndpoint: "/register",
			defaultHandler: GitHubHandler as any,
			tokenEndpoint: "/token",
		});
	}
	return oauthProvider;
}

// Best-effort maintenance run for the daily Cron Trigger (wrangler.jsonc crons).
// Keeps the Kroger client-credentials OAuth token warm in KV so the first `shop`
// call of the day doesn't pay the mint latency. Entirely optional: does nothing
// unless KROGER_CLIENT_ID/SECRET are configured, and is wrapped so it can NEVER
// throw — a failed tick must not surface as a Worker error. Mirrors the token
// cache scheme in fns/kroger.ts (same key, same expires_in - 60 TTL clamped to
// KV's 60s floor) so the value it writes is a drop-in for the read path there.
const KROGER_TOKEN_KEY = "sux:kroger:token";

async function refreshKrogerToken(env: RtEnv): Promise<void> {
	if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) return;
	const basic = btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
	const resp = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
		method: "POST",
		headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: "grant_type=client_credentials&scope=product.compact",
	});
	if (!resp.ok) throw new Error(`Kroger OAuth HTTP ${resp.status}`);
	const j: any = await resp.json();
	const token = String(j?.access_token ?? "");
	if (!token) throw new Error("Kroger OAuth response had no access_token.");
	const ttl = Math.max(60, (Number(j?.expires_in) || 1800) - 60);
	await env.OAUTH_KV.put(KROGER_TOKEN_KEY, token, { expirationTtl: ttl });
}

// One daily mail-triage cycle, driven by the same Cron Trigger. FAIL-CLOSED: early-returns
// doing nothing unless MAIL_TRIAGE_ENABLED is set (the cron fires every day regardless, but
// is a total no-op until Colin flips the flag) — and even then it only ACTS on the reversible
// allow-list (label/archive/unarchive/undelete) when MAIL_TRIAGE_ACT is also set; otherwise it
// classifies + writes a suggest-only digest.
// Everything is dynamically imported so the cron path pulls in the mail surface only when
// armed, and self-bounds its own wall-clock budget (scheduled() bypasses FN_DEADLINE_MS).
async function mailTriageTick(env: RtEnv): Promise<unknown> {
	const mod = await import("./fns/_mail_triage");
	if (!mod.hasMailTriage(env)) return { dormant: true };
	const deps = await mod.defaultDeps();
	return mod.runTriage(env, { max: 25 }, deps);
}

// One weekly recall-digest cycle, riding the SAME daily cron. FAIL-CLOSED: no-ops entirely
// unless WEEKLY_RECALL_ENABLED is set, and a once-per-ISO-week ledger gate means it does real
// work (recall fan-out + vault append) at most once every seven days — the other six daily
// ticks return immediately. recall is READ-only; the only write is a vault append, so this is
// strictly less privileged than mail triage. Dynamically imported so the cron path pulls in
// the recall surface only when armed.
async function weeklyRecallTick(env: RtEnv): Promise<unknown> {
	const mod = await import("./fns/_weekly_recall");
	if (!mod.hasWeeklyRecall(env)) return { dormant: true };
	const deps = await mod.defaultDeps();
	return mod.runWeeklyRecall(env, {}, deps);
}

// One daily morning-briefing cycle, driven by the same Cron Trigger. FAIL-CLOSED: early-returns
// doing nothing unless BRIEFING_ENABLED is set — and even then it only STAGES reply drafts (to
// Drafts, never sent) when BRIEFING_STAGE_DRAFTS is also set; otherwise it composes a
// summarize-and-nudge digest into the Daily note. Dynamically imported so the cron path pulls in
// the mail/cal surface only when armed. Composes "for today" (VAULT_TZ); idempotent per cycle.
async function briefingTick(env: RtEnv): Promise<unknown> {
	const mod = await import("./fns/_briefing");
	if (!mod.hasBriefing(env)) return { dormant: true };
	const deps = await mod.defaultDeps();
	return mod.runBriefing(env, {}, deps);
}

// Constant-time string compare (avoids leaking the token via early-exit timing).
function tokenEq(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// The frequent Cron Trigger (must match the second entry in wrangler.jsonc's
// `triggers.crons`): pushes the Prometheus metrics snapshot AND runs mail-triage on a
// ~5-min cadence. Any other cron (the daily 13:00 UTC one) runs the rest of the
// maintenance tick.
const METRICS_CRON = "*/5 * * * *";

// Each sub-job runs via runSubJob: swallows failures (a bad one never blocks the
// rest) and stamps a {ok,at,error?} heartbeat into KV, so gatherHealth can surface
// last-success + staleness for the unattended cron parts on the public status page.
async function maintenanceTick(env: RtEnv, ctx: ExecutionContext): Promise<void> {
	await runSubJob(env, "kroger_token", () => refreshKrogerToken(env));
	await runSubJob(env, "weekly_recall", () => weeklyRecallTick(env));
	await runSubJob(env, "briefing", () => briefingTick(env));
	// Rebuild the cosmetic-adblock engine blob in R2 — staleness-gated, so the
	// daily cron only does network work ≈ weekly (see _adblock.refreshAdblockEngine).
	await runSubJob(env, "adblock", async () => {
		const { refreshAdblockEngine } = await import("./fns/_adblock");
		await refreshAdblockEngine(env);
	});
	try {
		// Push the pre-aggregated metrics snapshot to Grafana Cloud Prometheus. Self-
		// contained + idempotent: a pure no-op unless the GRAFANA_PROM_* secrets are set,
		// and a push error is swallowed so it never fails the tick.
		await shipMetricsSnapshot(env, ctx);
	} catch (e) {
		console.warn(`sux scheduled maintenance: metrics snapshot push skipped: ${String((e as Error)?.message ?? e)}`);
	}
}

// Maps an exception thrown out of the OAuth provider into a clean JSON error
// Response. Client-side mistakes (bad redirect_uri, missing/invalid params, CSRF
// state) get a 400 whose error_description echoes the message so the caller can
// fix their own request. Everything else is an opaque 500: the real message is
// only logged, never placed in the body, so internal implementation detail (a
// network failure in handleCallback, an internal TypeError, etc.) is not leaked
// to the possibly-anonymous caller.
export function oauthErrorResponse(e: unknown): Response {
	const msg = String((e as Error)?.message ?? e);
	const clientError = /redirect|client|invalid|unauthoriz|unregister|missing|csrf|state/i.test(msg);
	console.error(`oauth wrapper caught: ${msg}`);
	const errorDescription = clientError ? msg : "Internal server error.";
	return new Response(JSON.stringify({ error: clientError ? "invalid_request" : "server_error", error_description: errorDescription }), {
		status: clientError ? 400 : 500,
		headers: { "content-type": "application/json" },
	});
}

// The OAuth library throws on malformed requests (e.g. an unregistered
// redirect_uri), which Cloudflare surfaces as a raw 1101 error page. Wrap it so
// those become clean JSON errors: 400 for client mistakes, 500 otherwise.
export default {
	// Cron Trigger entrypoint. Best-effort only: each tick is deferred via
	// ctx.waitUntil and self-contained in try/catch so it never throws. The
	// self-improvement tick rides the SAME daily cron beside the Kroger refresh; it
	// ships dormant (fail-closed) and no-ops entirely unless SELF_IMPROVE_ENABLE is set.
	async scheduled(event: ScheduledController, env: RtEnv, ctx: ExecutionContext): Promise<void> {
		// Two crons on one handler (wrangler.jsonc): the frequent */5 trigger pushes the
		// Prometheus metrics snapshot AND runs mail-triage on a ~5-min cadence — a label is
		// only useful before you next open mail, and triage is idempotent via its seen-
		// ledger + a dormant no-op unless MAIL_TRIAGE_ENABLED, so a frequent tick is cheap
		// and only ever processes new unread mail. The daily trigger runs the rest of the
		// maintenance suite + self-improve (maintenanceTick pushes a snapshot too, so the
		// daily run is also covered).
		if (event.cron === METRICS_CRON) {
			ctx.waitUntil(shipMetricsSnapshot(env, ctx));
			ctx.waitUntil(runSubJob(env, "mail_triage", () => mailTriageTick(env)));
			return;
		}
		ctx.waitUntil(maintenanceTick(env, ctx));
		ctx.waitUntil(runSubJob(env, "self_improve", () => selfImproveTick(env)));
	},
	async fetch(request: Request, env: RtEnv, ctx: ExecutionContext): Promise<Response> {
		// Public, unauthenticated observability routes (health/metrics/dashboard)
		// are served before the OAuth provider claims every path.
		const obs = await handleObservability(new URL(request.url), request, env);
		if (obs) return obs;

		// Recovery dead-drop — the out-of-band control channel the home router phones
		// home to (HMAC-authed checkin, bearer-authed operator enqueue/status). Served
		// before the OAuth provider claims every path; fail-closed (404) when its secret
		// is unset. The Worker only stores health + vends Worker-signed commands — it
		// executes nothing (the box pulls, verifies, and acts). See src/recovery.ts.
		const recovery = await handleRecovery(new URL(request.url), request, env);
		if (recovery) return recovery;

		// Manual ops trigger for the daily cron ticks — POST /admin/tick?job=mail-triage|
		// self-improve|maintenance, bearer-gated by SUX_CRON_TOKEN (unset ⇒ 404, feature off).
		// Runs the tick inline and returns its report, so an operator can fire a cycle on
		// demand (each tick self-bounds its own budget and is idempotent).
		{
			const u = new URL(request.url);
			if (request.method === "POST" && u.pathname === "/admin/tick") {
				const token = env.SUX_CRON_TOKEN;
				if (!token) return new Response("not found", { status: 404 });
				const auth = request.headers.get("authorization") ?? "";
				const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
				if (!presented || !tokenEq(token, presented)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
				const job = u.searchParams.get("job") ?? "";
				try {
					let out: unknown;
					if (job === "mail-triage") out = await mailTriageTick(env);
					else if (job === "weekly-recall") out = await weeklyRecallTick(env);
					else if (job === "briefing") out = await briefingTick(env);
					else if (job === "self-improve") out = await selfImproveTick(env);
					else if (job === "maintenance") { await maintenanceTick(env, ctx); out = { ok: true }; }
					else return new Response(JSON.stringify({ error: "unknown job", jobs: ["mail-triage", "weekly-recall", "briefing", "self-improve", "maintenance"] }), { status: 400, headers: { "content-type": "application/json" } });
					return new Response(JSON.stringify({ ok: true, job, result: out }, null, 2), { headers: { "content-type": "application/json" } });
				} catch (e) {
					return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500, headers: { "content-type": "application/json" } });
				}
			}
		}

		// JMAP push webhook — Fastmail POSTs here the moment new mail arrives (once
		// mail({action:'push_subscribe'}) is armed), letting mail_triage react in
		// seconds instead of waiting for the next ~5min cron tick. The URL's <token>
		// segment IS the credential (Fastmail's POST carries no auth header of ours);
		// an unmatched token 404s, indistinguishable from the route not existing. See
		// handleMailPushWebhook's own comment for why a guessed token still can't do
		// anything the existing bearer-gated /admin/tick couldn't already.
		{
			const u = new URL(request.url);
			const m = request.method === "POST" && u.pathname.match(/^\/push\/jmap\/([^/]+)$/);
			if (m) {
				const body = await request.text();
				if (body.length > 16_000) return new Response("payload too large", { status: 413 });
				const mod = await import("./mail-mcp");
				const matched = await mod.handleMailPushWebhook(env, m[1], body, () => mailTriageTick(env));
				return matched ? new Response(null, { status: 200 }) : new Response("not found", { status: 404 });
			}
		}
		try {
			return await (await getOAuthProvider()).fetch(request, env as any, ctx);
		} catch (e) {
			return oauthErrorResponse(e);
		}
	},
};
