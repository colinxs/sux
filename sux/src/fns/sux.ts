import { type Fn, ok } from "../registry";
import { domainKeys, renderDomain, renderOverview } from "./_surface";
import { FUNCTIONS } from "./index";

// The self-describing ROOT VERB. sux advertises ~95 leaf tools plus three
// personal-data namespace connectors (mail/vault/files); a skill file explains how
// they compose, but skills do NOT sync to mobile — so on a phone the agent sees the
// bare tool list and no map. `sux` IS that map, delivered as a single mobile-safe
// tool call: it returns the whole capability surface (domains → what each is for →
// the leaf fns under it → how to reach them) built live from the registry, so it
// never drifts from what's actually deployed. Call it first on an unfamiliar surface;
// then call any leaf directly as its own tool, e.g. search({query}) or ingest({url}).
// The map itself lives in `_surface.ts`, shared with the public GET /llms.txt.

export const sux: Fn = {
	name: "sux",
	surface: "front",
	// Self-description doesn't mutate anything and doesn't touch the network — it just
	// reflects the registry. Idempotent + read-only so a client treats it as free.
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	description:
		"sux capability map — the single, mobile-safe entry point that describes the whole toolset. tools/list advertises only the front verbs (e.g. sux, fn, search, scrape, shop, ingest, recall, oracle, pipe, batch, store, preferences, issue); every other capability is a LEAF, reached via the `fn` escape — fn({name, args}) — or by their own name. Skills explain how these compose, but skills don't sync to mobile — so call `sux` first on an unfamiliar surface to get the map: the DOMAINS (search, fetch, extract, research, shop, convert, compute, data, storage, recall, tasks, mail, compose, meta), what each is for, and the exact leaf fns under it. Then invoke any leaf, e.g. fn({name:\"arxiv\", args:{query}}) or a front verb directly like search({query}). Pass `domain` to zoom into one group and get each leaf's one-line summary; omit it for the full overview. The map is built live from the deployed registry, so it never drifts from what's actually available.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			domain: {
				type: "string",
				description: "Zoom into one domain (e.g. shop, fetch, recall) and list each leaf with its one-line summary. Omit for the full overview across all domains + namespaces.",
			},
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const want = typeof args?.domain === "string" ? args.domain.trim() : "";
		if (want) {
			const zoom = renderDomain(FUNCTIONS, want);
			if (zoom) return ok(zoom);
			return ok(`Unknown domain "${want.toLowerCase()}". Known domains: ${domainKeys().join(", ")}. Omit \`domain\` for the full map.`);
		}
		return ok(renderOverview(FUNCTIONS));
	},
};
