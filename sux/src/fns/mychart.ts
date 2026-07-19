import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";
import { MYCHART_ORGS, mychartConfigured, mychartFetch, pull, readGrant, redirectUri, resolveFhirPath, resolveOrg } from "../mychart";

// MyChart — Epic SMART-on-FHIR clinical records, read-only. The interactive OAuth
// dance lives on the public /mychart/connect + /mychart/callback routes (src/mychart.ts);
// this fn is the headless surface over the resulting refresh grant. Design + PHI
// invariants: docs/proposals/mychart.md (§2b, §5).
//
// cacheable:false + raw:true is LOAD-BEARING, not cosmetic: `pull`/`get` return PHI
// (lab results, notes, conditions), which must NEVER enter the shared KV result cache.
// The only cached token is the opaque, short-lived access token in OAUTH_KV.
//
// Inert until EPIC_CLIENT_ID / EPIC_CLIENT_SECRET are set (like monarch/dropbox);
// `status` still answers so an operator can see it's unconfigured. Multi-org (§2/§2.4):
// the org set lives in mychart.ts's MYCHART_ORGS registry, not env — connect/pull/get
// take an `org` arg, defaulting to the sole CONNECTED org when omitted and unambiguous.

const ORG_IDS = Object.keys(MYCHART_ORGS);
const NOT_CONFIGURED =
	"MyChart not configured. Set EPIC_CLIENT_ID and EPIC_CLIENT_SECRET " +
	"(one confidential client authenticates against every registry org via Epic's Automatic " +
	"Client-ID Distribution). Then open /mychart/connect?org=<id> once per org to link the account. Read-only.";

export const mychart: Fn = {
	name: "mychart",
	cost: 3,
	cacheable: false,
	raw: true,
	annotations: { readOnlyHint: true, openWorldHint: true },
	description:
		"MyChart — READ-ONLY Epic clinical records over SMART-on-FHIR (labs, vitals, conditions, meds, allergies, immunizations, procedures, notes) across multiple health systems. Ops: " +
		"status (no org — grant presence/patient id/scopes/refresh-token age for EVERY registry org, NEVER returns token material) | " +
		"connect ({org?} — returns the /mychart/connect URL to open in a browser — the fn can't do the interactive login itself) | " +
		"pull ({org?, types?:[...], since?:'YYYY-MM-DD'} — sync: pages the USCDI resource set for one org, resolves DocumentReference→Binary notes, writes raw FHIR to private R2; returns per-type COUNTS only, never values) | " +
		"get ({org?, path:'Observation?category=vital-signs&date=ge2026-06-01'} — read-only FHIR passthrough against one org, path-validated against its FHIR base). " +
		`\`org\` is one of: ${ORG_IDS.join(", ")} — omit it when exactly one org is connected (defaults to it), otherwise required. ` +
		"PHI never enters the response cache or public share links. " +
		"Needs EPIC_CLIENT_ID/EPIC_CLIENT_SECRET + a one-time /mychart/connect?org=<id> login per org; absent → not_configured.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["op"],
		properties: {
			op: { type: "string", enum: ["status", "connect", "pull", "get"] },
			org: { type: "string", enum: ORG_IDS, description: "connect/pull/get: which registry org. Omit when exactly one org is connected." },
			types: { type: "array", items: { type: "string" }, description: "pull: narrow to these FHIR resource types (default the full USCDI set)." },
			since: { type: "string", description: "pull: only resources updated on/after this date (YYYY-MM-DD), where the org honors _lastUpdated." },
			path: { type: "string", description: "get: a FHIR search/read path relative to the FHIR base (e.g. `Observation?category=laboratory`). Read-only GET; validated to stay under the base." },
		},
	},
	run: async (env: RtEnv, a: any) => {
		const op = String(a?.op ?? "");

		// status answers even when unconfigured (it's the "why isn't this working" probe).
		if (op === "status") {
			const configured = mychartConfigured(env);
			const orgs = await Promise.all(
				ORG_IDS.map(async (org) => {
					const grant = configured ? await readGrant(env, org) : null;
					return {
						org,
						name: MYCHART_ORGS[org].name,
						fhirBase: MYCHART_ORGS[org].fhirBase,
						connected: Boolean(grant),
						patient: grant?.patient,
						scopes: grant?.scope,
						refreshTokenAgeSeconds: grant?.issued_at ? Math.max(0, Math.floor((Date.now() - grant.issued_at) / 1000)) : undefined,
					};
				}),
			);
			return ok(oj({ configured, orgs }));
		}

		if (!mychartConfigured(env)) return failWith("not_configured", NOT_CONFIGURED);

		try {
			if (op === "connect") {
				const resolved = await resolveOrg(env, a?.org);
				if ("error" in resolved) return failWith("bad_input", resolved.error);
				const { org } = resolved;
				const gate = env.SUX_CRON_TOKEN;
				const base = `${redirectUri(env).replace(/\/callback$/, "/connect")}?org=${encodeURIComponent(org)}`;
				// Deliberately does NOT embed SUX_CRON_TOKEN: it's an operator secret and
				// this string flows into model context/logs. The operator supplies it as a
				// Bearer header (§2.5 — no longer a query string, unlike the old ?token= gate).
				return ok(
					oj({
						org,
						connect_url: base,
						note: gate
							? `Open this URL with an 'Authorization: Bearer <SUX_CRON_TOKEN>' header (e.g. curl -sL -H "Authorization: Bearer $SUX_CRON_TOKEN" '${base}'), log into MyChart, and approve. The refresh grant is then stored under org '${org}' and pull/get work headlessly for it.`
							: "SUX_CRON_TOKEN is not set — the /mychart/connect route is currently locked (404). Set it, then retry.",
					}),
				);
			}

			if (op === "get") {
				const resolved = await resolveOrg(env, a?.org);
				if ("error" in resolved) return failWith("bad_input", resolved.error);
				const { org } = resolved;
				const path = String(a?.path ?? "");
				if (!path.trim()) return failWith("bad_input", "op=get requires a `path` (e.g. `Observation?category=vital-signs`).");
				const abs = resolveFhirPath(org, path);
				if (!abs) {
					// PHI-free error surface, same reasoning as the resp.status>=400 branch below:
					// the query string can carry patient identifiers (e.g. `given=Jane&family=Doe`)
					// which must never reach Logs/Loki/metrics.tools.mychart.last_error.
					const safePath = path.split("?")[0].slice(0, 100);
					return failWith("bad_input", `op=get: path escapes org '${org}'s FHIR base — refused. (${safePath})`);
				}
				if (!(await readGrant(env, org))) return failWith("not_configured", `MyChart not connected for org '${org}' — open /mychart/connect?org=${org} once.`);
				const resp = await mychartFetch(env, org, abs);
				const text = await resp.text();
				if (resp.status >= 400) {
					// PHI-free error surface: HTTP status + FHIR OperationOutcome
					// resourceType/issue-code only. The raw body can carry patient identifiers
					// or echoed values, which must never enter `err` → Logs/Loki/metrics (§5).
					let detail = "";
					try {
						const j: any = JSON.parse(text);
						if (j?.resourceType) detail = ` ${String(j.resourceType).replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`;
						const code = Array.isArray(j?.issue) ? j.issue[0]?.code : undefined;
						if (typeof code === "string") detail += `/${code.replace(/[^A-Za-z0-9\-]/g, "").slice(0, 40)}`;
					} catch {}
					return failWith(resp.status === 404 ? "not_found" : resp.status === 429 ? "rate_limited" : "upstream_error", `MyChart get HTTP ${resp.status}${detail}`);
				}
				return ok(text);
			}

			if (op === "pull") {
				const resolved = await resolveOrg(env, a?.org);
				if ("error" in resolved) return failWith("bad_input", resolved.error);
				const { org } = resolved;
				if (!(await readGrant(env, org))) return failWith("not_configured", `MyChart not connected for org '${org}' — open /mychart/connect?org=${org} once.`);
				if (!env.R2) return failWith("not_configured", "op=pull needs the R2 bucket bound (raw FHIR is written to the private phi/ prefix).");
				const types = Array.isArray(a?.types) ? a.types.map(String).filter(Boolean) : undefined;
				const since = typeof a?.since === "string" && a.since.trim() ? a.since.trim() : undefined;
				const r = await pull(env, org, { types, since });
				return ok(oj(r));
			}

			return failWith("bad_input", `mychart: unknown op '${op}'. Use status | connect | pull | get.`);
		} catch (e) {
			return failWith("upstream_error", `mychart ${op} failed: ${errMsg(e)}`);
		}
	},
};
