import { type Fn, failWith, ok, type RtEnv } from "../registry";

// ControlD API (api.controld.com) — official, clean REST behind a single Bearer
// token. Read-only surface: list DNS profiles, the devices bound to them, and a
// profile's custom rules. ControlD wraps every response in `{ success, body: {…} }`,
// so we dig the useful array out of `body` defensively (the field name differs per
// endpoint) and normalize each record to the ids/names/status a caller actually wants.

const API = "https://api.controld.com";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

async function api(env: RtEnv, path: string): Promise<any> {
	const resp = await fetch(`${API}${path}`, {
		headers: { Authorization: `Bearer ${env.CONTROLD_API_TOKEN}`, Accept: "application/json" },
	});
	if (!resp.ok) throw new Error(`ControlD API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

/**
 * Dig the record array out of a ControlD response. Real payloads look like
 * `{ body: { profiles: [...] } }` / `{ body: { devices: [...] } }` /
 * `{ body: { rules: [...] } }`, but we stay tolerant of the array living directly
 * on `body`, at the top level, or under a differently-named key.
 */
function extractItems(j: any, key: string): any[] {
	const body = j?.body ?? j;
	if (Array.isArray(body?.[key])) return body[key];
	if (Array.isArray(body)) return body;
	if (Array.isArray(j?.[key])) return j[key];
	// Last resort: first array-valued property on the body object.
	if (body && typeof body === "object") {
		for (const v of Object.values(body)) if (Array.isArray(v)) return v as any[];
	}
	return [];
}

function normProfile(d: any): Record<string, unknown> {
	return {
		id: d?.PK ?? d?.pk ?? d?.id,
		name: d?.name,
		updated: d?.updated,
	};
}

function normDevice(d: any): Record<string, unknown> {
	return {
		id: d?.PK ?? d?.pk ?? d?.device_id ?? d?.id,
		name: d?.name,
		profile_id: d?.profile?.PK ?? d?.profile_id ?? d?.profile,
		status: d?.status,
		last_activity: d?.last_activity,
	};
}

function normRule(d: any): Record<string, unknown> {
	return {
		id: d?.PK ?? d?.pk ?? d?.hostname ?? d?.id,
		hostname: d?.PK ?? d?.hostname,
		action: d?.action?.do ?? d?.action?.status ?? d?.action,
		group: d?.group,
		comment: d?.comment,
	};
}

/** Map each record with a per-item guard so one malformed entry can't sink the set. */
function normAll(items: any[], fn: (d: any) => Record<string, unknown>): Record<string, unknown>[] {
	return items
		.map((d) => {
			try {
				return fn(d);
			} catch {
				return null;
			}
		})
		.filter((r): r is Record<string, unknown> => r !== null);
}

export const controld: Fn = {
	name: "controld",
	description:
		"ControlD API (official) — read-only view of your ControlD DNS setup. " +
		"`action`: profiles (all DNS profiles), devices (devices/endpoints bound to profiles), rules (custom rules for a profile — needs `profile_id`). " +
		"Needs CONTROLD_API_TOKEN (dashboard → Preferences → API). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["profiles", "devices", "rules"], default: "profiles" },
			profile_id: { type: "string", description: "Profile id (required for action=rules)." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		if (!env.CONTROLD_API_TOKEN)
			return failWith("not_configured", "ControlD API not configured (CONTROLD_API_TOKEN). Get a token in the ControlD dashboard under Preferences → API.");

		const action = String(args?.action ?? "profiles");

		try {
			if (action === "devices") {
				const j = await api(env, "/devices");
				const items = normAll(extractItems(j, "devices"), normDevice);
				return ok(JSON.stringify({ service: "controld", action, count: items.length, items }, null, 2));
			}

			if (action === "rules") {
				const pid = String(args?.profile_id ?? "").trim();
				if (!pid) return failWith("bad_input", "action=rules requires a `profile_id`.");
				const j = await api(env, `/profiles/${encodeURIComponent(pid)}/rules`);
				const items = normAll(extractItems(j, "rules"), normRule);
				return ok(JSON.stringify({ service: "controld", action, profile_id: pid, count: items.length, items }, null, 2));
			}

			// action === "profiles"
			const j = await api(env, "/profiles");
			const items = normAll(extractItems(j, "profiles"), normProfile);
			return ok(JSON.stringify({ service: "controld", action, count: items.length, items }, null, 2));
		} catch (e) {
			return failWith("upstream_error", `controld (${action}) failed: ${errMsg(e)}`);
		}
	},
};
