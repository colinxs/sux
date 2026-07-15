import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";
import { fhirBase, mychartConfigured, mychartFetch, pull, readGrant, redirectUri, resolveFhirPath } from "../mychart";

// MyChart — Epic SMART-on-FHIR clinical records, read-only. The interactive OAuth
// dance lives on the public /mychart/connect + /mychart/callback routes (src/mychart.ts);
// this fn is the headless surface over the resulting refresh grant. Design + PHI
// invariants: docs/proposals/mychart.md (§2b, §5).
//
// cacheable:false + raw:true is LOAD-BEARING, not cosmetic: `pull`/`get` return PHI
// (lab results, notes, conditions), which must NEVER enter the shared KV result cache.
// The only cached token is the opaque, short-lived access token in OAUTH_KV.
//
// Inert until EPIC_CLIENT_ID / EPIC_CLIENT_SECRET / EPIC_FHIR_BASE are set (like
// monarch/dropbox); `status` still answers so an operator can see it's unconfigured.

const NOT_CONFIGURED =
	"MyChart not configured. Set EPIC_CLIENT_ID, EPIC_CLIENT_SECRET, and EPIC_FHIR_BASE " +
	"(the org's FHIR R4 base URL). Then open /mychart/connect once to link the account. Read-only.";

export const mychart: Fn = {
	name: "mychart",
	cost: 3,
	cacheable: false,
	raw: true,
	annotations: { readOnlyHint: true, openWorldHint: true },
	description:
		"MyChart — READ-ONLY Epic clinical records over SMART-on-FHIR (labs, vitals, conditions, meds, allergies, immunizations, procedures, notes). Ops: " +
		"status (grant present? patient id, FHIR base, scopes, refresh-token age — NEVER returns token material) | " +
		"connect (returns the /mychart/connect URL to open in a browser — the fn can't do the interactive login itself) | " +
		"pull ({types?:[...], since?:'YYYY-MM-DD'} — sync: pages the USCDI resource set, resolves DocumentReference→Binary notes, writes raw FHIR to private R2; returns per-type COUNTS only, never values) | " +
		"get ({path:'Observation?category=vital-signs&date=ge2026-06-01'} — read-only FHIR passthrough, path-validated against the FHIR base). " +
		"PHI never enters the response cache or public share links. " +
		"Needs EPIC_CLIENT_ID/EPIC_CLIENT_SECRET/EPIC_FHIR_BASE + a one-time /mychart/connect login; absent → not_configured.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["op"],
		properties: {
			op: { type: "string", enum: ["status", "connect", "pull", "get"] },
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
			const grant = configured ? await readGrant(env) : null;
			return ok(
				oj({
					configured,
					connected: Boolean(grant),
					fhirBase: configured ? fhirBase(env) : undefined,
					patient: grant?.patient,
					scopes: grant?.scope,
					refreshTokenAgeSeconds: grant?.issued_at ? Math.max(0, Math.floor((Date.now() - grant.issued_at) / 1000)) : undefined,
				}),
			);
		}

		if (!mychartConfigured(env)) return failWith("not_configured", NOT_CONFIGURED);

		try {
			if (op === "connect") {
				const gate = env.SUX_CRON_TOKEN;
				const base = redirectUri(env).replace(/\/callback$/, "/connect");
				// Deliberately does NOT embed SUX_CRON_TOKEN: it's an operator secret and
				// this string flows into model context/logs. The operator appends it.
				return ok(
					oj({
						connect_url: base,
						note: gate
							? "Open this URL in a browser with `?token=<SUX_CRON_TOKEN>` appended, log into MyChart, and approve. The refresh grant is then stored and `pull`/`get` work headlessly."
							: "SUX_CRON_TOKEN is not set — the /mychart/connect route is currently locked (404). Set it, then open /mychart/connect?token=<SUX_CRON_TOKEN>.",
					}),
				);
			}

			if (op === "get") {
				const path = String(a?.path ?? "");
				if (!path.trim()) return failWith("bad_input", "op=get requires a `path` (e.g. `Observation?category=vital-signs`).");
				const abs = resolveFhirPath(env, path);
				if (!abs) return failWith("bad_input", `op=get: path escapes the configured FHIR base — refused. (${path})`);
				if (!(await readGrant(env))) return failWith("not_configured", "MyChart not connected — open /mychart/connect once.");
				const resp = await mychartFetch(env, abs);
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
				if (!(await readGrant(env))) return failWith("not_configured", "MyChart not connected — open /mychart/connect once.");
				if (!env.R2) return failWith("not_configured", "op=pull needs the R2 bucket bound (raw FHIR is written to the private phi/ prefix).");
				const types = Array.isArray(a?.types) ? a.types.map(String).filter(Boolean) : undefined;
				const since = typeof a?.since === "string" && a.since.trim() ? a.since.trim() : undefined;
				const r = await pull(env, { types, since });
				return ok(oj(r));
			}

			return failWith("bad_input", `mychart: unknown op '${op}'. Use status | connect | pull | get.`);
		} catch (e) {
			return failWith("upstream_error", `mychart ${op} failed: ${errMsg(e)}`);
		}
	},
};
