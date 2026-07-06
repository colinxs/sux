// Composing helpers for the Kagi MCP proxy.
//
// The Worker is "mostly transparent": initialize / notifications / GET streams
// pass straight through. Only `tools/list` (for curation) and `tools/call` (for
// caching + audit) are intercepted, and any parse failure falls back to a plain
// passthrough — so a Kagi response shape we don't recognize can never break the
// connection.

export type JsonRpc = {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: { name?: string; arguments?: unknown; [k: string]: unknown };
	result?: any;
	error?: any;
};

// ---- SSE <-> JSON-RPC ------------------------------------------------------
// Kagi answers tools/* as a single SSE frame: `event: message\ndata: {json}\n\n`.
// (notifications come back as 202 application/json.) Read either into an object.

export function extractRpcFromText(text: string, contentType: string | null): JsonRpc | null {
	if ((contentType ?? "").includes("text/event-stream")) {
		const dataLine = text
			.split("\n")
			.map((l) => l.trim())
			.reverse()
			.find((l) => l.startsWith("data:"));
		if (!dataLine) return null;
		try {
			return JSON.parse(dataLine.slice("data:".length).trim());
		} catch {
			return null;
		}
	}
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// Re-emit an object in Kagi's exact SSE framing so clients see no difference.
export function sseResponse(obj: unknown, status = 200): Response {
	return new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, {
		status,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
		},
	});
}

export function parseJsonRpc(bodyText: string | undefined): JsonRpc | undefined {
	if (!bodyText) return undefined;
	try {
		return JSON.parse(bodyText) as JsonRpc;
	} catch {
		return undefined;
	}
}

// ---- Tool curation ---------------------------------------------------------
// Edit these to hide tools or sharpen their descriptions. Empty = expose Kagi's
// tools verbatim (default, fully transparent).

export const HIDDEN_TOOLS = new Set<string>([
	// e.g. "kagi_extract",
]);

export const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
	// e.g. kagi_search_fetch: "Search the web via Kagi. Prefer for current events.",
};

// ---- Custom lenses (on the fly, no persistence) ----------------------------
// A "lens" scopes a search. It's either a named preset (Kagi's built-in lens IDs,
// or your own hardcoded filter bundles) or ad-hoc filters supplied per call. We
// inject a `kagi_lens_search` tool and translate it into a kagi_search_fetch call
// server-side — so nothing is saved, Claude just composes a lens each time.

export type LensSpec = {
	description?: string;
	lens_id?: string;
	include_domains?: string[];
	exclude_domains?: string[];
	time_relative?: "day" | "week" | "month";
	after?: string;
	before?: string;
	file_type?: string;
	workflow?: string;
};

export const LENS_PRESETS: Record<string, LensSpec> = {
	academic: { lens_id: "2", description: "Education / .edu domains" },
	forums: { lens_id: "1", description: "Discussion forums" },
	programming: { lens_id: "15", description: "Official language sites & forums" },
	news360: { lens_id: "29", description: "Multi-perspective global news" },
	recipes: { lens_id: "120", description: "Recipe sites (English)" },
	smallweb: { lens_id: "107", description: "Noncommercial small web" },
	// Add your own hardcoded lenses here, e.g.:
	// rustdocs: { include_domains: ["doc.rust-lang.org", "docs.rs"], description: "Rust docs" },
};

export const LENS_TOOL = {
	name: "kagi_lens_search",
	description:
		"Search the web through a custom 'lens' that scopes results. Build a lens on the fly: pass a preset name (academic, forums, programming, news360, recipes, smallweb) and/or ad-hoc filters (include_domains, exclude_domains, time_relative, after, before, file_type). Presets apply a Kagi lens and are mutually exclusive with the domain/time/file filters — if you pass both, the explicit filters win. Results are numbered like kagi_search_fetch.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Keyword-focused search query." },
			lens: {
				anyOf: [{ type: "string" }, { type: "null" }],
				default: null,
				description: "Preset lens name: academic | forums | programming | news360 | recipes | smallweb.",
			},
			include_domains: {
				anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
				default: null,
				description: "Restrict to these domains, e.g. ['docs.python.org'].",
			},
			exclude_domains: {
				anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
				default: null,
				description: "Exclude these domains.",
			},
			time_relative: {
				anyOf: [{ enum: ["day", "week", "month"] }, { type: "null" }],
				default: null,
				description: "Restrict to the last day/week/month.",
			},
			after: { anyOf: [{ type: "string", format: "date" }, { type: "null" }], default: null },
			before: { anyOf: [{ type: "string", format: "date" }, { type: "null" }], default: null },
			file_type: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
			workflow: { enum: ["search", "news", "videos", "podcasts", "images"], default: "search" },
			limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
			extract_count: { type: "integer", minimum: 0, maximum: 10, default: 0 },
		},
	},
};

// Translate kagi_lens_search arguments into kagi_search_fetch arguments.
export function lensToSearchArgs(args: any): Record<string, unknown> {
	const out: Record<string, unknown> = { query: args?.query };
	if (args?.workflow) out.workflow = args.workflow;
	if (args?.limit != null) out.limit = args.limit;
	if (args?.extract_count != null) out.extract_count = args.extract_count;

	const presetName = typeof args?.lens === "string" ? args.lens.trim().toLowerCase() : null;
	const preset = presetName ? LENS_PRESETS[presetName] : undefined;
	if (preset) {
		if (preset.lens_id) out.lens_id = preset.lens_id;
		if (preset.include_domains) out.include_domains = preset.include_domains;
		if (preset.exclude_domains) out.exclude_domains = preset.exclude_domains;
		if (preset.time_relative) out.time_relative = preset.time_relative;
		if (preset.after) out.after = preset.after;
		if (preset.before) out.before = preset.before;
		if (preset.file_type) out.file_type = preset.file_type;
		if (preset.workflow) out.workflow = preset.workflow;
	}

	// Ad-hoc inline filters. Kagi treats lens_id as mutually exclusive with the
	// domain/time/file filters, so if any inline filter is present we drop lens_id
	// and let the explicit filters win (avoids a Kagi 400).
	const inline: Record<string, unknown> = {};
	if (args?.include_domains) inline.include_domains = args.include_domains;
	if (args?.exclude_domains) inline.exclude_domains = args.exclude_domains;
	if (args?.time_relative) inline.time_relative = args.time_relative;
	if (args?.after) inline.after = args.after;
	if (args?.before) inline.before = args.before;
	if (args?.file_type) inline.file_type = args.file_type;
	if (Object.keys(inline).length) {
		delete out.lens_id;
		Object.assign(out, inline);
	}
	return out;
}

// Advertise kagi_lens_search alongside Kagi's own tools in tools/list.
export function injectLensTool(result: any): any {
	if (!result || !Array.isArray(result.tools)) return result;
	if (result.tools.some((t: any) => t?.name === LENS_TOOL.name)) return result;
	return { ...result, tools: [...result.tools, LENS_TOOL] };
}

export function curateToolsResult(result: any): any {
	if (!result || !Array.isArray(result.tools)) return result;
	const tools = result.tools
		.filter((t: any) => !HIDDEN_TOOLS.has(t?.name))
		.map((t: any) =>
			t?.name && TOOL_DESCRIPTION_OVERRIDES[t.name]
				? { ...t, description: TOOL_DESCRIPTION_OVERRIDES[t.name] }
				: t,
		);
	return { ...result, tools };
}

// ---- Response caching ------------------------------------------------------
// Only cache read-only tools whose result is deterministic-ish for a TTL.

export const CACHEABLE_TOOLS = new Set<string>(["kagi_search_fetch", "kagi_extract"]);
export const CACHE_TTL_SECONDS = 3600;
const CACHE_PREFIX = "cache:";

export async function cacheKey(toolName: string, args: unknown): Promise<string> {
	const data = new TextEncoder().encode(`${toolName}:${JSON.stringify(args ?? {})}`);
	const buf = await crypto.subtle.digest("SHA-256", data);
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return CACHE_PREFIX + hex;
}

// A tool result is a JSON-RPC `result` object; Kagi signals tool failure with
// `result.isError === true` (still HTTP 200), which we must never cache.
export function isCacheableResult(rpc: JsonRpc | null): boolean {
	return Boolean(rpc && rpc.result && rpc.result.isError !== true && !rpc.error);
}

// ---- Audit -----------------------------------------------------------------
// Structured line → Workers Logs (observability is enabled), queryable in the
// dashboard. Logs metadata only: never the full result payload.

export function audit(entry: Record<string, unknown>): void {
	console.log(`audit ${JSON.stringify(entry)}`);
}
