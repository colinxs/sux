import { type Fn, fail, ok } from "../registry";

// ClinicalTrials.gov API v2 (clinicaltrials.gov/api/v2) — keyless, free registry of
// clinical studies. No residential proxy: a public government API with no bot wall.

const API = "https://clinicaltrials.gov/api/v2/studies";

function normStudy(s: any): Record<string, unknown> {
	const ps = s?.protocolSection ?? {};
	const nctId = ps?.identificationModule?.nctId ?? null;
	return {
		nct_id: nctId,
		title: ps?.identificationModule?.briefTitle ?? null,
		status: ps?.statusModule?.overallStatus ?? null,
		conditions: Array.isArray(ps?.conditionsModule?.conditions) ? ps.conditionsModule.conditions : [],
		phases: Array.isArray(ps?.designModule?.phases) ? ps.designModule.phases : [],
		url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : null,
	};
}

export const clinical_trials: Fn = {
	name: "clinical_trials",
	description:
		"Search ClinicalTrials.gov (keyless, free) — the NIH registry of clinical studies worldwide. Provide `term` (condition, intervention, or free text). Returns normalized JSON { count, results:[{ nct_id, title, status, conditions[], phases[], url }] }. Tune with `page_size` (default 10, max 50).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search terms (condition, intervention, or free text)." },
			page_size: { type: "integer", minimum: 1, maximum: 50, default: 10 },
		},
	},
	cacheable: true,
	ttl: 1800,
	run: async (_env, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const pageSize = Math.min(50, Math.max(1, Number(args?.page_size) || 10));

		const p = new URLSearchParams({ "query.term": term, pageSize: String(pageSize), format: "json" });
		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`);
		} catch (e) {
			return fail(`ClinicalTrials.gov fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`ClinicalTrials.gov API HTTP ${resp.status}.`);
		const j: any = await resp.json();
		const results = (j?.studies ?? []).map(normStudy);
		return ok(JSON.stringify({ count: results.length, results }, null, 2));
	},
};
