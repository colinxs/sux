# Design: `travel(from, to)` — API-first travel vertical for sux

**Angle commitment: API-FIRST, production-primary.** Amadeus Self-Service (a **production** key pair, live real-time fares) is the data floor for flights, hotels, and price analytics. Purchase links are *constructed*, never scraped. Visa comes from a commit-pinned passport-index matrix + a vendored pre-authorization table + Wikipedia detail; attractions from the existing `places` fn (+ Wikivoyage). Scraping appears exactly once, as the keyless flights fallback (Google Flights, parsed from aria-label accessibility strings) — a legitimate degradation path because we already beat bot detection through the residential exit + `render:mac`. Zero mac renders on the happy path; at most one per call, budget-gated, on the deepest fallback.

One fn (`travel`) + one helper module (`_travel.ts`). Fn count 89 → **90**.

---

## Resolved decisions

| # | Question | Decision | One-line rationale |
|---|---|---|---|
| 1 | One fn or five? | **One `travel` fn + `_travel.ts`** | Facets share OAuth client, geo resolution, deep-link builders; splitting = N²-glue the repo forbids. |
| 2 | Amadeus env | **Production** key pair is the target; `AMADEUS_ENV=test` stamps a non-droppable `env:"test"` marker | User directive: live pricing; test data is canned samples that must never look live. |
| 3 | Default facets | **`["flights","links","visa","attractions"]`** (judges outrank the base doc) | The spec is a trip dossier; flights+links under-delivers. All four are cheap/zero-render. |
| 4 | Omitted `depart` | **Default `today+21d`, `return=depart+7d`, `assumed_dates:true`** — but `price_trend` and `track` require explicit `depart` | Lower friction for the model; a quartile verdict for a date nobody chose is noise. |
| 5 | `passport` default | **REMOVED.** Resolution: explicit arg → `kv:travel:home.passport` → **no answer** (visa `ok:false`) | Safety-critical: a silent `"US"` default answers for a nationality the caller never claimed. |
| 6 | Facet execution | **Two-phase small-DAG.** Phase A parallel `Promise.allSettled`: flights, hotels, attractions, *base* visa. Phase B (visa/price_trend `await` the shared `flightsPromise`): transit augmentation + trend verdict. Per-facet ~15s deadline — **the flights facet's deadline extends to ~35s on mac-render escalation** (sized to cover the elapsed rung-2 smartFetch + the render's `timeout_ms`, so the keyless→`render:mac` floor can actually complete inside its own race); ~50s global soft budget spanning both phases under the 60s ceiling | Visa's `transit[]` and price_trend's verdict CONSUME flights output — racing them emits a false `transit:[]` (defeats decision #13) and a nondeterministic verdict. A hung facet still must not sink completed facets via `withDeadline`'s whole-call abandon. A generic 15s flights deadline would fire before a 15–20s mac render (which runs *after* rung-2 smartFetch) could yield a fare — killing the marketed degradation path and leaking the concurrency-1 mac slot — so flights gets the sized exception. |
| 7 | `book` link semantics | Typed **`search_link: {url, kind}`**, never `book`; flights caveat says "opens a live route search, not this exact fare" | A route search is not the priced fare; "book" on a read-only tool teaches the wrong thing. |
| 8 | `price_trend` verdict | Compute on **`price/adults`**, pass **`oneWay`** when no return, **suppress for cabin≠economy**, **suppress on currency mismatch** (offer's currency ≠ the currency the metrics API returned → `verdict:null`, quartiles still reported), and **suppress when `nonstop:true`** (cheapest is nonstop-only but the metrics API has no `nonStop` filter, so quartiles are all-routing → `verdict:null`, quartiles still reported) | Amadeus `grandTotal` is all-travelers-total; quartiles are per-itinerary economy-basis **all-routing**; either side can diverge from `requested_currency` (§6) and the offer's routing basis can diverge from the quartiles', so an unguarded compare is a silent EUR-vs-USD or nonstop-vs-all-routing barometer. |
| 9 | Trend series key | `routeKey` hashes **all price-affecting params**; the sub record pins the **full canonical query** | A trend built from heterogeneous quotes (economy vs business, USD vs EUR) is worse than none. |
| 10 | Track cap (11th) | **FIFO-evict oldest**, report `evicted` in the envelope | The base doc's "untrack one first" instructs an impossible action (no untrack mechanism). |
| 11 | Visa dataset | **`ilyankou/passport-index-dataset` matrix-iso2 CSV, pinned to a commit SHA**; `data_as_of` = commit date | The base doc's `imorte/...` URL 404s; runtime `master` fetch is a supply-chain hole for safety data. |
| 12 | Visa staleness | **Hard 12-month ceiling** → stop asserting, return verify links only; 6–12 mo → warning fused into `requirement` | A boolean `stale:true` the model can drop is not a safety control. |
| 13 | Transit visas | Extract intermediate countries from offer segments → `transit[]` in visa block; per-offer `connects_in[]` **+ `routing_known`**. "Nonstop" = stops 0 (NOT `connects_in:[]`); a connecting offer with unresolved routing (`routing_known:false`, keyless) NEVER emits a clear → `transit_unknown:true` | The envelope emits connecting itineraries; pairing "visa: not required" next to a CA/US layover — or a keyless offer whose layover was never resolved — denies boarding. |
| 14 | ETA/eVISA/ESTA | Parse value column into a **closed enum**; never fold pre-auth into "not required"; vendored override table applied to **both destination AND transit** countries (structured `pre_authorization` on `TransitEntry`, §8) | The highest-probability wrong answer is "visa-free" hiding a mandatory ESTA/ETIAS/ETA — and airside transit (e.g. VWP connecting through the US, which has no sterile transit) is where it hides most, so the override must fire on the transit axis too, not just the destination. |
| 15 | ISO-3 vs IATA | Check **ISO-3166 alpha-3 FIRST**; `USA`/`CAN`/`IND`/`PER` are country codes AND live IATA codes | `travel(from="USA")` must not resolve to a North Carolina airfield. |
| 16 | Airports table | **Generated OurAirports + hand-maintained metro supplement** via `gen-airports.mjs` (committed output) | OurAirports is airports-only; TYO/NYC/LON/SEL metro codes must survive the swap. |
| 17 | tfs deep link | Keep tested **`?q=` prose primary**; commit the verified tfs fixture + field map as a one-cycle upgrade | tfs precision (cabin/pax) is a ready path, not a research project; `?q=` survived live testing. |
| 18 | `noCache` on partial | Only on **transient** codes (timeout / rate_limited / blocked / upstream_error / layout_change) | `not_configured`/`not_found` are deterministic; caching them protects the scrape floor. |
| 19 | KV-resolved passport + cache | **`noCache:true` when the visa facet is requested AND `passport` was resolved from `kv:travel:home` (not an explicit arg)** | The cache key is `cacheKey(name,args)` over RAW args (§9) with no fn-level key-override, so a KV-resolved passport is absent from the key; else a home-nationality change serves a stale wrong-passport visa clear (within the ~10-min `staleGrace:600` window — still a false clear). noCache is the only fn-level lever (mirrors §10 state-mutation → noCache). Tradeoff inverted vs #4/assumed_dates: safety cost > quota cost. **Collision:** on the DEFAULT facet set (visa included) a home-profile bare `travel(from,to)` meets both preconditions, so the dominant call never caches (quota protection of §9/§11 lost) until the deferred cache-key-contribution hook folds the KV-resolved passport into the key (§9, intended fix). |
| 20 | `from` required? | **Schema-optional (`required:["to"]` only), runtime-resolved**: arg → `kv:travel:home.from` → `bad_input`; `defaults_from` names `from` when KV supplied it | `from` is a first-class member of the `kv:travel:home` `{from,currency,passport}` profile (§12) — leaving it in `required` under `additionalProperties:false` makes the argless home-airport path dead code the validator rejects before `run()`, so `from` must join its schema-optional siblings and be validated at runtime. |

---

## 1. One fn, not five

**Decision: a single `travel` fn** plus a shared helper module `_travel.ts` (the `_retail.ts` pattern).

- **Bosman/F13 gate** (PLAN.md:185-188): Amadeus is the archetypal "overly-verbose public connector" — OAuth2 client-credentials dance, per-endpoint quotas, a deeply nested `flight-offers` response (~4 KB/offer) flattened to ~10 fields. One wrapper amortizes the OAuth client, geo resolution, and normalization across facets.
- **Retail precedent does NOT apply**: retail earned per-retailer fns because each needs a *distinct transport*. Travel's facets share one transport (keyed HTTPS) and one geo step; splitting = N fns × 1 method, the N² glue the Julia philosophy forbids (PLAN.md:38-57).
- **Facets share state**: `from`/`to` resolution is computed once and feeds every facet.
- Facets are internal branches, not registered fns — no `shop`-style dispatch (nothing to dispatch *to*).

Files:

```
sux/src/fns/_travel.ts          shared: Amadeus client, geo resolution, deep-link builders, visa engine, envelope types
sux/src/fns/travel.ts           the fn (facet orchestration, Promise.allSettled)
sux/src/fns/travel.test.ts      fn tests (vitest, co-located, fetch-spy style)
sux/src/fns/_travel.test.ts     pure-helper tests (link builders, visa enum, IATA/country resolution)
sux/src/data/airports.json      generated OurAirports table + metro supplement + ISO-3 index (committed)
sux/src/data/visa-overrides.ts  vendored pre-authorization table (ESTA/ETIAS/ETA/…) + verify.official ladder tables
sux/scripts/gen-airports.mjs    regenerates airports.json (provenance header, rerunnable)
sux/scripts/gen-visa-matrix.mjs OPTIONAL: vendors the pinned CSV to remove the runtime GitHub dependency
```

---

## 2. Input schema (exact, post-graft)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["to"],
  "properties": {
    "from": { "type": "string", "description": "Origin: IATA airport/city code ('PDX','TYO') or city ('Portland OR'). 3-letter uppercase = IATA unless it is also an ISO-3 country code. Country names resolve for visa/attractions only. Omitted → kv:travel:home.from, else bad_input." },
    "to": { "type": "string", "description": "Destination: IATA code, city, or country. One origin→destination pair per call — comma / ' to ' / ' and ' is rejected." },
    "depart": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": "Departure date. Omitted → assumed today+21d (flagged assumed_dates). Must be >= today-1 UTC. price_trend and track:true require an explicit depart." },
    "return": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": "Return date. Omitted → one-way (assumed trips use depart+7d). Must be >= depart." },
    "facets": {
      "type": "array",
      "items": { "type": "string", "enum": ["flights", "hotels", "attractions", "visa", "price_trend", "links", "all"] },
      "default": ["flights", "links", "visa", "attractions"],
      "description": "Which facets to fetch. 'all' expands to every facet."
    },
    "adults": { "type": "integer", "minimum": 1, "maximum": 9, "default": 1 },
    "cabin": { "type": "string", "enum": ["economy", "premium_economy", "business", "first"], "default": "economy" },
    "nonstop": { "type": "boolean", "default": false },
    "currency": { "type": "string", "description": "ISO-4217. Omitted → kv:travel:home.currency, else USD. Echoed as requested_currency (see §7)." },
    "passport": { "type": "string", "description": "ISO-2 nationality for the visa facet. NO default — omitted reads kv:travel:home.passport, else the visa facet returns ok:false. Never inferred from `from`." },
    "limit": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5, "description": "Max results per facet." },
    "track": { "type": "boolean", "default": false, "description": "Register this route for daily price snapshots (max 10 routes, FIFO-evicted). Requires explicit depart." }
  }
}
```

**Default facets** (settling "all by default?"): the wider judge-mandated default `["flights","links","visa","attractions"]` — all four are cheap and zero-render (visa is one KV read + at most one cached subrequest; attractions is one `places` call; links are pure construction; flights is the one live fetch). `facets:["all"]` adds hotels + price_trend. Cost consequence is re-derived in §11 (default path is ~6–7 cold subrequests, not "flat").

**Assumed dates** (Judge 0 graft 7, scoped by the issues): omitted `depart` → `today+21d`; omitted `return` on an assumed trip → `depart+7d` (round-trip is the representative fare, so a one-way skew doesn't inflate the quote). `assumed_dates:true` rides at envelope top level **and** as a `caveat` inside every date-dependent facet block ("assumed dates were computed at fetched_at, which may be up to ~15 min old on a stale-served cache hit (max served age = ttl 300 + staleGrace 600 = 900s, §9) — recompute from fetched_at if you need today's +21d"; there is no read-time cache bypass, §9). **`price_trend` is exempt**: quartiles for an invented date are noise, so with assumed dates it returns `ok:false, code:"bad_input", note:"price_trend needs an explicit depart"`. **`track:true` with assumed dates** is a facet-level `bad_input` ("tracking needs an explicit depart") — never a whole-call failure that throws away fetched offers.

**Past dates** (top of `run()`, before any fetch): validate `depart >= today-1` (UTC, one-day grace). On violation, whole-call `failWith("bad_input", "depart 2025-09-10 is in the past — today is 2026-07-08 (UTC); did you mean 2026-09-10?")`. **Embedding the server's current date is load-bearing** — it lets a clock-drifted model self-correct in one retry.

**Multi-city guard**: if `from`/`to` (trimmed) contains `,`, ` and `, or ` to `, whole-call `failWith("bad_input", "travel takes one origin→destination pair per call — for multi-city, call once per leg")`.

**Origin is schema-optional, runtime-resolved** (reconciles the schema with the §12 home profile — `from` is a first-class member of `kv:travel:home`, alongside its two schema-optional siblings `currency`/`passport`, so it cannot sit in `required` or the argless home-airport path is dead code the validator rejects before `run()`). At the top of `run()`, resolve origin: explicit `from` arg → `kv:travel:home.from` (echo `defaults_from` naming `from`, §7/§12) → `failWith("bad_input", "origin required — pass from (IATA/city) or set kv:travel:home.from")`. Only `to` is JSON-schema required; `from`'s absence is a runtime branch, not a validation rejection, so a bare `travel({to:"Tokyo"})` resolves the home airport instead of hard-failing at the schema wall.

---

## 3. Geo / IATA resolution

Resolution runs once per side and produces:

```ts
type Place = {
  input: string;                 // what the caller passed
  kind: "airport" | "city" | "country";
  iata?: string;                 // airport or metro code (TYO covers NRT+HND); absent for kind:"country"
  city?: string;
  country: string;               // ISO-2 destination country — feeds the DESTINATION side of the visa matrix ONLY
  lat?: number; lng?: number;
  resolution?: "iata" | "fuzzy"; // "fuzzy" = keyword/substring match, ambiguity possible
  alternatives?: Array<{ iata: string; city: string; country: string }>; // other candidates for an ambiguous name
};
```

> **`_travel.ts` invariant (documented in code):** `Place.country` for the ORIGIN side must **never** feed the passport lookup. Only the destination side's country feeds the matrix's destination axis. Nationality comes exclusively from `passport` / `kv:travel:home.passport` (§8).

Resolution ladder — `resolvePlace(env, input, opts): Promise<Place>`:

1. **ISO-3166 alpha-3 country check FIRST** (blocker fix). If the input matches an ISO-3 code (`USA`, `CAN`, `IND`, `PER`, `MEX`, `COL`, …) it resolves to `kind:"country"` — **not** the colliding IATA airport. Geo-dependent facets (flights/hotels/route deep-links) then return `ok:false, code:"bad_input"` ("'USA' reads as a country — give a city or airport, e.g. 'Portland' or 'PDX'"); visa/attractions/dateless-links still work. Also matches common country names ("Japan", "United States").
2. **`/^[A-Z]{3}$/` IATA passthrough** (only if step 1 missed). Looks up `city`/`country`/`kind` from `airports.json` so even a 3-letter input carries resolution context the model can sanity-check. Metro codes (TYO/NYC/LON/SEL) resolve via the supplement.
3. **Amadeus Airport & City Search** — `GET /v1/reference-data/locations?keyword={input}&subType=AIRPORT,CITY&page[limit]=5`. Prefer `subType=CITY`. Relevance-ranked; the winner is `Place`, the rest become `alternatives[]`. **Cache the full candidate list** at `sux:travel:geo:<sha256(lc input)>`, 30 d. On >1 city candidate, attach `alternatives[]` and a note ("assumed Portland OR (PDX) — pass an IATA code to override").
4. **Keyless floor** — deterministic ranking against `airports.json`: exact city-name match beats substring, then by `passenger_rank` (a column `gen-airports.mjs` emits). Metro supplement participates so `Tokyo`→`TYO`.
5. **Total miss** → `failWith("bad_input", "could not resolve '<input>' — try an IATA code")`, *only* when a facet actually needs geo (a visa-only call with two country names resolves country-only).

**`kind:"country"` handling** (major fix): a facet needing an IATA/city gets `ok:false, code:"bad_input"` ("'Japan' is a country — flights need a city/airport ('Tokyo','NRT'); visa/attractions still returned"). Links degrade to the dateless Google Flights `?q=` prose (accepts country names) and drop Kayak/Expedia/Skyscanner.

**Territory→sovereign** (visa correctness): `gen-airports.mjs` emits a sovereign map (PR/GU/VI→US, RE/GP/MQ→FR with a "Schengen does not apply" flag; HK/MO kept distinct). The visa matrix uses the sovereign code.

**Keyless ambiguity into visa**: when the top two keyless candidates are in different countries and the visa facet is requested, visa returns `ok:false, code:"bad_input"` ("ambiguous destination — pass an IATA code or country") rather than guessing a country. The resolved destination display is embedded in the visa block (`destination:{city,country,resolved_from}`) with `resolution:"fuzzy"` when it came from a keyword/substring match.

---

## 4. Per-facet source matrix (production-primary)

Primary is what v1 ships against a **production** Amadeus key; fallback triggers on `not_configured` (missing key) or upstream failure.

| Facet | Primary | Fallback | Renders | Notes |
|---|---|---|---|---|
| **flights** | Amadeus Flight Offers Search — `GET /v2/shopping/flight-offers?originLocationCode&destinationLocationCode&departureDate&returnDate&adults&travelClass&nonStop&currencyCode&max={limit}` (**prod: live real-time**) | Google Flights keyless via `smartFetch` rung 2 (curl-impersonate through residential exit), parsed from **aria-label accessibility strings** ("From 194 US dollars", carrier/stops/duration phrases) → escalate ONCE to `render backend:mac` **only if ≥25s global budget remains** and `looks_blocked` (the flights facet's own deadline extends to ~35s to host the render — §11.4/§11.6); else `failWith("blocked")` with links intact | 0 typical, ≤1 worst | Fares are GDS: no Southwest, LCC/NDC undercount. Keyless fares are **USD/US-POS teasers**, `approx:true` (see §6 currency). Keyless connecting offers stamp **`routing_known:false`** (aria-label yields a stop *count*, not the layover IATA), which forces the visa transit-unknown branch (§8) instead of a false `transit:[]`. Solver (`solve:true`) is **never** used. |
| **hotels** | Amadeus Hotel List (`/v1/reference-data/locations/hotels/by-city?cityCode={metro}`) → slice ≤20 distance-ordered hotelIds → Hotel Search v3 (`/v3/shopping/hotel-offers?hotelIds=…&checkInDate&checkOutDate&adults&currency`) → trim to `limit` | No scrape. Unkeyed → constructed Booking.com + Google Hotels links, `ok:false, code:"not_configured"` | 0 | cityCode is always the **metro** code (TYO not NRT), resolved via `airports.json` even when `to` was an airport. Currency + tax handling in §6. LiteAPI deferred to v2 (card-on-file). |
| **attractions** | Existing `places` fn via registry dispatch (shop.ts:67 dynamic-import pattern) — `textQuery:"top tourist attractions in {city}"` (needs `GOOGLE_MAPS_KEY`, already provisioned) | Wikivoyage MediaWiki API — `?action=parse&page={city}&prop=wikitext&format=json&formatversion=2`; **detect `{{districtify}}`/district-index (or <2 listings) and follow 2-3 district subpages** (bounded, +2-3 subrequests); if still empty return `ok:false, code:"not_found"` + a Wikivoyage link, never empty-but-ok | 0 | When both sources present, enrich Places results with Wikivoyage `{{see}}/{{do}}` hours/price/summary, tagged per-source. |
| **visa** | Commit-pinned `ilyankou/passport-index-dataset` matrix-iso2 CSV → KV at `sux:travel:visa:matrix` (§8/§9) | Wikipedia per-passport detail (run even for visa-free — the Notes column holds "ETA required from 2025") via MediaWiki `action=parse&redirects=1&page={ISO2→exact title}` | 0 | Closed-enum requirement, transit array, pre-authorization overrides, structured `verify` block, hard staleness ceiling — all §8. |
| **price_trend** | Amadeus Flight Price Analysis — `GET /v1/analytics/itinerary-price-metrics?originIataCode&destinationIataCode&departureDate&currencyCode&oneWay={!return}` → MIN/25/50/75/MAX quartiles + per-adult verdict (§6) | (a) `google_insight` block parsed opportunistically from any Google Flights fetch ("prices are currently low — $X–$Y typical", carries own `{currency:"USD",pos:"US"}`); (b) self-accumulated `track` series | 0 | Thin US-route coverage → frequent `not_found` on day one; `google_insight` is the practical day-zero verdict for US routes. Requires explicit `depart`. |
| **links** | Pure URL construction (§5) | — | 0 | Every template marked "verify live before landing" with a `verification_date`. Grade downgraded from A+; drift is invisible without a canary (§5). |

---

## 5. Deep-link construction spec

All builders are pure functions in `_travel.ts`, unit-tested against golden strings **authored only after one live click-through per template** (the golden test otherwise enshrines a broken link forever). A `verification_date` constant rides in the `_travel.ts` file-top comment and in each `search_link` object; a cheap drift canary (selftest-triggered or quarterly cron) does one HEAD/GET per template asserting non-404 / non-redirect-to-homepage.

```ts
// gfFlightsLink({from,to,depart,ret?,adults,cabin,currency}) — cabin/adults folded into the prose so Google parses them:
`https://www.google.com/travel/flights?q=${encodeURIComponent(
  `${cabin==="economy"?"":cabin.replace("_"," ")+" class "}${ret?`flights from ${from} to ${to} on ${depart} through ${ret}`
    :`oneway flights from ${from} to ${to} on ${depart}`} for ${adults} adult${adults>1?"s":""}`)}&curr=${currency}&hl=en`
// dateless / country: q=`flights from ${from} to ${to}`

// kayakFlightsLink → `https://www.kayak.com/flights/${from}-${to}/${depart}${ret?`/${ret}`:""}/${adults}adults?sort=bestflight_a`
// expediaFlightsLink → `https://www.expedia.com/go/flight/search/${ret?"Roundtrip":"Oneway"}/${depart}/${ret??depart}?FromAirport=${from}&ToAirport=${to}&NumAdult=${adults}`
// skyscannerLink → `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${yymmdd(depart)}/${ret?yymmdd(ret)+"/":""}`   // YYMMDD, NOT ddmmyy
// bookingHotelsLink → `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(city)}&checkin=${depart}&checkout=${ret}&group_adults=${adults}`
// googleHotelsLink → `https://www.google.com/travel/search?q=${encodeURIComponent(`hotels in ${city}`)}`
// airlineDirectLink(carrier, offer) — table-driven; v1 ships UA, keyed off the offer's OWN first-segment operating carrier + destination:
//   UA → `https://www.united.com/en/us/fsr/choose-flights?f=${segFrom}&t=${segTo}&d=${depart}${ret?`&r=${ret}`:""}&tt=${ret?2:1}&px=${adults}&sc=${cabinCode}&st=bestmatches`
```

**`search_link` typing** (blocker fix — the "$918 in the envelope, $1,240 on the page" trap): every offer's link is typed, never named `book`:

```ts
type SearchLink = { url: string; kind: "route_search" | "airline_search"; encodes: Array<"dates"|"adults"|"cabin">; };
```

- The per-offer link is `route_search` (Google Flights `?q=` with cabin+adults folded in) unless the offer's **own first-segment operating carrier** has a direct template (then `airline_search`, destination derived from the offer's segments — never the request's resolved IATA, and only when the validating carrier actually operates the first segment).
- Flights-facet caveat carries the fixed line: **"links open a live route search, not this exact fare."**
- tfs upgrade: the verified fixture `CAIQABoaEgoyMDI2LTA5LTEwGgUSA1NFQSIFEgNKRksoAUABSAE` + field map live in `_travel.ts` comments/tests as the one-cycle path to per-cabin/per-pax-precise `route_search` links (~40-line varint writer, fast-flights reference). `?q=` stays primary because it survived live testing.

Golden-link tests **must** cover a business-cabin and an `adults:2` case, not only the 1-adult economy defaults.

---

## 6. Price integrity (money that doesn't lie)

**Currency model** (blocker/major cluster):

- Top-level field is **`requested_currency`** (bidirectional naming — it names what it is, not "the currency of every number here"). Omitted `currency` → `kv:travel:home.currency` → `USD`.
- **Every money-bearing object carries its own explicit `currency`.** `FlightOffer.currency` required; `HotelOffer.currency` **required whenever `price_total` is present** (drop/flag an offer where Amadeus returns none — never stamp the requested currency onto a response-provided number); quartiles block carries the currency the metrics API returned; `google_insight` carries `{currency:"USD", pos:"US"}`.
- Amadeus FX caveat: when `requested_currency != offer's native quote currency`, the flights caveat appends "prices converted from `<native>` at Amadeus FX — checkout price is set by the seller's point of sale."
- US-POS lives in the **envelope**, not just the description: flights block carries `pos:"US"` (single US residential exit = US point-of-sale fares). Envelope fields survive model summarization; prose does not.
- Hotels may return **property-local currency** (JPY in Tokyo) when conversion is unavailable → keep the offer, add `currency_note:"rates returned in property currency; conversion unavailable"`. Add `includes_taxes?:boolean` from the price breakdown; hotels caveat: "totals may exclude local taxes/fees — confirm at booking." `links.note:"linked sites display prices in your local currency/POS — may differ from quoted fares."`

**Test-env stamp** (major fix): when `AMADEUS_ENV != production`, every Amadeus-sourced facet block gets a **non-droppable `env:"test"`** field + caveat "Amadeus test environment — sample fares, not live prices," and the fn description says so. Production is the target per the user directive; the stamp exists so a half-configured deployment can't present canned samples as live.

**Keyless-fallback money rules** (major fix): parse the currency FROM the aria string; force `flights.currency` to the parsed value (USD); set `pos:"US"`, `approx:true` per offer; caveat "scraped display prices (US point of sale, USD) — lowest-fare teasers, not held quotes; requested currency not applied." If the caller requested non-USD, add a `currency_note` rather than silently diverging. **Routing-provenance stamp (blocker fix):** independently of money, stamp `routing_known:false` on any keyless offer whose parsed stop count exceeds the number of layover IATAs actually resolved from the aria string — the normal case for every keyless connecting fare, where the aria-label carries a stop *count* but no intermediate airport. This is what routes the offer into the visa transit-unknown branch (§8), never a false `transit:[]`.

**Freshness horizon** (major fix — `ttl:300` is NOT a hard staleness ceiling on its own): the substrate's *default* `CACHE_STALE_GRACE_SECONDS=86_400` (mcp-util.ts:58) would serve a matched envelope **stale for up to ~24h after `quoted_at`** — the same default serve-stale that keeps the visa matrix alive (§9). But the shared registry now carries an optional **`Fn.staleGrace`** per-fn override (introduced by shop.md R8, co-signed by search.md §9), consumed by `deferCacheWrite` as `expirationTtl = softTtl + (fn.staleGrace ?? CACHE_STALE_GRACE_SECONDS)`. `travel` sets **`staleGrace: 600`** (matching shop/search), so a served envelope is stale for **at most ~10 min** past the 300s revalidate point, not up to ~24h. **Two quantities that differ by the 300s revalidate interval must not be conflated:** the serve-stale *window* = `staleGrace` = 600s (~10 min of stale-serving past the 300s revalidate point), whereas the max *age* of any served envelope measured from `quoted_at` = `ttl + staleGrace` = 300 + 600 = **900s (~15 min)** — fresh 0–300s, stale-but-served 300–900s, evicted at 900s. The consumer-facing caveat must state the latter. The flights/hotels blocks still **do not** carry a `quote_ttl_s` field — `staleGrace` is now a substrate-honored ceiling, but the embedded **`quoted_at`** (RFC-3339, stamped at fetch time and immutable through the cache) remains the single load-bearing freshness *signal*: the consumer computes `now − quoted_at` age and re-requests for a fresh fare rather than trusting a fixed TTL. The flights/hotels caveats carry the fixed line **"served from edge cache — may be up to ~15 min old; check quoted_at, re-request for a fresh fare."**

### 6.1 price_trend architecture

**Read layer (stateless).** `price_trend` calls itinerary-price-metrics and reports quartiles plus, when flights were fetched in the same call, a `verdict`. Because the verdict reads flights' output it is **Phase B** of the DAG (§11): it `await`s the shared `flightsPromise` before computing, never races it:

- Compute the verdict on **`cheapest_offer.price / adults`** vs the quartile bands (blocker fix — `grandTotal` is all-travelers-total, quartiles are per-itinerary single-traveler).
- **Flights-unavailable branch** (blocker): if flights timed out, failed, or were not requested, do not fabricate or silently drop the verdict — emit `verdict:null, verdict_note:"no flights fetched this call"`. Quartiles still report.
- Pass **`oneWay=true`** to the metrics call when `return` is absent (default `false` = round-trip distribution; comparing a one-way cheapest against round-trip quartiles reads "below typical" almost always).
- **Suppress the verdict entirely when `cabin != economy`**: emit `verdict:null, verdict_note:"quartiles are economy-basis; no comparison for business/first"`.
- **Nonstop-basis guard** (blocker fix — symmetric to the cabin-suppression branch above): the flights facet passes `nonStop=nonstop` to Flight Offers (§4), but the itinerary-price-metrics endpoint has **no `nonStop` parameter** — its inputs are `originIataCode/destinationIataCode/departureDate/currencyCode/oneWay` (see the cache key below). So when `nonstop:true`, `cheapest_offer` is a nonstop-only fare (systematically pricier) while the quartiles are the *all-routing* distribution (connecting-fare-dominated and cheaper), and the verdict would compare across incompatible routing bases — reading a competitive nonstop fare as a false "typical"/"high." **Suppress the verdict entirely when `nonstop===true`**: emit `verdict:null, verdict_note:"cheapest fare is nonstop-only but price-history quartiles cover all routings (the metrics API has no nonstop filter); no comparison"`, while STILL reporting the (honestly all-routing) quartiles block. `nonstop` need not enter the metrics cache key (the metrics call is routing-agnostic) — only the verdict-suppression decision reads the request's `nonstop` flag.
- **Currency-alignment guard** (blocker fix — the one place two independent money numbers are arithmetically compared): the numerator (`cheapest_offer.currency`) and the bands (**the currency the metrics API actually returned**, per §6 — not the requested `currencyCode`, which neither side is guaranteed to honor) can each diverge from `requested_currency` and from each other. Before comparing, require `cheapest_offer.currency === quartiles.currency` on the **real returned labels**. On mismatch, do NOT compare across currencies: emit `verdict:null, verdict_note:"cheapest fare is in <offerCur> but price-history quartiles are in <quartileCur> — no cross-currency comparison"`, while STILL reporting the quartiles block (which carries its own metrics-API `currency`). This bites hardest on the keyless path: keyless offers are force-stamped USD/pos:US (§6), so any non-USD requested currency that still resolves a quartiles block guarantees an offer(USD)-vs-quartiles(non-USD) mismatch. When the comparison IS possible, the `verdict_note` names the shared currency both numerator and bands are in (e.g. "cheapest per-adult fare 918.40 USD sits between q1 and median USD").
- Caveat states the basis: "per-adult, round-trip vs one-way matched, all cabins pooled economy-dominated, all routings pooled — nonstop not isolable, offer and quartile currencies matched — trip length not controlled; historical booked-fare distribution, partly interpolated."
- Cache at `sux:travel:trend:metrics:<sha256(from|to|depart|oneWay|cabin|currency)>`, 24 h (the base doc's key omitted `oneWay`/`cabin`/`currency` — blocker).

**Accumulation layer (stateful, opt-in).** `track:true` writes a subscription that **pins the full canonical query** so the daily replay and the instant snapshot are the same product:

```ts
type TrendSub = { from: string; to: string; depart: string; return?: string;
  adults: number; cabin: string; nonstop: boolean; currency: string; created_at: string };
// routeKey = sha256Hex([from,to,depart,return??"",adults,cabin,nonstop,currency].join("\n"))
```

- `routeKey` hashes **all price-affecting params** (blocker fix — the base doc's `from|to|month` collided economy+business into one series).
- The **existing** cron (`wrangler.jsonc:22`, `0 13 * * *` → `maintenanceTick`, index.ts:398) gains one **never-throw** step, `travelTrendTick(env)`: list subs (bounded loop), replay each pinned query with `max=1`, append `{date, price, currency, carrier}` to `sux:travel:trend:series:<routeKey>` with a rolling `.slice(-60)` cap. **A failed Amadeus call skips the day** — never retries or escalates; a missing point is fine for a trend line.
- **Instant first snapshot**: on `track:true`, write today's point immediately from the flights offer just fetched in the same call (by construction it matches the pinned params) — instant day-zero data instead of waiting for the first tick.
- **Dedupe by date**: one point per date per route, so the 300s edge cache and repeated same-day calls never skew the series.
- **FIFO cap**: subs hard-capped at **10**. The 11th `track:true` **evicts the oldest** (by `created_at`), writes the new one, and reports `tracking:{added:true, evicted:{route, created_at}}` in the envelope. No `failWith`, no "untrack" text. Subs also auto-expire after 60 days via KV TTL on the sub key; re-tracking refreshes.
- Series block echoes the pinned basis (`series_basis:{adults,cabin,currency,depart,return}`) and an honesty guard: `points:N` plus a `series_note` when `N<7` or span `<7d` ("insufficient history for a trend — snapshots accumulate daily").

**Quota math** is re-derived in §11 against the production per-endpoint free tier.

---

## 7. Output envelope — concrete example (post-graft shape)

`travel({from:"PDX", to:"Tokyo", depart:"2026-09-10", return:"2026-09-24", passport:"US", facets:["all"]})`, production Amadeus + Maps keys:

```json
{
  "provider": "travel",
  "from": { "input": "PDX", "kind": "airport", "iata": "PDX", "city": "Portland", "country": "US", "resolution": "iata" },
  "to":   { "input": "Tokyo", "kind": "city", "iata": "TYO", "city": "Tokyo", "country": "JP", "resolution": "fuzzy",
            "alternatives": [] },
  "depart": "2026-09-10", "return": "2026-09-24", "adults": 1, "cabin": "economy",
  "requested_currency": "USD", "assumed_dates": false, "defaults_from": null,
  "fetched_at": "2026-07-08T18:04:11Z",
  "flights": {
    "ok": true, "source": "amadeus", "pos": "US", "quoted_at": "2026-07-08T18:04:11Z",
    "caveat": "GDS fares (no Southwest / some LCC-NDC); US point of sale; links open a live route search, not this exact fare; prices change frequently; served from edge cache — may be up to ~15 min old, check quoted_at, re-request for a fresh fare.",
    "count": 2,
    "offers": [
      { "price": 918.40, "currency": "USD", "carrier": "AS", "carrier_name": "Alaska Airlines",
        "stops_out": 1, "stops_back": 1, "duration_out": "PT14H35M", "duration_back": "PT12H50M",
        "route_out": "PDX-SEA-NRT", "route_back": "HND-SEA-PDX", "cabin": "economy", "connects_in": ["US"], "routing_known": true,
        "search_link": { "url": "https://www.google.com/travel/flights?q=flights%20from%20PDX%20to%20TYO%20on%202026-09-10%20through%202026-09-24%20for%201%20adult&curr=USD&hl=en",
          "kind": "route_search", "encodes": ["dates", "adults"] } },
      { "price": 1024.10, "currency": "USD", "carrier": "UA", "carrier_name": "United",
        "stops_out": 1, "stops_back": 0, "duration_out": "PT15H10M", "duration_back": "PT9H5M",
        "route_out": "PDX-SFO-NRT", "route_back": "NRT-PDX", "cabin": "economy", "connects_in": ["US"], "routing_known": true,
        "search_link": { "url": "https://www.united.com/en/us/fsr/choose-flights?f=PDX&t=NRT&d=2026-09-10&r=2026-09-24&tt=2&px=1&st=bestmatches",
          "kind": "airline_search", "encodes": ["dates", "adults", "cabin"] } }
    ]
  },
  "hotels": {
    "ok": true, "source": "amadeus", "quoted_at": "2026-07-08T18:04:11Z",
    "caveat": "GDS rates skew to chains; totals may exclude local taxes/fees — confirm at booking; served from edge cache — may be up to ~15 min old, check quoted_at, re-request for a fresh rate.",
    "count": 1,
    "offers": [
      { "name": "Hotel Gracery Shinjuku", "rating": 4, "price_total": 1310.00, "currency": "USD", "includes_taxes": false,
        "nights": 14, "check_in": "2026-09-10", "check_out": "2026-09-24",
        "search_link": { "url": "https://www.booking.com/searchresults.html?ss=Tokyo&checkin=2026-09-10&checkout=2026-09-24&group_adults=1",
          "kind": "route_search", "encodes": ["dates", "adults"] } }
    ]
  },
  "attractions": {
    "ok": true, "source": "places", "count": 3,
    "results": [
      { "name": "Senso-ji", "rating": 4.5, "address": "2-3-1 Asakusa, Taito City, Tokyo", "lat": 35.7148, "lng": 139.7967, "sources": ["places"] },
      { "name": "Meiji Jingu", "rating": 4.6, "address": "1-1 Yoyogikamizonocho, Shibuya City, Tokyo", "lat": 35.6764, "lng": 139.6993, "sources": ["places"] },
      { "name": "teamLab Planets", "rating": 4.5, "address": "6-1-16 Toyosu, Koto City, Tokyo", "lat": 35.6489, "lng": 139.7897, "sources": ["places"] }
    ]
  },
  "visa": {
    "ok": true, "source": "passport-index-dataset", "passport": "US", "passport_source": "arg",
    "destination": { "city": "Tokyo", "country": "JP", "resolved_from": "Tokyo" },
    "requirement": "visa_free", "allowed_stay_days": 90, "purpose": "tourism/short-stay",
    "conditions": "typically requires onward/return ticket and passport validity beyond stay; does not permit work or study",
    "pre_authorization": null,
    "transit": [],
    "data_as_of": "2026-05-14", "checked_at": "2026-07-08T18:04:12Z", "stale": false,
    "verify": { "official": "https://www.mofa.go.jp/j_info/visit/visa/index.html", "wikipedia": "https://en.wikipedia.org/wiki/Visa_requirements_for_United_States_citizens" },
    "disclaimer": "Community-maintained reference data, NOT legal advice. Assumes an ordinary passport of the stated nationality; dual nationals should query each passport. Confirm at the official source above before booking.",
    "sources": [ { "name": "passport-index-dataset", "url": "https://github.com/ilyankou/passport-index-dataset/blob/<sha>/…", "as_of": "2026-05-14" } ]
  },
  "price_trend": {
    "ok": true, "source": "amadeus-price-analysis", "route": "PDX-TYO", "depart": "2026-09-10", "one_way": false, "currency": "USD",
    "quartiles": { "min": 702, "q1": 855, "median": 968, "q3": 1180, "max": 2410 },
    "verdict": "typical", "verdict_note": "cheapest per-adult fare 918.40 USD sits between q1 and median USD",
    "google_insight": { "level": "typical", "low": 820, "high": 1120, "currency": "USD", "pos": "US" },
    "caveat": "per-adult, round-trip-matched, cabins pooled (economy-dominated), all routings pooled — nonstop not isolable, offer and quartile currencies matched (USD); historical distribution, partly interpolated.",
    "tracked": false, "series_basis": null, "points": 0, "series": []
  },
  "links": {
    "verification_date": "2026-07-01",
    "google_flights": "https://www.google.com/travel/flights?q=flights%20from%20PDX%20to%20TYO%20on%202026-09-10%20through%202026-09-24&curr=USD&hl=en",
    "kayak": "https://www.kayak.com/flights/PDX-TYO/2026-09-10/2026-09-24/1adults?sort=bestflight_a",
    "expedia": "https://www.expedia.com/go/flight/search/Roundtrip/2026-09-10/2026-09-24?FromAirport=PDX&ToAirport=TYO&NumAdult=1",
    "skyscanner": "https://www.skyscanner.net/transport/flights/pdx/tyo/260910/260924/",
    "booking_hotels": "https://www.booking.com/searchresults.html?ss=Tokyo&checkin=2026-09-10&checkout=2026-09-24&group_adults=1",
    "google_hotels": "https://www.google.com/travel/search?q=hotels%20in%20Tokyo",
    "note": "linked sites display prices in your local currency and point of sale — may differ from quoted fares."
  }
}
```

**Per-facet `ok` flags** (Judge 0 graft 5): every *requested* facet appears in the envelope. `ok:false` carries `{ok:false, code:FailCode, error}` (and any partial data) in place of the success shape, so the calling model never has to infer absence semantics. `facets_failed:FacetError[]` is retained as a summary array for convenience. Emitted `JSON.stringify(env, null, 2)`; facets not requested are absent entirely.

A realistic **US-route / unkeyed** variant is authored as a second golden fixture: `flights.ok:true, source:"google-flights", pos:"US", approx:true`; `price_trend.ok:false, code:"not_found"` with a populated `google_insight`; `hotels.ok:false, code:"not_configured"`.

A **cross-currency verdict** case is asserted directly (the all-USD golden set above hides it — every offer and every quartile is USD, so the currency-alignment guard of §6.1 never fires). `travel({from:"PDX", to:"TYO", depart:"2026-09-10", currency:"EUR", facets:["flights","price_trend"]})` where Amadeus returns the cheapest offer as `{price:845, currency:"EUR"}` but the itinerary-price-metrics endpoint returns its distribution in **USD** (`min:702, q1:855, median:968, …, currency:"USD"`): assert `price_trend.verdict:null` with `verdict_note:"cheapest fare is in EUR but price-history quartiles are in USD — no cross-currency comparison"`, and assert the `quartiles` block is **still present** (with the price_trend block's `currency:"USD"` intact). A keyless companion (`currency:"EUR"`, no key → offer force-stamped USD, metrics EUR) asserts the same `verdict:null` cross-currency note in the mirror direction — locking the guard against the all-USD blind spot.

A **nonstop-basis verdict** case is asserted directly (every golden fixture and every build-step-6 verdict test runs the default `nonstop:false`, so the nonstop-vs-all-routing mismatch never surfaces otherwise). `travel({from:"JFK", to:"LHR", depart:"2026-09-10", nonstop:true, facets:["flights","price_trend"]})` where the cheapest nonstop offer is `{price:780, currency:"USD"}` but the itinerary-price-metrics distribution is all-routing (it includes 1-stop fares via DUB/KEF — the endpoint has no `nonStop` filter) returning `{min:540, q1:610, median:690, q3:820, max:1180, currency:"USD"}`: assert `price_trend.verdict:null` with `verdict_note:"cheapest fare is nonstop-only but price-history quartiles cover all routings (the metrics API has no nonstop filter); no comparison"`, and assert the `quartiles` block is **still present** (honestly all-routing). Without the guard the unguarded compare puts $780 near q3 and emits `verdict:"typical"`/`"high"` — presenting a competitive nonstop fare as "on the high side."

A **third-country-connection** variant is authored as a third golden fixture — the example above only ever shows domestic US layovers, so the Phase-B transit dependency (§8/§11) is never exercised by it. `travel({from:"PDX", to:"BKK", depart:"2026-09-10", passport:"US", facets:["flights","visa"]})` whose cheapest offer routes `PDX-ICN-BKK` (`connects_in:["KR"]`): visa's block carries a **non-empty** `transit:[{country:"KR", requirement:"eta", pre_authorization:{name:"K-ETA", url:"https://www.k-eta.go.kr/", applies_to:"visa-exempt nationals"}, note:"this is the entry rule; airside-transit exemptions must be confirmed", verify:{…}}]`. A companion fixture forces flights to `ok:false, code:"timeout"` and asserts the visa block emits `transit_unknown:true` with **no** `transit` field — never `transit:[]` — and `price_trend` (when requested) emits `verdict:null, verdict_note:"no flights fetched this call"`. A **third, keyless-unresolved-routing** companion — the no-Amadeus-key mirror, and the case the all-happy Amadeus golden set structurally cannot reach — is authored too: `travel({from:"LAX", to:"SYD", passport:"US", facets:["flights","visa"]})` with no key, whose keyless cheapest offer ("From 620 US dollars, 1 stop, 18 hr", real routing LAX-PVG-SYD) normalizes to `{stops_out:1, connects_in:[], routing_known:false}` because the layover IATA is never resolved from the aria-label. Assert the visa block emits `transit_unknown:true` with `transit_note:"connecting-country visa exposure could not be checked — routing not resolvable on the keyless fare path; confirm transit rules independently"` and **no** `transit` field — **never** `transit:[]` — so a US passport is not falsely cleared through a Chinese transit that requires transit authorization. This is the exact false-clear decision #13 guards, here produced by mis-classifying an unresolved-routing connecting offer as nonstop rather than by omission. A **fourth, flights-not-requested** companion — the visa-only call that fetches no itinerary at all, and the case reached by request *shape* rather than fetch failure — is authored too: `travel({from:"LAX", to:"SYD", passport:"US", facets:["visa"]})` (no flights facet). Assert the visa block carries the base requirement (matrix lookup + any pre-auth override) **and** `transit_unknown:true` with `transit_note:"connecting-country visa exposure not assessed — no itinerary evaluated (flights not requested this call); if you will fly, re-query with the flights facet or confirm transit rules independently"` and **no** `transit` field — **never** `transit:[]`; because the schema admits any facet subset, a visa-only call must not fall through to the default empty array. Together these four lock the dependency, its flights-absent branch, its keyless unresolved-routing branch, and its flights-not-requested branch against regression.

A **pre-auth-hidden transit** variant is authored as a fifth golden fixture — the sole third-country-transit fixture above lands on `requirement:"eta"` because K-ETA surfaces in the matrix/notes column *itself*, so the matrix-cell-says-`visa_free`-but-pre-auth-is-mandatory transit branch (the exact harm decision #14 exists to prevent, now on the transit axis) is never exercised by it. `travel({from:"CDG", to:"MEX", passport:"FR", facets:["flights","visa"]})` whose cheapest offer routes `CDG-ATL-MEX` (`connects_in:["US"]`, `routing_known:true`) — a routine VWP itinerary connecting airside in the US, where a French citizen MUST hold ESTA (the US has no sterile international transit). The matrix cell France→US is `visa_free`, so *without the override the transit entry would emit a false clear* `{country:"US", requirement:"visa_free"}`; assert instead that the pre-auth override fires on the transit country and the block carries `transit:[{country:"US", requirement:"visa_free", pre_authorization:{name:"ESTA", url:"https://esta.cbp.dhs.gov/", applies_to:"visa-exempt nationals"}, note:"this is the entry rule; airside-transit exemptions must be confirmed", verify:{…}}]`. This is the structured protection decision #14 mandates for the destination extended to the connection axis — the SAME US as a *destination* would carry the identical `pre_authorization` (the override is keyed by country, applied to both axes, §8).

A **stale-serve honesty** case (§9 freshness fix) is asserted directly: replay the full-keyed fixture as if served from cache at the eviction horizon `ttl + staleGrace` = 900s (~15 min after its `quoted_at` — 300s revalidate + 600s serve-stale) and assert the block still reads honestly — `quoted_at` is unchanged (so `now − quoted_at ≈ 15 min` is computable by the consumer), no `quote_ttl_s` field is present, and the flights/hotels caveats carry "may be up to ~15 min old". A companion asserts `assumed_dates` **honesty** (there is no read-time bypass — §9 proves the substrate has no hook for one, and `staleGrace` shrinks but does not close the window): replay an `assumed_dates:true` fixture as a cache hit served at the ~15-min max-age horizon (or straddling a UTC-midnight boundary) and assert the block does **not** silently claim a fresh date — its concrete `depart` and top-level `fetched_at` are unchanged, `assumed_dates:true` is present, and every assumed-date facet carries the "assumed dates were computed at fetched_at — recompute from fetched_at if you need today's +21d" caveat, so the calling model can detect and correct the stale assumption itself.

Normalized shapes (in `_travel.ts`, exported for tests):

```ts
type FlightOffer = { price: number; currency: string; carrier: string; carrier_name?: string;
  stops_out: number; stops_back?: number; duration_out: string; duration_back?: string;
  route_out: string; route_back?: string; cabin: string; connects_in: string[]; routing_known: boolean;
  approx?: boolean; search_link: SearchLink };
type HotelOffer = { name: string; rating?: number; price_total?: number; currency?: string;
  includes_taxes?: boolean; currency_note?: string; nights: number; check_in: string; check_out: string; search_link: SearchLink };
type Requirement = "visa_free" | "visa_on_arrival" | "e_visa" | "eta" | "visa_required" | "no_admission";
type PreAuth = { name: string; url: string; applies_to: string } | null;
type TransitEntry = { country: string; requirement: Requirement; pre_authorization: PreAuth; note: string; verify: VerifyBlock };
type VerifyBlock = { official: string | null; wikipedia?: string; verify_hint?: string };
type VisaSummary = { ok: boolean; source: string; passport: string; passport_source: "arg" | "kv:travel:home";
  destination: { city?: string; country: string; resolved_from: string };
  requirement: Requirement; allowed_stay_days?: number; purpose: string; conditions: string;
  pre_authorization: PreAuth; transit?: TransitEntry[]; transit_unknown?: boolean; transit_note?: string; detail?: string;
  data_as_of: string; checked_at: string; stale: boolean; verify: VerifyBlock; disclaimer: string;
  sources: Array<{ name: string; url: string; as_of: string }> };
type FacetError = { facet: string; code: FailCode; message: string };
```

`FlightOffer.routing_known` is the per-offer routing-provenance flag (§8): `true` when every layover IATA was resolved (Amadeus segments), `false` when the offer has `stops_out>0` (or `stops_back>0`) but no layover IATA could be parsed — the default state of every connecting offer on the keyless aria-label path, which reads a stop *count*, not the intermediate airport. It gates the transit rule so that `connects_in:[]` on an unresolved-routing offer is NEVER mistaken for "no transit exposure."

Prices pass through `normalizeMoney` (non-positive → undefined), a local copy of `_retail.ts:34` logic to avoid a cross-module reach.

---

## 8. Visa facet: authority, staleness, harm

Wrong visa info causes real-world harm, so the facet is engineered for provenance and refusal, not confidence.

**Nationality resolution (blocker — no US default).** Order: explicit `passport` arg → `kv:travel:home.passport` → **no answer**. When neither exists, the visa facet returns `ok:false, code:"bad_input", message:"nationality required — pass passport (ISO-2) or set kv:travel:home"`. `passport_source:"arg"|"kv:travel:home"` records the provenance of the nationality itself. `Place.country` of the ORIGIN **never** feeds the passport side — documented as a `_travel.ts` invariant; the misleading base-doc type comment is deleted. When passport is defaulted-absent AND `to` is a country equal to no known nationality, visa is simply skipped-with-note.

**Requirement is a closed enum (blocker — ETA/eVISA).** The passport-index value column is parsed exhaustively into `Requirement = visa_free | visa_on_arrival | e_visa | eta | visa_required | no_admission` with an exhaustive-match test; **any unrecognized raw value fails the facet with `layout_change`** — never a guess. `eta`/`e_visa` are **never** collapsed into "visa not required"; the requirement string names the authorization.

**Pre-authorization override table (blocker).** A vendored table in `visa-overrides.ts` (US-ESTA, UK-ETA, EU/Schengen-ETIAS, NZeTA, K-ETA, CA-eTA, AU-ETA) keyed by country code, applied to **both** the destination country **and** every resolved transit country (below). For the **destination**: whenever it has such a regime **and** the matrix answered `visa_free`, emit `pre_authorization:{name, url, applies_to:"visa-exempt nationals"}`. For a **transit** country the same table fires (the transit bullet below), so a pre-auth regime is never lost on the connection axis — the highest-miss case, since airside transit is where a mandatory ESTA/ETA is most often overlooked. This tiny, slow-changing table is the only reliable guard while the upstream dataset lags. The **Wikipedia detail fetch runs even for `visa_free`** (one cached subrequest) because the Notes column is where "ETA required from Jan 2025" lives.

**Transit visas (blocker).** This enrichment is **Phase B** of the execution DAG (§11): the base visa requirement is computed in Phase A, then the transit augmentation `await`s the shared `flightsPromise` before finalizing — it must **never** run concurrently with flights, or a fast matrix read scans zero offers and emits a false `transit:[]`. When the flights facet was **not requested** this call (a valid `facets:["visa"]` query — the schema admits any subset), there is **no** `flightsPromise` to await, so Phase B takes the flights-not-requested branch below rather than awaiting `undefined` and scanning zero offers. Once flights settle, classify each offer by its routing *provenance* — keyed on stop counts and `routing_known`, never on whether `connects_in` happens to be empty:

- **Nonstop** (`stops_out===0 && (stops_back??0)===0`) → no transit exposure; contributes nothing. This — not `connects_in.length===0` — is the definition of "nonstop," because a keyless connecting offer normalizes to `stops_out:1, connects_in:[]` (the intermediate airport is never resolved: the aria-label scan parses a stop *count*, and segment IATA→country needs an intermediate IATA that was never parsed).
- **Stops ≥1 with `routing_known:true`** (Amadeus segments resolved every layover) → extract the set of intermediate-connection countries (segment IATA → country via `airports.json`); for each intermediate country ≠ origin ≠ destination, run the same matrix lookup **AND the vendored pre-authorization override table keyed by the transit country** — whenever the transit country has an ESTA/ETIAS/ETA/eTA regime, emit `pre_authorization:{name, url, applies_to}` on the transit entry **regardless of whether the matrix answered `visa_free`** (airside transit is where pre-auth is most often overlooked, and many pre-auth regimes — notably US-ESTA — have no sterile international-transit exemption, so a matrix `visa_free` cell is exactly where the hidden mandatory authorization lives). Emit a `transit[]` entry `{country, requirement, pre_authorization, note, verify}`.
- **Stops ≥1 with `routing_known:false`** (keyless, layover unparseable) → this offer **must NEVER contribute a clear.** Route it into the same safety branch as flights-unavailable: set `transit_unknown:true`, OMIT the `transit` field, and never emit `transit:[]`.

Because the matrix encodes **entry** rules (not transit-without-visa), every transit entry carries the explicit caveat "this is the entry rule; airside-transit exemptions must be confirmed" — **never** "no transit visa needed." The generic "some countries (US, CA) require authorization even for transit" line is demoted to a *supporting* caveat: the structured `pre_authorization` field on the transit entry (above) is now the primary, non-droppable signal for that exact hazard, so the specific authorization (name + URL) rides in the envelope rather than in droppable prose (decision #12: a caveat the model can drop is not a safety control). Each `FlightOffer` is tagged `connects_in:[...]` **and `routing_known`** so the model can correlate offer↔risk. If flights returned third-country connections but visa was not requested, a one-line `transit_note` is appended to the flights block. Only a nonstop offer (stops 0) yields the "nonstop — no transit exposure" note.

**Flights-absent, not-requested, OR unresolved-routing branch (blocker).** If flights timed out or failed, **OR** the flights facet was **not requested this call** (mirroring price_trend's identical "were not requested" guard in §6.1 — a visa-only `travel(from,to,passport,facets:["visa"])` evaluates no itinerary), **OR** flights are present but a connecting offer's routing could not be resolved (`stops≥1` with `routing_known:false` — the normal state of every keyless connecting fare), transit **MUST NOT** be an empty array — an empty `transit[]` reads as "no transit visa needed," the very false-clear decision #13 exists to prevent. Instead emit `transit_unknown:true` with the `transit_note` naming the cause — `"connecting-country visa exposure could not be checked — flights unavailable; confirm transit rules independently"` when flights are absent, `"connecting-country visa exposure not assessed — no itinerary evaluated (flights not requested this call); if you will fly, re-query with the flights facet or confirm transit rules independently"` when the flights facet was not requested, or `"connecting-country visa exposure could not be checked — routing not resolvable on the keyless fare path; confirm transit rules independently"` when routing is unresolved — and omit the `transit` field entirely. The distinction is load-bearing and now has three states, not two: `transit:[]` means *flights were **requested AND fetched**, routing was resolved, and there was no third-country connection* — so it can never be reached on a visa-only call; `transit_unknown:true` means *nothing could be checked* — flights were absent, flights were not requested this call, or they were present with routing that could not be resolved. A **mixed** offer set (some offers `routing_known:true`, some `false`) still surfaces the resolved-country `transit[]` entries **and** sets `transit_unknown:true` (a per-offer `transit_unknown` correlates which offers were unchecked), because a partial clear is a false clear for the unresolved offers.

**Dataset source + pinning (blocker/major).** `ilyankou/passport-index-dataset`, `passport-index-matrix-iso2.csv`, **pinned to a specific commit SHA** recorded as a constant in `_travel.ts`, with `data_as_of` = that commit's date hardcoded alongside (a raw fetch returns no commit metadata, so runtime-derived `data_as_of` is unimplementable — it must be the pinned constant). Bumping the SHA+date is a deliberate docs-synced PR (mirrors the `gen-airports.mjs` committed-output pattern). Optionally `gen-visa-matrix.mjs` vendors the CSV outright, removing the runtime GitHub dependency and the cold-load subrequest. On parse, a **shape assertion** (≈199×199, spot-check cells like US→JP=`visa_free`) fails the refresh with `layout_change` rather than storing a malformed matrix.

**Hard staleness ceiling (blocker).** The registry taxonomy (registry.ts:112) has no `stale` code, so:
- `data_as_of` **older than 12 months** → the facet **stops asserting a requirement**: `ok:false, code:"upstream_error", message:"visa dataset older than 12 months — refusing to state a requirement"` while STILL emitting the `verify` links so the caller is pointed at authority, not a guess.
- Between **6 and 12 months** → serve the answer but fuse the age into `requirement`'s prose so a summarizing model can't separate fact from age: `"visa_free (per dataset dated 2025-06-30 — verify, >6 months old)"`, plus `stale:true`.
- Under 6 months → normal. The 12-month rule is checked against the pinned commit date, not the KV write date.

**Structured verify block (Judge 2 graft 3).** `verify` is a **non-droppable object** `{official, wikipedia?, verify_hint?}`, not a URL buried in prose. `verify.official` is constructed by a ladder (never a non-government URL):
1. **Destination-side authority** — vendored ~30-row table of major destinations' official immigration pages (Japan MOFA, UK gov.uk ETA, US travel.state.gov visa-waiver, Schengen/ETIAS official, Australia immi.homeaffairs.gov.au, …). Covers the overwhelming majority of real queries.
2. **Passport-side authority** — small second table when the destination table misses (US travel.state.gov country pages, UK FCDO, DE Auswärtiges Amt).
3. **Both miss** → `official:null`, `verify_hint:"search: {destination} official visa requirements site:gov"`.

**Wikipedia titling (minor).** An **ISO2→exact-page-title map** (not demonym-derived — the US page is "Visa requirements for United States citizens," not "American"), verified against live titles for the top ~30 passports; pass `redirects=1`; the parser strips `{{yes}}/{{no}}/flag` cell templates. One real wikitext-table fixture in tests.

**Purpose/conditions & scope (minor).** `purpose:"tourism/short-stay"` and a generic `conditions` string are fixed fields (visa-free allowances are purpose-conditioned and often condition on onward tickets / 6-month passport validity). The disclaimer states the dual-national / travel-document scope ("assumes an ordinary passport of the stated nationality; dual nationals should query each passport; residence-permit holders must use official sources").

The fn description states: "visa data is community-maintained reference material, NOT legal advice — the envelope always links the authoritative source."

**Sources array** (Judge 1 graft 6): `sources:[{name, url, as_of}]` captures the pinned dataset commit and the Wikipedia revision timestamp alongside the disclaimer.

---

## 9. Freshness / caching policy

Fn-level: `cacheable: true, ttl: 300, staleGrace: 600` (live fares govern the whole-call cache, matching `shop`/`search`; `staleGrace` — the per-fn override introduced by shop.md R8 and co-signed by search.md §9 — caps serve-stale at ~10 min instead of the substrate default `CACHE_STALE_GRACE_SECONDS=86_400` ~24h). Per-facet staleness layered underneath:

| Layer | Key | TTL | Why |
|---|---|---|---|
| whole-call result | edge fn cache | 300 s revalidate, **~10 min serve-stale (`staleGrace:600`); max served age 900 s ≈ 15 min** | fares are per-second, so `ttl:300` is the house "live external state" *revalidation* interval; `travel` sets `Fn.staleGrace:600` (the per-fn override from shop.md R8 / search.md §9) so `deferCacheWrite` sets `expirationTtl = softTtl + 600` = 900 s — ~10 min of serve-stale past the 300 s revalidate point, so a max served age of ~15 min from `quoted_at` — rather than the default `CACHE_STALE_GRACE_SECONDS=86_400` (~24h). `quoted_at` (not the TTL) is still the freshness signal the consumer reads (§6). |
| Amadeus OAuth token | `sux:travel:amadeus_token` | `expires_in` − 60 s (~29 min) | Kroger-token pattern (index.ts:380); saves 1 subrequest/call |
| geo resolution | `sux:travel:geo:<hash>` | 30 d | cities don't move; caches the FULL candidate list, not just the winner |
| visa matrix | `sux:travel:visa:matrix` | **no KV expiration** | serve-stale requires the value to persist; §8 treats 30 d as a soft read-time refresh threshold. `fetched_at`/`data_as_of` live INSIDE the value. |
| trend metrics | `sux:travel:trend:metrics:<hash>` | 24 h | historical quartiles; key includes `oneWay|cabin|currency` |
| trend series/subs | `sux:travel:trend:series/sub:<routeKey>` | series: none (rolling 60); sub: 60 d | §6 |
| attractions | none extra | — | `places` already `ttl:900`; Wikivoyage responses big but rare |

> **Matrix-TTL fix (minor blocker interaction):** the base doc's 30-day KV TTL on `sux:travel:visa:matrix` **contradicts** serve-stale — when the TTL fires KV deletes the value, so on a refresh failure there is no stale copy. The matrix is therefore stored with **no expiration**; staleness is a read-time comparison against the embedded `data_as_of`.

Cache honesty (major fix — the grace window is bounded by `Fn.staleGrace`, not the substrate default ~24h): `travel` sets `Fn.staleGrace:600` (the per-fn override from shop.md R8 / search.md §9), so `deferCacheWrite` writes `expirationTtl = softTtl + 600` = 900s and a matched envelope is served stale for **at most ~10 min** past the 300s revalidate point — not the default `CACHE_STALE_GRACE_SECONDS=86_400`. **Distinguish the two quantities the additive formula produces:** the serve-stale *window* = `staleGrace` = 600s (~10 min of stale-serving past the 300s revalidate point), whereas the max *age* of any served envelope from `quoted_at` = `ttl + staleGrace` = 900s (~15 min); the consumer-facing caveat must state the latter. So `quoted_at`/`checked_at` may lag the wall-clock by **up to ~15 min** (= ttl 300 + staleGrace 600), not ≤ ttl and not ~24h. These embedded timestamps — never the `ttl` — are authoritative: the consumer computes age from `quoted_at` and re-requests if it needs a fresher fare (this is why the `quote_ttl_s` field was dropped, §6: `staleGrace` already bounds staleness, and a `quote_ttl_s` would redundantly re-name that bound while inviting the model to treat a cached fare as fresh). **`assumed_dates` honesty (no read-time bypass — the substrate has no hook for one; `staleGrace` does NOT rescue this).** A cache-hit envelope's `depart`/`return` were computed from `today+21d`/`depart+7d` *at write time*, so a stale-within-grace hit (now ≤ ~15 min old — max served age `ttl + staleGrace` = 900s — or one computed just before a UTC-midnight boundary and served just after it) can still show a depart date a day off from a fresh `today+21d`. `staleGrace` shrinks the window but does not close it: the defect rests on the cache-key-over-raw-args wall, not the grace magnitude. A prior draft claimed `run()` "validates on read" and "bypasses the cache and recomputes" for this case — **that mechanism is unimplementable and is deleted.** Three substrate facts make a fn-level read-time guard impossible: (a) the cache key is `cacheKey(name, args)` (index.ts:206) computed from the RAW input args *before* `fn.run`, so a bare `travel(from,to)` (no `depart` in args) hashes byte-identically today and tomorrow — the key cannot encode the assumed date; (b) on **any** hit, fresh or stale-within-grace, index.ts:289-297 returns the stored bytes (`return sseResponse({… JSON.parse(unpackFromCache(raw))})`) and **never calls `fn.run`** for that caller — a stale hit only schedules a background `waitUntil(computeAndCache())`; (c) the `Fn` type (registry.ts:128-140) exposes only `cacheable`/`ttl`/`run` — no key-override, no read-interception, no pre-serve revalidate callback. So `run()` is simply not on the cache-hit serve path and cannot bypass anything. The design therefore relies on the same embedded-timestamp honesty used everywhere else: `assumed_dates:true` plus the visible concrete `depart` and top-level `fetched_at` let the calling model see that the assumed date was computed up to ~15 min ago (or across a UTC-midnight boundary) and recompute the intended `today+21d` itself. Every assumed-date facet block carries the caveat **"assumed dates were computed at fetched_at (may be up to ~15 min old) — recompute from fetched_at if you need today's +21d."** A true read-time guard would require a substrate change — a per-fn cache-key contribution, or a pre-serve revalidate hook on the `Fn` type — which is **out of scope for a single fn** and is called out here rather than asserted as working behavior. (Caching was kept rather than forcing `noCache:true` on every assumed-date call *for this reason alone*, because assumed-date `travel(from,to)` is the dominant Flight Offers consumer per §11 — making it uncacheable would multiply that quota spend. **But note the collision reconciled below:** on the dominant *home-profile* call — a bare `travel(from,to)` with `kv:travel:home.passport` set and the **default** facet set, which *includes* visa (§3) — the separate visa+KV-passport rule *does* force `noCache:true`, so that path does not cache regardless of this decision, and the quota protection this parenthetical seeks is restored only by the same deferred per-fn cache-key-contribution hook flagged just above, which folds both the assumed `depart` and the KV-resolved `passport` into the key and fixes both staleness cases at once — see the visa+KV-resolved-passport paragraph below.) Every volatile facet also carries the "may be up to ~15 min old — check quoted_at" caveat; a stale-served envelope still reads honestly (its own `quoted_at`/`fetched_at` betray its age), and a golden fixture asserts exactly that (§7).

**Visa + KV-resolved passport → `noCache:true` (blocker).** The same cache-key wall that makes the `assumed_dates` read-time guard unimplementable — the key is `cacheKey(name, args)` (index.ts:206) over the RAW args *before* `fn.run`, with no fn-level key-override hook — also means a `passport` resolved from `kv:travel:home` (§12) is **never in the cache key**: a bare `travel(from,to)` (visa is a default facet, §3) hashes byte-identically regardless of the home nationality. Left cached, a home-profile nationality change serves a stale wrong-passport visa clear (for up to the ~10-min `staleGrace:600` window — still a false clear, so still unacceptable). Concrete failure: home passport `"US"` caches `visa: visa_free` for Japan; the user updates `kv:travel:home.passport` to `"IN"` (dual citizenship / typo fix / planning on another passport); a re-call within the ~10-min `staleGrace:600` grace window is a cache HIT — index.ts:289-297 returns the stored bytes and never calls `fn.run` — handing the caller `passport:"US", requirement:"visa_free"` for an itinerary that on an Indian passport REQUIRES a Japan visa, the exact primary-destination false-clear §8's refusal machinery exists to prevent, now on the *base* requirement. Unlike the sibling `assumed_dates` case, embedded-timestamp honesty cannot rescue it: the stale envelope embeds `passport:"US", passport_source:"kv:travel:home"` and carries no signal that the current home passport is now `"IN"`, so the model can neither detect nor correct the wrong legal answer. Because folding the KV-resolved passport into the key at fn level is impossible (the same `Fn`-type wall documented above for assumed_dates), the only fn-level lever is to bypass the cache: **when the visa facet is requested AND `passport` was resolved from `kv:travel:home` (not an explicit arg), the call sets `noCache:true`** (§10), mirroring the state-mutation → `noCache` rule (watch.ts:41). This bounds the blast radius — explicit-passport calls stay in the key and cache normally; only KV-resolved-passport visa calls bypass — so a home-nationality change can never serve a stale wrong-passport visa block. The quota tradeoff is **inverted** vs the `assumed_dates` decision above (which *sought* to keep caching to protect Flight Offers quota, §11): here the safety cost of a wrong visa clear dominates the quota cost, so the visa facet's presence on a KV-resolved passport forces the bypass. **Dominant-call collision (reconciled explicitly).** These two decisions meet on the single most common call shape and must be read together: a bare `travel(from,to)` from a home-profile user takes the **default** facet set `["flights","links","visa","attractions"]` (§3) — which *includes* visa — and omits `passport`, so it resolves from `kv:travel:home.passport` (§12). Both `noCache` preconditions are therefore met on the default path, so **every bare `travel(from,to)` with `kv:travel:home.passport` set never caches** — the live Flight Offers fetch (plus places, hotels, everything) re-runs on each repeat. This is exactly the configuration §12 encourages ("kills the most common repeated arg"; the home profile's value is the set `{from,currency,passport}`), so the quota protection the `assumed_dates` paragraph sought does **not** hold for the dominant home-profile path, and §11's cost model must not assume a cache hit there (corrected in §11). A prior draft's reconciliation example — a `facets:["flights","links"]` call with a KV-resolved-but-unused passport "still caches" — is true but **misleading**: it silently picked a *non-default* facet set that structurally excludes visa, so it can never exhibit the collision; stated on the actual **default** set (visa included) the collision is real and the default home-profile call bypasses. **Intended fix (deferred — one substrate change fixes both).** This is a *second* consumer of the exact per-fn cache-key-contribution hook the `assumed_dates` guard above already flags as out-of-scope-for-a-single-fn: once the `Fn` type gains a hook to fold fn-resolved values into `cacheKey(name,args)`, the KV-resolved `passport` (and the assumed `depart`) join the key, the call caches safely with the nationality *in* the key, and `noCache` becomes unnecessary — restoring Flight Offers quota protection **and** fixing the wrong-passport staleness in one change. That is the intended fix; until the hook lands the safety>quota choice of #19 stands and the default home-profile call is honestly uncacheable. `from`/`currency` share the key-omission but are not safety-critical the way a wrong-nationality visa clear is, so they alone do not force a bypass.

---

## 10. Error / partial-result envelope

**A facet failure never sinks the call.** Facets run in the two-phase DAG of §11 (Phase A `Promise.allSettled`; Phase B `await`s `flightsPromise`); each resolves to `ok:true` or `ok:false {code, error}` using the FAIL_CODES taxonomy (registry.ts:112). Envelope assembly is in fixed key order (geo → flights → hotels → attractions → visa → price_trend → links) for deterministic golden tests — **determinism comes from assembly order, not execution order.**

Hard failures (whole-call `failWith`, before fan-out): `bad_input` for malformed/past dates, multi-city input, `return` before `depart`, and unresolvable `from`/`to` when a geo-dependent facet was requested. ALL requested facets failing also collapses to a whole-call error.

**`noCache` is scoped to transient codes only** (blocker/major fix): set `noCache:true` when any facet failed with `timeout | rate_limited | blocked | upstream_error | layout_change`. Deterministic failures (`not_configured`, `not_found`, `bad_input`) cache normally at ttl 300 — the same call minutes later fails identically, so caching it is correct and **protects the scrape floor and the mac node** (an unkeyed deployment always has `hotels:not_configured`, and must not re-scrape Google Flights on every repeat). `track:true` also sets `noCache:true` (state mutation must not be swallowed by the edge cache), mirroring watch.ts:41. **A visa call on a KV-resolved passport likewise sets `noCache:true`** (§9/§12, decision #19): when the visa facet is requested and `passport` came from `kv:travel:home` rather than an explicit arg, the nationality is absent from `cacheKey(name, args)` (raw args only, no fn-level key-override), so caching would serve a stale wrong-passport visa clear after a home-profile nationality change — bypassing is the only fn-level lever, since the `Fn` type exposes no cache-key contribution. Explicit-passport visa calls cache normally.

---

## 11. Runtime, wall-clock budget, and cost (re-derived)

**Time architecture (blocker fix).** The dispatcher's `withDeadline` (index.ts:52) resolves the ENTIRE call to a generic timeout at `FN_DEADLINE_MS=60_000` (index.ts:41) and abandons the run — so a facet *hang* (the common failure) would discard every completed facet under the base doc's sequential model. Therefore:

**The five facets are NOT independent — two consume flights' output** (blocker fix): the visa facet's `transit[]` reads each offer's connection segments (§8, decision #13), and price_trend's `verdict` reads `cheapest_offer.price / adults` (§6.1). A flat "five facets in parallel" model races them against flights; because a KV matrix read is far faster than a live Amadeus fetch, visa almost always settles *before* flights, scans zero offers, and emits `transit:[]` — the exact false "no transit visa needed" signal decision #13 exists to prevent — and price_trend's verdict lands nondeterministically absent. Execution is therefore a **two-phase small DAG**, not a flat fan-out:

1. After the shared geo + token step, **Phase A** runs the flights-independent work in **true parallel via `Promise.allSettled`**: flights, hotels, attractions, and the **base visa requirement** (destination+passport matrix lookup, pre-auth override, staleness bands — none of which need flight data). `flightsPromise` is captured here as a shared handle **only when the flights facet is in the requested set; when it is not (a visa-only call fetches no itinerary), `flightsPromise` is `undefined`.**
2. **Phase B is gated on `flightsPromise` settling**, not a wall-clock boundary: visa's `transit[]` augmentation and price_trend's `verdict` both `await flightsPromise` internally before finalizing, so a fast visa lookup still blocks on flights before emitting transit. Phase B's own work is cheap KV/cached matrix reads. **Both `await`s are guarded**: if `flightsPromise` is `undefined` (flights not requested this call), Phase B does **not** `await undefined` and scan zero offers — visa takes the flights-not-requested transit-unknown branch (§8) and price_trend emits `verdict:null`.
3. **Flights-absent, not-requested, OR unresolved-routing branch** (the safety-critical case — flights timed out or failed, **OR were not requested this call** (a visa-only call), **OR** present but with `routing_known:false` connecting offers): transit MUST NOT be an empty array. Visa emits `transit_unknown:true` + a `transit_note` naming the cause (flights unavailable, flights not requested — no itinerary evaluated, or routing not resolvable on the keyless fare path) (never `transit:[]`); price_trend emits `verdict:null, verdict_note:"no flights fetched this call"`. Only a **nonstop** offer (`stops_out===0 && (stops_back??0)===0`) yields the legitimate empty-transit "no transit exposure" note — the empty array is forbidden whenever flights are *absent*, *not requested*, OR a connecting offer's routing is *unresolved*, permitted only when flights are present, routing is resolved, and no third-country connection exists. `connects_in.length===0` is NOT the nonstop test — a keyless connecting offer normalizes to `stops_out:1, connects_in:[]`.
4. Each facet is raced against its **own ~15s deadline** (`Promise.race` against a timer) resolving to `ok:false {code:"timeout"}` — one slow upstream cannot consume the whole budget. **Flights carries a sized exception**: when it escalates to `render backend:mac` (§11.6) its deadline extends to **~35s** (elapsed rung-2 smartFetch + the render's `timeout_ms`), so a generic 15s timer cannot fire before a 15–20s mac render — which starts *after* the smartFetch — could yield a fare. The render is awaited **inside** this same race; on facet-timeout it is aborted, never left detached (§11.6).
5. A **global ~50s soft budget** (comfortably under `FN_DEADLINE_MS`) spans **both phases** — Phase B's transit lookups are KV/cached matrix reads, so the budget is dominated by Phase A's live fetches — after which unfinished facets are marked `timeout` and the **partial envelope is returned**, never abandoned by `withDeadline`.
6. **Budget-aware mac escalation** (major fix, facet-deadline reconciled): the keyless flights fallback calls `render backend:mac` only when **≥25s of global budget remains** AND the flights facet's own deadline can host it. The naive form is self-defeating: the render's `timeout_ms` runs *after* the rung-2 smartFetch (itself several seconds), so a generic ~15s **facet** deadline (§11.4) necessarily fires before a 15–20s render can complete — the facet's `Promise.race` resolves to `ok:false {code:"timeout"}`, the render never yields a fare, and the detached node keeps burning its concurrency-1 slot on a result nobody reads (the exact leak this step tries to prevent, realized by the facet timer rather than `withDeadline`). The ≥25s **global** gate does not rescue this — it checks a different quantity than the facet's cap. Reconciliation: (a) **the flights facet's deadline extends to ~35s when (and only when) it escalates to mac render**, sized to cover elapsed rung-2 smartFetch + the render's `timeout_ms`; (b) `timeout_ms` is clamped to `min(remaining facet budget after smartFetch, 20s)` (render.ts:230,247) so the node-side render is bounded to what the Worker will actually await; (c) the render is invoked **inside** the flights facet's `Promise.race` against that extended timer — not detached — and on facet-timeout the `render` call is **aborted/cancelled** (AbortSignal wired through), so a timed-out flights facet can never leave the concurrency-1 mac node burning its slot on a discarded fare. Escalation goes through the `render` fn (owns the SSRF guard, render.ts:244), **never** the raw `macRender` helper, and **never** `solve:true`.

**Subrequest accounting** must include `withRetry`: a hung upstream inflates one logical fetch to up to 3 attempts (proxy.ts:208-247), so the worst case is ~27–30 subrequests, not "8-9" — still under the Workers 50-subrequest floor, but stated honestly.

**Cost tables (re-derived for grafted defaults):**

| Path | Cold subrequests | Renders | Notes |
|---|---|---|---|
| **Default `[flights,links,visa,attractions]`, keyed, cold** | token(1) + geo(2) + flights(1) + places(1) + visa matrix(0–1, usually warm) + wiki detail(0–1) = **~5–7** | 0 | The new default is NOT "flat"; this row replaces the base doc's claim. **With a home-profile passport (`kv:travel:home.passport` set) this default path is `noCache:true` (§9/#19 — visa is a default facet, passport is KV-resolved), so it is cold on *every* repeat — no cache relief — until the deferred cache-key-contribution hook lands.** |
| **`facets:["all"]`, keyed, cold** | above + hotels(2) + price-metrics(1) = **~8–10 cold, ~4–5 warm** | 0 | worst case with `withRetry` inflation ~27–30 |
| **Keyless floor, flights** | 1 `smartFetch` (rung 2, curl-impersonate) + ≤1 mac render if `looks_blocked` **and** ≥25s left (flights deadline extends to ~35s to host it, §11.6) | ≤1 | headless tier only; serialized solver untouched; render awaited-in-race, aborted on facet-timeout |
| **Cron `travelTrendTick`** | 10 subs × 1 Flight Offers (`max=1`) = **10/day** | 0 | never-throw, failed day skipped |

**Fn `cost: 4`** (up from the base doc's 3) to price in the occasional render — with the documented caveat that **registry-internal dispatch is un-billed** (weightedRateLimit runs on the top-level tool name in `rtServer.fetch`, index.ts:344; the `target.run` pattern bypasses it), so the render escalation and the `places` sub-call are charged at `travel`'s flat cost, not additionally.

**Production quota reality (major fix).** '2,000 free/mo' is the **test** Flight Offers quota; production free-transaction counts differ **per endpoint** (Flight Offers, Hotel Search, Price Analysis, Location Search each have their own). Because the default facet set now fires a Flight Offers call on every bare `travel(from,to)` (assumed dates), casual calls are the dominant consumer — and for **home-profile** users that dominant path is additionally `noCache:true` (default facets include visa, passport is KV-resolved → §9/#19), so *every* repeat is a full cold Flight Offers spend with **no cache relief** until the deferred cache-key-contribution hook (§9) folds the resolved passport into the key and lets the path cache again. The design **does not assert a headroom multiple**; instead build step 6 live-measures the production per-endpoint quotas and the README states them, and `price_trend` is exempted from assumed dates so synthetic-date quartile calls never spend Price Analysis quota.

---

## 12. Statefulness — `kv:travel:home`

**Home profile (Judges 0/1/2 graft — actually READ, not documented-only).** When `from`, `currency`, or `passport` are omitted, read the JSON object at `kv:travel:home` (the enforced user `kv:` prefix, set via the existing `kv_put` — no new fn) shaped `{from, currency, passport}`, and echo `defaults_from:"kv:travel:home"` in the envelope naming which fields it supplied (`from` included — its most valuable member, the home airport). All three are schema-optional (§2): none sits in `required`, so an argless call reaches `run()` where each is resolved from KV before use, rather than being rejected at the JSON-schema wall. `from` alone is runtime-mandatory — arg → `kv:travel:home.from` → `bad_input` (§2, "origin required") — because a trip needs an origin; `currency` falls back to `USD` and `passport` to a visa `ok:false`. This kills the most common repeated arg with zero new code. The fn description names the convention. (The base doc's prose-only punt is strictly worse and is dropped.)

**Cache-key caveat (§9/§10, decision #19).** A `passport` resolved from `kv:travel:home` is absent from `cacheKey(name, args)` (raw args only, no fn-level key-override), so when the visa facet is requested on a KV-resolved passport the call sets `noCache:true` — otherwise a later home-nationality change would serve a stale wrong-passport visa clear from the ~10-min `staleGrace:600` grace window (still a false clear). Explicit-passport calls (and non-visa calls that merely default `from`/`currency`) are unaffected; only the visa facet's presence on a KV-resolved passport forces the bypass. **This collides with the dominant call shape the home profile exists to serve:** a bare `travel(from,to)` from a home-profile user takes the default facets (visa included, §3) *and* a KV-resolved passport, so it meets both `noCache` preconditions and never caches — the very "kills the most common repeated arg" win above comes at zero cache benefit and full cold Flight Offers spend on each repeat (§9/§11) until the deferred per-fn cache-key-contribution hook folds the resolved passport into `cacheKey` and lets the path cache safely with nationality in the key (§9, the intended fix).

**Price watch** is `travel`'s own state (§6), not the `watch` fn — `watch` stores only a latest-hash with no history, and fare pages hash-change every load; the trend series needs values + timestamps under `sux:travel:` per KV convention.

---

## 13. Key setup (README section)

New optional secrets in `RtEnv` (registry.ts, alongside the existing optional-key block):

```ts
// Amadeus Self-Service (travel fn) — OAuth2 client-credentials. PRODUCTION is the
// target (live real-time fares). Test and production are SEPARATE credential pairs:
// you cannot flip an env flag on a test key — production issues its own key/secret,
// so the secrets are rotated, not toggled. Production requires registering billing
// details (pay-as-you-go past the per-endpoint free quota).
AMADEUS_CLIENT_ID?: string;      // production key/secret when AMADEUS_ENV=production
AMADEUS_CLIENT_SECRET?: string;
AMADEUS_ENV?: string;            // "test" | "production" (default "test"); "test" stamps env:"test" on every Amadeus number
```

README steps: (1) sign up at developers.amadeus.com → My Self-Service Workspace → Create New App → copy the **test** API Key/Secret to verify wiring; (2) `wrangler secret put AMADEUS_CLIENT_ID --config sux/wrangler.jsonc` and same for `_SECRET` (the `--config sux/wrangler.jsonc` requirement is the known two-workers footgun — memory: "two workers / connector target"); (3) to go live: in the workspace **request production** — this issues a **separate** production key pair and requires **billing details on file** — then rotate the secrets to the production pair and set `AMADEUS_ENV=production` in wrangler vars. Base URLs: `https://test.api.amadeus.com` / `https://api.amadeus.com`. Rate limits 10 TPS test / 40 TPS prod — irrelevant at sux volume. No key → flights degrade to the keyless Google Flights floor; hotels/price_trend degrade to links/absent with actionable `not_configured` messages naming the signup URL (places.ts:44 pattern). `GOOGLE_MAPS_KEY` (attractions) already exists.

**Deliberate non-targets** (Judge 2 graft 4, README): Kayak/Skyscanner/Booking are **never scraped** (hard-walled; would serialize on the concurrency-1 headed solver) — links only. The single US residential exit means **US point-of-sale** fares. Captcha solver (`solve:true`) is never invoked by travel.

---

## 14. Fn description (consolidated, ~120 words)

> "Trip research for ONE from→to pair (IATA or city; 3-letter uppercase = IATA unless it's a country code, so use 'Tokyo' not 'JPN'; country names work for visa/attractions only). facets: flights, hotels, attractions, visa, price_trend, links (default flights+links+visa+attractions; 'all'). Dates YYYY-MM-DD; omitted depart assumes ~3 weeks out (assumed_dates). Fares are Amadeus GDS at US point of sale (no Southwest/some LCCs) or a keyless Google Flights fallback — point-in-time quotes; links open a live route search, sux never books. visa: community data + official verify links, NOT legal advice; `passport` (ISO-2) is required and never inferred from `from`. Omitted from/currency/passport read kv:travel:home {from,currency,passport} (set via kv_put). track:true snapshots daily prices (10 routes, FIFO). AMADEUS_CLIENT_ID/SECRET optional — degrades keyless; captcha solver never used."

---

## 15. Build order (one-change-per-cycle, each step green + tested)

1. **`_travel.ts` core + generated tables**: `gen-airports.mjs` → `airports.json` (OurAirports + metro supplement + ISO-3 index + passenger_rank + territory→sovereign); `amadeusToken(env)` (KV-cached), `amadeusGet()`, `resolvePlace()` (ISO-3-first ladder), all deep-link builders (yymmdd Skyscanner, `r=` United, `search_link` typing) + `_travel.test.ts` (golden links incl. business/adults:2, `USA`/`CAN` country resolution, token-cache via fetch spy, verification_date).
2. **`travel.ts` — flights + links facets only**, registered in `fns/index.ts`; **two-phase DAG skeleton** (Phase A `Promise.allSettled` capturing `flightsPromise`; Phase B `await`s it) + per-facet deadline + global budget spanning both phases; `travel.test.ts`: happy path (mocked Amadeus → normalized offers, outgoing-request assertion), keyless fallback (aria-label `gf.html` fixture, USD/pos forced, `approx:true`, connecting offer stamps `routing_known:false`), **keyless→`looks_blocked`→mac-render escalation driven end-to-end (rung-2 returns a blocked page, the `render backend:mac` sub returns a fare-bearing page: asserts the render actually yields a fare and the flights facet resolves `ok:true` within the extended ~35s deadline — NOT `code:"timeout"` — the one path every other keyless fixture stops short of; plus a facet-timeout variant asserting the `render` call receives an AbortSignal so the concurrency-1 mac slot is not left burning on a discarded result)**, no-key degradation, past-date teaching failure (asserts today's date in message), multi-city reject, **omitted-`from` resolution (argless `travel({to:"TYO"})`: seed `kv:travel:home.from="PDX"` → asserts `from` resolves to PDX and `defaults_from` includes `from`; and the no-KV-no-arg → whole-call `bad_input` "origin required" branch — no §7 fixture omits `from`)**, partial-failure envelope with `ok` flags, `noCache` transient-only, **stale-serve honesty (replay a fixture at the eviction horizon `ttl + staleGrace` = 900s, ~15 min past `quoted_at`: no `quote_ttl_s`, caveat says "may be up to ~15 min old") + `assumed_dates` honesty (replay an `assumed_dates:true` cache hit ~15 min old: `depart`/`fetched_at` unchanged, `assumed_dates:true` + recompute-from-fetched_at caveat present — asserts the model can self-correct, NOT a nonexistent read-time bypass)**.
3. **hotels facet** (metro-cityCode normalization, hotelIds ≤20 slice, JPY-priced fixture asserting currency required + `includes_taxes`, unkeyed degradation).
4. **attractions facet** — registry dispatch to `places` (shop.ts:67) + Wikivoyage fallback with district-subpage follow (+ big-city `districtify` fixture, per-source merge tags).
5. **visa facet** — commit-pinned matrix (no-expiry KV, serve-stale, shape assertion), closed-enum parse (exhaustive-match test), pre-auth overrides (destination **and** transit axis), **Phase-B transit extraction (`await flightsPromise`)**, structured `verify` ladder, staleness bands, ISO2→title map + `redirects=1` (+ tests: no-passport `bad_input`, JP→US ESTA, US→UK ETA, ICN/YVR third-country-connection transit entry with non-empty `transit[]`, **CDG-ATL-MEX on a FR passport → transit entry `{country:"US", requirement:"visa_free", pre_authorization:{name:"ESTA",…}}` — the matrix-`visa_free`-but-pre-auth-hidden transit false-clear the KR `eta` fixture structurally cannot cover**, **flights-timeout → `transit_unknown:true` with no `transit` field (never `transit:[]`)**, **keyless connecting offer (`stops_out:1, connects_in:[], routing_known:false`) → `transit_unknown:true` with no `transit` field (never `transit:[]`) — the keyless false-clear**, **visa-only call (`facets:["visa"]`, no flights facet) → base requirement present + `transit_unknown:true` with no `transit` field (never `transit:[]`) — the flights-not-requested false-clear**, 6–12mo and >12mo bands, disclaimer/purpose/conditions always present, **KV-resolved-passport visa call sets `noCache:true` — seed `kv:travel:home.passport="US"`, cache `travel(PDX,TYO)`, flip home to `"IN"`, re-call within the grace window, assert the visa block is NOT served stale (recomputed for IN, or the call is uncacheable), and that an explicit-`passport` visa call still caches — the omitted/KV-resolved-passport path no §7 fixture covers**).
6. **price_trend facet** — price-metrics (`oneWay`, per-adult verdict, cabin-suppression), 24h cache with full key, `google_insight` parse; **live-measure production per-endpoint quotas** and 3–4 US routes' coverage here; realistic `not_found`+`google_insight` example fixture (+ tests: adults:2 divides, one-way sets oneWay, business suppresses verdict, **`nonstop:true` → `verdict:null` with the nonstop-only note and quartiles (all-routing) still present**, **flights-timeout → `verdict:null, verdict_note:"no flights fetched this call"` with quartiles still present**, **currency mismatch (offer EUR vs quartiles USD, and the keyless USD-offer vs non-USD-metrics mirror) → `verdict:null` with the cross-currency note and quartiles still present**).
7. **`track:true` + `travelTrendTick`** step appended to `maintenanceTick` (index.ts:398, never-throw): pinned canonical query, all-params routeKey, instant first snapshot, per-date dedupe, FIFO-evict with `evicted` report, assumed-dates rejection, `series_note` thin-guard (+ collision test: two tracks differing only in cabin → two subs/series).
8. **Docs sync**: `npm run docs` (FUNCTIONS.md → 90 fns), name `travel` in `.claude/skills/sux/SKILL.md`, mirror to `plugins/sux-router/skills/`, update the profile-snippet count, `scripts/check-skill-sync.mjs` green; fix the stale PLAN.md status line; add `travel` normalization to `golden.test.ts`; add the keyless GF live canary to `selftest` (asserts ≥1 fare or fails `layout_change`) + a per-template deep-link drift canary.

Each step is a small PR on a `feat/travel` branch off main (`feat/shop-refactor` is unrelated).

---

## 16. Test & doc impact

- **New**: `travel.test.ts` (~28 cases: validation ×5, happy ×3, degradation ×3, visa ×10 incl. third-country transit entry + pre-auth-hidden transit (matrix `visa_free` but ESTA on the US transit axis — the CDG-ATL-MEX/FR false-clear) + flights-timeout `transit_unknown` + keyless-unresolved-routing `transit_unknown` (the keyless false-clear) + flights-not-requested `transit_unknown` (the visa-only false-clear) + KV-resolved-passport `noCache` (home-nationality flip not served stale, the omitted-passport false-clear), phase-ordering/price_trend flights-unavailable ×2, price_trend cross-currency verdict-suppression (offer EUR vs quartiles USD + keyless mirror) ×2, partial-failure/ok-flags ×2, freshness stale-serve honesty + `assumed_dates` stale-hit honesty ×2), `_travel.test.ts` (~12 pure cases), input fixtures (`gf.html` aria-label capture from the actual curl-impersonate transport; a wikitext visa-table fixture) and three envelope golden fixtures (§7: full keyed, US-route/unkeyed, third-country connection + its flights-timeout, keyless-unresolved-routing, flights-not-requested/visa-only, and pre-auth-hidden-transit companions). Mocking per house style: `vi.spyOn(globalThis,"fetch")` for Amadeus/Wikipedia/GitHub-raw, `vi.mock("../proxy")` for the scrape fallback, inline realistic fixtures, unset-key path asserted.
- **Touched**: `registry.ts` (3 env keys), `fns/index.ts` (register), `index.ts` (`maintenanceTick` +1 step), `sux/scripts/gen-airports.mjs` (+ committed `airports.json`), `visa-overrides.ts`, FUNCTIONS.md/SKILL.md/plugins-mirror/snippet counts (89→90), README (Amadeus prod key section, non-targets, US-POS + solver-never), PLAN.md status, `golden.test.ts`, `selftest` (+ canaries).
- **Not touched**: wrangler.jsonc cron (reused as-is), proxy/render infra (consumed via the `render` fn), no new bindings.

---

## Deliberate scope cuts

- **Flexible-date search** (Amadeus Cheapest Date) — thin route coverage; `price_trend` already answers "is this date's price good."
- **LiteAPI hotel rates** (v2) — needs card-on-file; the same card-on-file friction is now honestly accepted for the production Amadeus key, so LiteAPI is reconsidered on equal footing in v2, not shipped in v1.
- **tfs protobuf encoder** — fixture + field map committed; the ~40-line varint writer is a one-cycle upgrade, not v1.
- **Sub-daily price granularity** — a one-line cron addition, deferred.
- **Multi-city / multi-leg itineraries** — rejected with a teaching error; call per-leg.
- **Dual-national / travel-document nationality** — single `passport` string; call twice for duals (documented, no schema bloat).
- **Airline-direct links beyond United** — table-driven; v1 ships UA only, others fall back to `route_search`.

---

## Safety notes

> **VISA — reference data, not legal advice.** The visa facet answers from a commit-pinned, community-maintained passport-index matrix + a small vendored pre-authorization table + Wikipedia detail. It **refuses** rather than guesses: no nationality → `ok:false`; unrecognized dataset value → `layout_change`; dataset >12 months old → stops asserting a requirement and returns only official verify links. It **never** folds ESTA/ETIAS/ETA/eTA into "not required" — the vendored pre-authorization override table is applied to **both the destination AND every resolved transit country**, emitting a structured `pre_authorization:{name,url,applies_to}` even when the matrix cell reads `visa_free` (airside transit through a pre-auth country such as the US, which has no sterile international transit, is the highest-miss case). It **never** infers nationality from the departure city, and always flags **transit-country** exposure from the offer's own segments with an explicit "entry-rule, confirm airside-transit" caveat. "Nonstop — no transit exposure" is asserted **only** when an offer's stop counts are zero, never merely because `connects_in` is empty: a connecting offer whose routing could not be resolved (`routing_known:false`, the keyless fare path) — or a visa-only call that requested no flights facet, so no itinerary was evaluated — emits `transit_unknown:true`, never a false `transit:[]`. Every visa answer carries a non-droppable `verify.official` government link, `data_as_of`, and the dual-national/residence-permit scope note. Confirm at the linked authority before booking.

> **PRICE — a quote is not a booking.** Every fare is a point-in-time GDS or scraped-teaser number, not a held quote. `search_link.kind` is `route_search` unless an airline template matched — **the link opens a live search, not this exact fare** ("$918 here, maybe $1,240 on the page"). Money objects each name their own `currency`; the top-level field is `requested_currency`, not a promise that every number is in it. Keyless fares are **USD/US point-of-sale teasers** (`approx:true`). `AMADEUS_ENV=test` numbers are **canned samples** stamped `env:"test"`. Price-trend verdicts are per-adult, cabin-matched deal barometers over an interpolated historical distribution — never a forecast, suppressed entirely for business/first **and for nonstop-only requests, since the price-history distribution cannot be filtered to nonstop** (the metrics API has no `nonStop` parameter, so the all-routing quartiles are a different routing basis than a nonstop-only fare and a nonstop-vs-all-routing verdict would be confidently wrong — `verdict:null`, quartiles still shown as all-routing), and **suppressed when the fare and the price-history quartiles are in different currencies** (the metrics API and the offer can each quote a currency that differs from the one requested, so a cross-currency verdict would be a confidently-wrong EUR-vs-USD signal — `verdict:null`, quartiles still shown in their own currency). sux never books.
