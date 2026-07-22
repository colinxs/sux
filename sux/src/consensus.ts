// Consensus.app OAuth conduit — dynamic client registration, the PKCE
// authorization-code dance, token lifecycle, and the two public routes
// (/consensus/connect, /consensus/callback). A deliberately simpler sibling of
// src/mychart.ts's machinery: ONE org (consensus.app), a PUBLIC client
// (token_endpoint_auth_methods_supported: ["none"] — no client secret exists
// anywhere), and the client_id itself is minted at runtime via RFC 7591 dynamic
// registration (POST /oauth/register/) and persisted in KV — so there is no env
// secret to configure at all; "configured" simply means "a grant exists".
//
// Token lifecycle mirrors mychart: the long-lived refresh token lives in KV as
// the grant, short-lived access tokens are minted on demand via the
// refresh_token grant and KV-cached with TTL = expires_in - 60, and a rotated
// refresh_token in a refresh response is persisted back before the fresh access
// token is used.

import { challengeFor, escapeHtml, makeVerifier } from "./mychart";
import { timingSafeEqual } from "./crypto-util";
import type { RtEnv } from "./registry";
import { safeParseJson } from "./fns/_util";

// Live-verified 2026-07-22 (issue #1297): authorization server metadata at
// https://consensus.app/.well-known/... advertises these fixed endpoints, PKCE
// S256, grants authorization_code + refresh_token, and dynamic registration.
// Fixed constants (not discovery) because there is exactly one org — the
// mychart smartConfig() machinery exists only for Epic's per-org endpoints.
const AUTH_BASE = "https://consensus.app";
export const CONSENSUS_REGISTER_URL = `${AUTH_BASE}/oauth/register/`;
export const CONSENSUS_AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize/`;
export const CONSENSUS_TOKEN_URL = `${AUTH_BASE}/oauth/token/`;
export const CONSENSUS_MCP_URL = "https://mcp.consensus.app/mcp";
const SCOPE = "search";

const CLIENT_KEY = "sux:consensus:client";
const GRANT_KEY = "sux:consensus:grant";
const ACCESS_TOKEN_KEY = "sux:consensus:token";
const pkceKey = (state: string): string => `sux:consensus:pkce:${state}`;
const PKCE_TTL_S = 600; // 10 min — the interactive login must complete inside this.

export interface ConsensusGrant {
	refresh_token: string;
	scope?: string;
	issued_at: number;
}

/** Public base for the callback redirect URI — shares STORE_BASE with mychart's
 * redirectUri so a staging deploy points its callback at itself. Must match the
 * redirect_uri sent at dynamic registration exactly. */
export function consensusRedirectUri(env: RtEnv): string {
	const v = (env as { STORE_BASE?: string }).STORE_BASE;
	const base = (typeof v === "string" && v ? v : "https://suxos.net").replace(/\/+$/, "");
	return `${base}/consensus/callback`;
}

export async function readConsensusGrant(env: RtEnv): Promise<ConsensusGrant | null> {
	const raw = await env.OAUTH_KV?.get(GRANT_KEY);
	return safeParseJson<ConsensusGrant | null>(raw, null);
}

/** True once /consensus/callback has stored a refresh grant — the fn's
 * "configured" check (there are no env secrets; the grant IS the configuration). */
export async function consensusConnected(env: RtEnv): Promise<boolean> {
	return Boolean((await readConsensusGrant(env))?.refresh_token);
}

/** The registered public client_id, minting it via RFC 7591 dynamic registration
 * on first use and persisting it in KV. NOT a secret (public client) — KV rather
 * than an env secret so first use / a fresh deploy bootstraps itself. */
export async function ensureConsensusClient(env: RtEnv): Promise<string> {
	const cached = await env.OAUTH_KV?.get(CLIENT_KEY);
	const parsed = safeParseJson<{ client_id?: string } | null>(cached, null);
	if (parsed?.client_id) return parsed.client_id;
	const resp = await fetch(CONSENSUS_REGISTER_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_name: "sux",
			redirect_uris: [consensusRedirectUri(env)],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: SCOPE,
		}),
		signal: AbortSignal.timeout(20_000),
	});
	const j: any = await resp.json().catch(() => null);
	if (resp.status >= 400 || !j?.client_id) throw new Error(`Consensus client registration failed: HTTP ${resp.status}`);
	await env.OAUTH_KV?.put(CLIENT_KEY, JSON.stringify({ client_id: String(j.client_id), issued_at: Date.now() }));
	return String(j.client_id);
}

/** POST the token endpoint with a URL-encoded body. Public client ("none" auth
 * method): client_id rides in the body, NO Authorization header, no secret. */
async function tokenPost(body: Record<string, string>): Promise<{ status: number; json: any }> {
	const resp = await fetch(CONSENSUS_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(20_000),
	});
	return { status: resp.status, json: await resp.json().catch(() => null) };
}

async function cacheAccessToken(env: RtEnv, accessToken: string, expiresIn: unknown): Promise<void> {
	const ttl = Math.max(60, (Number(expiresIn) || 3600) - 60);
	await env.OAUTH_KV?.put(ACCESS_TOKEN_KEY, accessToken, { expirationTtl: ttl });
}

/** Drop the cached access token — the 401 self-heal's first step (mirrors
 * mychartFetch's cache-drop + single re-mint). */
export async function dropCachedConsensusToken(env: RtEnv): Promise<void> {
	await env.OAUTH_KV?.delete(ACCESS_TOKEN_KEY).catch(() => {});
}

/** Mint an access token from the stored refresh grant, persisting any rotated
 * refresh_token back to the grant before returning. Throws a caller-friendly
 * not-connected message when no grant exists. */
export async function mintConsensusAccessToken(env: RtEnv): Promise<string> {
	const grant = await readConsensusGrant(env);
	if (!grant?.refresh_token) throw new Error("Consensus not connected — no grant in KV. Open /consensus/connect once to link the account.");
	const clientId = await ensureConsensusClient(env);
	const { status, json } = await tokenPost({
		grant_type: "refresh_token",
		refresh_token: grant.refresh_token,
		client_id: clientId,
	});
	if (status >= 400 || !json?.access_token) {
		// Status + the OAuth error *code* only (a short enum like invalid_grant), never
		// error_description free-text — this string surfaces as the call's `err` into logs.
		const code = typeof json?.error === "string" ? json.error.replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 40) : "no_access_token";
		throw new Error(`Consensus token refresh HTTP ${status} (${code})`);
	}
	if (typeof json.refresh_token === "string" && json.refresh_token && json.refresh_token !== grant.refresh_token) {
		const updated: ConsensusGrant = { ...grant, refresh_token: json.refresh_token, issued_at: Date.now(), scope: json.scope ?? grant.scope };
		await env.OAUTH_KV?.put(GRANT_KEY, JSON.stringify(updated));
	}
	await cacheAccessToken(env, String(json.access_token), json.expires_in);
	return String(json.access_token);
}

/** Resolve a bearer: KV-cached access token, else a fresh mint from the grant. */
export async function consensusAccessToken(env: RtEnv): Promise<string> {
	const cached = await env.OAUTH_KV?.get(ACCESS_TOKEN_KEY);
	if (cached) return cached;
	return mintConsensusAccessToken(env);
}

const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
// Same reflected-XSS discipline as mychart's routes: anything interpolating
// caller-/upstream-supplied values is text/plain; only the fixed success page is HTML.
const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

/** GET /consensus/connect + GET /consensus/callback. Served BEFORE the
 * OAuthProvider claims every path (same pre-gate trick as /mychart/*). `/connect`
 * is Bearer-gated by the operator SUX_CRON_TOKEN exactly like /mychart/connect so
 * a stranger can't bind THEIR Consensus account to the Worker. Returns null when
 * the path isn't ours. */
export async function handleConsensusRoutes(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;

	if (url.pathname === "/consensus/connect") {
		const gate = env.SUX_CRON_TOKEN;
		if (!gate) return new Response("not found", { status: 404 });
		const authHeader = request.headers.get("authorization") ?? "";
		const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
		if (!presented || !timingSafeEqual(gate, presented)) return new Response("unauthorized", { status: 401 });
		try {
			const clientId = await ensureConsensusClient(env);
			const verifier = makeVerifier();
			const challenge = await challengeFor(verifier);
			const state = makeVerifier().slice(0, 32);
			await env.OAUTH_KV?.put(pkceKey(state), JSON.stringify({ verifier, created: Date.now() }), { expirationTtl: PKCE_TTL_S });
			const auth = new URL(CONSENSUS_AUTHORIZE_URL);
			auth.searchParams.set("response_type", "code");
			auth.searchParams.set("client_id", clientId);
			auth.searchParams.set("redirect_uri", consensusRedirectUri(env));
			auth.searchParams.set("scope", SCOPE);
			auth.searchParams.set("state", state);
			auth.searchParams.set("code_challenge", challenge);
			auth.searchParams.set("code_challenge_method", "S256");
			return new Response(null, { status: 302, headers: { location: auth.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
		} catch (e) {
			return new Response(escapeHtml(String((e as Error)?.message ?? e)), { status: 502, headers: TEXT_HEADERS });
		}
	}

	if (url.pathname === "/consensus/callback") {
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? "";
		const err = url.searchParams.get("error");
		if (err) return new Response(`Consensus authorization error: ${err}`, { status: 400, headers: TEXT_HEADERS });
		if (!code || !state) return new Response("Missing code/state.", { status: 400, headers: TEXT_HEADERS });
		const stored = await env.OAUTH_KV?.get(pkceKey(state));
		if (!stored) return new Response("Invalid or expired state (CSRF check failed).", { status: 400, headers: TEXT_HEADERS });
		await env.OAUTH_KV?.delete(pkceKey(state)).catch(() => {}); // one-time.
		const verifier = safeParseJson<{ verifier?: string } | null>(stored, null)?.verifier ?? "";
		if (!verifier) return new Response("Corrupt PKCE state.", { status: 400, headers: TEXT_HEADERS });
		try {
			const clientId = await ensureConsensusClient(env);
			const { status, json } = await tokenPost({
				grant_type: "authorization_code",
				code,
				redirect_uri: consensusRedirectUri(env),
				code_verifier: verifier,
				client_id: clientId,
			});
			if (status >= 400 || !json?.access_token) {
				return new Response(`Token exchange failed: HTTP ${status} ${json?.error_description ?? json?.error ?? ""}`.trim(), { status: 502, headers: TEXT_HEADERS });
			}
			if (typeof json.refresh_token === "string" && json.refresh_token) {
				const grant: ConsensusGrant = { refresh_token: json.refresh_token, scope: json.scope, issued_at: Date.now() };
				await env.OAUTH_KV?.put(GRANT_KEY, JSON.stringify(grant));
			}
			await cacheAccessToken(env, String(json.access_token), json.expires_in);
			const hasRefresh = Boolean(json.refresh_token);
			return new Response(
				`<!doctype html><meta charset=utf-8><title>Consensus connected</title><body style="font-family:system-ui;padding:2rem"><h1>Consensus connected</h1><p>Academic search is live.${hasRefresh ? "" : " <strong>No refresh token was issued</strong> — searches will stop working when this access token expires (re-open /consensus/connect)."}</p><p>You can close this tab. Try <code>consensus query:"..."</code>.</p></body>`,
				{ status: 200, headers: PAGE_HEADERS },
			);
		} catch (e) {
			return new Response(`Consensus callback failed: ${escapeHtml(String((e as Error)?.message ?? e))}`, { status: 502, headers: TEXT_HEADERS });
		}
	}

	return null;
}
