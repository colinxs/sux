import { normalizeText } from "../normalize";
import { failWith, type Fn, findFn } from "../registry";
import { FUNCTIONS } from "./index";

// The ESCAPE HATCH. The front-door lists only ~13 root verbs (see registry
// FRONT_VERBS); every other capability is a leaf reached either by its own name or
// through this one tool. `fn({name, args})` invokes any registered leaf — so the
// full ~95-tool surface stays one tool-call away without flooding tools/list.
//
// In production the dispatcher (index.ts handleRpc) UNWRAPS an `fn` call before it
// reaches findFn/cache, so `fn({name:"scrape", args:{url}})` runs byte-identically
// to `scrape({url})` — same cache key, same deadline, same normalization. This
// `run` is the equivalent fallback for any caller that invokes the fn directly
// (tests, or a path that skips the unwrap): it delegates to the named leaf.
//
// Discover leaves with `sux()` (the capability map) or `sux({domain})`; then call
// them here, e.g. fn({name:"arxiv", args:{query:"…"}}). Cache-control flags go on
// the INNER args — fn({name:"search", args:{query:"…", fresh:true}}).
export const fnEscape: Fn = {
	name: "fn",
	surface: "front",
	description:
		"Escape hatch — call ANY sux leaf tool by name. tools/list shows only ~13 front verbs; every other capability (the ~95-tool surface) is reached here: fn({name, args}). Call `sux()` first for the capability map, then invoke a leaf, e.g. fn({name:\"amazon\", args:{query:\"laptop stand\"}}) or fn({name:\"arxiv\", args:{query:\"…\"}}). Put any cache flags on the inner args (fn({name:\"search\", args:{query:\"…\", fresh:true}})). Behaves exactly as a direct call to that leaf.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["name"],
		properties: {
			name: { type: "string", description: "The leaf tool to invoke, e.g. \"scrape\", \"arxiv\", \"amazon\". Get the full list from sux()." },
			args: { type: "object", description: "Arguments passed straight to that leaf (its own schema). Omit for a no-arg tool.", additionalProperties: true },
		},
	},
	run: async (env, args) => {
		// Resolve through the same normalization the dispatcher + unwrapFnCall use, so
		// this fallback path can never resolve a leaf the unwrap rejected (which would
		// re-open the cost/cache bypass) — the two sites stay in lockstep.
		const target = typeof args?.name === "string" ? normalizeText(args.name).trim() : "";
		if (!target) return failWith("bad_input", 'fn requires a `name` — the leaf tool to call, e.g. fn({name:"scrape", args:{url:"…"}}). Call sux() for the list.');
		if (target === "fn") return failWith("bad_input", "fn cannot call itself.");
		const leaf = findFn(FUNCTIONS, target);
		if (!leaf) return failWith("not_found", `Unknown tool "${target}". Call sux() for the map of available leaves.`);
		const inner = args?.args ?? {};
		if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return failWith("bad_input", "`args` must be an object (the leaf's own arguments).");
		return leaf.run(env, inner);
	},
};
