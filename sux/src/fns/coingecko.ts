import { type Fn, fail, ok } from "../registry";
import { oj } from "./_util";

// CoinGecko (api.coingecko.com) — keyless free tier for crypto prices and coin
// search. No residential proxy: a public market-data API with no bot wall. Two
// actions: price (simple/price for given coin ids) and search (coins matching a
// term). Prices are volatile, so a short cache ttl.

const API = "https://api.coingecko.com/api/v3";

async function getJson(url: string): Promise<{ ok: boolean; status: number; json: any }> {
	const resp = await fetch(url, { headers: { Accept: "application/json" } });
	if (!resp.ok) return { ok: false, status: resp.status, json: null };
	return { ok: true, status: resp.status, json: await resp.json() };
}

export const coingecko: Fn = {
	name: "coingecko",
	description:
		"CoinGecko (keyless, free) — crypto prices and coin search. `action`: search (coins matching a `term` → { id, name, symbol, market_cap_rank }), price (spot prices for comma-separated coin `ids`, with 24h change). Prices via `currency` (default usd). Returns normalized JSON.",
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
	run: async (_env, args) => {
		const action = String(args?.action ?? "search");

		if (action === "price") {
			const ids = String(args?.ids ?? "").trim();
			if (!ids) return fail("action=price requires `ids` (comma-separated coin ids).");
			const currency = (String(args?.currency ?? "usd").trim() || "usd").toLowerCase();
			const p = new URLSearchParams({ ids, vs_currencies: currency, include_24hr_change: "true" });
			let r: { ok: boolean; status: number; json: any };
			try {
				r = await getJson(`${API}/simple/price?${p}`);
			} catch (e) {
				return fail(`CoinGecko fetch failed: ${String((e as Error)?.message ?? e)}`);
			}
			if (!r.ok) return fail(`CoinGecko API HTTP ${r.status}.`);
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
			r = await getJson(`${API}/search?${new URLSearchParams({ query: term })}`);
		} catch (e) {
			return fail(`CoinGecko fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!r.ok) return fail(`CoinGecko API HTTP ${r.status}.`);
		const coins = (r.json?.coins ?? []).map((c: any) => ({
			id: c?.id ?? null,
			name: c?.name ?? null,
			symbol: c?.symbol ?? null,
			market_cap_rank: c?.market_cap_rank ?? null,
		}));
		return ok(oj({ action, count: coins.length, coins }));
	},
};
