# research-tools (Service 2)

The rich engine. A **second** Cloudflare Worker (separate from the clean
`kagi-mcp` core) that exposes research + commerce tools and routes **every single
outbound query** through a configurable Tailscale residential node.

## Why it's separate

Service 1 (`../src`, the `kagi-mcp` Worker) stays a clean, reliable path:

```
Claude ──OAuth──▶ CF (OAuthProvider) ──▶ KV (state/cache) ──▶ Worker ──▶ public Kagi MCP
```

Service 2 is where all the heavy, failure-prone stuff lives, so the core never
carries its weight or its dependency on the residential node.

## Architecture

```
Claude ──MCP──▶ research-tools Worker
                    │  tools: kagi_search · scrape · rest · ocr · google · homedepot · local_shop
                    │
                    │  proxyFetch() — EVERY outbound query, no exceptions
                    ▼
        Tailscale node (configurable, residential IP)   ← node/server.mjs
            fetch · render (headless) · screenshot · compress/decompress · convert
                    ▼
        { Kagi MCP, Google, Home Depot, Costco, any URL }
```

- **`proxyFetch` (src/proxy.ts)** — the one and only egress. HMAC-signed
  (secret never on the wire, replay-bounded), host-allowlisted on the node.
  Optional direct fallback for resilience; for the "everything proxies" posture
  it defaults to proxy-required.
- **Tailscale node (node/)** — runs on a residential box in your tailnet, exposed
  via Funnel. Does the actual fetch/render/transform from a residential IP, which
  is what beats the Akamai + datacenter-IP wall (Home Depot, Lowe's, Costco).

## Tools (planned)

| Tool | What | Backing |
|---|---|---|
| `kagi_search` | web search | Kagi Search API (via proxy) |
| `scrape` | fetch + parse a page (JSON-LD, `__NEXT_DATA__`, microdata → structured) | node fetch/render |
| `rest` | authenticated REST calls (e.g. Kroger official API, OAuth `client_credentials`) | node fetch |
| `ocr` | image/screenshot → text | Workers AI `@cf/meta/llama-3.2-11b-vision-instruct` |
| `google` | Google-quality results / knowledge | search + scrape compose |
| `homedepot` | product price/stock/store inventory | node render (residential) → GraphQL `federation-gateway` |
| `local_shop` | local Google-Shopping (search snippets + barcode) | `src/tools/localshop.ts` (moved from core, working) |

## Node is DUMB (no work at the residential node)

The Tailscale node does exactly one thing: **fetch a URL from its residential IP
and return the bytes** (HMAC-authed, SSRF-guarded, host-allowlisted). No parsing,
no rendering, no transforms.

**All work happens in the cloud Worker:** rendering (Cloudflare Browser Run), OCR
(Workers AI vision), structured parsing, compress/convert, and KV caching. The
node only lends its IP. This keeps the box trivial and disposable.

> Caveat this creates: a site that needs *both* JS rendering *and* a residential
> IP (Akamai SPAs) can't be fully solved this way, since Browser Run renders from
> Cloudflare IPs. For those we rely on residential *fetch* of the HTML + cloud
> parsing, or the barcode → Barcode-Lookup fallback.

## Retailer backends (from research)

- **Kroger** → official API (`api.kroger.com`, OAuth `client_credentials`,
  per-store price/stock/aisle). Clean — use the `rest` tool.
- **Ace Hardware** → plain fetch, parse JSON-LD + Kibo JSON. Easy via `scrape`.
- **Home Depot / Lowe's / Costco** → Akamai + datacenter-IP block → require the
  **residential node with render** (`homedepot` tool). Barcode → Barcode Lookup
  is the cheaper fallback for cross-store price.

## Build phases

1. **Scaffold + proxy** — `proxyFetch` (done, moved from core), node fetch (done).
2. **MCP transport** — expose tools over MCP (OAuth-gated like the core).
3. **local_shop** — moved in, working (snippet + best-effort price).
4. **scrape + rest** — structured extraction; Kroger + Ace adapters.
5. **Node render** — Playwright on the residential box → Home Depot/Lowe's/Costco.
6. **ocr + transforms** — Workers AI vision; node compress/convert.

Status: **Phase 1 done** (proxy + node + moved shopping tool). Transport + tools next.
