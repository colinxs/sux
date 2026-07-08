import { hasAI, llm } from "../ai";
import { normalizeArgs, normalizeText } from "../normalize";
import { type Fn, fail, ok } from "../registry";
import { pool } from "./_util";

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
// Nested fan-out cap: when the mapped tool is itself a fan-out (`pipe`,
// `batch_fetch`, `crawl`), each call can expand into many more upstream fetches,
// so the product must stay bounded. Mapping any of these over MAX_CALLS would
// multiply unbounded (e.g. 100 batch_fetch × 100 URLs = 10 000 node fetches);
// the tighter MAX_NESTED_CALLS cap holds the total work product to
// ≤ MAX_NESTED_CALLS × the mapped tool's own width instead of 100 × that width.
const NESTED_FANOUT_TOOLS = new Set(["pipe", "batch_fetch", "crawl"]);
const MAX_NESTED_CALLS = 25;
// Joiner between mapped results before concat/summarize reduction.
const SEP = "\n\n---\n\n";

type ItemResult = { ok: boolean; text?: string; error?: string };

/** Resolve a dotted path against a value (best-effort; undefined on miss). */
function dig(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((v, k) => (v != null && typeof v === "object" ? (v as any)[k] : undefined), value);
}

/**
 * Deep-substitute a `{{token}}` across a template's strings. A whole-value
 * `"{{token}}"` is replaced by the raw replacement (preserving objects/arrays);
 * `{{token.path}}` digs a field; inline occurrences stringify. Used to expand a
 * map template over each `over` item ({{item}}) and to inject the collected
 * mapped outputs into a reducer ({{items}}).
 */
export function fillToken(value: unknown, token: string, replacement: unknown): unknown {
	if (typeof value === "string") {
		if (!value.includes(`{{${token}`)) return value;
		if (value.trim() === `{{${token}}}`) return replacement; // whole-value → raw (keeps arrays/objects)
		const re = new RegExp(`\\{\\{${token}(?:\\.([\\w.]+))?\\}\\}`, "g");
		return value.replace(re, (_m, path) => {
			const got = path ? dig(replacement, path) : replacement;
			return got == null ? "" : typeof got === "string" ? got : JSON.stringify(got);
		});
	}
	if (Array.isArray(value)) return value.map((v) => fillToken(v, token, replacement));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = fillToken(v, token, replacement);
		return out;
	}
	return value;
}

/** Collect a field from each mapped output (JSON-parsing string items), or the
 * whole array when no path — powers reduce_with's {{items}} / {{items.path}}. */
export function pluckItems(items: string[], path?: string): unknown {
	if (!path) return items;
	return items
		.map((t) => {
			try {
				return dig(JSON.parse(t), path);
			} catch {
				return undefined;
			}
		})
		.filter((v) => v !== undefined);
}

/** Deep-fill {{items}} / {{items.path}} in a reducer's args. A whole-value token
 * becomes the raw array (so sources:'{{items.url}}' → [url1, url2]); inline uses
 * stringify. */
export function fillItemsTokens(value: unknown, items: string[]): unknown {
	if (typeof value === "string") {
		const whole = value.trim().match(/^\{\{items(?:\.([\w.]+))?\}\}$/);
		if (whole) return pluckItems(items, whole[1]);
		if (!value.includes("{{items")) return value;
		return value.replace(/\{\{items(?:\.([\w.]+))?\}\}/g, (_m, p) => JSON.stringify(pluckItems(items, p)));
	}
	if (Array.isArray(value)) return value.map((v) => fillItemsTokens(v, items));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = fillItemsTokens(v, items);
		return out;
	}
	return value;
}

export const batch: Fn = {
	name: "batch",
	description:
		"Map-reduce one sux tool over many inputs. MAP two ways: `calls` (array of full arg objects, tool runs once each) OR `over` + `args` (map a template over a list — for each item in `over`, run `tool` with `args` where {{item}} / {{item.path}} is filled in, e.g. tool:pdf, over:[url1,url2], args:{url:'{{item}}'}). Map tool:pipe with {{item}}-templated steps to run a per-item PIPELINE — map(shrink(pdf()), URLs). Capped concurrency (~8), per-item failure tolerated. REDUCE the successful results server-side so you don't pull them all back into context: reduce = none (default) | concat (join text) | summarize (Workers-AI synthesis, falls back to concat). OR reduce_with = {tool, args} for a TOOL-based reduce — run a reducer once over the mapped outputs with {{items}} (JSON array of ok texts) or {{items.path}} (pluck a field from each) injected, e.g. reduce_with:{tool:'pdf',args:{operation:'merge',sources:'{{items.url}}'}} to merge mapped PDFs — shrink(reduce(pdf, URLs)). include_results (default true) → false drops the per-item array. Returns JSON { tool, results?, reduced? }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["tool"],
		properties: {
			tool: { type: "string", description: "Name of the sux tool to run for each call." },
			calls: {
				type: "array",
				items: { type: "object", additionalProperties: true },
				maxItems: 100,
				description: "Array of argument objects; the tool runs once per entry (max 100). Provide this OR over+args.",
			},
			over: {
				type: "array",
				items: {},
				maxItems: 100,
				description: "Items to map `args` over — each fills {{item}} / {{item.path}}. Lighter alternative to `calls` (e.g. over:[url1,url2], args:{url:'{{item}}'}).",
			},
			args: {
				type: "object",
				additionalProperties: true,
				description: "Per-item argument TEMPLATE used with `over`; {{item}} (whole) or {{item.path}} is substituted per item. Map tool:pipe with {{item}}-templated steps for a per-item pipeline.",
			},
			reduce_with: {
				type: "object",
				additionalProperties: false,
				required: ["tool"],
				properties: {
					tool: { type: "string", description: "Reducer tool, run once over the mapped outputs." },
					args: { type: "object", additionalProperties: true, description: "Reducer args; {{items}} = JSON array of the ok mapped texts (whole-value keeps it an array)." },
				},
				description: "TOOL-based reduce (overrides `reduce`): run a reducer once over the mapped outputs, e.g. reduce_with:{tool:'pdf',args:{operation:'merge',sources:'{{items}}'}}.",
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
		// MAP inputs two ways: explicit `calls`, or map an `args` template over `over`
		// (each item fills {{item}} / {{item.path}}). over+args is the lighter form.
		let calls: unknown[];
		if (Array.isArray(args?.over)) {
			const tmpl = args?.args;
			if (tmpl == null || typeof tmpl !== "object" || Array.isArray(tmpl)) return fail("`over` requires an `args` template object (e.g. args:{url:'{{item}}'}).");
			calls = (args.over as unknown[]).map((item) => fillToken(tmpl, "item", item));
		} else if (Array.isArray(args?.calls)) {
			calls = args.calls;
		} else {
			return fail("Provide `calls` (array of arg objects) or `over` + `args` (template to map over).");
		}
		if (calls.length > MAX_CALLS) return fail(`Too many calls: ${calls.length} (max ${MAX_CALLS} per batch).`);
		// A fan-out tool mapped over many calls multiplies the work product; keep it bounded.
		if (NESTED_FANOUT_TOOLS.has(toolName) && calls.length > MAX_NESTED_CALLS) {
			return fail(`Too many calls for nested fan-out tool '${toolName}': ${calls.length} (max ${MAX_NESTED_CALLS} when mapping a fan-out tool).`);
		}
		const reduce = String(args?.reduce ?? "none");
		if (reduce !== "none" && reduce !== "concat" && reduce !== "summarize") return fail(`Unknown reduce '${reduce}'. Options: none, concat, summarize.`);
		const reduceWith = args?.reduce_with as { tool?: unknown; args?: unknown } | undefined;
		const hasReduceWith = reduceWith != null && typeof reduceWith === "object" && typeof reduceWith.tool === "string";
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

		const results: ItemResult[] = await pool(calls, CONCURRENCY, async (callArgs): Promise<ItemResult> => {
			if (callArgs == null || typeof callArgs !== "object" || Array.isArray(callArgs)) {
				return { ok: false, error: "call args must be an object." };
			}
			try {
				// Per-call boundary parity with index.ts: non-raw targets get
				// normalized args in and normalized text out; raw ones stay byte-exact.
				const r = await target.run(env, target.raw ? callArgs : normalizeArgs(callArgs));
				const text = r.content?.[0]?.text ?? "";
				return r.isError ? { ok: false, error: text } : { ok: true, text: target.raw ? text : normalizeText(text) };
			} catch (e) {
				return { ok: false, error: String((e as Error)?.message ?? e) };
			}
		});

		// TOOL-based reduce (overrides the text reduces): run a reducer once over the
		// mapped ok outputs, with {{items}} = their texts (and {{items.path}} plucking
		// a field from each). This is the general reduce — merge PDFs, join a table,
		// pack, etc. — that completes shrink(reduce(pdf, URLs)).
		if (hasReduceWith) {
			const rTool = String(reduceWith!.tool);
			if (rTool === "batch") return fail("reduce_with tool cannot be `batch`.");
			const rFound = FUNCTIONS.find((f) => f.name === rTool);
			if (!rFound) return fail(`reduce_with: unknown tool '${rTool}'.`);
			const items = results.filter((r) => r?.ok && r.text).map((r) => r.text as string);
			const filled = fillItemsTokens((reduceWith!.args as Record<string, unknown>) ?? {}, items) as Record<string, unknown>;
			try {
				const rr = await rFound.run(env, rFound.raw ? filled : normalizeArgs(filled));
				const text = rr.content?.[0]?.text ?? "";
				if (rr.isError) return fail(`reduce_with '${rTool}' failed: ${text}`);
				const reduced = rFound.raw ? text : normalizeText(text);
				const payload = includeResults ? { tool: toolName, results, reduced, reduced_with: rTool } : { tool: toolName, reduced, reduced_with: rTool };
				return ok(JSON.stringify(payload, null, 2));
			} catch (e) {
				return fail(`reduce_with '${rTool}' failed: ${String((e as Error)?.message ?? e)}`);
			}
		}

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
