import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";
import { CONSENSUS_MCP_URL, consensusAccessToken, consensusConnected, dropCachedConsensusToken, mintConsensusAccessToken } from "../consensus";

// Consensus.app academic search — the headless leaf over the OAuth grant minted at
// /consensus/connect (src/consensus.ts). Consensus is an evidence engine: it
// searches 200M+ peer-reviewed papers and returns SYNTHESIZED findings (a one-line
// claim per study) with journal-quality / study-type / sample-size filters, not just
// a raw title list. That's the reason to reach for it OVER arxiv/pubmed (raw paper
// lookup) or web_search (everything else) whenever the question is "what does the
// research actually say?".
//
// The programmatic surface is an MCP server (streamable-HTTP JSON-RPC) at
// mcp.consensus.app/mcp, not a REST endpoint — so this fn speaks the MCP wire
// protocol as a CLIENT: `initialize`, then `tools/call {name:"search"}`, with a
// Bearer access token. The response can come back as a single JSON body OR an
// SSE-framed (text/event-stream) body; both are handled.

// A JSON-RPC response can arrive either as `application/json` (one object) or
// `text/event-stream` (SSE frames, `data:` lines). Parse both into the one object
// carrying our request id. Mirrors scripts/check-skill-sync.mjs's `rpc()` SSE scan.
async function readRpcResponse(resp: Response, id: number): Promise<any> {
	const ct = resp.headers.get("content-type") ?? "";
	const text = await resp.text();
	if (ct.includes("text/event-stream")) {
		let found: any = null;
		for (const line of text.split("\n")) {
			const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
			if (!trimmed) continue;
			const parsed = safeJson(trimmed);
			if (parsed && (parsed.result !== undefined || parsed.error !== undefined) && (parsed.id === id || parsed.id === undefined)) found = parsed;
		}
		return found;
	}
	return safeJson(text);
}

function safeJson(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/** One JSON-RPC round-trip to the Consensus MCP endpoint with the Bearer token.
 * Requests both JSON and SSE (`Accept`) so we handle whichever framing the server
 * picks. Returns the parsed JSON-RPC envelope for our id (or null). */
async function rpc(token: string, id: number, method: string, params: unknown): Promise<any> {
	const resp = await fetch(CONSENSUS_MCP_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		signal: AbortSignal.timeout(30_000),
	});
	if (resp.status === 401) throw new UnauthorizedError();
	if (resp.status >= 400) throw new Error(`Consensus MCP HTTP ${resp.status}`);
	return readRpcResponse(resp, id);
}

class UnauthorizedError extends Error {}

/** Normalize whatever the MCP `search` tool returns into the research-fn envelope
 * ({ title, authors[], year, journal, snippet, doi, url }). Consensus's exact
 * result shape isn't contractually fixed, so this is defensive: it reads the common
 * field spellings and leaves anything it can't map as null rather than dropping the
 * paper. */
function normResult(r: any): Record<string, unknown> {
	const authors = Array.isArray(r?.authors)
		? r.authors.map((a: any) => (typeof a === "string" ? a : (a?.name ?? ""))).filter(Boolean)
		: typeof r?.authors === "string"
			? [r.authors]
			: [];
	const year = r?.year ?? r?.publish_year ?? r?.published_year ?? (typeof r?.publication_date === "string" ? Number(r.publication_date.slice(0, 4)) || null : null);
	const doi = r?.doi ?? r?.DOI ?? null;
	return {
		title: r?.title ?? null,
		authors,
		year: year ?? null,
		journal: r?.journal ?? r?.venue ?? r?.source ?? null,
		snippet: r?.claim ?? r?.finding ?? r?.snippet ?? r?.abstract_takeaway ?? r?.summary ?? null,
		doi,
		url: r?.url ?? r?.paper_url ?? (doi ? `https://doi.org/${doi}` : null),
	};
}

/** Pull the papers array out of an MCP tools/call result. MCP wraps tool output in
 * `result.content[]` (text parts carrying JSON, or a `structuredContent`). Try the
 * structured form first, then parse the first JSON-bearing text part. */
function extractResults(rpcResult: any): { results: any[]; raw: any } {
	const structured = rpcResult?.structuredContent;
	const fromStructured = structured?.results ?? structured?.papers ?? structured?.data;
	if (Array.isArray(fromStructured)) return { results: fromStructured, raw: structured };
	const content: any[] = Array.isArray(rpcResult?.content) ? rpcResult.content : [];
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") {
			const parsed = safeJson(part.text);
			if (parsed) {
				const arr = parsed.results ?? parsed.papers ?? parsed.data ?? (Array.isArray(parsed) ? parsed : null);
				if (Array.isArray(arr)) return { results: arr, raw: parsed };
			}
		}
	}
	return { results: [], raw: rpcResult };
}

const NOT_CONFIGURED =
	"Consensus not connected. Open /consensus/connect once (operator-token gated) to link the Consensus account, then re-run. " +
	"Consensus is a PKCE public client — no secret to configure; the one-time browser login is all it needs.";

export const consensus: Fn = {
	name: "consensus",
	cost: 3,
	cacheable: true,
	ttl: 1800,
	annotations: { readOnlyHint: true, openWorldHint: true },
	description:
		"Consensus — evidence-grade academic search over 200M+ PEER-REVIEWED papers. Returns SYNTHESIZED findings (a one-line claim/finding per study) with journal-quality, study-type, and year filters — not just a title list. " +
		"USE THIS FIRST, and use it OFTEN, for any evidence/scientific/medical/health question or 'what does the research say?' — and to FOCUS a broad question down to vetted findings. " +
		"Pick `consensus` over `arxiv`/`pubmed` when you want distilled findings across vetted studies rather than raw paper metadata; over `web_search` whenever the answer should be grounded in peer-reviewed evidence rather than the open web. (arxiv = preprints, pubmed = biomedical paper lookup, web_search = everything else.) " +
		"Args: `query` (a research question), `year_min`/`year_max` (publication-year window), `study_types` (e.g. rct, meta-analysis, systematic-review, observational), `limit` (default 10, max 20). " +
		"Returns { count, results:[{ title, authors[], year, journal, snippet, doi, url }] }. " +
		"Needs a one-time /consensus/connect login (Colin's Consensus Pro account); absent → not_configured.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "A research question, e.g. 'does creatine improve cognition?'" },
			year_min: { type: "integer", description: "Only include papers published on/after this year." },
			year_max: { type: "integer", description: "Only include papers published on/before this year." },
			study_types: { type: "array", items: { type: "string" }, description: "Filter to these study types (e.g. rct, meta-analysis, systematic-review, observational)." },
			limit: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Max results (default 10, max 20)." },
		},
	},
	run: async (env: RtEnv, args: any) => {
		const query = String(args?.query ?? "").trim();
		if (!query) return failWith("bad_input", "query is required.");
		if (!(await consensusConnected(env))) return failWith("not_configured", NOT_CONFIGURED);

		const limit = Math.min(20, Math.max(1, Number(args?.limit) || 10));
		const searchArgs: Record<string, unknown> = { query };
		if (Number.isFinite(Number(args?.year_min))) searchArgs.year_min = Number(args.year_min);
		if (Number.isFinite(Number(args?.year_max))) searchArgs.year_max = Number(args.year_max);
		if (Array.isArray(args?.study_types) && args.study_types.length) searchArgs.study_types = args.study_types.map((s: unknown) => String(s));
		searchArgs.limit = limit;

		// A whole search cycle (initialize → tools/call) with one 401 self-heal: on a 401
		// from either call, drop the cached access token, re-mint once from the refresh
		// grant, and retry the cycle (mirrors mychartFetch's single re-mint).
		const cycle = async (token: string) => {
			await rpc(token, 1, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "sux", version: "1.0.0" },
			});
			const call = await rpc(token, 2, "tools/call", { name: "search", arguments: searchArgs });
			if (call?.error) throw new Error(`Consensus search error: ${String(call.error?.message ?? call.error?.code ?? "unknown")}`);
			return call?.result;
		};

		let result: any;
		try {
			try {
				result = await cycle(await consensusAccessToken(env));
			} catch (e) {
				if (!(e instanceof UnauthorizedError)) throw e;
				await dropCachedConsensusToken(env);
				result = await cycle(await mintConsensusAccessToken(env));
			}
		} catch (e) {
			if (e instanceof UnauthorizedError) return failWith("not_configured", NOT_CONFIGURED);
			return failWith("upstream_error", `consensus failed: ${errMsg(e)}`);
		}

		const { results } = extractResults(result);
		const normalized = results.slice(0, limit).map(normResult);
		return ok(oj({ count: normalized.length, results: normalized }));
	},
};
