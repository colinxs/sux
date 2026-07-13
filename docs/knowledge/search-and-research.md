# Search & Research APIs — durable reference

**What's here:** every external SEARCH and RESEARCH API the sux Worker calls, distilled from the fn source (ground truth for auth + endpoints) and web-confirmed for base URLs, current (2026) rate limits, and canonical/OpenAPI docs. This file exists so future sessions never re-fetch these vendor docs. Each entry names the exact sux fn file:line that shapes the call. Line numbers are approximate — grep the fn if drifted. Ground-truth rule: **the code decides auth + endpoint; this doc annotates limits + refs.** All research-DB fns return normalized JSON via `oj(...)` and are `cacheable` (TTLs noted). Secrets live in Worker secrets / `sux/.dev.vars`; keyless fns take none.

---

## Web search engines

### Kagi (Search API)
- **Purpose**: Flagship keyed web search — the default engine for both `search` and `web_search`; also `news/videos/podcasts/images` workflows and domain/lens scoping.
- **Auth**: `KAGI_API_KEY` → `Authorization: Bearer <key>` header. Called through Kagi's **hosted MCP** (JSON-RPC `tools/call`), not a REST search endpoint.
- **Base URL**: `https://mcp.kagi.com/mcp` (`sux/src/kagi.ts:7`)
- **Endpoints/methods sux calls**: JSON-RPC `tools/call` with `name: "kagi_search_fetch"`, args `{query, limit, workflow, include_domains, exclude_domains, time_relative, after, before, file_type, lens_id}` — `sux/src/kagi.ts:13` (`kagiTool`), driven by `sux/src/fns/search.ts:44` and `sux/src/fns/web_search.ts:116` (`kagi()` parses the markdown `### [title](url)` blocks the MCP returns).
- **Code pattern** (`sux/src/kagi.ts:14`):
  ```ts
  const resp = await smartFetch(env, "https://mcp.kagi.com/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.KAGI_API_KEY}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args } }),
  }, route);
  ```
- **Limits/gotchas**: `mcp.kagi.com` is a DIRECT host (egresses direct under `route: "auto"`; pass `proxy: true` to originate from the residential Tailscale exit, with direct fallback if the node is down). The Search API is **metered ~$25/1k queries and still invite-only in 2026** — no subscription tier includes API credits. Lens IDs: Academic=2, Forums=1, Programming=15, News360=29, Recipes=120, Small Web=107.
- **Refs**: https://help.kagi.com/kagi/api/search.html · MCP: https://help.kagi.com/kagi/api/mcp.html

### Kagi (Session-Link scrape — free/unmetered, NOT yet shipped in code)
- **Purpose**: Drive Colin's paid Kagi **subscription** programmatically (free/unmetered on Professional/Ultimate) instead of the metered Search API. Staged design; **not wired into `web_search.ts` yet** (blocked on the secret for live parser verification).
- **Auth**: `KAGI_SESSION` = the token from Kagi Settings → **Session Link** (`https://kagi.com/search?token=<THIS>`). Sent as `Cookie: kagi_session=<KAGI_SESSION>`. Full-account credential — Colin sets it as a Worker secret himself. Rotatable (regenerating the Session Link rotates it).
- **Base URL**: `https://kagi.com/html/search?q=<urlencoded>` (no-JS server-rendered variant). Summarizer at `https://kagi.com/mother/summary_labs`.
- **Endpoints/methods sux calls**: none yet — planned `kagi_session` engine in `web_search.ts` (ENGINES/available/schema ~L130–208), made the dynamic default when `KAGI_SESSION` is set. Fetch via **residential proxy** + Safari-like UA (dodges datacenter-IP heuristics). Parse HTML with kagi-ken's cheerio selectors into `{t,url,title,snippet}` (t:0 web, t:1 related).
- **Code pattern** (planned):
  ```ts
  const resp = await smartFetch(env, `https://kagi.com/html/search?q=${encodeURIComponent(q)}`,
    { headers: { Cookie: `kagi_session=${env.KAGI_SESSION}`, "User-Agent": SAFARI_UA } }, "proxy");
  ```
- **Limits/gotchas**: Draws down normal (unlimited on paid) account search allowance; does NOT touch API balance. **ToS-GRAY** (unofficial automated `/html` access), markup-fragile, session can expire. Do NOT ship the parser unverified — fetch a live sample once the secret is set and confirm selectors.
- **Refs**: community tooling `kagi-ken` (selectors to port). Memory: `kagi-session-token-search`.

### Brave (Search API)
- **Purpose**: Keyed JSON web search; one of the `web_search` engines (used only when its secret is set, included in `engine: all`).
- **Auth**: `BRAVE_API_KEY` → `X-Subscription-Token: <key>` header.
- **Base URL**: `https://api.search.brave.com/res/v1/web/search`
- **Endpoints/methods sux calls**: `GET /res/v1/web/search?q=&count=` — `sux/src/fns/web_search.ts:106` (`brave()`), reads `j.web.results[]` → `{title, url, snippet: description}`.
- **Code pattern** (`sux/src/fns/web_search.ts:107`):
  ```ts
  const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`, {
    headers: { "X-Subscription-Token": env.BRAVE_API_KEY, Accept: "application/json" },
  });
  ```
- **Limits/gotchas**: **Brave's free tier was KILLED Feb 2026 — now metered/paid.** Plain `fetch` (no proxy; `api.search.brave.com` is a clean API host).
- **Refs**: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started · OpenAPI: https://api-dashboard.search.brave.com/app/documentation (dashboard exposes the spec)

### DuckDuckGo (keyless HTML scrape)
- **Purpose**: The best **no-key default** engine — cheap keyless web search, no JS.
- **Auth**: none.
- **Base URL**: `https://html.duckduckgo.com/html/?q=<urlencoded>`
- **Endpoints/methods sux calls**: `GET html.duckduckgo.com/html/` via `smartFetch` (residential proxy / curl-impersonate), parsed by `parseDdg()` (unwraps the `//duckduckgo.com/l/?uddg=<encoded>` redirect) — `sux/src/fns/web_search.ts:57` (parser), `:86` (`ddg()`).
- **Code pattern** (`sux/src/fns/web_search.ts:87`):
  ```ts
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const resp = await smartFetch(env, url, { headers: { "Accept-Language": "en-US,en;q=0.9" } },
    route === "direct" ? "auto" : route);
  return parseDdg(await resp.text(), limit);
  ```
- **Limits/gotchas**: Unofficial HTML endpoint — markup-fragile; goes through the residential proxy to dodge datacenter-IP blocks. Title+URL only (no snippet).
- **Refs**: none official (the `/html` endpoint is undocumented).

### Google (native SERP render — keyless, heavy)
- **Purpose**: Real Google results with no SERP-API key; opt-in `engine: google`.
- **Auth**: none, but requires the `render` mac backend (headed browser + CapSolver clears the bot wall). Google gates results behind JS, so a plain fetch returns an empty shell.
- **Base URL**: `https://www.google.com/search?q=<q>&num=<n>&hl=en`
- **Endpoints/methods sux calls**: renders the SERP via `renderHtml(env, url)` (delegates to the `render` fn, `backend: "mac", as: "html", solve: true, wait_ms: 6000` — `sux/src/fns/_util.ts:42`), then `parseGoogleSerp()` extracts anchor+`<h3>` hits, unwrapping `/url?q=` redirects and dropping google/gstatic hosts — `sux/src/fns/web_search.ts:26` (parser), `:98` (`googleDirect()`).
- **Code pattern** (`sux/src/fns/web_search.ts:102`):
  ```ts
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=${Math.min(40, limit + 10)}&hl=en`;
  return parseGoogleSerp(await renderHtml(env, url), limit);
  ```
- **Limits/gotchas**: Heavy/slow (full headed render) — opt-in only. Over-requests (`num = limit+10`, ≤40 ceiling) because host-drops + dedupe shrink the parsed count.
- **Refs**: no official API (SERP scrape). CSE alternative: https://developers.google.com/custom-search/v1/overview (100/day free, narrow).

### Tavily (LLM-oriented search)
- **Purpose**: LLM-oriented search returning a synthesized `answer` plus ranked results. Standalone `tavily` fn.
- **Auth**: `TAVILY_API_KEY` — sent in the **JSON body** (`api_key` field), not a header.
- **Base URL**: `https://api.tavily.com/search`
- **Endpoints/methods sux calls**: `POST /search` body `{api_key, query, max_results, include_answer: true, search_depth}` — `sux/src/fns/tavily.ts:45`. Reads `j.answer` + `j.results[]` → `{title, url, content, score}`.
- **Code pattern** (`sux/src/fns/tavily.ts:45`):
  ```ts
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query,
      max_results: maxResults, include_answer: true, search_depth: depth }),
  });
  ```
- **Limits/gotchas**: **Free 1,000 requests/mo** (2026) — the best keyed free backstop. `depth`: `basic` (fast) or `advanced` (deeper, costs more credits). Plain fetch, no proxy. `ttl: 600`.
- **Refs**: https://docs.tavily.com/ · OpenAPI: https://docs.tavily.com/documentation/api-reference/introduction

### Exa (neural search / find-similar)
- **Purpose**: Neural "more like this" — semantic similar-pages from a URL, or a neural web-search query. Standalone `find_similar` fn.
- **Auth**: `EXA_API_KEY` → `x-api-key: <key>` header.
- **Base URL**: `https://api.exa.ai`
- **Endpoints/methods sux calls**: `POST /findSimilar` body `{url, numResults}` OR `POST /search` body `{query, numResults, type: "neural"}` (exactly one of url/query) — `sux/src/fns/find_similar.ts:33`. Normalizes `results[]` → `{title, url, published, author, score}`.
- **Code pattern** (`sux/src/fns/find_similar.ts:36`):
  ```ts
  const endpoint = url ? "https://api.exa.ai/findSimilar" : "https://api.exa.ai/search";
  const body = url ? { url, numResults } : { query, numResults, type: "neural" };
  const resp = await fetch(endpoint, { method: "POST",
    headers: { "x-api-key": env.EXA_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  ```
- **Limits/gotchas**: Paid API (key at exa.ai); free trial credits only, no standing free tier. Plain fetch, no proxy. `ttl: 900`.
- **Refs**: https://docs.exa.ai/reference/getting-started · OpenAPI: https://docs.exa.ai/reference/openapi-spec

---

## Research databases

All keyless-first, plain `fetch` (public academic/gov APIs, no bot wall — **no residential proxy**), except Reddit (proxy-gated). `oj(...)` JSON out.

### arXiv
- **Purpose**: Preprint search — physics, math, CS, quant-bio, etc. (`arxiv` fn).
- **Auth**: none.
- **Base URL**: `http://export.arxiv.org/api/query` (note: **http**, Atom XML out).
- **Endpoints/methods sux calls**: `GET /api/query?search_query=all:<term>&start=0&max_results=<n>&sortBy=<relevance|lastUpdatedDate|submittedDate>` — `sux/src/fns/arxiv.ts:75`. Parses `<entry>` Atom via regex → `{id, title, authors[], summary, published, url, pdf_url, categories[]}`.
- **Code pattern** (`sux/src/fns/arxiv.ts:75`):
  ```ts
  const p = new URLSearchParams({ search_query: `all:${term}`, start: "0",
    max_results: String(maxResults), sortBy });
  const resp = await fetch(`http://export.arxiv.org/api/query?${p}`);
  ```
- **Limits/gotchas**: Recommended ≤1 request per 3 seconds; max 30,000 results per query, page ≤2,000. `max_results` capped at 50 in the fn. `ttl: 1800`.
- **Refs**: https://info.arxiv.org/help/api/user-manual.html

### PubMed / NCBI E-utilities
- **Purpose**: Biomedical / life-sciences literature (`pubmed` fn).
- **Auth**: optional `NCBI_API_KEY` → `&api_key=<key>` query param (raises rate limit; not required).
- **Base URL**: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils`
- **Endpoints/methods sux calls**: two hops — `GET /esearch.fcgi?db=pubmed&term=<t>&retmax=<n>&retmode=json` (term→PMIDs) then `GET /esummary.fcgi?db=pubmed&id=<csv>&retmode=json` (PMIDs→metadata) — `sux/src/fns/pubmed.ts:58,63`. Out: `{pmid, title, authors[], journal, pubdate, doi, url}`.
- **Code pattern** (`sux/src/fns/pubmed.ts:58`):
  ```ts
  const key = env.NCBI_API_KEY ? `&api_key=${encodeURIComponent(env.NCBI_API_KEY)}` : "";
  const search = await getJson(`${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmax=${retmax}&retmode=json${key}`);
  const summary = await getJson(`${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json${key}`);
  ```
- **Limits/gotchas**: **3 req/s without key, 10 req/s with an API key** (2026); >10 rps by request. NCBI asks for `tool` + `email` params for heavy use. `retmax` capped 50. `ttl: 1800`.
- **Refs**: https://www.ncbi.nlm.nih.gov/books/NBK25497/ · key mgmt: https://support.nlm.nih.gov/kbArticle/?pn=KA-05317

### Semantic Scholar (Academic Graph)
- **Purpose**: ~200M-paper Academic Graph search across every field (`semantic_scholar` fn).
- **Auth**: optional `S2_API_KEY` → `x-api-key: <key>` header (raises limit).
- **Base URL**: `https://api.semanticscholar.org/graph/v1/paper/search`
- **Endpoints/methods sux calls**: `GET /graph/v1/paper/search?query=<t>&limit=<n>&fields=title,abstract,year,authors,citationCount,url,externalIds,openAccessPdf` — `sux/src/fns/semantic_scholar.ts:46`. Out: `{id, title, abstract, year, authors[], citations, url, pdf}`.
- **Code pattern** (`sux/src/fns/semantic_scholar.ts:46`):
  ```ts
  const p = new URLSearchParams({ query: term, limit: String(limit), fields: FIELDS });
  const headers: Record<string,string> = { Accept: "application/json" };
  if (env?.S2_API_KEY) headers["x-api-key"] = env.S2_API_KEY;
  const resp = await fetch(`${API}?${p}`, { headers });
  ```
- **Limits/gotchas**: Unauthenticated is a **shared pool ~5,000 req / 5 min** (throttled under load). An API key's **introductory limit is 1 rps** on all endpoints (request higher). `limit` capped 50. Reads `j.data`. `ttl: 1800`.
- **Refs**: https://api.semanticscholar.org/api-docs/ · https://www.semanticscholar.org/product/api

### Crossref (Works)
- **Purpose**: Scholarly DOI metadata across every discipline (`crossref` fn).
- **Auth**: none (fn sends no `mailto`; see gotcha).
- **Base URL**: `https://api.crossref.org/works`
- **Endpoints/methods sux calls**: `GET /works?query=<t>&rows=<n>` — `sux/src/fns/crossref.ts:47`. Reads `j.message.items[]` → `{doi, title, authors[], journal, year, citations, url}`.
- **Code pattern** (`sux/src/fns/crossref.ts:47`):
  ```ts
  const p = new URLSearchParams({ query: term, rows: String(rows) });
  const resp = await fetch(`https://api.crossref.org/works?${p}`);
  ```
- **Limits/gotchas**: Public pool is rate-limited and best-effort; the **"polite pool" (faster/more reliable) requires a `mailto`** query param or `User-Agent` — the fn currently sends neither, so it rides the anonymous pool. `rows` capped 50. `ttl: 1800`.
- **Refs**: https://api.crossref.org/swagger-ui/index.html (Swagger/OpenAPI) · https://www.crossref.org/documentation/retrieve-metadata/rest-api/

### OpenAlex (Works)
- **Purpose**: 250M+ open scholarly graph with citations + OA links (`openalex` fn).
- **Auth**: none — sends a `mailto` politeness param for the faster pool.
- **Base URL**: `https://api.openalex.org/works`
- **Endpoints/methods sux calls**: `GET /works?search=<t>&per-page=<n>&mailto=colinxsummers@gmail.com` — `sux/src/fns/openalex.ts:48`. Out: `{id, title, year, authors[], doi, citations, url, oa_url}`.
- **Code pattern** (`sux/src/fns/openalex.ts:48`):
  ```ts
  const p = new URLSearchParams({ search: term, "per-page": String(perPage),
    mailto: "colinxsummers@gmail.com" });
  const resp = await fetch(`https://api.openalex.org/works?${p}`);
  ```
- **Limits/gotchas**: Free; **100,000 calls/day, max 10 req/s**. The `mailto` routes into the polite pool (harmless if absent). `per_page` capped 50 here (API allows 200). `ttl: 1800`.
- **Refs**: https://docs.openalex.org/ · OpenAPI: https://docs.openalex.org/how-to-use-the-api/api-overview

### Stack Exchange
- **Purpose**: Q&A search across any network site (Stack Overflow, Super User, Server Fault, …) (`stackexchange` fn).
- **Auth**: optional `STACKEXCHANGE_KEY` → `&key=<key>` query param (raises quota).
- **Base URL**: `https://api.stackexchange.com/2.3/search/advanced`
- **Endpoints/methods sux calls**: `GET /2.3/search/advanced?order=desc&sort=relevance&q=<t>&site=<slug>&pagesize=<n>&filter=withbody` — `sux/src/fns/stackexchange.ts:54`. Reads `j.items[]` → `{title, url, score, answered, answers, tags[], created}`.
- **Code pattern** (`sux/src/fns/stackexchange.ts:54`):
  ```ts
  const p = new URLSearchParams({ order: "desc", sort: "relevance", q: term,
    site, pagesize: String(pagesize), filter: "withbody" });
  if (env?.STACKEXCHANGE_KEY) p.set("key", env.STACKEXCHANGE_KEY);
  const resp = await fetch(`${API}?${p}`);
  ```
- **Limits/gotchas**: **~300 req/day/IP without a key; 10,000 req/day with a registered key.** Also a short-term throttle (backoff field in responses). Responses are gzipped — a direct fetch auto-decompresses. `site` defaults `stackoverflow`; `pagesize` capped 30. HTML entities in titles are decoded. `ttl: 900`.
- **Refs**: https://api.stackexchange.com/docs · register keys: https://stackapps.com/apps/oauth/register

### Reddit (read-only)
- **Purpose**: Search posts, browse a subreddit, read a post's comments, look up a user (`reddit` fn).
- **Auth**: **Keyless-first** — public `.json` endpoints, no creds. Auto-upgrades to **app-only OAuth** when `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` are both set (KV-cached bearer). Reddit blocks self-serve OAuth app creation now, so keyless is the default path.
- **Base URLs**: keyless `https://www.reddit.com` (append `.json`); OAuth token `https://www.reddit.com/api/v1/access_token`, API `https://oauth.reddit.com`.
- **Endpoints/methods sux calls** (`sux/src/fns/reddit.ts`): search `/search` or `/r/<sub>/search?restrict_sr=1` (:239), subreddit `/r/<sub>/<sort>` (:199), comments `/comments/<id>` (:207), user `/user/<name>/about` (:217). Token minted at `mintToken()` (:38) via `grant_type=client_credentials`. Keyless fetch goes through the **residential proxy** (Reddit blocks datacenter IPs).
- **Code pattern** (keyless, `sux/src/fns/reddit.ts:99`):
  ```ts
  // publicUrl() inserts ".json" before any query string
  const resp = await smartFetch(env, publicUrl(path),
    { headers: { "User-Agent": "sux/1.0 (+https://github.com/colinxs/sux)" } }, "proxy");
  ```
- **Limits/gotchas**: A stable, descriptive `User-Agent` rides EVERY request on both paths (Reddit blocks default UAs). OAuth ~100 QPM/client; keyless is unmetered-ish but IP-block-prone → surfaces `failWith("blocked")` on 403/empty/HTML-challenge (retryable, hints the OAuth upgrade). OAuth path self-heals a rejected token (drops KV, re-mints once on 401/403). Cached token TTL = `expires_in − 60`, ≥60s (KV floor). `ttl: 300`.
- **Refs**: https://www.reddit.com/dev/api/ · OAuth: https://github.com/reddit-archive/reddit/wiki/OAuth2

### ClinicalTrials.gov
- **Purpose**: NIH registry of clinical studies worldwide (`clinical_trials` fn).
- **Auth**: none.
- **Base URL**: `https://clinicaltrials.gov/api/v2/studies`
- **Endpoints/methods sux calls**: `GET /api/v2/studies?query.term=<t>&pageSize=<n>&format=json` — `sux/src/fns/clinical_trials.ts:42`. Digs `protocolSection` → `{nct_id, title, status, conditions[], phases[], url}`.
- **Code pattern** (`sux/src/fns/clinical_trials.ts:42`):
  ```ts
  const p = new URLSearchParams({ "query.term": term, pageSize: String(pageSize), format: "json" });
  const resp = await fetch(`https://clinicaltrials.gov/api/v2/studies?${p}`);
  ```
- **Limits/gotchas**: Free, no key, no published hard rate limit (be reasonable). API **v2** (v1 retired June 2024). `pageSize` capped 50 here (API allows up to 1000); paging via `pageToken` (not used by the fn). `ttl: 1800`.
- **Refs**: https://clinicaltrials.gov/data-api/api · OpenAPI: https://clinicaltrials.gov/data-api/about-api/api-migration (v2 spec linked there)

---

## Cross-cutting notes

- **`smartFetch(env, url, init, route)`** (`sux/src/proxy.ts`): `route` = `"auto"` (direct for DIRECT_HOST hosts, else proxy) | `"proxy"` (residential Tailscale exit, direct fallback if node down) | `"direct"`. Used by Kagi, DDG, Reddit-keyless. The pure academic/gov DBs use plain `fetch` (no wall).
- **`renderHtml(env, url, opts)`** (`sux/src/fns/_util.ts:42`): post-JS HTML via the `render` mac backend (headed browser + CapSolver). Google SERP path; `solve: true`, `wait_ms: 6000` defaults.
- **Engine selection in `web_search`** (`sux/src/fns/web_search.ts:130` ENGINES, `:138` available): keyed engines (`kagi`, `brave`) appear only when their secret is set; `engine: all` fans out concurrently, merges/dedupes by normalized URL with consensus ranking, and with `summarize: true` reduces via Workers AI (`llm`) with `[n]` citations.
- **2026 free-tier status (memory `kagi-session-token-search`):** DDG keyless ✅ free backstop · Brave free ❌ killed Feb 2026 · Bing Web Search API ❌ retired Aug 2025 · Google CSE 100/day free but narrow · Tavily 1k/mo ✅ best keyed free backstop.
