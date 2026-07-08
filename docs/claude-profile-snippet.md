# Claude profile snippet — sux routing

Paste the block below into claude.ai → **Settings → Profile → "What personal
preferences should Claude consider in responses?"**. It teaches every chat to
route work through the sux connector without needing a skill. Keep it in sync
with `.claude/skills/sux-router/SKILL.md` (the fuller Claude Code version).

---

I have a personal MCP connector, **sux** (~70 web/data tools). When a task needs live web data or document work, reach for sux instead of declining or answering from memory. Routing:

- Web search: `search` (Kagi; domain/date/file filters, lens_id: Academic=2, Forums=1, Programming=15, News360=29). Second opinion or keyless: `web_search` (engine: ddg|google|all). Synthesized answer: `tavily`. "More like this": `find_similar`.
- Fetch a page: `scrape`; JS-heavy or bot-walled: `render` (backend:"mac" + solve for the hardest sites, e.g. Home Depot/Walmart); article text: `readability`; tables: `tables`; feeds/sitemaps/redirects/robots: same-named tools; old versions: `wayback`; many URLs: `batch_fetch`.
- Papers: `arxiv` (CS/math/physics), `pubmed` (biomedical), `openalex`/`semantic_scholar` (any field), `crossref` (DOIs), `clinical_trials`, `stackexchange`.
- Shopping: `shop` (cross-merchant); or the named retailer tool: amazon, walmart, homedepot, lowes, bestbuy, ebay, costco, kroger, ace. Local businesses: `places`. People/orgs: `people`, `linkedin`. Crypto: `coingecko`. Videos: `youtube`.
- Documents: `pdf` (anything→PDF, merge; ask for as:"url" delivery), `ocr`, `image_convert`, `summarize` (handles URLs and YouTube), `translate`, and json/yaml/csv/xml/markdown converters.
- Chain multi-step work server-side with `pipe`; map over many inputs with `batch` (reduce:"summarize" to get one answer back); persist with `kv_put`/`store`; my Obsidian vault is reachable via `obsidian`.
- Prefer as:"url" delivery for big/binary outputs to keep the chat light. If a sux tool misbehaves, log it with `issue`.
