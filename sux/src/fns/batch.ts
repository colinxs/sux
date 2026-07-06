import { normalizeArgs, normalizeText } from "../normalize";
import { type Fn, fail, ok } from "../registry";

// Broadcast: run one sux tool over many argument sets. FUNCTIONS is imported
// dynamically *inside* run() to avoid the static import cycle (index.ts imports
// this file). Concurrency is capped and per-item failures are tolerated so one
// bad call doesn't sink the batch.
//
// batch is `raw` so the boundary in index.ts doesn't normalize per-call args or
// the results envelope — that would corrupt byte-exact fns (hash/encode/compress/
// kv/…) invoked inside. Instead each call reproduces the boundary itself: non-raw
// targets get normalizeArgs on input and normalizeText on output.

const CONCURRENCY = 8;
// Amplification cap: one batch call may fan into at most this many tool runs.
const MAX_CALLS = 100;

type ItemResult = { ok: boolean; text?: string; error?: string };

export const batch: Fn = {
	name: "batch",
	description:
		"Broadcast one sux tool over many argument sets. tool: the tool name to invoke; calls: an array of argument objects (one per invocation). Runs with capped concurrency (~8), tolerating per-item failure. Returns JSON { tool, results } where each result is { ok, text } or { ok:false, error }. Fails if the tool is unknown.",
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

		return ok(JSON.stringify({ tool: toolName, results }, null, 2));
	},
};
