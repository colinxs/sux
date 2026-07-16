import { type Fn, fail, ok, type RtEnv } from "../registry";
import { oj } from "./_util";

// CoinGecko (api.coingecko.com) — crypto prices and coin search. CoinGecko now
// blocks anonymous datacenter/keyless traffic with a blanket 403 (sux#541); an
// optional COINGECKO_API_KEY (free "Demo" tier, sent as x-cg-demo-api-key) lifts
// that block. No residential proxy: a public market-data API, not a bot wall.
// Two actions: price (simple/price for given coin ids) and search (coins
// matching a term). Prices are volatile, so a short cache ttl.

const API = "https://api.coingecko.com/api/v3";

async function getJson(url: string, apiKey?: string): Promise<{ ok: boolean; status: number; json: any }> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
	const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
	if (!resp.ok) return { ok: false, status: resp.status, json: null };
	return { ok: true, status: resp.status, json: await resp.json() };
}

export const coingecko: Fn = {
	name: "coingecko",
	description:
		"CoinGecko (free; keyless with a lower quota, or COINGECKO_API_KEY for the demo tier) — crypto prices and coin search. `action`: search (coins matching a `term` → { id, name, symbol, market_cap_rank }), price (spot prices for comma-separated coin `ids`, with 24h change). Prices via `currency` (default usd). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["price", "search"], default: "search" },
			term: { type: "string", description: "Search text (action=search)." },
			ids: { type: "string", description: "Comma-separated CoinGecko coin ids, e.g. bitcoin,ethereum (action=price)." },
			currency: { type: "string", default: "usd", description: "Fiat currency for prices (action=price)." },
		},
	},
	cacheable: true,
	ttl: 120,
	run: async (env: RtEnv, args) => {
		const action = String(args?.action ?? "search");
		const apiKey = env?.COINGECKO_API_KEY;
		const forbiddenHint = (status: number) =>
			status === 403 && !apiKey
				? " CoinGecko now blocks unauthenticated/datacenter traffic — set COINGECKO_API_KEY (free Demo tier) to fix."
				: "";

		if (action === "price") {
			const ids = String(args?.ids ?? "").trim();
			if (!ids) return fail("action=price requires `ids` (comma-separated coin ids).");
			const currency = (String(args?.currency ?? "usd").trim() || "usd").toLowerCase();
			const p = new URLSearchParams({ ids, vs_currencies: currency, include_24hr_change: "true" });
			let r: { ok: boolean; status: number; json: any };
			try {
				r = await getJson(`${API}/simple/price?${p}`, apiKey);
			} catch (e) {
				return fail(`CoinGecko fetch failed: ${String((e as Error)?.message ?? e)}`);
			}
			if (!r.ok) return fail(`CoinGecko API HTTP ${r.status}.${forbiddenHint(r.status)}`);
			const prices = Object.entries(r.json ?? {}).map(([id, v]: [string, any]) => ({
				id,
				price: v?.[currency] ?? null,
				change_24h: v?.[`${currency}_24h_change`] ?? null,
			}));
			return ok(oj({ action, currency, count: prices.length, prices }));
		}

		// action === "search"
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("action=search requires a `term`.");
		let r: { ok: boolean; status: number; json: any };
		try {
			r = await getJson(`${API}/search?${new URLSearchParams({ query: term })}`, apiKey);
		} catch (e) {
			return fail(`CoinGecko fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!r.ok) return fail(`CoinGecko API HTTP ${r.status}.${forbiddenHint(r.status)}`);
		const coins = (r.json?.coins ?? []).map((c: any) => ({
			id: c?.id ?? null,
			name: c?.name ?? null,
			symbol: c?.symbol ?? null,
			market_cap_rank: c?.market_cap_rank ?? null,
		}));
		return ok(oj({ action, count: coins.length, coins }));
	},
};
