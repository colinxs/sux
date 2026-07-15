import { type RtEnv } from "./registry";

// Stage-then-commit — the accidental-misuse guard for every side-effectful verb. A caller
// passes stage:true to get back { preview, commit_token } WITHOUT mutating; a second call
// passing that token commits, iff the token is unspent, unexpired (5-min TTL), and the exact
// payload still hashes to what was staged. The token binds to the payload so a stale preview
// can't commit a changed action. This is a two-STEP guard (mint then spend are separate tool
// calls), NOT an injection boundary — a read-only credential is the real containment.

const PREFIX = "sux:stage:";
const TTL_SECONDS = 300;

// The stage-kind annotation registry — the SINGLE source of truth that makes the guard
// default-on and annotation-driven. Keyed by the `kind` string every side-effectful verb
// passes to staged(); its own map (NOT registry.ts's TOOL_ANNOTATIONS, which hints the ~95
// `fns` MCP tools — the mail/files verbs here are separate handlers with no such hints).
//   irreversible:true  → auto-STAGE by default (a preview + commit_token; the human/agent must
//                        come back with the token, or pass force:true, to actually do it).
//   irreversible:false → auto-MUTATE by default (a reversible create/update is safe to just do).
// A `kind` routed through staged() with NO entry here fails CLOSED (staged() throws) — a
// forgotten annotation can never silently auto-run an outward action.
export type StageKind = { irreversible: boolean };
export const STAGE_KINDS: Record<string, StageKind> = {
	// mail — send + the destructive/durable ones stage; reversible masked/contact creates+updates auto-run.
	mail_send: { irreversible: true },
	mail_masked_create: { irreversible: false },
	mail_masked_delete: { irreversible: true },
	mail_mailbox_delete: { irreversible: true },
	mail_vacation: { irreversible: true },
	contact_create: { irreversible: false },
	contact_update: { irreversible: false },
	contact_delete: { irreversible: true },
	cal_create: { irreversible: false },
	cal_update: { irreversible: false },
	cal_delete: { irreversible: true },
	task_create: { irreversible: false },
	task_update: { irreversible: false },
	task_complete: { irreversible: false },
	// files Mode B (whole-Dropbox) — every write/move/delete/operate/transform stages by default.
	files_write_full: { irreversible: true },
	files_upload_full: { irreversible: true },
	files_move_full: { irreversible: true },
	files_delete_full: { irreversible: true },
	files_operate: { irreversible: true },
	files_transform: { irreversible: true },
	// fn tier — store.put mints a world-readable, unauthenticated /s/<uuid> URL for
	// whatever bytes it's given, the one concrete egress channel a prompt-injected
	// agent could use to hand out private content (mail/vault/financial). Stages by
	// default so a fresh put needs a second explicit step (commit_token or force),
	// same threat class as mail_send. dropbox/obsidian/kv_*/ingest are NOT routed
	// through this guard: unlike store, they're called internally as building blocks
	// by ~a dozen other fns (recall, advise, _kb, _agenda, _consolidate, mail triage,
	// …) that need to auto-run — gating them here would mean threading force:true
	// through every one of those call sites, well beyond this fix's scope.
	store_put: { irreversible: true },
};

// In-isolate spent-token claim. A commit's KV get→verify→delete is not atomic —
// KV has no compare-and-set — so two concurrent commits of ONE token could both
// read it present, both delete, and both run mutate(): a double-spend (for
// mail_send, a user-visible double-send). This synchronous Set is the single-
// winner guard for the common case: JS in a Worker isolate is single-threaded, so
// the has→add below runs with NO await between the check and the claim, making it
// impossible for two concurrent commits IN THIS ISOLATE to both win. The KV delete
// still fires so other isolates (and later retries) see the token spent — that
// cross-isolate leg stays best-effort (a Durable Object is the only true multi-
// isolate CAS; deferred until send volume makes a rare cross-isolate race matter).
// Bounded so a long-lived isolate can't leak: tokens are one-shot and 5-min TTL'd,
// so a full clear past the cap only reopens the (already best-effort) cross-window.
const spentTokens = new Set<string>();
const SPENT_CAP = 10_000;

function claimToken(token: string): boolean {
	if (spentTokens.has(token)) return false;
	if (spentTokens.size >= SPENT_CAP) spentTokens.clear();
	spentTokens.add(token);
	return true;
}

async function hashPayload(payload: unknown): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload ?? null)));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randToken(): string {
	const a = new Uint8Array(18);
	crypto.getRandomValues(a);
	return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Conscience-lint — the advisory second opinion on a staged action ─────────────
// A cheap, payload-only heuristic pass that rides into EVERY stage preview (attached to
// StageResult.advisory below), so the human/agent reviewing the preview sees the "are you
// sure?" flags — typo'd recipients, a wider blast than intended, "see attached" with nothing
// attached, a shouting/phishing-shaped tone. It is ADVISORY ONLY: it never blocks, never
// alters the commit path, and is entirely separate from _jmap.ts enforceGates() (the real
// credential-layer allow_send/allow_destroy gate). Fields are read defensively so it's safe
// over any verb's payload; non-mail kinds simply produce no notes.

const PROFANITY = /\b(fuck|shit|asshole|bastard|bitch|dick|crap|damn)\b/i;
const MONEY_SCAM = /\b(urgent(ly)?|wire transfer|gift ?cards?|bitcoin|crypto|western union|send (me )?money|bank (details|account)|routing number|ssn|social security|password|verify your account)\b/i;

/** A recipient that is malformed or matches a common typo shape (bad structure, double dot,
 *  misspelled provider, or a fat-fingered TLD like .cmo/.con). Heuristic — false positives are fine (advisory). */
function looksTypoedEmail(addr: string): boolean {
	const a = addr.toLowerCase().trim();
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) return true; // not a well-formed address
	if (/\.\./.test(a)) return true; // double dot
	if (/@(gmial|gmai|gnail|gmail\.co$|hotmial|hotmai|hotnail|yaho|outlok|iclould)\b/.test(a)) return true;
	const tld = a.split(".").pop() ?? "";
	return /^(cmo|con|ocm|cim|coom|comm|nett|orgg|edd)$/.test(tld);
}

/** Advisory conscience notes over a staged payload — recipient sanity, typo'd addresses,
 *  attachment mention vs presence, and tone/sentiment flags. Never throws; never blocks. */
export function conscience(_kind: string, payload: unknown): string[] {
	const notes: string[] = [];
	const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
	const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
	const to = asArr(p.to);
	const cc = asArr(p.cc);
	const bcc = asArr(p.bcc);
	const recipients = [...to, ...cc, ...bcc];

	if (recipients.length >= 10) notes.push(`${recipients.length} recipients — confirm this isn't a wider blast than intended.`);
	if (bcc.length >= 5) notes.push(`${bcc.length} bcc recipients — a large blind-copy set.`);

	const suspect = recipients.filter(looksTypoedEmail);
	if (suspect.length) notes.push(`possible typo'd / malformed address: ${suspect.slice(0, 3).join(", ")}.`);

	const domains = new Set(recipients.map((r) => r.split("@")[1]?.toLowerCase()).filter(Boolean));
	if (domains.size >= 5) notes.push(`recipients span ${domains.size} distinct domains.`);

	const body = typeof p.text === "string" ? p.text : "";
	const atts = Array.isArray(p.attachments) ? p.attachments : [];
	const mentionsAttach = /\b(attach(ed|ment|ing|ments)?|enclosed)\b/i.test(body);
	if (mentionsAttach && atts.length === 0) notes.push("the body mentions an attachment but none are attached.");
	if (!mentionsAttach && atts.length > 0) notes.push("attachments are present but the body doesn't reference them.");

	const subject = typeof p.subject === "string" ? p.subject : "";
	if (subject.replace(/[^a-z]/gi, "").length >= 6 && subject === subject.toUpperCase() && /[A-Z]/.test(subject)) notes.push("the subject is ALL CAPS — reads as shouting.");
	if (PROFANITY.test(`${subject}\n${body}`)) notes.push("contains profanity — confirm the tone is intended.");
	if (MONEY_SCAM.test(`${subject}\n${body}`)) notes.push("urgent-money / credential keywords — a classic phishing shape; confirm this is legitimate.");

	return notes;
}

export type StageResult = { staged: true; kind: string; preview: unknown; commit_token: string; expires_in: number; note: string; advisory?: string[] };

/** Mint a commit token bound to `payload` and return the preview. Performs NO mutation.
 *  Attaches conscience-lint notes to StageResult.advisory so they surface in every stage preview. */
export async function stage(env: RtEnv, kind: string, payload: unknown, preview: unknown): Promise<StageResult> {
	const token = randToken();
	const hash = await hashPayload(payload);
	await env.OAUTH_KV?.put(`${PREFIX}${token}`, JSON.stringify({ kind, hash }), { expirationTtl: TTL_SECONDS });
	const advisory = conscience(kind, payload);
	return { staged: true, kind, preview, commit_token: token, expires_in: TTL_SECONDS, note: `Nothing done yet. Re-call the same verb with commit_token:'${token}' (+ the identical payload) within 5 min to commit.`, ...(advisory.length ? { advisory } : {}) };
}

/** Verify + consume a commit token against `payload`. Throws a clear reason on any mismatch; single-use. */
export async function commit(env: RtEnv, kind: string, token: string, payload: unknown): Promise<void> {
	const raw = await env.OAUTH_KV?.get(`${PREFIX}${token}`);
	if (!raw) throw new Error("commit_token is invalid, already spent, or expired (5-min TTL) — re-stage to get a fresh preview.");
	let rec: { kind?: string; hash?: string };
	try {
		rec = JSON.parse(raw);
	} catch {
		rec = {};
	}
	if (rec.kind !== kind) throw new Error(`commit_token was staged for '${rec.kind}', not '${kind}'.`);
	if (rec.hash !== (await hashPayload(payload))) throw new Error("the payload changed since staging — the commit_token is bound to the exact previewed action. Re-stage.");
	// Single-winner claim: the synchronous has→add makes a concurrent second commit
	// of this token in the same isolate lose here (see spentTokens) rather than
	// racing to a double mutate(). Must precede the KV delete so the claim is the
	// authority — a lost claimant never reaches mutate() in staged().
	if (!claimToken(token)) throw new Error("commit_token is already being spent by a concurrent commit — single-use.");
	await env.OAUTH_KV?.delete(`${PREFIX}${token}`).catch(() => {});
}

/**
 * The stage/commit dispatch every side-effectful verb wraps its mutation in. DEFAULT-ON and
 * ANNOTATION-DRIVEN: with no stage/commit_token/force, the STAGE_KINDS entry for `kind` decides.
 *   - force:true          → runs `mutate()` directly, bypassing the guard (the `!`-override:
 *                           the one-shot opt-out that wins over stage/commit_token). No token.
 *   - commit_token present → verifies+consumes it, then runs `mutate()`
 *   - stage:true          → returns the preview + a commit_token (no mutation)
 *   - neither             → look up STAGE_KINDS[kind]:
 *       • irreversible:true  → auto-STAGE (preview + token; the caller must force/commit to do it)
 *       • irreversible:false → auto-MUTATE (a reversible side-effect is safe to just run)
 *       • no entry           → THROW (fail-closed): a guarded verb with no annotation must never auto-run.
 * Returns the StageResult in the stage cases; else the mutate result.
 */
export async function staged<T>(env: RtEnv, kind: string, args: { stage?: boolean; commit_token?: string; force?: boolean }, payload: unknown, preview: unknown, mutate: () => Promise<T>): Promise<{ stageResult: StageResult } | { result: T }> {
	// `force` is the generalized `!`-override: opt out of staging outright, ahead of
	// any stage/commit_token, so a caller that has decided can't be forced into a
	// round-trip. It never mints or consumes a token.
	if (args?.force === true) {
		return { result: await mutate() };
	}
	if (args?.commit_token) {
		await commit(env, kind, String(args.commit_token), payload);
		return { result: await mutate() };
	}
	if (args?.stage === true) {
		return { stageResult: await stage(env, kind, payload, preview) };
	}
	// Default-on, annotation-driven. The fail-closed throw is the catch for a forgotten
	// annotation: a verb wired through the guard but absent from STAGE_KINDS surfaces as a
	// teaching error (via each run()'s fail(errMsg(e))), never a silent auto-execute.
	const ann = STAGE_KINDS[kind];
	if (!ann) throw new Error(`'${kind}' is routed through the stage guard but has no STAGE_KINDS annotation — a guarded verb must never auto-run. Annotate it in STAGE_KINDS (irreversible: true|false), or call with force:true to run once / stage:true to preview.`);
	if (ann.irreversible) {
		return { stageResult: await stage(env, kind, payload, preview) };
	}
	return { result: await mutate() };
}
