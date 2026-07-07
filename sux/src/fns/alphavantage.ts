import { type Fn, fail, ok } from "../registry";

// Alpha Vantage (alphavantage.co) — official, free stock/market data over a plain
// REST endpoint; one apiKey rides the query string. `quote` fetches a real-time
// global quote for a symbol; `search` resolves a keyword to matching symbols.

const API = "https://www.alphavantage.co/query";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

async function api(url: string): Promise<any> {
	const resp = await fetch(url, { headers: { Accept: "application/json" } });
	if (!resp.ok) throw new Error(`Alpha Vantage HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	const j = await resp.json();
	// Alpha Vantage returns HTTP 200 with a Note/Information/Error Message body when
	// rate-limited or misconfigured; surface it as an error rather than empty data.
	const notice = (j as any)?.Note ?? (j as any)?.Information ?? (j as any)?.["Error Message"];
	if (notice) throw new Error(String(notice).slice(0, 300));
	return j;
}

function normQuote(q: any): Record<string, unknown> {
	return {
		symbol: q?.["01. symbol"],
		price: q?.["05. price"] !== undefined ? Number(q["05. price"]) : undefined,
		change: q?.["09. change"] !== undefined ? Number(q["09. change"]) : undefined,
		change_percent: q?.["10. change percent"],
		volume: q?.["06. volume"] !== undefined ? Number(q["06. volume"]) : undefined,
		latest_trading_day: q?.["07. latest trading day"],
	};
}

function normMatch(m: any): Record<string, unknown> {
	return {
		symbol: m?.["1. symbol"],
		name: m?.["2. name"],
		type: m?.["3. type"],
		region: m?.["4. region"],
		currency: m?.["8. currency"],
		match_score: m?.["9. matchScore"] !== undefined ? Number(m["9. matchScore"]) : undefined,
	};
}

export const alphavantage: Fn = {
	name: "alphavantage",
	description:
		"Alpha Vantage (official, free) — real-time stock quotes and symbol search. " +
		"`action`: quote (global quote for `symbol`), search (resolve `term` to matching symbols). " +
		"Needs ALPHAVANTAGE_KEY (free at alphavantage.co/support/#api-key). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["quote", "search"], default: "quote" },
			symbol: { type: "string", description: "Ticker symbol (action=quote), e.g. IBM." },
			term: { type: "string", description: "Keyword to resolve to symbols (action=search)." },
		},
	},
	cacheable: true,
	ttl: 120,
	run: async (env, args) => {
		if (!env.ALPHAVANTAGE_KEY) return fail("Alpha Vantage not configured (ALPHAVANTAGE_KEY). Free key at alphavantage.co/support/#api-key.");

		const action = String(args?.action ?? "quote");
		const key = env.ALPHAVANTAGE_KEY;

		try {
			if (action === "search") {
				const term = String(args?.term ?? "").trim();
				if (!term) return fail("action=search requires a `term`.");
				const p = new URLSearchParams({ function: "SYMBOL_SEARCH", keywords: term, apikey: key });
				const j = await api(`${API}?${p}`);
				const matches = (j?.bestMatches ?? []).map(normMatch);
				return ok(JSON.stringify({ provider: "alphavantage", action, count: matches.length, matches }, null, 2));
			}

			// action === "quote"
			const symbol = String(args?.symbol ?? "").trim();
			if (!symbol) return fail("action=quote requires a `symbol`.");
			const p = new URLSearchParams({ function: "GLOBAL_QUOTE", symbol, apikey: key });
			const j = await api(`${API}?${p}`);
			const q = j?.["Global Quote"];
			if (!q || q?.["01. symbol"] === undefined) return fail(`No Alpha Vantage quote found for '${symbol}'.`);
			return ok(JSON.stringify({ provider: "alphavantage", action, quote: normQuote(q) }, null, 2));
		} catch (e) {
			return fail(`alphavantage (${action}) failed: ${errMsg(e)}`);
		}
	},
};
