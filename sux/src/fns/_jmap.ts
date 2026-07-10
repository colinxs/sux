import { withRetry } from "../proxy";
import { type FailCode, type RtEnv } from "../registry";
import { fromB64, getBlob, putBlob, readBodyBytes, storeRefUuid, toB64 } from "./_util";

// _jmap.ts — the shared JMAP engine behind the `jmap` conduit fn and the ergonomic
// `mail` surface. It owns Session discovery + KV cache + self-heal, generalized
// accountId routing, `using`-capability derivation, the limit-safe POST, blob
// upload/download, and anchor-based query pagination. `jmap.ts`/`mail.ts` are thin
// schema+dispatch shells over this. Design: docs/proposals/jmap.md (FINAL).
//
// Two hard facts every path respects: FN_DEADLINE_MS = 60_000 wraps every fn.run
// (so we self-bound each POST well inside a 55s budget and hold a resumable cursor
// in an OUTER variable); the whole surface is cacheable:false (mail bodies + Session
// PII never touch the response KV — only the token-free Session blob is cached).

// ---- capability URNs (the only vendor-specific knowledge — a pure lookup) ----
const CAP_CORE = "urn:ietf:params:jmap:core";
const CAP_MAIL = "urn:ietf:params:jmap:mail";
const CAP_SUBMISSION = "urn:ietf:params:jmap:submission";
const CAP_VACATION = "urn:ietf:params:jmap:vacationresponse";
const CAP_CONTACTS = "urn:ietf:params:jmap:contacts";
const CAP_CALENDARS = "urn:ietf:params:jmap:calendars";
const CAP_MASKEDEMAIL = "https://www.fastmail.com/dev/maskedemail";
const CAP_FM_CONTACTS = "https://www.fastmail.com/dev/contacts";

export const SESSION_KEY = "sux:fastmail:session";
const SESSION_TTL = 3600;
const DEFAULT_SESSION_URL = "https://api.fastmail.com/jmap/session";

/** Soft wall-clock budget inside the 60s FN_DEADLINE_MS wrapper (§14). */
const SOFT_DEADLINE_MS = 55_000;
/** Cap on a single POST's abort timeout, deadline-aware (§14/D17). */
const POST_TIMEOUT_MS = 30_000;
/** Accumulated-output byte ceiling for a paginated pull (raw:true bypasses MAX_OUTPUT_CHARS, §9/D18). */
const OUTPUT_CEILING_BYTES = 700_000;
/** Hard cap on a single blob download (as:'store' can be large, but never unbounded → isolate OOM). */
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

export type JmapSession = {
	apiUrl: string;
	uploadUrl: string;
	downloadUrl: string;
	accounts: Record<string, { name?: string; isPersonal?: boolean; accountCapabilities?: Record<string, unknown> }>;
	primaryAccounts: Record<string, string>;
	capabilities: Record<string, any>;
	state?: string;
};

export type Invocation = [string, Record<string, any>, string];

/** A failure carrying a machine-readable FailCode, thrown by the engine and mapped by the fn shell. */
export class JmapError extends Error {
	code: FailCode;
	constructor(code: FailCode, message: string) {
		super(message);
		this.code = code;
		this.name = "JmapError";
	}
}

/** JSON emission for a raw:true fn: escape U+2028/U+2029 so the envelope stays valid JSON. */
export function jstr(v: unknown): string {
	return JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const authHeaders = (env: RtEnv): Record<string, string> => ({
	Authorization: `Bearer ${env.FASTMAIL_TOKEN}`,
	"Content-Type": "application/json",
	Accept: "application/json",
});

const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// ---------------------------------------------------------------------------
// Session discovery + KV cache + self-heal (§4)
// ---------------------------------------------------------------------------

/** GET the Session, validate it, cache the token-free body in KV (tight TTL). Throws JmapError. */
export async function discoverSession(env: RtEnv): Promise<JmapSession> {
	const url = env.FASTMAIL_SESSION_URL || DEFAULT_SESSION_URL;
	let resp: Response;
	try {
		resp = await withRetry(() => fetch(url, { headers: authHeaders(env) }));
	} catch (e) {
		throw new JmapError("upstream_error", `JMAP session discovery failed: ${String((e as Error)?.message ?? e)}`);
	}
	if (resp.status === 401 || resp.status === 403)
		throw new JmapError("not_configured", "Fastmail rejected the token (401/403) — it is revoked or not a JMAP-scoped token. Mint a new one at Fastmail → Settings → Privacy & Security → API tokens.");
	if (!resp.ok) throw new JmapError("upstream_error", `JMAP session discovery HTTP ${resp.status}.`);
	let s: JmapSession;
	try {
		s = (await resp.json()) as JmapSession;
	} catch {
		throw new JmapError("layout_change", "JMAP session response was not JSON.");
	}
	if (!s?.apiUrl || !s?.accounts || !s?.primaryAccounts) throw new JmapError("layout_change", "JMAP session missing apiUrl/accounts/primaryAccounts.");
	await env.OAUTH_KV.put(SESSION_KEY, JSON.stringify(s), { expirationTtl: SESSION_TTL }).catch(() => {});
	return s;
}

/** Session from KV if present (and valid), else discover. `forceRefresh` bypasses the cache (§4, session_refresh). */
export async function getSession(env: RtEnv, forceRefresh = false): Promise<JmapSession> {
	if (!forceRefresh) {
		const cached = await env.OAUTH_KV.get(SESSION_KEY);
		if (cached) {
			try {
				const s = JSON.parse(cached) as JmapSession;
				if (s?.apiUrl) return s;
			} catch {
				/* fall through to discovery */
			}
		}
	}
	return discoverSession(env);
}

// ---------------------------------------------------------------------------
// `using` derivation — over-declare + union (§7)
// ---------------------------------------------------------------------------

/** The contacts URN the live Session advertises (Fastmail may use its dev URN). */
function contactsCap(session: JmapSession): string {
	const caps = session.capabilities ?? {};
	if (CAP_CONTACTS in caps) return CAP_CONTACTS;
	if (CAP_FM_CONTACTS in caps) return CAP_FM_CONTACTS;
	return CAP_CONTACTS;
}

/** The capability URN a method needs (null = underivable → caller must pass `using`). */
export function capForMethod(method: string, session?: JmapSession): string | null {
	const p = method.split("/")[0];
	if (p === "Email" || p === "Mailbox" || p === "Thread" || p === "SearchSnippet") return CAP_MAIL;
	if (p === "Identity" || p === "EmailSubmission") return CAP_SUBMISSION;
	if (p === "VacationResponse") return CAP_VACATION;
	if (p === "MaskedEmail") return CAP_MASKEDEMAIL;
	if (p === "Contact" || p === "AddressBook" || p === "ContactGroup") return session ? contactsCap(session) : CAP_CONTACTS;
	if (p.startsWith("Calendar")) return CAP_CALENDARS;
	if (p === "Core") return CAP_CORE;
	return null;
}

/** Over-declare (EmailSubmission implies mail) and UNION the caller's `using` — never suppress a required cap. */
export function deriveUsing(methods: string[], session: JmapSession, callerUsing?: string[]): string[] {
	const set = new Set<string>([CAP_CORE]);
	for (const m of methods) {
		const p = m.split("/")[0];
		if (p === "Email" || p === "Mailbox" || p === "Thread" || p === "SearchSnippet") set.add(CAP_MAIL);
		if (p === "Identity" || p === "EmailSubmission") {
			set.add(CAP_SUBMISSION);
			set.add(CAP_MAIL); // onSuccess*Email performs a server-side Email mutation
		}
		if (p === "VacationResponse") set.add(CAP_VACATION);
		if (p === "MaskedEmail") set.add(CAP_MASKEDEMAIL);
		if (p === "Contact" || p === "AddressBook" || p === "ContactGroup") set.add(contactsCap(session));
		if (p.startsWith("Calendar")) set.add(CAP_CALENDARS);
	}
	for (const u of callerUsing ?? []) if (typeof u === "string" && u) set.add(u);
	return [...set];
}

// ---------------------------------------------------------------------------
// accountId routing — generalized (§4/D14), fixes MaskedEmail
// ---------------------------------------------------------------------------

export function accountIdFor(session: JmapSession, method: string, envOverride?: string): string | undefined {
	if (envOverride) return envOverride;
	const cap = capForMethod(method, session);
	const mailPrimary = session.primaryAccounts?.[CAP_MAIL];
	if (!cap) return mailPrimary ?? Object.keys(session.accounts ?? {})[0];
	const primary = session.primaryAccounts?.[cap];
	if (primary) return primary;
	// Non-primary capability (MaskedEmail, Fastmail contacts): scan accountCapabilities.
	for (const [id, acct] of Object.entries(session.accounts ?? {})) if (acct?.accountCapabilities && cap in acct.accountCapabilities) return id;
	return mailPrimary; // in practice MaskedEmail lives on the mail-primary account
}

/** Fill accountId into any Invocation args lacking it (never overwrite a caller's explicit id). */
export function injectAccountIds(calls: Invocation[], session: JmapSession, envOverride?: string): Invocation[] {
	return calls.map(([method, args, id]) => {
		if (args && typeof args === "object" && args.accountId === undefined) {
			const acct = accountIdFor(session, method, envOverride);
			if (acct) return [method, { ...args, accountId: acct }, id] as Invocation;
		}
		return [method, args, id] as Invocation;
	});
}

// ---------------------------------------------------------------------------
// Batch validation, gates (§10), limits (§6.0)
// ---------------------------------------------------------------------------

export function coreLimits(session: JmapSession): { maxCallsInRequest: number; maxObjectsInGet: number; maxObjectsInSet: number; maxSizeRequest: number; maxSizeUpload: number } {
	const core = session.capabilities?.[CAP_CORE] ?? {};
	return {
		maxCallsInRequest: num(core.maxCallsInRequest, 16),
		maxObjectsInGet: num(core.maxObjectsInGet, 500),
		maxObjectsInSet: num(core.maxObjectsInSet, 500),
		maxSizeRequest: num(core.maxSizeRequest, 10_000_000),
		maxSizeUpload: num(core.maxSizeUpload, 50_000_000),
	};
}

/** Validate the raw batch shape; return the first duplicate callId, or null. Throws JmapError on a malformed tuple. */
export function validateCalls(calls: unknown): asserts calls is Invocation[] {
	if (!Array.isArray(calls) || calls.length === 0) throw new JmapError("bad_input", "`calls` must be a non-empty array of [method, args, callId] invocations.");
	const seen = new Set<string>();
	for (const c of calls) {
		if (!Array.isArray(c) || c.length !== 3 || typeof c[0] !== "string" || typeof c[2] !== "string" || c[1] === null || typeof c[1] !== "object")
			throw new JmapError("bad_input", "each call must be a 3-tuple [methodName, argsObject, callId].");
		if (seen.has(c[2])) throw new JmapError("bad_input", `duplicate callId '${c[2]}' — callIds must be unique (they anchor back-references).`);
		seen.add(c[2]);
	}
}

// A JMAP arg can be back-referenced by renaming it with a `#` prefix + a
// ResultReference (RFC 8620 §3.7) — e.g. `#destroy:{resultOf:'q',…}` is the
// canonical "expunge everything a query matched" pattern. Its resolved value is
// opaque to us, so the gates must treat a `#`-prefixed mutation key as present:
// checking only the literal key let a back-referenced destroy/send slip the gate.
const hasMutArg = (args: any, key: string): boolean => {
	const lit = args?.[key];
	if (Array.isArray(lit) ? lit.length > 0 : lit != null && typeof lit === "object" && Object.keys(lit).length > 0) return true;
	return args?.[`#${key}`] != null; // back-referenced — can't verify empty, so gate conservatively
};

/** True if the batch would dispatch mail (an EmailSubmission/set create — literal or back-referenced). */
export function detectSend(calls: Invocation[]): boolean {
	return calls.some(([method, args]) => method === "EmailSubmission/set" && hasMutArg(args, "create"));
}

/** True if the batch contains an irreversible / persistent-egress mutation (§10). */
export function detectDestroy(calls: Invocation[]): boolean {
	return calls.some(([method, args]) => {
		if (!args || typeof args !== "object") return false;
		if (hasMutArg(args, "destroy")) return true; // Foo/set destroy (permanent) — literal OR #back-ref
		if (method === "Mailbox/set" && (args.onDestroyRemoveEmails === true || args["#onDestroyRemoveEmails"] != null)) return true;
		if (method === "VacationResponse/set" && (hasMutArg(args, "update") || hasMutArg(args, "create"))) return true;
		if (/(^|\/)(Rule|Sieve|Filter|Forwarding)/i.test(method)) {
			if (hasMutArg(args, "create") || hasMutArg(args, "update") || hasMutArg(args, "destroy")) return true;
		}
		return false;
	});
}

/** Enforce the two write gates; throw a teaching JmapError when a gate is unmet. */
export function enforceGates(calls: Invocation[], allowSend: boolean, allowDestroy: boolean): void {
	if (!allowSend && detectSend(calls)) throw new JmapError("bad_input", "sending requires allow_send:true — this batch contains an EmailSubmission/set create that would dispatch mail.");
	if (!allowDestroy && detectDestroy(calls))
		throw new JmapError("bad_input", "this batch contains an irreversible or persistent-egress mutation (destroy / onDestroyRemoveEmails / VacationResponse/set / forwarding) — set allow_destroy:true to proceed.");
}

// ---------------------------------------------------------------------------
// The limit-safe POST (§5/§6/§11/§13/§14)
// ---------------------------------------------------------------------------

type ApiResponse = { methodResponses: any[]; sessionState?: string; createdIds?: Record<string, string> };

/** POST one batch to apiUrl with a deadline-aware abort; map transport failures to JmapError. */
async function postOnce(env: RtEnv, apiUrl: string, body: unknown, remainingMs: number, retry: boolean): Promise<ApiResponse> {
	// When retry is on, withRetry may run up to 3 attempts (proxy MAX_ATTEMPTS) — divide
	// the remaining budget across them so the whole sequence stays inside the soft
	// deadline. A fixed 30s per attempt could stack 3×30s past the 60s FN_DEADLINE
	// wrapper, defeating the deadline-aware design and hard-killing the fn with no
	// clean timeout FailCode (D17).
	const perAttempt = retry ? Math.floor(remainingMs / 3) : remainingMs;
	const timeout = Math.max(1_000, Math.min(POST_TIMEOUT_MS, perAttempt));
	const doFetch = () => fetch(apiUrl, { method: "POST", headers: authHeaders(env), body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
	let resp: Response;
	try {
		resp = retry ? await withRetry(doFetch) : await doFetch();
	} catch (e) {
		const name = (e as Error)?.name ?? "";
		if (name === "AbortError" || name === "TimeoutError") throw new JmapError("timeout", "JMAP POST exceeded its deadline.");
		throw new JmapError("upstream_error", `JMAP POST failed: ${String((e as Error)?.message ?? e)}`);
	}
	return interpretResponse(resp);
}

async function interpretResponse(resp: Response): Promise<ApiResponse> {
	if (resp.status === 401 || resp.status === 403) throw new JmapError("__reauth__" as FailCode, "reauth"); // sentinel handled by caller
	if (resp.status === 429) throw new JmapError("rate_limited", "JMAP rate-limited (429).");
	if (resp.status === 404 || resp.status === 405 || resp.status === 410) throw new JmapError("__rediscover__" as FailCode, "apiUrl moved"); // sentinel
	if (resp.status >= 500) throw new JmapError("upstream_error", `JMAP server error (${resp.status}).`);
	let j: any;
	try {
		j = await resp.json();
	} catch {
		throw new JmapError("layout_change", "JMAP response was not JSON.");
	}
	// Request-level JMAP error object (RFC 8620 §3.6.1): { type, ... }
	if (j && typeof j === "object" && typeof j.type === "string" && !Array.isArray(j.methodResponses)) {
		const type = String(j.type).split("/").pop() || "requestError";
		if (/limit/i.test(type)) throw new JmapError("__limit__" as FailCode, JSON.stringify({ limit: j.limit }));
		if (/rateLimit/i.test(type)) throw new JmapError("rate_limited", `JMAP: ${type}`);
		throw new JmapError("upstream_error", `JMAP request error: ${type}`);
	}
	if (!j || !Array.isArray(j.methodResponses)) throw new JmapError("layout_change", "JMAP response missing methodResponses.");
	return j as ApiResponse;
}

/**
 * Run a validated batch: derive `using`, inject accountIds, refuse an over-cap batch
 * (v1: no auto-split — refuse-and-teach, the reliable choice; splitting a reference
 * graph is a documented follow-up), POST with the 401→rediscover + apiUrl-moved
 * self-heals, and return the raw response plus the (possibly refreshed) session.
 */
export async function runBatch(
	env: RtEnv,
	calls: Invocation[],
	opts: { using?: string[]; sessionRefresh?: boolean; startedAt: number },
): Promise<{ response: ApiResponse; session: JmapSession }> {
	let session = await getSession(env, opts.sessionRefresh);
	const limits = coreLimits(session);
	if (calls.length > limits.maxCallsInRequest)
		throw new JmapError(
			"bad_input",
			`batch has ${calls.length} calls but the server's maxCallsInRequest is ${limits.maxCallsInRequest} — split independent calls across separate jmap() calls (sux does not auto-split a reference graph).`,
		);

	const build = (s: JmapSession) => {
		const methods = calls.map((c) => c[0]);
		const using = deriveUsing(methods, s, opts.using);
		const methodCalls = injectAccountIds(calls, s, env.FASTMAIL_ACCOUNT_ID);
		return { using, methodCalls };
	};

	const remaining = () => SOFT_DEADLINE_MS - (Date.now() - opts.startedAt);
	const post = (s: JmapSession, retry: boolean) => {
		const { using, methodCalls } = build(s);
		return postOnce(env, s.apiUrl, { using, methodCalls }, remaining(), retry);
	};

	// Retry only READ-ONLY batches. Retrying a batch containing a /set (or /import|
	// /copy) after a timeout risks double-applying a non-idempotent mutation — a
	// duplicate send is the worst case. Reads are idempotent and safe to retry.
	const readOnly = !calls.some((c) => /\/(set|import|copy)$/i.test(String(c[0])));
	try {
		const response = await post(session, readOnly && remaining() > POST_TIMEOUT_MS);
		maybeInvalidateOnStateDrift(env, session, response);
		return { response, session };
	} catch (e) {
		if (e instanceof JmapError && (e.code === ("__reauth__" as FailCode) || e.code === ("__rediscover__" as FailCode) || e.code === ("__limit__" as FailCode))) {
			// Self-heal: re-discover the Session directly (not via getSession — KV
			// read-after-delete can hand back the stale blob), then retry once.
			await env.OAUTH_KV.delete(SESSION_KEY).catch(() => {});
			session = await discoverSession(env);
			try {
				const response = await post(session, false);
				return { response, session };
			} catch (e2) {
				throw normalizeSentinel(e2);
			}
		}
		throw normalizeSentinel(e);
	}
}

/** Turn an internal sentinel code into a real FailCode after the self-heal path is exhausted. */
function normalizeSentinel(e: unknown): JmapError {
	if (e instanceof JmapError) {
		if (e.code === ("__reauth__" as FailCode)) return new JmapError("not_configured", "Fastmail rejected the token after re-discovery — it is revoked or lacks scope.");
		if (e.code === ("__rediscover__" as FailCode)) return new JmapError("upstream_error", "JMAP apiUrl moved and the retry failed.");
		if (e.code === ("__limit__" as FailCode)) return new JmapError("rate_limited", "JMAP request-level limit exceeded — reduce the batch/objects and retry.");
		return e;
	}
	return new JmapError("upstream_error", `jmap failed: ${String((e as Error)?.message ?? e)}`);
}

/** On sessionState divergence, best-effort invalidate the cache so the NEXT call re-discovers (don't block this one). */
function maybeInvalidateOnStateDrift(env: RtEnv, session: JmapSession, response: ApiResponse): void {
	if (session.state && response.sessionState && response.sessionState !== session.state) {
		env.OAUTH_KV.delete(SESSION_KEY).catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Query pagination — anchor-based, dedup, queryState-validated (§6.3)
// ---------------------------------------------------------------------------

export type Cursor = { anchor: string | null; anchorOffset: number; queryState?: string; method: string; filterHash: string; ids?: string[] };

async function filterHash(filter: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(filter ?? null));
	const buf = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(buf).slice(0, 8))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const b64json = (o: unknown): string => toB64(new TextEncoder().encode(JSON.stringify(o)));
const unb64json = <T>(s: string): T => JSON.parse(new TextDecoder().decode(fromB64(s))) as T;

/**
 * Paginate a single Foo/query past the server page limit via stable anchor paging,
 * accumulating ids up to max_results / a 55s budget / an output byte ceiling. On a
 * bound, returns a resumable cursor + partial:true. queryState divergence mid-pull
 * stops the pull (never mixes snapshots). Optionally hydrates a back-referenced get.
 */
export async function runPaginate(
	env: RtEnv,
	queryCall: Invocation,
	getCall: Invocation | undefined,
	opts: { maxResults: number; cursor?: string; sessionRefresh?: boolean; startedAt: number; using?: string[] },
): Promise<{ payload: Record<string, unknown>; session: JmapSession }> {
	const [method, baseArgs] = queryCall;
	const session = await getSession(env, opts.sessionRefresh);
	const limits = coreLimits(session);
	const pageLimit = Math.min(num(limits.maxObjectsInGet, 200), 200);
	const fh = await filterHash(baseArgs?.filter);

	let anchor: string | null = null;
	let anchorOffset = 0;
	let queryState: string | undefined;
	const ids = new Set<string>();
	if (opts.cursor) {
		const c = unb64json<Cursor>(opts.cursor);
		if (c.filterHash !== fh) throw new JmapError("bad_input", "cursor does not match this call's filter — start a fresh paginate.");
		anchor = c.anchor;
		anchorOffset = c.anchorOffset;
		queryState = c.queryState;
		for (const id of c.ids ?? []) ids.add(id);
	}
	// Ids carried in from the cursor are already-emitted. Budget max_results (and the
	// emit slice) against only ids NEWLY fetched this call, so a fixed-max_results resume
	// advances by up to max_results per call instead of deadlocking on the preloaded set.
	const seeded = ids.size;

	const remaining = () => SOFT_DEADLINE_MS - (Date.now() - opts.startedAt);
	let truncated = false;
	let reason = "";
	const acct = accountIdFor(session, method, env.FASTMAIL_ACCOUNT_ID);

	// Absolute backstop against a server that returns full pages forever (or ignores
	// the anchor and re-serves the same ids): a hard page cap AND a no-progress break.
	let pages = 0;
	const MAX_PAGES = 1000;

	while (true) {
		if (++pages > MAX_PAGES) {
			truncated = true;
			reason = "max_pages";
			break;
		}
		if (remaining() < POST_TIMEOUT_MS) {
			truncated = true;
			reason = "deadline";
			break;
		}
		const qArgs: Record<string, any> = { ...baseArgs, accountId: baseArgs?.accountId ?? acct, limit: pageLimit, calculateTotal: !queryState };
		if (anchor) {
			qArgs.anchor = anchor;
			qArgs.anchorOffset = anchorOffset;
		} else {
			qArgs.position = ids.size; // first page(s) before we have an anchor
		}
		const using = deriveUsing([method], session, opts.using);
		const resp = await postOnce(env, session.apiUrl, { using, methodCalls: [[method, qArgs, "q"]] }, remaining(), false).catch((e) => {
			// anchorNotFound (a live inbox mutated) → degrade to partial, never error.
			if (e instanceof JmapError && e.code === "upstream_error" && /anchorNotFound/i.test(e.message)) return null;
			throw e;
		});
		if (!resp) {
			truncated = true;
			reason = "anchor_lost";
			break;
		}
		const mr = resp.methodResponses?.[0];
		if (!mr) throw new JmapError("upstream_error", "JMAP query error: empty response");
		if (mr[0] === "error") {
			// anchorNotFound is a METHOD-level error inside a 200 (postOnce doesn't throw it, so the
			// catch above is unreachable) — the live inbox mutated under us. Degrade to partial: keep
			// the ids gathered so far + the resume cursor, don't discard the whole run.
			if (/anchorNotFound/i.test(String((mr[1] as { type?: string })?.type ?? ""))) {
				truncated = true;
				reason = "anchor_lost";
				break;
			}
			throw new JmapError("upstream_error", `JMAP query error: ${(mr[1] as { type?: string })?.type ?? "unknown"}`);
		}
		const page = mr[1] as { ids?: string[]; queryState?: string };
		if (queryState && page.queryState && page.queryState !== queryState) {
			truncated = true;
			reason = "queryState_changed";
			break;
		}
		queryState = page.queryState ?? queryState;
		const pageIds = Array.isArray(page.ids) ? page.ids : [];
		const before = ids.size;
		for (const id of pageIds) ids.add(id);
		if (pageIds.length > 0) {
			anchor = pageIds[pageIds.length - 1];
			anchorOffset = 1;
		}
		if (pageIds.length < pageLimit) {
			// Last page — but it can still return more NEW ids than max_results; flag
			// truncated so a resume cursor is emitted rather than silently dropping the tail.
			if (ids.size - seeded > opts.maxResults) {
				truncated = true;
				reason = "max_results";
			}
			break;
		}
		if (ids.size === before) {
			// A full page that added no NEW ids → the server isn't advancing; stop
			// rather than spin (protects against a stuck anchor / all-duplicate page).
			truncated = true;
			reason = "no_progress";
			break;
		}
		if (ids.size - seeded >= opts.maxResults) {
			truncated = true;
			reason = "max_results";
			break;
		}
		if (jstr([...ids]).length > OUTPUT_CEILING_BYTES) {
			truncated = true;
			reason = "output_ceiling";
			break;
		}
	}

	const idList = [...ids].slice(0, seeded + opts.maxResults);
	const payload: Record<string, unknown> = { ids: idList, queryState, total: idList.length, partial: truncated, paged: true };
	if (truncated) {
		// Anchor the resume cursor on the LAST EMITTED id, not the loop's raw anchor.
		// A page is accumulated whole (pageLimit at a time) but idList is sliced to
		// maxResults, so on a max_results/output_ceiling break the loop anchor can sit
		// past the emitted tail (e.g. anchor=id#600 while idList ends at #500) — resuming
		// from it would silently skip the #501–#600 gap. Anchoring on idList's last id
		// closes the gap; for the other reasons idList[last] already equals the anchor.
		const lastEmitted = idList[idList.length - 1];
		const cursor: Cursor = { anchor: lastEmitted ?? anchor, anchorOffset: lastEmitted ? 1 : anchorOffset, queryState, method, filterHash: fh, ids: idList };
		payload.cursor = b64json(cursor);
		payload.truncated_reason = reason;
	}

	// Optional client-side hydration of a back-referenced Foo/get, collapsed into one response (§6.3/D10).
	if (getCall) {
		const [getMethod, getArgs] = getCall;
		const chunkSize = Math.min(num(limits.maxObjectsInGet, 200), 200);
		const list: any[] = [];
		const notFound: any[] = [];
		for (let i = 0; i < idList.length; i += chunkSize) {
			if (remaining() < POST_TIMEOUT_MS) {
				payload.partial = true;
				break;
			}
			const chunk = idList.slice(i, i + chunkSize);
			const gArgs: Record<string, any> = { ...getArgs, accountId: getArgs?.accountId ?? acct, ids: chunk };
			delete gArgs["#ids"]; // discard the caller's ResultReference; hydrate explicitly
			const gUsing = deriveUsing([getMethod], session, opts.using);
			const gr = await postOnce(env, session.apiUrl, { using: gUsing, methodCalls: [[getMethod, gArgs, "g"]] }, remaining(), false);
			const gmr = gr.methodResponses?.[0];
			if (gmr && gmr[0] === "error") {
				// A method-level error on a hydration chunk must NOT be swallowed as a complete success —
				// the caller would get ids for the full set but a list missing this chunk, with partial:false.
				payload.partial = true;
				payload.truncated_reason = "get_error";
			} else if (gmr && gmr[1]) {
				if (Array.isArray(gmr[1].list)) list.push(...gmr[1].list);
				if (Array.isArray(gmr[1].notFound)) notFound.push(...gmr[1].notFound);
			}
			if (jstr(list).length > OUTPUT_CEILING_BYTES) {
				payload.partial = true;
				payload.truncated_reason = "output_ceiling";
				break;
			}
		}
		payload.list = list;
		if (notFound.length) payload.notFound = notFound;
	}

	return { payload, session };
}

// ---------------------------------------------------------------------------
// Blob upload / download (§8)
// ---------------------------------------------------------------------------

/** Resolve upload bytes from a /s/<uuid> CAS ref or base64 — NEVER an https URL (SSRF, D15). */
async function resolveUploadBytes(env: RtEnv, data: string): Promise<Uint8Array> {
	const uuid = storeRefUuid(data) ?? (/^[0-9a-f-]{36}$/i.test(data.trim()) ? data.trim().toLowerCase() : null);
	if (uuid) {
		const blob = await getBlob(env, uuid);
		if (!blob) throw new JmapError("not_found", `no stored object for '${uuid}'.`);
		return blob.bytes;
	}
	if (/^https?:\/\//i.test(data)) throw new JmapError("bad_input", "upload.data does not accept an https URL (SSRF) — pass base64 or a /s/<uuid> CAS ref.");
	try {
		return fromB64(data);
	} catch {
		throw new JmapError("bad_input", "upload.data must be base64 or a /s/<uuid> CAS ref.");
	}
}

function expandUrl(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? encodeURIComponent(vars[k]) : `{${k}}`));
}

export async function doUpload(env: RtEnv, data: string, type: string): Promise<Record<string, unknown>> {
	const session = await getSession(env);
	const bytes = await resolveUploadBytes(env, data);
	const acct = accountIdFor(session, "Email/set", env.FASTMAIL_ACCOUNT_ID);
	if (!acct) throw new JmapError("upstream_error", "could not resolve an accountId for upload.");
	const url = expandUrl(session.uploadUrl, { accountId: acct });
	let resp: Response;
	try {
		resp = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${env.FASTMAIL_TOKEN}`, "Content-Type": type }, body: bytes as BodyInit, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
	} catch (e) {
		throw new JmapError("upstream_error", `blob upload failed: ${String((e as Error)?.message ?? e)}`);
	}
	if (resp.status === 401 || resp.status === 403) throw new JmapError("not_configured", "Fastmail rejected the token on upload.");
	if (!resp.ok) throw new JmapError("upstream_error", `blob upload HTTP ${resp.status}.`);
	return (await resp.json()) as Record<string, unknown>;
}

export async function doDownload(env: RtEnv, args: { blobId: string; type?: string; name?: string; as?: string }): Promise<Record<string, unknown>> {
	const session = await getSession(env);
	const acct = accountIdFor(session, "Email/get", env.FASTMAIL_ACCOUNT_ID);
	if (!acct) throw new JmapError("upstream_error", "could not resolve an accountId for download.");
	const type = args.type || "application/octet-stream";
	const url = expandUrl(session.downloadUrl, { accountId: acct, blobId: args.blobId, type, name: args.name || "download" });
	let resp: Response;
	try {
		resp = await fetch(url, { headers: { Authorization: `Bearer ${env.FASTMAIL_TOKEN}` }, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
	} catch (e) {
		throw new JmapError("upstream_error", `blob download failed: ${String((e as Error)?.message ?? e)}`);
	}
	if (resp.status === 404) throw new JmapError("not_found", `blob '${args.blobId}' not found.`);
	if (!resp.ok) throw new JmapError("upstream_error", `blob download HTTP ${resp.status}.`);
	// Bound the read (content-length pre-check + mid-stream abort) so a huge attachment errors
	// clearly instead of buffering unbounded into the 128MB isolate. 50MB covers real attachments.
	let bytes: Uint8Array;
	try {
		bytes = await readBodyBytes(resp, DOWNLOAD_MAX_BYTES);
	} catch (e) {
		if (/too large|exceeds/i.test(String((e as Error)?.message ?? e))) throw new JmapError("bad_input", `blob '${args.blobId}' exceeds the ${DOWNLOAD_MAX_BYTES}-byte download cap.`);
		throw e;
	}
	// as:"store" always spills to R2; as:"base64" spills too when it would blow the output ceiling (D18).
	if (args.as === "store" || bytes.length * (4 / 3) > OUTPUT_CEILING_BYTES) {
		const ref = await putBlob(env, bytes, type);
		return { blobId: args.blobId, type, size: bytes.length, ref: ref.url };
	}
	return { blobId: args.blobId, type, size: bytes.length, data: toB64(bytes) };
}
