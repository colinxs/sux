// Epic SMART-on-FHIR conduit — the OAuth dance, token lifecycle, FHIR fetch, and
// the two public routes (/mychart/connect, /mychart/callback) plus the Apple Health
// ingest endpoint (/apple-health). Design + rationale: docs/proposals/mychart.md.
//
// Token lifecycle is a straight port of the fns/_dropbox-core pattern: a long-lived
// REFRESH token minted at /mychart/callback is held in KV (NOT a wrangler secret —
// Epic rotates it on use and the org sets its lifetime, so it must be writable at
// runtime), short-lived access tokens are minted on demand and KV-cached with
// TTL = expires_in - 60, and a 401 self-heals by dropping the cache and re-minting
// once. Unlike Dropbox, a rotated refresh_token in the refresh response is persisted
// back to the grant before the fresh access token is used.
//
// PHI invariants (§5): raw FHIR/HealthKit blobs land under the private R2 `phi/`
// prefix which the /s/<uuid> handler refuses to serve, never route through dropbox,
// and never enter the generic KV result cache (the mychart fn is cacheable:false).

import { timingSafeEqual } from "./crypto-util";
import type { RtEnv } from "./registry";

export const PHI_PREFIX = "phi/";

const GRANT_KEY = "sux:mychart:grant";
const ACCESS_TOKEN_KEY = "sux:mychart:token";
const SMART_CFG_KEY = "sux:mychart:smartcfg";
const pkceKey = (state: string): string => `sux:mychart:pkce:${state}`;

// USCDI-only patient read scopes preserve Epic's Automatic Client ID Distribution
// (§1 / D4). offline_access is what mints the durable refresh token.
const DEFAULT_SCOPES = "openid fhirUser offline_access patient/*.read";
const PKCE_TTL_S = 600; // 10 min — the interactive login must complete inside this.
const SMART_CFG_TTL_S = 12 * 60 * 60; // config changes propagate in ~12h (§1).

export interface MychartGrant {
	refresh_token: string;
	patient?: string;
	scope?: string;
	issued_at: number;
}

interface SmartConfig {
	authorization_endpoint: string;
	token_endpoint: string;
}

/** All three of EPIC_CLIENT_ID / EPIC_CLIENT_SECRET / EPIC_FHIR_BASE set. Absent →
 * the fn and routes stay inert (not_configured), exactly like monarch/dropbox. */
export function mychartConfigured(env: RtEnv): boolean {
	return Boolean(env.EPIC_CLIENT_ID && env.EPIC_CLIENT_SECRET && env.EPIC_FHIR_BASE);
}

/** The org's FHIR R4 base URL (no trailing slash), the `aud` for the OAuth dance. */
export function fhirBase(env: RtEnv): string {
	return String(env.EPIC_FHIR_BASE ?? "").replace(/\/+$/, "");
}

/** Public base for the callback redirect URI — must match the fhir.epic.com
 * registration exactly (§3 step 3). Shares STORE_BASE with the `store` handles so a
 * staging deploy points its callback at itself; defaults to the prod host. */
export function redirectUri(env: RtEnv): string {
	const v = (env as { STORE_BASE?: string }).STORE_BASE;
	const base = (typeof v === "string" && v ? v : "https://suxos.net").replace(/\/+$/, "");
	return `${base}/mychart/callback`;
}

const b64url = (bytes: Uint8Array): string => {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A high-entropy PKCE code_verifier (RFC 7636 — 43-128 chars, base64url alphabet). */
export function makeVerifier(): string {
	return b64url(crypto.getRandomValues(new Uint8Array(48)));
}

/** S256 challenge = base64url(SHA-256(verifier)). The sandbox advertises S256 only (§1). */
export async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return b64url(new Uint8Array(digest));
}

/** Discover the authorize/token endpoints from the org's SMART configuration,
 * caching them in KV (config changes propagate in ~12h). Epic's oauth endpoints do
 * not share a simple suffix with the FHIR base, so discovery is the robust path. */
export async function smartConfig(env: RtEnv): Promise<SmartConfig> {
	const cached = await env.OAUTH_KV?.get(SMART_CFG_KEY);
	if (cached) {
		try {
			const c = JSON.parse(cached);
			if (c?.authorization_endpoint && c?.token_endpoint) return c;
		} catch {}
	}
	const resp = await fetch(`${fhirBase(env)}/.well-known/smart-configuration`, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(20_000),
	});
	const j: any = await resp.json().catch(() => null);
	if (!resp.ok || !j?.authorization_endpoint || !j?.token_endpoint) {
		throw new Error(`SMART configuration discovery failed: HTTP ${resp.status}`);
	}
	const cfg: SmartConfig = { authorization_endpoint: String(j.authorization_endpoint), token_endpoint: String(j.token_endpoint) };
	await env.OAUTH_KV?.put(SMART_CFG_KEY, JSON.stringify(cfg), { expirationTtl: SMART_CFG_TTL_S });
	return cfg;
}

export async function readGrant(env: RtEnv): Promise<MychartGrant | null> {
	const raw = await env.OAUTH_KV?.get(GRANT_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as MychartGrant;
	} catch {
		return null;
	}
}

// Confidential client → the token endpoint is authed with HTTP Basic client_id:secret.
function tokenAuthHeaders(env: RtEnv): Record<string, string> {
	return {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
		Authorization: `Basic ${btoa(`${env.EPIC_CLIENT_ID}:${env.EPIC_CLIENT_SECRET}`)}`,
	};
}

/** POST the token endpoint with a URL-encoded body; returns the parsed JSON + status. */
async function tokenPost(env: RtEnv, cfg: SmartConfig, body: Record<string, string>): Promise<{ status: number; json: any }> {
	const resp = await fetch(cfg.token_endpoint, {
		method: "POST",
		headers: tokenAuthHeaders(env),
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(20_000),
	});
	return { status: resp.status, json: await resp.json().catch(() => null) };
}

/** Cache a freshly-minted access token in KV (TTL = expires_in - 60, KV's 60s floor). */
async function cacheAccessToken(env: RtEnv, accessToken: string, expiresIn: unknown): Promise<void> {
	const ttl = Math.max(60, (Number(expiresIn) || 3600) - 60);
	await env.OAUTH_KV?.put(ACCESS_TOKEN_KEY, accessToken, { expirationTtl: ttl });
}

/** Mint an access token from the stored refresh grant, PERSISTING any rotated
 * refresh_token back to the grant before returning. Throws not-configured / no-grant
 * with a caller-friendly message. */
export async function mintAccessToken(env: RtEnv): Promise<string> {
	if (!mychartConfigured(env)) throw new Error("MyChart not configured (EPIC_CLIENT_ID / EPIC_CLIENT_SECRET / EPIC_FHIR_BASE).");
	const grant = await readGrant(env);
	if (!grant?.refresh_token) throw new Error("MyChart not connected — no grant in KV. Open /mychart/connect once to link the account.");
	const cfg = await smartConfig(env);
	const { status, json } = await tokenPost(env, cfg, {
		grant_type: "refresh_token",
		refresh_token: grant.refresh_token,
		client_id: String(env.EPIC_CLIENT_ID),
	});
	if (status >= 400 || !json?.access_token) {
		// PHI-free: status + the OAuth error *code* only (a short enum like
		// invalid_grant), never error_description free-text — this string surfaces as the
		// call's `err` into Workers Logs / Loki / metrics.last_error (§5 invariant #4).
		const code = typeof json?.error === "string" ? json.error.replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 40) : "no_access_token";
		throw new Error(`MyChart token refresh HTTP ${status} (${code})`);
	}
	// Epic MAY rotate the refresh token on use — persist the new one (plus any
	// refreshed patient/scope) before the access token is used, or the next refresh
	// replays a spent token and the grant dies.
	if (typeof json.refresh_token === "string" && json.refresh_token && json.refresh_token !== grant.refresh_token) {
		const updated: MychartGrant = { ...grant, refresh_token: json.refresh_token, issued_at: Date.now(), patient: json.patient ?? grant.patient, scope: json.scope ?? grant.scope };
		await env.OAUTH_KV?.put(GRANT_KEY, JSON.stringify(updated));
	}
	await cacheAccessToken(env, String(json.access_token), json.expires_in);
	return String(json.access_token);
}

/** Resolve a bearer: KV-cached access token, else a fresh mint from the refresh grant. */
export async function mychartAccessToken(env: RtEnv): Promise<string> {
	const cached = await env.OAUTH_KV?.get(ACCESS_TOKEN_KEY);
	if (cached) return cached;
	return mintAccessToken(env);
}

/** FHIR fetch with the dropbox-core 401 self-heal: on a 401, drop the cached access
 * token and re-mint ONCE from the refresh grant (a server-side revocation recovers
 * without waiting out the KV TTL). Always requests FHIR+JSON. */
export async function mychartFetch(env: RtEnv, url: string): Promise<Response> {
	const build = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" }, signal: AbortSignal.timeout(30_000) });
	const first = await fetch(url, build(await mychartAccessToken(env)));
	if (first.status !== 401) return first;
	await env.OAUTH_KV?.delete(ACCESS_TOKEN_KEY).catch(() => {});
	return fetch(url, build(await mintAccessToken(env)));
}

/** True when `u` is an absolute URL under the configured FHIR base — the guard for
 * `get` passthrough and for following a Bundle's `next` link (an org-supplied URL
 * must never let us fetch off-base). */
export function isUnderFhirBase(env: RtEnv, u: string): boolean {
	const base = fhirBase(env);
	if (!base) return false;
	try {
		const target = new URL(u);
		const b = new URL(base);
		// Same origin AND the path is at/below the base path — prefix on a path segment
		// boundary so `/api/FHIR/R4x` can't masquerade as `/api/FHIR/R4`.
		if (target.origin !== b.origin) return false;
		const basePath = b.pathname.replace(/\/+$/, "");
		return target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
	} catch {
		return false;
	}
}

/** Resolve a caller-supplied FHIR `path` (relative like `Observation?...`, or an
 * absolute URL) to a validated absolute URL under the FHIR base, or null if it
 * escapes the base. */
export function resolveFhirPath(env: RtEnv, path: string): string | null {
	const base = fhirBase(env);
	if (!base) return null;
	const trimmed = String(path ?? "").trim();
	if (!trimmed) return null;
	const abs = /^https?:\/\//i.test(trimmed) ? trimmed : `${base}/${trimmed.replace(/^\/+/, "")}`;
	return isUnderFhirBase(env, abs) ? abs : null;
}

// ---------------- PHI R2 writes ----------------

/** Write a raw PHI blob under the private `phi/` prefix. NEVER mints a /s/ handle
 * and never routes through dropbox (§5). Idempotent by key. No-op-safe: throws only
 * if R2 is unbound, which callers surface. */
export async function putPhi(env: RtEnv, key: string, body: string | Uint8Array, contentType: string): Promise<string> {
	if (!env.R2) throw new Error("R2 bucket is not bound — cannot store PHI.");
	const fullKey = key.startsWith(PHI_PREFIX) ? key : `${PHI_PREFIX}${key}`;
	await env.R2.put(fullKey, body, { httpMetadata: { contentType } });
	return fullKey;
}

// ---------------- pull: the USCDI resource plan ----------------

export interface PlanItem {
	type: string;
	label: string;
	query: string;
}

// The Epic USCDI R4 read set (§1). Observation is split per USCDI category (a bare
// Observation search is rejected/over-broad). Appointment is deliberately absent —
// it is not USCDI and selecting it forfeits auto client-ID distribution (§1).
const OBSERVATION_CATEGORIES = ["laboratory", "vital-signs", "social-history"];
const SIMPLE_TYPES = ["Condition", "MedicationRequest", "AllergyIntolerance", "Immunization", "Procedure", "DiagnosticReport", "DocumentReference", "Encounter", "CarePlan", "CareTeam", "Goal", "Device", "Provenance"];

/** Build the per-type search plan for a patient. `types` narrows to the given
 * resource types (matched case-insensitively); `since` adds `_lastUpdated=ge…` where
 * the org honors it (falls through harmlessly otherwise). */
export function resourcePlan(patientId: string, types?: string[], since?: string): PlanItem[] {
	const want = types && types.length ? new Set(types.map((t) => t.toLowerCase())) : null;
	const wants = (t: string): boolean => !want || want.has(t.toLowerCase());
	const dateParam = since ? `&_lastUpdated=ge${encodeURIComponent(since)}` : "";
	const pid = encodeURIComponent(patientId);
	const plan: PlanItem[] = [];
	if (wants("Patient")) plan.push({ type: "Patient", label: "Patient", query: `_id=${pid}` });
	if (wants("Observation")) {
		for (const cat of OBSERVATION_CATEGORIES) plan.push({ type: "Observation", label: `Observation.${cat}`, query: `patient=${pid}&category=${cat}&_count=100${dateParam}` });
	}
	for (const t of SIMPLE_TYPES) {
		if (wants(t)) plan.push({ type: t, label: t, query: `patient=${pid}&_count=100${dateParam}` });
	}
	return plan;
}

/** The `next` link URL from a FHIR searchset Bundle, or null. */
export function nextLink(bundle: any): string | null {
	const link = Array.isArray(bundle?.link) ? bundle.link.find((l: any) => l?.relation === "next") : null;
	return link?.url ? String(link.url) : null;
}

export interface PullResult {
	patient: string;
	counts: Record<string, number>;
	pages: number;
	binaries: number;
	keys: number;
	truncated?: boolean;
}

// A hard page ceiling per plan item so a runaway/looping `next` chain can't blow the
// Worker's wall-clock budget on a single resource type.
const MAX_PAGES_PER_TYPE = 50;

/** Execute a pull: iterate the resource plan, page through each searchset, resolve
 * DocumentReference → Binary attachments, and write every raw page + Binary under
 * `phi/`. Returns a per-label count summary — never resource values. */
export async function pull(env: RtEnv, opts?: { types?: string[]; since?: string }): Promise<PullResult> {
	const grant = await readGrant(env);
	const patient = grant?.patient;
	if (!patient) throw new Error("MyChart pull needs a patient id — reconnect via /mychart/connect (the grant carries it).");
	const base = fhirBase(env);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const plan = resourcePlan(patient, opts?.types, opts?.since);
	const counts: Record<string, number> = {};
	let pages = 0;
	let binaries = 0;
	let keys = 0;
	let truncated = false;

	for (const item of plan) {
		let url: string | null = `${base}/${item.type}?${item.query}`;
		let page = 0;
		counts[item.label] = counts[item.label] ?? 0;
		while (url) {
			if (page >= MAX_PAGES_PER_TYPE) {
				truncated = true;
				break;
			}
			const resp = await mychartFetch(env, url);
			const bundle: any = await resp.json().catch(() => null);
			if (resp.status >= 400 || !bundle) {
				// A single failing resource type must not sink the whole pull (some orgs
				// 404 a type they don't support). Record nothing and move on.
				break;
			}
			pages++;
			page++;
			const entries: any[] = Array.isArray(bundle.entry) ? bundle.entry : [];
			const resources = entries.map((e) => e?.resource).filter(Boolean);
			counts[item.label] += resources.length;
			keys += 1;
			await putPhi(env, `mychart/${patient}/${item.label}/${stamp}-p${page}.json`, JSON.stringify(bundle), "application/fhir+json");
			if (item.type === "DocumentReference") {
				for (const doc of resources) {
					for (const bin of await resolveBinaries(env, base, doc)) {
						await putPhi(env, `mychart/${patient}/Binary/${bin.id}.json`, bin.body, "application/fhir+json");
						binaries++;
						keys++;
					}
				}
			}
			const next = nextLink(bundle);
			url = next && isUnderFhirBase(env, next) ? next : null;
		}
	}
	return { patient, counts, pages, binaries, keys, ...(truncated ? { truncated } : {}) };
}

/** Resolve a DocumentReference's Binary attachments (content[].attachment.url →
 * Binary/{id}). Returns the raw fetched bodies keyed by Binary id. Skips non-Binary
 * or off-base attachment URLs. */
async function resolveBinaries(env: RtEnv, base: string, doc: any): Promise<Array<{ id: string; body: string }>> {
	const out: Array<{ id: string; body: string }> = [];
	const contents: any[] = Array.isArray(doc?.content) ? doc.content : [];
	for (const c of contents) {
		const attUrl = c?.attachment?.url;
		if (typeof attUrl !== "string" || !attUrl) continue;
		const m = /Binary\/([A-Za-z0-9\-.]+)$/.exec(attUrl);
		if (!m) continue;
		const abs = /^https?:\/\//i.test(attUrl) ? attUrl : `${base}/Binary/${m[1]}`;
		if (!isUnderFhirBase(env, abs)) continue;
		const resp = await mychartFetch(env, abs);
		if (resp.status >= 400) continue;
		out.push({ id: m[1], body: await resp.text() });
	}
	return out;
}

// ---------------- Public routes ----------------

const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
// Error/status responses that interpolate caller- or upstream-supplied values are
// served as text/plain so an echoed `error`/`error_description` can NEVER execute as
// HTML on the prod origin (reflected-XSS class), even if a future edit forgets to
// escape a new field. Only the fixed success page is HTML.
const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

/** Escape a value for safe interpolation into a text/html response body — the one
 * remaining HTML page (the success page) interpolates the patient id with this. */
export function escapeHtml(s: unknown): string {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** GET /mychart/connect + GET /mychart/callback. Served BEFORE the OAuthProvider
 * claims every path (same pre-gate trick as /health, /metrics). Returns null when
 * the path isn't ours. `/connect` is gated by the operator SUX_CRON_TOKEN in the
 * query so a stranger can't bind THEIR MyChart to the Worker (§2a). */
export async function handleMychartRoutes(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;

	if (url.pathname === "/mychart/connect") {
		if (!mychartConfigured(env)) return new Response("MyChart not configured.", { status: 404 });
		const gate = env.SUX_CRON_TOKEN;
		if (!gate) return new Response("not found", { status: 404 });
		const presented = url.searchParams.get("token") ?? "";
		if (!presented || !timingSafeEqual(gate, presented)) return new Response("unauthorized", { status: 401 });
		try {
			const cfg = await smartConfig(env);
			const verifier = makeVerifier();
			const challenge = await challengeFor(verifier);
			const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
			await env.OAUTH_KV?.put(pkceKey(state), JSON.stringify({ verifier, created: Date.now() }), { expirationTtl: PKCE_TTL_S });
			const auth = new URL(cfg.authorization_endpoint);
			auth.searchParams.set("response_type", "code");
			auth.searchParams.set("client_id", String(env.EPIC_CLIENT_ID));
			auth.searchParams.set("redirect_uri", redirectUri(env));
			auth.searchParams.set("scope", DEFAULT_SCOPES);
			auth.searchParams.set("state", state);
			auth.searchParams.set("aud", fhirBase(env));
			auth.searchParams.set("code_challenge", challenge);
			auth.searchParams.set("code_challenge_method", "S256");
			return new Response(null, { status: 302, headers: { location: auth.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
		} catch (e) {
			// Defense-in-depth: today only smartConfig()'s status-number-only errors reach here,
			// but escapeHtml + an explicit content-type keep this catch consistent with every
			// other error response in this flow the moment its error surface gains attacker-
			// influenced content (matches the reflected-XSS fix applied to the callback route).
			return new Response(escapeHtml(String((e as Error)?.message ?? e)), { status: 502, headers: TEXT_HEADERS });
		}
	}

	if (url.pathname === "/mychart/callback") {
		if (!mychartConfigured(env)) return new Response("MyChart not configured.", { status: 404 });
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? "";
		const err = url.searchParams.get("error");
		if (err) return new Response(`MyChart authorization error: ${err}`, { status: 400, headers: TEXT_HEADERS });
		if (!code || !state) return new Response("Missing code/state.", { status: 400, headers: PAGE_HEADERS });
		const stored = await env.OAUTH_KV?.get(pkceKey(state));
		if (!stored) return new Response("Invalid or expired state (CSRF check failed).", { status: 400, headers: PAGE_HEADERS });
		await env.OAUTH_KV?.delete(pkceKey(state)).catch(() => {}); // one-time.
		let verifier = "";
		try {
			verifier = JSON.parse(stored)?.verifier ?? "";
		} catch {}
		if (!verifier) return new Response("Corrupt PKCE state.", { status: 400, headers: PAGE_HEADERS });
		try {
			const cfg = await smartConfig(env);
			const { status, json } = await tokenPost(env, cfg, {
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri(env),
				code_verifier: verifier,
				client_id: String(env.EPIC_CLIENT_ID),
			});
			if (status >= 400 || !json?.access_token) {
				return new Response(`Token exchange failed: HTTP ${status} ${json?.error_description ?? json?.error ?? ""}`.trim(), { status: 502, headers: TEXT_HEADERS });
			}
			if (typeof json.refresh_token === "string" && json.refresh_token) {
				const grant: MychartGrant = { refresh_token: json.refresh_token, patient: json.patient, scope: json.scope, issued_at: Date.now() };
				await env.OAUTH_KV?.put(GRANT_KEY, JSON.stringify(grant));
			}
			await cacheAccessToken(env, String(json.access_token), json.expires_in);
			const hasRefresh = Boolean(json.refresh_token);
			return new Response(
				`<!doctype html><meta charset=utf-8><title>MyChart connected</title><body style="font-family:system-ui;padding:2rem"><h1>MyChart connected</h1><p>Patient <code>${escapeHtml(String(json.patient ?? "(unknown)"))}</code> linked.${hasRefresh ? "" : " <strong>No refresh token was issued</strong> — pulls will need re-login (the org may not have provisioned offline_access)."}</p><p>You can close this tab. Run <code>mychart op:\"pull\"</code> to sync.</p></body>`,
				{ status: 200, headers: PAGE_HEADERS },
			);
		} catch (e) {
			return new Response(`MyChart callback failed: ${String((e as Error)?.message ?? e)}`, { status: 502, headers: TEXT_HEADERS });
		}
	}

	return null;
}

// ---------------- Apple Health ingest ----------------

/** The batch's period-start date (YYYY-MM-DD) parsed from the HAE payload itself, so
 * the storage key is stable regardless of when the (possibly midnight-crossing) retry
 * arrives. Checks an explicit top-level period, then the earliest metric sample date.
 * Returns null when the payload carries no usable date. */
export function payloadPeriodDate(body: string): string | null {
	let j: any;
	try {
		j = JSON.parse(body);
	} catch {
		return null;
	}
	const dateOf = (v: unknown): string | null => {
		const m = typeof v === "string" ? /(\d{4}-\d{2}-\d{2})/.exec(v) : null;
		return m ? m[1] : null;
	};
	const explicit = dateOf(j?.period?.start) ?? dateOf(j?.period) ?? dateOf(j?.data?.period?.start) ?? dateOf(j?.data?.period);
	if (explicit) return explicit;
	const metrics: any[] = Array.isArray(j?.data?.metrics) ? j.data.metrics : [];
	let best: string | null = null;
	for (const met of metrics) {
		const rows: any[] = Array.isArray(met?.data) ? met.data : [];
		for (const row of rows) {
			const d = dateOf(row?.date);
			if (d && (!best || d < best)) best = d;
		}
	}
	return best;
}

/** POST /apple-health — Health Auto Export pushes its JSON here. Bearer-gated
 * (constant-time) against HEALTH_INGEST_TOKEN; unset ⇒ 404 (feature off). Writes
 * the raw payload under the private `phi/` prefix with an idempotent, content-
 * derived key so a re-POST of the same batch overwrites rather than duplicates. */
export async function handleAppleHealth(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (url.pathname !== "/apple-health") return null;
	if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
	const token = env.HEALTH_INGEST_TOKEN;
	if (!token) return new Response("not found", { status: 404 });
	const auth = request.headers.get("authorization") ?? "";
	const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	if (!presented || !timingSafeEqual(token, presented)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
	if (!env.R2) return new Response(JSON.stringify({ error: "R2 not bound" }), { status: 503, headers: { "content-type": "application/json" } });
	const MAX_BYTES = 8 * 1024 * 1024;
	// Reject on the declared Content-Length BEFORE buffering the whole body into memory
	// — a fabricated 100 MiB POST shouldn't get read in full just to be rejected.
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BYTES) return new Response(JSON.stringify({ error: "payload too large" }), { status: 413, headers: { "content-type": "application/json" } });
	const body = await request.text();
	if (!body) return new Response(JSON.stringify({ error: "empty body" }), { status: 400, headers: { "content-type": "application/json" } });
	// Fallback post-read check (chunked / absent Content-Length can't be trusted above).
	// Measure actual UTF-8 bytes, not body.length (UTF-16 code units) — multi-byte
	// characters (non-ASCII names/notes in the export) make code-unit count undercount
	// true byte size by up to ~3x, letting an oversized payload slip under MAX_BYTES.
	// Encode once and reuse the bytes below for the hash and the R2 write.
	const bytes = new TextEncoder().encode(body);
	if (bytes.length > MAX_BYTES) return new Response(JSON.stringify({ error: "payload too large" }), { status: 413, headers: { "content-type": "application/json" } });
	// Idempotent key: an automation-id + period header identifies a batch across the
	// jittery Background-App-Refresh retries HAE makes; fall back to a content hash so
	// identical bodies still collapse to one object. Header-driven so a retry lands on
	// the SAME key and R2's put overwrites in place (never assume completeness — §2c).
	const automationId = (request.headers.get("x-automation-id") || request.headers.get("automation-id") || "").slice(0, 128);
	const period = (request.headers.get("x-period") || request.headers.get("period") || "").slice(0, 128);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hash = Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
	// The date directory MUST be derived from the PAYLOAD, never the server clock: a
	// Background-App-Refresh retry that crosses UTC midnight would otherwise land under a
	// new date dir and write a DUPLICATE instead of overwriting (§2c). Prefer the batch's
	// own period start, then the x-period header, then the content hash — all stable
	// across a retry, so the same batch always resolves to the same key.
	const headerDate = /^\d{4}-\d{2}-\d{2}/.test(period) ? period.slice(0, 10) : "";
	const datePart = payloadPeriodDate(body) || headerDate || hash;
	const idPart = [automationId, period].filter(Boolean).map((s) => s.replace(/[^A-Za-z0-9_-]/g, "_")).join("-") || hash;
	const key = `apple-health/${datePart}/${idPart}.json`;
	try {
		const stored = await putPhi(env, key, bytes, "application/json");
		return new Response(JSON.stringify({ ok: true, key: stored, bytes: bytes.length }), { status: 200, headers: { "content-type": "application/json" } });
	} catch (e) {
		return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500, headers: { "content-type": "application/json" } });
	}
}

/** Cron helper (rides maintenanceTick beside refreshKrogerToken): keep the refresh
 * grant alive by minting a fresh access token. No-op when unconfigured or unconnected
 * (throws are swallowed by the runSubJob wrapper). */
export async function refreshMychartToken(env: RtEnv): Promise<void> {
	if (!mychartConfigured(env)) return;
	if (!(await readGrant(env))) return; // never connected — nothing to keep warm.
	// Short-circuit when a cached access token is still valid: minting on every tick
	// would force a needless refresh_token grant and risk a double-spend race with a
	// concurrent pull rotating the refresh token. Only mint when the cache is empty/expired.
	if (await env.OAUTH_KV?.get(ACCESS_TOKEN_KEY)) return;
	await mintAccessToken(env);
}
