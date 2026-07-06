import { type Fn, fail, ok } from "../registry";

// Compose: chain sux tools so each step's text output feeds the next step's args
// — the server-side derivation graph that pairs with the content-addressed store.
// batch is MAP (one tool, many args, fan out); pipe is COMPOSE (many tools, one
// value, threaded). `{{prev}}` in any step arg is replaced by the previous step's
// text output; `{{prev.<path>}}` pulls a field when that output is JSON. FUNCTIONS
// is imported dynamically inside run() to avoid the index.ts import cycle.

type Step = { tool: string; args?: Record<string, unknown> };
type StepResult = { step: number; tool: string; ok: boolean; text?: string; error?: string };

/** Resolve a dotted path against a parsed value (best-effort; undefined on miss). */
function dig(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((v, k) => (v != null && typeof v === "object" ? (v as any)[k] : undefined), value);
}

/** Replace {{prev}} / {{prev.a.b}} tokens in one arg value using the prior output. */
function substitute(argValue: unknown, prev: string): unknown {
	if (typeof argValue !== "string") return argValue;
	if (!argValue.includes("{{prev")) return argValue;
	// Whole-value passthrough preserves non-string prev (kept as the raw text).
	if (argValue.trim() === "{{prev}}") return prev;
	let parsed: unknown;
	let didParse = false;
	return argValue.replace(/\{\{prev(?:\.([\w.]+))?\}\}/g, (_m, path) => {
		if (!path) return prev;
		if (!didParse) {
			try {
				parsed = JSON.parse(prev);
			} catch {
				parsed = undefined;
			}
			didParse = true;
		}
		const got = dig(parsed, path);
		return got == null ? "" : typeof got === "string" ? got : JSON.stringify(got);
	});
}

function fillArgs(args: Record<string, unknown> | undefined, prev: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args ?? {})) out[k] = substitute(v, prev);
	return out;
}

export const pipe: Fn = {
	name: "pipe",
	description:
		"Compose sux tools into a pipeline: each step's text output feeds the next. `steps` is [{ tool, args }]; use `{{prev}}` in any arg to inject the previous step's output, or `{{prev.a.b}}` to pull a field when that output is JSON. Runs server-side (no round-trips through the model); stops at the first failing step. Returns JSON { steps:[{tool,ok,text|error}], output } where output is the final step's text. This is COMPOSE to batch's MAP.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["steps"],
		properties: {
			steps: {
				type: "array",
				minItems: 1,
				description: "Ordered pipeline steps.",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["tool"],
					properties: {
						tool: { type: "string", description: "sux tool name to run at this step." },
						args: { type: "object", additionalProperties: true, description: "Args; string values may contain {{prev}} / {{prev.path}}." },
					},
				},
			},
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const steps = args?.steps as Step[] | undefined;
		if (!Array.isArray(steps) || steps.length === 0) return fail("Provide a non-empty `steps` array.");

		// Dynamic import breaks the static cycle (index.ts -> pipe.ts -> index.ts).
		const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Fn[] };

		const results: StepResult[] = [];
		let prev = "";
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			const toolName = typeof step?.tool === "string" ? step.tool.trim() : "";
			if (!toolName) return fail(`steps[${i}] is missing a tool name.`);
			if (toolName === "pipe" || toolName === "batch") return fail(`steps[${i}]: refusing to run '${toolName}' inside a pipe.`);
			const target = FUNCTIONS.find((f) => f.name === toolName);
			if (!target) return fail(`steps[${i}]: unknown tool '${toolName}'.`);

			const callArgs = fillArgs(step.args, prev);
			try {
				const r = await target.run(env, callArgs);
				const text = r.content?.[0]?.text ?? "";
				if (r.isError) {
					results.push({ step: i, tool: toolName, ok: false, error: text });
					return ok(JSON.stringify({ steps: results, output: null, stopped_at: i }, null, 2));
				}
				results.push({ step: i, tool: toolName, ok: true, text });
				prev = text;
			} catch (e) {
				results.push({ step: i, tool: toolName, ok: false, error: String((e as Error)?.message ?? e) });
				return ok(JSON.stringify({ steps: results, output: null, stopped_at: i }, null, 2));
			}
		}
		return ok(JSON.stringify({ steps: results, output: prev }, null, 2));
	},
};
