import { hasAI, llm } from "../ai";
import { normalizeArgs, normalizeText } from "../normalize";
import { type Fn, fail, ok } from "../registry";

// Map-reduce: MAP one sux tool over many argument sets, then optionally REDUCE
// the successful results into one value. FUNCTIONS is imported dynamically
// *inside* run() to avoid the static import cycle (index.ts imports this file).
// Concurrency is capped and per-item failures are tolerated so one bad call
// doesn't sink the batch.
//
// batch is `raw` so the boundary in index.ts doesn't normalize per-call args or
// the results envelope — that would corrupt byte-exact fns (hash/encode/compress/
// kv/…) invoked inside. Instead each call reproduces the boundary itself: non-raw
// targets get normalizeArgs on input and normalizeText on output.

const CONCURRENCY = 8;
// Amplification cap: one batch call may fan into at most this many tool runs.
const MAX_CALLS = 100;
// Joiner between mapped results before concat/summarize reduction.
const SEP = "\n\n---\n\n";

type ItemResult = { ok: boolean; text?: string; error?: string };

export const batch: Fn = {
	name: "batch",
	description:
		"Map-reduce one sux tool over many argument sets. MAP: tool is the tool name to invoke; calls is an array of argument objects (one per invocation), run with capped concurrency (~8), tolerating per-item failure. REDUCE (optional): reduce combines the successful results server-side so you don't pull every mapped result back into context — none (default) returns the per-item results as-is; concat joins the ok results' text; summarize feeds the joined ok text to Workers AI for one combined answer (falls back to concat if AI isn't configured). include_results (default true) can be set false on a pure reduce to drop the per-item array. Returns JSON { tool, results } (and reduced when reducing). Fails if the tool is unknown.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["tool", "calls"],
		properties: {
			tool: { type: "string", description: "Name of the sux tool to run for each call." },
			calls: {
				type: "array",
				items: { type: "object", additionalProperties: true },
				maxItems: 100,
				description: "Array of argument objects; the tool runs once per entry (max 100).",
			},
			reduce: {
				type: "string",
				enum: ["none", "concat", "summarize"],
				default: "none",
				description: "Reduce the successful results: none (return per-item results), concat (join their text), or summarize (synthesize one answer with Workers AI).",
			},
			include_results: {
				type: "boolean",
				default: true,
				description: "Include the per-item results array. Set false on a pure reduce to return just { tool, reduced }.",
			},
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const toolName = typeof args?.tool === "string" ? args.tool.trim() : "";
		if (!toolName) return fail("Provide a `tool` name.");
		if (!Array.isArray(args?.calls)) return fail("`calls` must be an array of argument objects.");
		const calls: unknown[] = args.calls;
		if (calls.length > MAX_CALLS) return fail(`Too many calls: ${calls.length} (max ${MAX_CALLS} per batch).`);
		const reduce = String(args?.reduce ?? "none");
		if (reduce !== "none" && reduce !== "concat" && reduce !== "summarize") return fail(`Unknown reduce '${reduce}'. Options: none, concat, summarize.`);
		const includeResults = args?.include_results !== false;

		// Dynamic import breaks the static cycle (index.ts -> batch.ts -> index.ts).
		const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Fn[] };
		if (toolName === "batch") return fail("Refusing to run `batch` recursively.");
		const found = FUNCTIONS.find((f) => f.name === toolName);
		if (!found) {
			const names = FUNCTIONS.map((f) => f.name).sort().join(", ");
			return fail(`Unknown tool '${toolName}'. Available: ${names}`);
		}
		const target: Fn = found;

		const results: ItemResult[] = new Array(calls.length);
		let next = 0;
		async function worker(): Promise<void> {
			for (;;) {
				const i = next++;
				if (i >= calls.length) return;
				const callArgs = calls[i];
				if (callArgs == null || typeof callArgs !== "object" || Array.isArray(callArgs)) {
					results[i] = { ok: false, error: "call args must be an object." };
					continue;
				}
				try {
					// Per-call boundary parity with index.ts: non-raw targets get
					// normalized args in and normalized text out; raw ones stay byte-exact.
					const r = await target.run(env, target.raw ? callArgs : normalizeArgs(callArgs));
					const text = r.content?.[0]?.text ?? "";
					results[i] = r.isError ? { ok: false, error: text } : { ok: true, text: target.raw ? text : normalizeText(text) };
				} catch (e) {
					results[i] = { ok: false, error: String((e as Error)?.message ?? e) };
				}
			}
		}

		const pool = Math.min(CONCURRENCY, Math.max(1, calls.length));
		await Promise.all(Array.from({ length: pool }, () => worker()));

		// Reduce operates only over ok results; failed items stay in `results`
		// but are skipped here.
		if (reduce === "none") return ok(JSON.stringify({ tool: toolName, results }, null, 2));

		const okText = results.filter((r) => r?.ok && r.text).map((r) => r.text as string);
		const joined = okText.join(SEP);

		let reduced: string;
		if (reduce === "summarize" && hasAI(env)) {
			try {
				reduced = await llm(
					env,
					"Synthesize these results — each is the output of one tool call — into one concise combined answer. No preamble.",
					joined.slice(0, 24_000),
					512,
				);
			} catch (e) {
				// Mirror web_search's graceful fallback: on AI failure, fall back to concat.
				reduced = `${joined}\n\n(summarize failed, returning concat: ${String((e as Error).message ?? e)})`;
			}
		} else if (reduce === "summarize") {
			// AI not configured — fall back to concat and note it.
			reduced = `${joined}\n\n(summarize skipped: Workers AI binding not configured — returning concat)`;
		} else {
			reduced = joined;
		}

		const payload = includeResults ? { tool: toolName, results, reduced } : { tool: toolName, reduced };
		return ok(JSON.stringify(payload, null, 2));
	},
};
