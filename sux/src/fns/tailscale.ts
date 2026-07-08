import { type Fn, failWith, ok, type RtEnv } from "../registry";

// Tailscale API (api.tailscale.com/api/v2) — official REST control-plane read.
// Bearer auth with a personal access token (TAILSCALE_API_KEY); the tailnet is
// TAILSCALE_TAILNET, defaulting to "-" (the token's own default tailnet).
//
// This is DISTINCT from the TAILSCALE_PROXY_URL/TAILSCALE_PROXY_SECRET funnel
// secrets that drive sux egress — those move traffic, this reads the control
// plane (devices, DNS, auth keys). Read-only; never mutates and never returns
// key secrets.

const API = "https://api.tailscale.com/api/v2";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** GET an authed Tailscale endpoint, throwing a status-carrying error on failure. */
async function api(env: RtEnv, path: string): Promise<any> {
	const resp = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${env.TAILSCALE_API_KEY}`, Accept: "application/json" } });
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
		"Tailnet comes from TAILSCALE_TAILNET (default '-' = the token's tailnet). Needs TAILSCALE_API_KEY (a PAT from the admin console). Read-only. Returns JSON.",
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
		if (!env.TAILSCALE_API_KEY) return failWith("not_configured", "Tailscale API not configured (TAILSCALE_API_KEY). Create a personal access token in the Tailscale admin console.");

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
				return ok(JSON.stringify({ service: "tailscale", tailnet, action, count: items.length, items }, null, 2));
			}

			if (action === "dns") {
				const [ns, prefs] = await Promise.all([api(env, `/tailnet/${tn}/dns/nameservers`), api(env, `/tailnet/${tn}/dns/preferences`)]);
				const merged = { ...(ns ?? {}), ...(prefs ?? {}) };
				const items = [merged];
				return ok(JSON.stringify({ service: "tailscale", tailnet, action, count: items.length, items }, null, 2));
			}

			if (action === "keys") {
				const j = await api(env, `/tailnet/${tn}/keys`);
				const items = (Array.isArray(j?.keys) ? j.keys : []).map(normKey);
				return ok(JSON.stringify({ service: "tailscale", tailnet, action, count: items.length, items }, null, 2));
			}

			// action === "devices"
			const j = await api(env, `/tailnet/${tn}/devices`);
			const items = (Array.isArray(j?.devices) ? j.devices : []).map(normDevice);
			return ok(JSON.stringify({ service: "tailscale", tailnet, action, count: items.length, items }, null, 2));
		} catch (e) {
			return failWith("upstream_error", `tailscale (${action}) failed: ${errMsg(e)}`);
		}
	},
};
