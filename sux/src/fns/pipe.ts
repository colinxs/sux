import { normalizeArgs, normalizeText } from "../normalize";
import { type Fn, fail, ok } from "../registry";
import { clamp } from "./_util";

// Compose: chain sux tools so each step's text output feeds the next step's args
// — the server-side derivation graph that pairs with the content-addressed store.
// batch is MAP (one tool, many args, fan out); pipe is COMPOSE (many tools, one
// value, threaded). `{{prev}}` in any step arg is replaced by the previous step's
// text output; `{{prev.<path>}}` pulls a field when that output is JSON. FUNCTIONS
// is imported dynamically inside run() to avoid the index.ts import cycle.
//
// pipe is `raw` so the boundary in index.ts doesn't normalize step args or the
// final envelope — that would corrupt byte-exact fns (hash/encode/compress/kv/…)
// nested inside. Instead each step reproduces the boundary itself: non-raw
// targets get normalizeArgs on input and normalizeText on output; raw targets
// keep their bytes untouched.

type Step = { tool: string; args?: Record<string, unknown> };
// Intermediate step texts are previews only (the full text still threads through
// {{prev}} and the final text lands in `output`) — echoing every step verbatim
// would return a huge pipeline result mostly made of data the model already gets.
const STEP_PREVIEW_BYTES = 500;
// Amplification cap: one pipe call may fan into at most this many tool runs.
const MAX_STEPS = 25;
type StepResult = { step: number; tool: string; ok: boolean; text?: string; error?: string };

/** Resolve a dotted path against a parsed value (best-effort; undefined on miss). */
function dig(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((v, k) => (v != null && typeof v === "object" ? (v as any)[k] : undefined), value);
}

/** Replace {{prev}} / {{prev.a.b}} tokens in one arg value using the prior output.
 * `getParsedPrev` is a step-scoped lazy parse of prev-as-JSON, shared across all
 * strings in the step so a huge prev is JSON.parsed at most once per step. */
function substitute(argValue: unknown, prev: string, getParsedPrev: () => unknown): unknown {
	if (typeof argValue !== "string") return argValue;
	if (!argValue.includes("{{prev")) return argValue;
	// Whole-value passthrough preserves non-string prev (kept as the raw text).
	if (argValue.trim() === "{{prev}}") return prev;
	return argValue.replace(/\{\{prev(?:\.([\w.]+))?\}\}/g, (_m, path) => {
		if (!path) return prev;
		const got = dig(getParsedPrev(), path);
		return got == null ? "" : typeof got === "string" ? got : JSON.stringify(got);
	});
}

/** Deep-fill: substitute tokens in every string inside nested objects/arrays
 * (mirrors normalizeArgs in ../normalize.ts) so e.g. pdf.sources[i].url or
 * fillable.fields values see {{prev}} too, not just top-level strings. */
function fillValue(value: unknown, prev: string, getParsedPrev: () => unknown): unknown {
	if (typeof value === "string") return substitute(value, prev, getParsedPrev);
	if (Array.isArray(value)) return value.map((v) => fillValue(v, prev, getParsedPrev));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = fillValue(v, prev, getParsedPrev);
		return out;
	}
	return value;
}

function fillArgs(args: Record<string, unknown> | undefined, prev: string): Record<string, unknown> {
	// One lazy parse per step, shared by every token-bearing string in the args.
	let parsed: unknown;
	let didParse = false;
	const getParsedPrev = () => {
		if (!didParse) {
			try {
				parsed = JSON.parse(prev);
			} catch {
				parsed = undefined;
			}
			didParse = true;
		}
		return parsed;
	};
	return fillValue(args ?? {}, prev, getParsedPrev) as Record<string, unknown>;
}

export const pipe: Fn = {
	name: "pipe",
	description:
		"Compose sux tools into a pipeline: each step's text output feeds the next. `steps` is [{ tool, args }]; use `{{prev}}` in any arg to inject the previous step's output, or `{{prev.a.b}}` to pull a field when that output is JSON. Runs server-side (no round-trips through the model); stops at the first failing step. Returns JSON { steps:[{tool,ok,text|error}], output } where output is the final step's full text (step texts are short previews; errors are kept in full). This is COMPOSE to batch's MAP.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["steps"],
		properties: {
			steps: {
				type: "array",
				minItems: 1,
				maxItems: 25,
				description: "Ordered pipeline steps (max 25).",
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
	raw: true,
	run: async (env, args) => {
		const steps = args?.steps as Step[] | undefined;
		if (!Array.isArray(steps) || steps.length === 0) return fail("Provide a non-empty `steps` array.");
		if (steps.length > MAX_STEPS) return fail(`Too many steps: ${steps.length} (max ${MAX_STEPS} per pipe).`);

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

			// Per-step boundary parity with index.ts: substitution runs on raw bytes,
			// then non-raw targets get their args normalized (raw ones stay byte-exact).
			const filled = fillArgs(step.args, prev);
			const callArgs = target.raw ? filled : normalizeArgs(filled);
			try {
				const r = await target.run(env, callArgs);
				let text = r.content?.[0]?.text ?? "";
				if (r.isError) {
					results.push({ step: i, tool: toolName, ok: false, error: text });
					return ok(JSON.stringify({ steps: results, output: null, stopped_at: i }, null, 2));
				}
				// Close-side normalization for non-raw targets (same as index.ts).
				if (!target.raw) text = normalizeText(text);
				// Preview only in steps[] — the full text threads on as prev and the
				// final step's full text is returned as `output`. Errors stay full.
				results.push({ step: i, tool: toolName, ok: true, text: clamp(text, STEP_PREVIEW_BYTES) });
				prev = text;
			} catch (e) {
				results.push({ step: i, tool: toolName, ok: false, error: String((e as Error)?.message ?? e) });
				return ok(JSON.stringify({ steps: results, output: null, stopped_at: i }, null, 2));
			}
		}
		return ok(JSON.stringify({ steps: results, output: prev }, null, 2));
	},
};
