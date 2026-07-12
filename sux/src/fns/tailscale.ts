import { getClientToken, mintClientToken, type OAuthClientCreds } from "./_oauth";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";

// Tailscale API (api.tailscale.com/api/v2) — official REST control-plane read.
// Auth is OAuth2 client-credentials (TAILSCALE_OAUTH_CLIENT_ID/SECRET); the
// bearer token is minted once and cached in KV (env.OAUTH_KV) until just before
// it expires, so we never re-mint per call. Tailscale recommends OAuth clients
// over personal access tokens (which expire in ≤90 days). The tailnet is
// TAILSCALE_TAILNET, defaulting to "-" (the client's own default tailnet).
//
// This is DISTINCT from the TAILSCALE_PROXY_URL/TAILSCALE_PROXY_SECRET funnel
// secrets that drive sux egress — those move traffic, this reads the control
// plane (devices, DNS, auth keys). Read-only; never mutates and never returns
// key secrets.

const API = "https://api.tailscale.com/api/v2";
const TOKEN_KEY = "sux:tailscale:token";
// Tailscale wants client_id/secret in the body (not HTTP Basic) and sends no scope.
const oauth = (env: RtEnv): OAuthClientCreds => ({
	tokenUrl: `${API}/oauth/token`,
	clientId: String(env.TAILSCALE_OAUTH_CLIENT_ID ?? ""),
	clientSecret: String(env.TAILSCALE_OAUTH_CLIENT_SECRET ?? ""),
	cacheKey: TOKEN_KEY,
	auth: "body",
	defaultTtl: 3600,
});

/**
 * GET an authed Tailscale endpoint, throwing a status-carrying error on failure.
 * Self-heals a revoked/rejected token: on a 401/403 it drops the cached token,
 * re-mints once, and retries — so a token invalidated before its TTL recovers
 * without waiting out the cache. The retry mints directly (not via getClientToken)
 * so KV read-after-delete eventual consistency can't hand back the rejected token.
 */
async function api(env: RtEnv, path: string): Promise<any> {
	const get = (token: string) => fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
	let resp = await get(await getClientToken(env, oauth(env)));
	if (resp.status === 401 || resp.status === 403) {
		await env.OAUTH_KV.delete(TOKEN_KEY);
		resp = await get(await mintClientToken(env, oauth(env)));
	}
	if (!resp.ok) throw new Error(`Tailscale API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

/** Normalize a device record to the stable, non-sensitive subset sux surfaces. */
function normDevice(d: any): Record<string, unknown> {
	return {
		id: d?.id,
		name: d?.name,
		hostname: d?.hostname,
		addresses: Array.isArray(d?.addresses) ? d.addresses : undefined,
		os: d?.os,
		clientVersion: d?.clientVersion,
		lastSeen: d?.lastSeen,
		online: typeof d?.online === "boolean" ? d.online : undefined,
		tags: Array.isArray(d?.tags) ? d.tags : undefined,
	};
}

/**
 * Normalize an auth-key record to id + capabilities ONLY. The one-time key secret
 * (the `key` field, present only at creation) is never echoed — we allowlist the
 * safe metadata fields rather than passing the record through.
 */
function normKey(d: any): Record<string, unknown> {
	return {
		id: d?.id,
		description: d?.description,
		created: d?.created,
		expires: d?.expires,
		revoked: d?.revoked,
		capabilities: d?.capabilities,
	};
}

export const tailscale: Fn = {
	name: "tailscale",
	description:
		"Tailscale API (official) — read your tailnet's control plane. " +
		"`action`: devices (all machines: name, hostname, addresses, os, version, lastSeen, online, tags), " +
		"device (one machine by device_id), dns (nameservers + preferences), keys (auth-key ids + capabilities, never secrets). " +
		"Tailnet comes from TAILSCALE_TAILNET (default '-' = the client's tailnet). Needs TAILSCALE_OAUTH_CLIENT_ID/TAILSCALE_OAUTH_CLIENT_SECRET (an OAuth client with read scopes from the admin console). Read-only. Returns JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["devices", "device", "dns", "keys"], default: "devices" },
			device_id: { type: "string", description: "Device id (action=device)." },
		},
	},
	cacheable: true,
	ttl: 120,
	run: async (env, args) => {
		if (!env.TAILSCALE_OAUTH_CLIENT_ID || !env.TAILSCALE_OAUTH_CLIENT_SECRET)
			return failWith("not_configured", "Tailscale API not configured (TAILSCALE_OAUTH_CLIENT_ID / TAILSCALE_OAUTH_CLIENT_SECRET). Create an OAuth client in the admin console with read scopes.");

		const action = String(args?.action ?? "devices");
		const tailnet = String(env.TAILSCALE_TAILNET ?? "-").trim() || "-";
		const tn = encodeURIComponent(tailnet);

		try {
			if (action === "device") {
				const id = String(args?.device_id ?? "").trim();
				if (!id) return failWith("bad_input", "action=device requires a `device_id`.");
				const d = await api(env, `/device/${encodeURIComponent(id)}`);
				if (!d || d?.id === undefined) return failWith("not_found", `No Tailscale device found for '${id}'.`);
				const items = [normDevice(d)];
				return ok(oj({ service: "tailscale", tailnet, action, count: items.length, items }));
			}

			if (action === "dns") {
				const [ns, prefs] = await Promise.all([api(env, `/tailnet/${tn}/dns/nameservers`), api(env, `/tailnet/${tn}/dns/preferences`)]);
				const merged = { ...(ns ?? {}), ...(prefs ?? {}) };
				const items = [merged];
				return ok(oj({ service: "tailscale", tailnet, action, count: items.length, items }));
			}

			if (action === "keys") {
				const j = await api(env, `/tailnet/${tn}/keys`);
				const items = (Array.isArray(j?.keys) ? j.keys : []).map(normKey);
				return ok(oj({ service: "tailscale", tailnet, action, count: items.length, items }));
			}

			// action === "devices"
			const j = await api(env, `/tailnet/${tn}/devices`);
			const items = (Array.isArray(j?.devices) ? j.devices : []).map(normDevice);
			return ok(oj({ service: "tailscale", tailnet, action, count: items.length, items }));
		} catch (e) {
			return failWith("upstream_error", `tailscale (${action}) failed: ${errMsg(e)}`);
		}
	},
};
