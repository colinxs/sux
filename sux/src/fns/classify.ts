import { type Fn, fail, ok } from "../registry";
import { hasAI, llm } from "../ai";
import { errMsg } from "./_util";

export const classify: Fn = {
	name: "classify",
	cost: 2,
	description: "Zero-shot classify text into one of the provided `labels` using Workers AI. multi=true allows multiple applicable labels. Returns the chosen label(s) and a one-line rationale.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text", "labels"],
		properties: {
			text: { type: "string" },
			labels: { type: "array", items: { type: "string" }, minItems: 2 },
			multi: { type: "boolean", default: false },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!hasAI(env)) return fail("Workers AI binding not configured (add \"ai\" to wrangler).");
		const text = String(args?.text ?? "");
		const labels = Array.isArray(args?.labels) ? args.labels.map(String) : [];
		if (!text) return fail("Provide `text`.");
		if (labels.length < 2) return fail("Provide at least 2 `labels`.");
		const multi = args?.multi === true;
		try {
			const out = await llm(
				env,
				`Classify the text into ${multi ? "all applicable labels" : "exactly one label"} from: ${labels.join(", ")}. Reply as JSON: {"labels":[...],"why":"..."}. Use only the given labels.`,
				text.slice(0, 12_000),
				200,
				"classify",
			);
			const json = out.match(/\{[\s\S]*\}/)?.[0];
			if (json) {
				try {
					const parsed = JSON.parse(json);
					parsed.labels = (parsed.labels ?? []).filter((l: string) => labels.includes(l));
					return ok(JSON.stringify(parsed));
				} catch {  }
			}
			return ok(out);
		} catch (e) {
			return fail(errMsg(e));
		}
	},
};
