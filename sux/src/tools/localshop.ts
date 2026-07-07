import { extractRpcFromText } from "../mcp-util";
import { smartFetch, type TailscaleEnv } from "../proxy";

// Env needed to call Kagi (key) and route via the residential proxy.
type ShopEnv = { KAGI_API_KEY: string } & TailscaleEnv;
const KAGI_MCP_URL = "https://mcp.kagi.com/mcp";

export const LOCAL_SHOP_TOOL = {
	name: "kagi_local_shop",
	description:
		"Find a product for sale at stores near a location — like local Google Shopping. Runs a retail search near the location and returns a price-ranked table (store, price, availability, link), reading prices straight from the search results. Prices/stock are best-effort and may be missing or approximate; treat them as a starting point, not a quote.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["product", "location"],
		properties: {
			product: { type: "string", description: "The product to shop for, e.g. 'KitchenAid stand mixer'." },
			location: { type: "string", description: "City/region to bias local results, e.g. 'Austin, TX'." },
			stores: { type: "integer", minimum: 1, maximum: 10, default: 6, description: "Max number of store listings to return." },
		},
	},
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const toolText = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const toolError = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// Hosts that are almost never a store checkout page — skip so we spend our N
// page-extracts on actual retailers.
const NON_STORE_HOSTS = /(^|\.)(wikipedia\.org|reddit\.com|youtube\.com|quora\.com|pinterest\.com|facebook\.com|x\.com|twitter\.com|instagram\.com)$/i;

/**
 * Pull the numbered `### [title](url)` entries — with their snippet text — out of
 * a Kagi search result. Kagi's snippets often carry the price and local store
 * info, so we parse those directly rather than fetching each page.
 */
export function parseSearchResults(md: string): Array<{ title: string; url: string; host: string; snippet: string }> {
	const out: Array<{ title: string; url: string; host: string; snippet: string }> = [];
	// Each result starts at a `### [` heading; split into per-result blocks.
	for (const block of md.split(/\n(?=###\s*\[)/)) {
		const m = block.match(/###\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
		if (!m) continue;
		let host = "";
		let path = "";
		try {
			const u = new URL(m[2]);
			host = u.host;
			path = u.pathname;
		} catch {
			continue;
		}
		if (NON_STORE_HOSTS.test(host)) continue;
		// Drop image/asset/CDN results — not shoppable store pages.
		if (/\.(webp|jpe?g|png|gif|svg|bmp)$/i.test(path)) continue;
		if (/(^|\.)(cdn|fdn|img|imgs|images|media|static|assets)\./i.test(host)) continue;
		if (/cloudfront|-cdn|cdn-|thumbor|vox-cdn/i.test(host)) continue;
		if (/\/(image|images|thumbor|imgroot|photo)\//i.test(path)) continue;
		const snippet = block
			.replace(/###\s*\[[^\]]+\]\([^)]+\)/, "")
			.replace(/\*\*URL:\*\*[^\n]*/g, "")
			.replace(/\*\*Published:\*\*[^\n]*/g, "")
			.replace(/<[^>]+>/g, " ") // strip inline HTML like <strong>
			.replace(/\s+/g, " ")
			.trim();
		out.push({ title: m[1].trim(), url: m[2], host, snippet });
	}
	return out;
}

/**
 * Best-effort price: scan all currency amounts, drop implausibly small ones
 * (e.g. "$1 off" noise), and return the lowest real price — usually the sale
 * price on a "list $X / our $Y" listing.
 */
export function parsePrice(text: string): { raw: string; value: number } | null {
	const re = /(?:USD\s*)?\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)(?!\d)/g;
	let best: { raw: string; value: number } | null = null;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const before = text.slice(Math.max(0, m.index - 9), m.index).toLowerCase();
		const after = text.slice(m.index + m[0].length, m.index + m[0].length + 10).toLowerCase();
		if (/^\s*\/?\s*(mo\b|month)/.test(after)) continue; // financing "$24/mo"
		if (/^\s*off\b/.test(after)) continue; // "$50 off"
		if (/(save|up to)\s*$/.test(before)) continue; // "save $50" / "up to $50"
		const value = Number(m[1].replace(/,/g, ""));
		if (!Number.isFinite(value) || value < 5) continue; // "$1 off"-style noise
		if (best === null || value < best.value) best = { raw: `$${m[1]}`, value };
	}
	return best;
}

/** Best-effort stock signal from page text. */
export function parseAvailability(md: string): string | null {
	if (/\bout of stock\b|\bsold out\b|\bunavailable\b/i.test(md)) return "out of stock";
	if (/\bin stock\b|\bavailable\b/i.test(md)) return "in stock";
	if (/\badd to cart\b|\bbuy now\b|\badd to bag\b/i.test(md)) return "likely available";
	return null;
}

/** Call a real Kagi tool server-side (via the residential proxy when enabled). */
async function kagiToolCall(env: ShopEnv, name: string, args: unknown): Promise<ToolResult | null> {
	const resp = await smartFetch(env, KAGI_MCP_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.KAGI_API_KEY}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	const obj = extractRpcFromText(await resp.text(), resp.headers.get("content-type"));
	return (obj?.result as ToolResult) ?? null;
}

/**
 * Orchestrate a local-shopping query: one retail search → parse price/stock from
 * each result's snippet → render a price-ranked markdown table. Kagi's snippets
 * carry prices for most retail results, so no per-page fetch is needed (which
 * also dodges JS-rendered / anti-bot store pages that return no content).
 */
export async function runLocalShop(env: ShopEnv, args: any): Promise<ToolResult> {
	const product = String(args?.product ?? "").trim();
	const location = String(args?.location ?? "").trim();
	if (!product || !location) return toolError("Both 'product' and 'location' are required.");
	const stores = Math.min(10, Math.max(1, Number(args?.stores) || 6));

	const search = await kagiToolCall(env, "kagi_search_fetch", {
		query: `${product} price ${location}`,
		limit: Math.max(10, stores * 2),
	});
	if (!search || search.isError) return toolError(`Search failed for "${product}" near ${location}.`);

	const results = parseSearchResults(search.content?.[0]?.text ?? "");
	if (results.length === 0) return toolError(`No store listings found for "${product}" near ${location}.`);

	const parsed = results.map((r) => ({ ...r, price: parsePrice(r.snippet), stock: parseAvailability(r.snippet) }));

	// One row per store — keep the priced (cheapest) listing for each host, so a
	// retailer that appears several times (e.g. Amazon search pages) collapses to
	// its best entry.
	const byHost = new Map<string, (typeof parsed)[number]>();
	for (const r of parsed) {
		const cur = byHost.get(r.host);
		if (!cur || (!cur.price && r.price) || (cur.price && r.price && r.price.value < cur.price.value)) {
			byHost.set(r.host, r);
		}
	}

	// Price-ranked: rows with a parsed price first (cheapest → priciest), rest after.
	const rows = [...byHost.values()]
		.sort((a, b) => (a.price?.value ?? Infinity) - (b.price?.value ?? Infinity))
		.slice(0, stores);

	const withPrice = rows.filter((r) => r.price).length;
	const lines = [
		`## Local shopping: "${product}" near ${location}`,
		`_${rows.length} listings, ${withPrice} with a parsed price._`,
		"",
		"| # | Store | Price | Availability | Listing |",
		"|---|-------|-------|--------------|---------|",
		...rows.map(
			(r, i) => `| ${i + 1} | ${r.host} | ${r.price?.raw ?? "—"} | ${r.stock ?? "—"} | [${r.title.slice(0, 50)}](${r.url}) |`,
		),
		"",
		"_Prices & availability are parsed best-effort from Kagi search snippets and may be missing, approximate, or out of date — confirm on the store's site before buying._",
	];
	return toolText(lines.join("\n"));
}
