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
import { safeParseJson } from "./fns/_util";

export const PHI_PREFIX = "phi/";

// The multi-org registry (design §1/§2.1) — a code constant, not runtime config: the
// org set changes rarely and a constant stays unit-testable/reviewable. One client
// credential (EPIC_CLIENT_ID/SECRET) authenticates against all three via Epic's
// Automatic Client-ID Distribution, so adding an org is a one-line PR, never a new
// Epic app registration. Base URLs are public directory data, never secrets.
export const MYCHART_ORGS: Record<string, { name: string; fhirBase: string }> = {
	uwmedicine: { name: "UW Medicine (WA)", fhirBase: "https://fhir.epic.medical.washington.edu/FHIR-Proxy/UWM/api/FHIR/R4" },
	swedish: { name: "Providence Swedish (WA)", fhirBase: "https://haikuwa.providence.org/fhirproxy/api/FHIR/R4" },
	bozeman: { name: "Bozeman Health (MT)", fhirBase: "https://revproxy.bh.bozemanhealth.org/Interconnect-Oauth2-PRD/api/FHIR/R4" },
};

const grantKey = (org: string): string => `sux:mychart:grant:${org}`;
const accessTokenKey = (org: string): string => `sux:mychart:token:${org}`;
const smartCfgKey = (org: string): string => `sux:mychart:smartcfg:${org}`;
// PKCE state is already unique per login attempt, so it keeps one shared key
// namespace; the org rides inside the stored blob (§2.2) instead of a suffix.
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

/** Both EPIC_CLIENT_ID / EPIC_CLIENT_SECRET set. Absent → the fn and routes stay
 * inert (not_configured), exactly like monarch/dropbox. EPIC_FHIR_BASE is retired
 * (§2.1) — the org's base now comes from MYCHART_ORGS, a code constant, not a secret. */
export function mychartConfigured(env: RtEnv): boolean {
	return Boolean(env.EPIC_CLIENT_ID && env.EPIC_CLIENT_SECRET);
}

/** True when `org` is a registered id in MYCHART_ORGS. */
export function isKnownOrg(org: string): boolean {
	return Boolean(MYCHART_ORGS[org]);
}

/** `org`'s FHIR R4 base URL (no trailing slash), the `aud` for the OAuth dance.
 * "" for an unregistered org — callers that need a hard failure use isKnownOrg first. */
export function fhirBase(org: string): string {
	return (MYCHART_ORGS[org]?.fhirBase ?? "").replace(/\/+$/, "");
}

/** Every registry org id with a stored refresh grant — the "connected" set that
 * `status`, `refreshMychartToken`, and the org-omitted single-org default all read. */
export async function connectedOrgs(env: RtEnv): Promise<string[]> {
	const ids = Object.keys(MYCHART_ORGS);
	const grants = await Promise.all(ids.map((org) => readGrant(env, org)));
	return ids.filter((_, i) => Boolean(grants[i]));
}

/** Resolve a caller-supplied (possibly omitted) org against the registry: an explicit
 * `requested` must name a known org; an omitted one defaults to the sole CONNECTED org
 * (§2.4's ergonomic single-org case) and is ambiguous otherwise. Shared by connect/
 * pull/get so the default rule can't drift between them. */
export async function resolveOrg(env: RtEnv, requested: unknown): Promise<{ org: string } | { error: string }> {
	const ids = Object.keys(MYCHART_ORGS);
	if (typeof requested === "string" && requested.trim()) {
		const org = requested.trim();
		if (!isKnownOrg(org)) return { error: `mychart: unknown org '${org}'. Valid orgs: ${ids.join(", ")}.` };
		return { org };
	}
	const connected = await connectedOrgs(env);
	if (connected.length === 1) return { org: connected[0] };
	const hint = connected.length ? ` Connected: ${connected.join(", ")}.` : "";
	return { error: `mychart: an 'org' arg is required (valid orgs: ${ids.join(", ")}).${hint}` };
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

/** Discover `org`'s authorize/token endpoints from its SMART configuration, caching
 * them in KV per org (config changes propagate in ~12h). Epic's oauth endpoints do
 * not share a simple suffix with the FHIR base, so discovery is the robust path. */
export async function smartConfig(env: RtEnv, org: string): Promise<SmartConfig> {
	const cached = await env.OAUTH_KV?.get(smartCfgKey(org));
	const c = safeParseJson<Partial<SmartConfig> | null>(cached, null);
	if (c?.authorization_endpoint && c?.token_endpoint) return c as SmartConfig;
	const resp = await fetch(`${fhirBase(org)}/.well-known/smart-configuration`, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(20_000),
	});
	const j: any = await resp.json().catch(() => null);
	if (!resp.ok || !j?.authorization_endpoint || !j?.token_endpoint) {
		throw new Error(`SMART configuration discovery failed: HTTP ${resp.status}`);
	}
	const cfg: SmartConfig = { authorization_endpoint: String(j.authorization_endpoint), token_endpoint: String(j.token_endpoint) };
	await env.OAUTH_KV?.put(smartCfgKey(org), JSON.stringify(cfg), { expirationTtl: SMART_CFG_TTL_S });
	return cfg;
}

export async function readGrant(env: RtEnv, org: string): Promise<MychartGrant | null> {
	const raw = await env.OAUTH_KV?.get(grantKey(org));
	return safeParseJson<MychartGrant | null>(raw, null);
}

// Confidential client → the token endpoint is authed with HTTP Basic client_id:secret.
// Shared across every org (§1 — one client_id/secret via Automatic Client-ID Distribution).
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

/** Cache a freshly-minted access token in KV, scoped to `org` (TTL = expires_in - 60,
 * KV's 60s floor). */
async function cacheAccessToken(env: RtEnv, org: string, accessToken: string, expiresIn: unknown): Promise<void> {
	const ttl = Math.max(60, (Number(expiresIn) || 3600) - 60);
	await env.OAUTH_KV?.put(accessTokenKey(org), accessToken, { expirationTtl: ttl });
}

/** Mint an access token from `org`'s stored refresh grant, PERSISTING any rotated
 * refresh_token back to that org's grant before returning. Throws not-configured /
 * unknown-org / no-grant with a caller-friendly message. */
export async function mintAccessToken(env: RtEnv, org: string): Promise<string> {
	if (!mychartConfigured(env)) throw new Error("MyChart not configured (EPIC_CLIENT_ID / EPIC_CLIENT_SECRET).");
	if (!isKnownOrg(org)) throw new Error(`Unknown MyChart org '${org}'.`);
	const grant = await readGrant(env, org);
	if (!grant?.refresh_token) throw new Error(`MyChart not connected for org '${org}' — no grant in KV. Open /mychart/connect?org=${org} once to link the account.`);
	const cfg = await smartConfig(env, org);
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
		await env.OAUTH_KV?.put(grantKey(org), JSON.stringify(updated));
	}
	await cacheAccessToken(env, org, String(json.access_token), json.expires_in);
	return String(json.access_token);
}

/** Resolve a bearer for `org`: KV-cached access token, else a fresh mint from the
 * refresh grant. */
export async function mychartAccessToken(env: RtEnv, org: string): Promise<string> {
	const cached = await env.OAUTH_KV?.get(accessTokenKey(org));
	if (cached) return cached;
	return mintAccessToken(env, org);
}

/** FHIR fetch against `org` with the dropbox-core 401 self-heal: on a 401, drop the
 * cached access token and re-mint ONCE from the refresh grant (a server-side
 * revocation recovers without waiting out the KV TTL). Always requests FHIR+JSON. */
export async function mychartFetch(env: RtEnv, org: string, url: string): Promise<Response> {
	const build = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" }, signal: AbortSignal.timeout(30_000) });
	const first = await fetch(url, build(await mychartAccessToken(env, org)));
	if (first.status !== 401) return first;
	await env.OAUTH_KV?.delete(accessTokenKey(org)).catch(() => {});
	return fetch(url, build(await mintAccessToken(env, org)));
}

/** True when `u` is an absolute URL under `org`'s FHIR base — the guard for `get`
 * passthrough and for following a Bundle's `next` link (an org-supplied URL must
 * never let us fetch off-base, and never let one org's link resolve under another's). */
export function isUnderFhirBase(org: string, u: string): boolean {
	const base = fhirBase(org);
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
 * absolute URL) to a validated absolute URL under `org`'s FHIR base, or null if it
 * escapes the base. */
export function resolveFhirPath(org: string, path: string): string | null {
	const base = fhirBase(org);
	if (!base) return null;
	const trimmed = String(path ?? "").trim();
	if (!trimmed) return null;
	const abs = /^https?:\/\//i.test(trimmed) ? trimmed : `${base}/${trimmed.replace(/^\/+/, "")}`;
	return isUnderFhirBase(org, abs) ? abs : null;
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
	org: string;
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

/** Execute a pull for `org`: iterate the resource plan, page through each searchset,
 * resolve DocumentReference → Binary attachments, and write every raw page + Binary
 * under `phi/mychart/${org}/...` (org-scoped so two orgs' opaque patient ids can never
 * collide on the same key). Returns a per-label count summary — never resource values. */
export async function pull(env: RtEnv, org: string, opts?: { types?: string[]; since?: string }): Promise<PullResult> {
	const grant = await readGrant(env, org);
	const patient = grant?.patient;
	if (!patient) throw new Error(`MyChart pull needs a patient id for org '${org}' — reconnect via /mychart/connect?org=${org} (the grant carries it).`);
	const base = fhirBase(org);
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
			const resp = await mychartFetch(env, org, url);
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
			await putPhi(env, `mychart/${org}/${patient}/${item.label}/${stamp}-p${page}.json`, JSON.stringify(bundle), "application/fhir+json");
			if (item.type === "DocumentReference") {
				for (const doc of resources) {
					for (const bin of await resolveBinaries(env, org, base, doc)) {
						await putPhi(env, `mychart/${org}/${patient}/Binary/${bin.id}.json`, bin.body, "application/fhir+json");
						binaries++;
						keys++;
					}
				}
			}
			const next = nextLink(bundle);
			url = next && isUnderFhirBase(org, next) ? next : null;
		}
	}
	return { org, patient, counts, pages, binaries, keys, ...(truncated ? { truncated } : {}) };
}

// ---------------- summarize: last-pull → redacted agenda signal (W6) ----------------

/** All pages sharing the newest stamp under `phi/mychart/{org}/{patient}/{label}/` —
 * the most recently pulled snapshot for one resource label (e.g. "Observation.laboratory",
 * "MedicationRequest") within one org, merged into a flat resource list. [] when never
 * pulled, R2 is unbound, or nothing parses. Server-side only: callers must keep raw
 * resource content out of anything that leaves the Worker (vault/mail/logs) — see the
 * PHI invariants at the top of this file. */
async function latestPulledResources(env: RtEnv, org: string, patient: string, label: string): Promise<any[]> {
	if (!env.R2) return [];
	const prefix = `${PHI_PREFIX}mychart/${org}/${patient}/${label}/`;
	// R2 lists a prefix in ASCENDING key order, and our ISO stamps sort ascending too — the
	// newest stamp is always on the LAST page. A single unpaginated list() call would silently
	// pin this to the OLDEST pull once a label accumulates more than one page (1000 objects,
	// plausible after months of pulls), so every page must be walked. Bounded to 50 pages
	// (50k objects) as a runaway-loop backstop, not an expected ceiling.
	const keys: string[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 50; i++) {
		const listing = await env.R2.list({ prefix, cursor, limit: 1000 });
		for (const o of listing.objects) keys.push(o.key);
		if (!listing.truncated || !listing.cursor) break;
		cursor = listing.cursor;
	}
	let latestStamp: string | null = null;
	for (const k of keys) {
		const m = /\/([^/]+)-p\d+\.json$/.exec(k);
		if (m && (!latestStamp || m[1] > latestStamp)) latestStamp = m[1];
	}
	if (!latestStamp) return [];
	const pageKeys = keys.filter((k) => k.startsWith(`${prefix}${latestStamp}-p`));
	const resources: any[] = [];
	for (const key of pageKeys) {
		const obj = await env.R2.get(key);
		if (!obj) continue;
		const bundle = safeParseJson<any>(await obj.text(), null);
		const entries: any[] = Array.isArray(bundle?.entry) ? bundle.entry : [];
		for (const e of entries) if (e?.resource) resources.push(e.resource);
	}
	return resources;
}

/** True once ANY resource page has ever been pulled for this org/patient — a connected-but-
 * never-pulled org (grant exists the instant OAuth completes, independent of `pull` ever
 * running) must NOT count toward summarizeMyChart's "2+ orgs contributing" prefixing decision
 * (#994), or a second org merely finishing OAuth retroactively re-prefixes every id from an
 * org that already pulled and had its bare ids proposed once — the exact re-migration flood
 * this function's own docstring says the bare/prefixed split avoids. limit:1 keeps this a
 * cheap existence check, not a full listing. */
async function hasEverPulled(env: RtEnv, org: string, patient: string): Promise<boolean> {
	if (!env.R2) return false;
	const listing = await env.R2.list({ prefix: `${PHI_PREFIX}mychart/${org}/${patient}/`, limit: 1 });
	return listing.objects.length > 0;
}

/** True once a SPECIFIC resource label (e.g. "AllergyIntolerance") has ever been pulled for
 * this org/patient — unlike `hasEverPulled`, which only proves SOME resource type was pulled.
 * `pull()`'s `opts.types` narrowing (see `resourcePlan`) means an org can be "ever pulled" while
 * a given label was never fetched; callers that need to tell "confirmed empty" apart from
 * "never asked" for one specific label (e.g. cross-org allergy-gap reconciliation) must gate on
 * this, not `hasEverPulled`. limit:1 keeps this a cheap existence check, not a full listing. */
async function hasPulledLabel(env: RtEnv, org: string, patient: string, label: string): Promise<boolean> {
	if (!env.R2) return false;
	const listing = await env.R2.list({ prefix: `${PHI_PREFIX}mychart/${org}/${patient}/${label}/`, limit: 1 });
	return listing.objects.length > 0;
}

// USCDI ObservationInterpretation codes (http://terminology.hl7.org/CodeSystem/v3-
// ObservationInterpretation) this cares about — everything else (incl. "N" normal) is
// left unflagged. High/Low/Abnormal only; critical variants collapse into the same
// direction bucket (a redacted "high"/"low" flag, never the raw value driving it).
const INTERPRETATION_DIRECTION: Record<string, "high" | "low" | "abnormal"> = {
	H: "high", HH: "high", HU: "high",
	L: "low", LL: "low", LU: "low",
	A: "abnormal", AA: "abnormal", AS: "abnormal",
};

function interpretationDirection(resource: any): "high" | "low" | "abnormal" | null {
	const codings: any[] = Array.isArray(resource?.interpretation) ? resource.interpretation.flatMap((i: any) => (Array.isArray(i?.coding) ? i.coding : [])) : [];
	for (const c of codings) {
		const code = typeof c?.code === "string" ? c.code.toUpperCase() : "";
		if (INTERPRETATION_DIRECTION[code]) return INTERPRETATION_DIRECTION[code];
	}
	return null;
}

function codeableConceptText(cc: any): string | undefined {
	const text = cc?.text || (Array.isArray(cc?.coding) ? cc.coding.find((c: any) => typeof c?.display === "string")?.display : undefined);
	return typeof text === "string" && text ? text : undefined;
}

/** True when a FHIR CodeableConcept's coding array contains `code` (case-insensitive). */
function codeableConceptHasCode(cc: any, code: string): boolean {
	const codings: any[] = Array.isArray(cc?.coding) ? cc.coding : [];
	return codings.some((c) => typeof c?.code === "string" && c.code.toLowerCase() === code);
}

/** An AllergyIntolerance still counts as a live allergy: no clinicalStatus at all is treated
 *  as active (many records omit it and absence isn't evidence of resolution), but an EXPLICIT
 *  "inactive"/"resolved" clinicalStatus, or an explicit "refuted"/"entered-in-error"
 *  verificationStatus, rules it out (#1011) — mirrors the meds filter's `status === "active"`
 *  so a resolved/refuted allergy stops permanently tripping the cross-org checks. */
function isAllergyActive(r: any): boolean {
	if (r?.clinicalStatus && !codeableConceptHasCode(r.clinicalStatus, "active")) return false;
	if (codeableConceptHasCode(r?.verificationStatus, "refuted")) return false;
	if (codeableConceptHasCode(r?.verificationStatus, "entered-in-error")) return false;
	return true;
}

export type MyChartLabFlag = { id: string; category: "laboratory" | "vital-signs"; direction: "high" | "low" | "abnormal" };
export type MyChartRefillDue = { id: string; name?: string; dueDate?: string };
export type MyChartEntry = { id: string; docType?: string };
export type MyChartSummary = { patient?: string; labFlags: MyChartLabFlag[]; refillsDue: MyChartRefillDue[]; newConditions: MyChartEntry[]; newDocuments: MyChartEntry[] };

const REFILL_WINDOW_DAYS_DEFAULT = 14;
// A validityPeriod.end this far in the past is treated as stale data (a since-renewed
// or discontinued order Epic hasn't re-marked) rather than a live refill-due signal —
// avoids a perpetual once-ever "refill due" drop for an old MedicationRequest whose
// status field lags reality.
const REFILL_STALE_DAYS = 30;

/** One org's slice of summarizeMyChart, ids left bare (not org-prefixed) — the caller
 * decides whether prefixing is needed (only once 2+ orgs are in play, §below). */
async function summarizeOrgSnapshot(env: RtEnv, org: string, patient: string, refillWindowDays: number, now: Date): Promise<MyChartSummary> {
	const [labs, vitals, meds, conditions, documents] = await Promise.all([
		latestPulledResources(env, org, patient, "Observation.laboratory"),
		latestPulledResources(env, org, patient, "Observation.vital-signs"),
		latestPulledResources(env, org, patient, "MedicationRequest"),
		latestPulledResources(env, org, patient, "Condition"),
		latestPulledResources(env, org, patient, "DocumentReference"),
	]);

	const labFlags: MyChartLabFlag[] = [];
	for (const [category, resources] of [["laboratory", labs] as const, ["vital-signs", vitals] as const]) {
		for (const r of resources) {
			if (!r?.id) continue;
			const direction = interpretationDirection(r);
			if (direction) labFlags.push({ id: String(r.id), category, direction });
		}
	}

	const refillsDue: MyChartRefillDue[] = [];
	for (const r of meds) {
		if (!r?.id || r?.status !== "active") continue;
		const end = r?.dispenseRequest?.validityPeriod?.end;
		if (typeof end !== "string" || !end) continue;
		const endDate = new Date(end);
		if (Number.isNaN(endDate.getTime())) continue;
		const daysUntil = Math.round((endDate.getTime() - now.getTime()) / 86_400_000);
		if (daysUntil <= refillWindowDays && daysUntil >= -REFILL_STALE_DAYS) {
			refillsDue.push({ id: String(r.id), name: codeableConceptText(r.medicationCodeableConcept), dueDate: end.slice(0, 10) });
		}
	}

	const newConditions: MyChartEntry[] = conditions.filter((r) => r?.id).map((r) => ({ id: String(r.id) }));
	const newDocuments: MyChartEntry[] = documents.filter((r) => r?.id).map((r) => ({ id: String(r.id), docType: codeableConceptText(r.type) }));

	return { patient, labFlags, refillsDue, newConditions, newDocuments };
}

/** Summarize the LAST pulled FHIR snapshot(s) into a REDACTED, agenda-ready form (W6) —
 * never raw lab values or diagnosis names, only enough to prompt "go check MyChart":
 * out-of-range lab/vital flags (direction only, no value/test name), medication
 * refill-due windows (name + due date — the same sensitivity level the mail-based
 * rx_ready cue in fns/_agenda.ts already surfaces from pharmacy email subjects), and
 * bare ids for new Condition/DocumentReference entries (DocumentReference keeps only
 * its generic type, e.g. "After Visit Summary" — never a Condition's diagnosis name).
 * "New" here just means "present in this pass" — detectMyChartDrops's caller dedupes
 * by resource id via the agenda proposal ledger, which is what turns this into a
 * one-time-ever notification without this function needing its own pull-to-pull
 * cursor. `opts.org` scopes to one org; omitted fans across every CONNECTED org and
 * merges. With exactly one org contributing, ids stay bare (preserves every existing
 * single-org ledger dedupe key — no migration flood the moment a second org connects
 * elsewhere in the registry). With 2+ orgs contributing, each id is prefixed
 * `${org}:` so two orgs' independently-assigned FHIR ids can never collide in the
 * dedupe ledger. Returns null when unconfigured or no org in scope has ever pulled. */
export async function summarizeMyChart(env: RtEnv, opts?: { org?: string; refillWindowDays?: number; now?: string }): Promise<MyChartSummary | null> {
	if (!mychartConfigured(env)) return null;
	const orgs = opts?.org ? (isKnownOrg(opts.org) ? [opts.org] : []) : await connectedOrgs(env);
	if (!orgs.length) return null;
	const refillWindowDays = opts?.refillWindowDays ?? REFILL_WINDOW_DAYS_DEFAULT;
	const now = opts?.now ? new Date(`${opts.now}T00:00:00Z`) : new Date();

	const perOrg = await Promise.all(
		orgs.map(async (org) => {
			const grant = await readGrant(env, org);
			if (!grant?.patient) return null;
			if (!(await hasEverPulled(env, org, grant.patient))) return null;
			return { org, snapshot: await summarizeOrgSnapshot(env, org, grant.patient, refillWindowDays, now) };
		}),
	);
	const contributing = perOrg.filter((v): v is { org: string; snapshot: MyChartSummary } => v !== null);
	if (!contributing.length) return null;
	if (contributing.length === 1) return contributing[0].snapshot;

	const prefixId = <T extends { id: string }>(org: string, items: T[]): T[] => items.map((it) => ({ ...it, id: `${org}:${it.id}` }));
	return {
		labFlags: contributing.flatMap(({ org, snapshot }) => prefixId(org, snapshot.labFlags)),
		refillsDue: contributing.flatMap(({ org, snapshot }) => prefixId(org, snapshot.refillsDue)),
		newConditions: contributing.flatMap(({ org, snapshot }) => prefixId(org, snapshot.newConditions)),
		newDocuments: contributing.flatMap(({ org, snapshot }) => prefixId(org, snapshot.newDocuments)),
	};
}

/** `org`'s display name from the registry, or the bare id if somehow unregistered
 * (defensive only — every caller here already validated the org). */
export function orgLabel(org: string): string {
	return MYCHART_ORGS[org]?.name ?? org;
}

// ---------------- cross-org reconciliation (#1005) ----------------

export type MyChartConflict = { medOrg: string; medId: string; medName: string; allergyOrg: string; allergyId: string; allergySubstance: string };

// Generic pharma filler words that would otherwise trip a false "overlap" between two
// unrelated substances (e.g. "Aspirin 81mg oral tablet" vs "Penicillin oral suspension"
// sharing only "oral") — excluded from the significant-word comparison below.
const SUBSTANCE_STOPWORDS = new Set([
	"tablet",
	"tablets",
	"capsule",
	"capsules",
	"oral",
	"injection",
	"solution",
	"cream",
	"ointment",
	"daily",
	"twice",
	"extended",
	"release",
	"delayed",
	"chewable",
	"suspension",
	"patch",
	"dose",
	"spray",
	"drops",
	"gel",
	"mg",
	"ml",
	"vitamin",
	"sodium",
	"potassium",
	"calcium",
	"acid",
	"complex",
	"extra",
	"strength",
	"plus",
	"hcl",
	"hydrochloride",
	"generic",
	"brand",
]);

function normalizeSubstance(s: string): string {
	return s
		.toLowerCase()
		.replace(/(\d)([a-z])/g, "$1 $2")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Conservative, non-diagnostic substance-string overlap: true when a significant
 * (4+ char, non-filler) word is shared between a medication's name and an allergy's
 * substance text, or one normalized string contains the other outright. This is a
 * TEXT match only — it says nothing about clinical significance, dosage, or route; the
 * caller (detectMychartConflictDrops) always phrases a hit as "may overlap — verify
 * with your provider", never a diagnostic claim. */
export function substancesOverlap(medName: string, allergySubstance: string): boolean {
	const med = normalizeSubstance(medName);
	const allergy = normalizeSubstance(allergySubstance);
	if (!med || !allergy) return false;
	const containsWholeWord = (haystack: string, needle: string) => {
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`\\b${escaped}\\b`).test(haystack);
	};
	if (containsWholeWord(med, allergy) || containsWholeWord(allergy, med)) return true;
	const isSignificant = (w: string) => w.length >= 4 && !SUBSTANCE_STOPWORDS.has(w) && !/^\d+$/.test(w);
	const medWords = new Set(med.split(" ").filter(isSignificant));
	return allergy.split(" ").some((w) => isSignificant(w) && medWords.has(w));
}

type OrgMedAllergySet = {
	org: string;
	meds: Array<{ id: string; name: string }>;
	allergies: Array<{ id: string; substance: string }>;
	allAllergies: Array<{ id: string; substance: string }>;
	allergiesPulled: boolean;
};

/** Every connected, ever-pulled org's ACTIVE medications + allergies, shared by
 * crossOrgMedicationAllergyConflicts and crossOrgAllergyGaps so the two cross-org checks
 * (med↔allergy overlap, and allergy↔allergy set-difference) don't each re-derive the same
 * per-org R2 reads independently. [] when unconfigured or fewer than 2 orgs have ever pulled —
 * both checks are meaningless with a single chart. */
async function gatherContributingMedsAndAllergies(env: RtEnv): Promise<OrgMedAllergySet[]> {
	if (!mychartConfigured(env)) return [];
	const orgs = await connectedOrgs(env);
	if (orgs.length < 2) return [];

	const perOrg = await Promise.all(
		orgs.map(async (org) => {
			const grant = await readGrant(env, org);
			if (!grant?.patient) return null;
			if (!(await hasEverPulled(env, org, grant.patient))) return null;
			const [meds, allergies, allergiesPulled] = await Promise.all([
				latestPulledResources(env, org, grant.patient, "MedicationRequest"),
				latestPulledResources(env, org, grant.patient, "AllergyIntolerance"),
				hasPulledLabel(env, org, grant.patient, "AllergyIntolerance"),
			]);
			const activeMeds = meds
				.filter((r) => r?.id && r?.status === "active")
				.map((r) => ({ id: String(r.id), name: codeableConceptText(r.medicationCodeableConcept) }))
				.filter((m): m is { id: string; name: string } => Boolean(m.name));
			const toAllergyList = (records: any[]) =>
				records
					.filter((r) => r?.id)
					.map((r) => ({ id: String(r.id), substance: codeableConceptText(r.code) }))
					.filter((a): a is { id: string; substance: string } => Boolean(a.substance));
			const activeAllergies = toAllergyList(allergies.filter((r) => isAllergyActive(r)));
			// #1057 widened this to also count inactive/resolved records as "org B has some
			// record of it" — but "refuted"/"entered-in-error" is the OPPOSITE signal (org B
			// affirmatively determined the patient is NOT allergic), not a weaker positive, so
			// those must still be excluded here same as the active set (#1084).
			const allAllergies = toAllergyList(
				allergies.filter((r) => !codeableConceptHasCode(r?.verificationStatus, "refuted") && !codeableConceptHasCode(r?.verificationStatus, "entered-in-error")),
			);
			return { org, meds: activeMeds, allergies: activeAllergies, allAllergies, allergiesPulled };
		}),
	);
	return perOrg.filter((v): v is OrgMedAllergySet => v !== null);
}

/** Cross-org drug/allergy continuity check (#1005): summarizeMyChart already fans out
 * across every connected org, but stops at concatenation — org A's data is never compared
 * against org B's. This closes the real continuity-of-care gap: org B's specialist has no
 * idea org A's PCP started a medication, and neither org's chart necessarily carries the
 * other's allergy list. Compares every connected org's ACTIVE medications against every
 * OTHER connected org's allergy list for a name/substance-string overlap only — never
 * anything diagnostic (dosage, interaction severity, route). Same-org pairs are skipped: a
 * same-org prescription against a known allergy is exactly what that org's own ordering
 * system's interaction check already guards against; the gap here is specifically the
 * blind spot ACROSS orgs. Only orgs that have ever pulled contribute (mirrors
 * summarizeMyChart's hasEverPulled gate). [] when unconfigured or fewer than 2 orgs
 * contribute — reconciliation is meaningless with a single chart. */
export async function crossOrgMedicationAllergyConflicts(env: RtEnv): Promise<MyChartConflict[]> {
	const contributing = await gatherContributingMedsAndAllergies(env);
	if (contributing.length < 2) return [];

	const conflicts: MyChartConflict[] = [];
	for (const medSide of contributing) {
		for (const allergySide of contributing) {
			if (medSide.org === allergySide.org) continue;
			for (const med of medSide.meds) {
				for (const allergy of allergySide.allergies) {
					if (substancesOverlap(med.name, allergy.substance)) {
						conflicts.push({ medOrg: medSide.org, medId: med.id, medName: med.name, allergyOrg: allergySide.org, allergyId: allergy.id, allergySubstance: allergy.substance });
					}
				}
			}
		}
	}
	return conflicts;
}

export type MyChartAllergyGap = { org: string; allergyId: string; allergySubstance: string; missingOrg: string };

/** Cross-org allergy-continuity gap (#1009): a distinct, likely higher-value sibling of
 * crossOrgMedicationAllergyConflicts's med↔allergy overlap check — this instead asks "does org
 * B's OWN allergy list have anything matching org A's allergy at all?" A hit means org B's chart
 * carries NO record whatsoever of an allergy org A has on file, e.g. a provider at org B could
 * prescribe without ever seeing it — the "neither knows the other's allergy list" gap #1005's
 * own issue text named but deliberately left out of that first cut. Same conservative
 * substancesOverlap text match (never anything diagnostic), same contributing-orgs gate (2+
 * pulled orgs) as crossOrgMedicationAllergyConflicts. [] when unconfigured or fewer than 2 orgs
 * contribute. */
export async function crossOrgAllergyGaps(env: RtEnv): Promise<MyChartAllergyGap[]> {
	const contributing = await gatherContributingMedsAndAllergies(env);
	if (contributing.length < 2) return [];

	const gaps: MyChartAllergyGap[] = [];
	for (const source of contributing) {
		for (const allergy of source.allergies) {
			for (const other of contributing) {
				if (other.org === source.org) continue;
				// An org that never actually pulled AllergyIntolerance has an empty `allergies`
				// array indistinguishable from a confirmed-empty list — treat it as unknown, not
				// as a real gap (see hasPulledLabel's docstring).
				if (!other.allergiesPulled) continue;
				// Match against the OTHER org's full allergy list regardless of active status — an
				// inactive/resolved/entered-in-error record there still means org B has SOME record of
				// it (#1057), unlike crossOrgMedicationAllergyConflicts's active-only med↔allergy check.
				const knownAtOther = other.allAllergies.some((a) => substancesOverlap(a.substance, allergy.substance));
				if (!knownAtOther) gaps.push({ org: source.org, allergyId: allergy.id, allergySubstance: allergy.substance, missingOrg: other.org });
			}
		}
	}
	return gaps;
}

/** Resolve a DocumentReference's Binary attachments (content[].attachment.url →
 * Binary/{id}). Returns the raw fetched bodies keyed by Binary id. Skips non-Binary
 * or off-base attachment URLs. */
async function resolveBinaries(env: RtEnv, org: string, base: string, doc: any): Promise<Array<{ id: string; body: string }>> {
	const out: Array<{ id: string; body: string }> = [];
	const contents: any[] = Array.isArray(doc?.content) ? doc.content : [];
	for (const c of contents) {
		const attUrl = c?.attachment?.url;
		if (typeof attUrl !== "string" || !attUrl) continue;
		const m = /Binary\/([A-Za-z0-9\-.]+)$/.exec(attUrl);
		if (!m) continue;
		const abs = /^https?:\/\//i.test(attUrl) ? attUrl : `${base}/Binary/${m[1]}`;
		if (!isUnderFhirBase(org, abs)) continue;
		const resp = await mychartFetch(env, org, abs);
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
 * the path isn't ours. `/connect` is Bearer-gated by the operator SUX_CRON_TOKEN
 * (matching /admin/tick and /apple-health, §2.5 — a reused admin secret no longer
 * rides in the query string / Cloudflare access logs) so a stranger can't bind THEIR
 * MyChart to the Worker, and takes `?org=<id>` naming which registry org to connect. */
export async function handleMychartRoutes(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;

	if (url.pathname === "/mychart/connect") {
		if (!mychartConfigured(env)) return new Response("MyChart not configured.", { status: 404 });
		const gate = env.SUX_CRON_TOKEN;
		if (!gate) return new Response("not found", { status: 404 });
		const authHeader = request.headers.get("authorization") ?? "";
		const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
		if (!presented || !timingSafeEqual(gate, presented)) return new Response("unauthorized", { status: 401 });
		const org = url.searchParams.get("org") ?? "";
		if (!org || !isKnownOrg(org)) return new Response("unknown org", { status: 404 });
		try {
			const cfg = await smartConfig(env, org);
			const verifier = makeVerifier();
			const challenge = await challengeFor(verifier);
			const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
			await env.OAUTH_KV?.put(pkceKey(state), JSON.stringify({ verifier, org, created: Date.now() }), { expirationTtl: PKCE_TTL_S });
			const auth = new URL(cfg.authorization_endpoint);
			auth.searchParams.set("response_type", "code");
			auth.searchParams.set("client_id", String(env.EPIC_CLIENT_ID));
			auth.searchParams.set("redirect_uri", redirectUri(env));
			auth.searchParams.set("scope", DEFAULT_SCOPES);
			auth.searchParams.set("state", state);
			auth.searchParams.set("aud", fhirBase(org));
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
		let org = "";
		try {
			const parsed = JSON.parse(stored);
			verifier = parsed?.verifier ?? "";
			org = parsed?.org ?? "";
		} catch {}
		if (!verifier || !org || !isKnownOrg(org)) return new Response("Corrupt PKCE state.", { status: 400, headers: PAGE_HEADERS });
		try {
			const cfg = await smartConfig(env, org);
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
				await env.OAUTH_KV?.put(grantKey(org), JSON.stringify(grant));
			}
			await cacheAccessToken(env, org, String(json.access_token), json.expires_in);
			const hasRefresh = Boolean(json.refresh_token);
			const orgName = MYCHART_ORGS[org]?.name ?? org;
			return new Response(
				`<!doctype html><meta charset=utf-8><title>MyChart connected</title><body style="font-family:system-ui;padding:2rem"><h1>MyChart connected</h1><p>${escapeHtml(orgName)} — patient <code>${escapeHtml(String(json.patient ?? "(unknown)"))}</code> linked.${hasRefresh ? "" : " <strong>No refresh token was issued</strong> — pulls will need re-login (the org may not have provisioned offline_access)."}</p><p>You can close this tab. Run <code>mychart op:\"pull\" org:\"${escapeHtml(org)}\"</code> to sync.</p></body>`,
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

/** Cron helper (rides maintenanceTick beside refreshKrogerToken): keep every
 * CONNECTED org's refresh grant alive by minting a fresh access token, independently
 * per org — one org's failure must not starve another org's keep-alive on this tick.
 * No-op when unconfigured or no org is connected. Attempts every connected org before
 * surfacing anything; if any failed, throws an aggregate error so runSubJob's
 * heartbeat still records the tick as unhealthy (§5 "refreshMychartToken across
 * orgs" — each org gets its own attempt regardless of a sibling's outcome). */
export async function refreshMychartToken(env: RtEnv): Promise<void> {
	if (!mychartConfigured(env)) return;
	const orgs = await connectedOrgs(env);
	if (!orgs.length) return; // never connected — nothing to keep warm.
	const errors: string[] = [];
	for (const org of orgs) {
		// Short-circuit when a cached access token is still valid: minting on every tick
		// would force a needless refresh_token grant and risk a double-spend race with a
		// concurrent pull rotating the refresh token. Only mint when the cache is empty/expired.
		if (await env.OAUTH_KV?.get(accessTokenKey(org))) continue;
		try {
			await mintAccessToken(env, org);
		} catch (e) {
			errors.push(`${org}: ${(e as Error)?.message ?? e}`);
		}
	}
	if (errors.length) throw new Error(`mychart token refresh failed for ${errors.length} org(s): ${errors.join("; ")}`);
}
