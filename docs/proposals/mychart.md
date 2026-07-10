# `mychart` — personal health data conduit (Epic SMART on FHIR + Apple Health ingest)

Proposal for connecting sux to the owner's MyChart account and Apple Health data.
Status: **design** — nothing here is built yet. Research current as of 2026-07
(Epic on FHIR docs, Apple HealthKit docs, and field reports cited inline).

## 0. The one-paragraph verdict

There are two distinct data planes, and they want two different pipes:

1. **Clinical records (labs, meds, conditions, notes, immunizations, vitals from
   the health system)** — pull them **directly from Epic's patient-facing SMART
   on FHIR API**, Worker-to-Epic, skipping Apple entirely. Registration at
   fhir.epic.com is free for patient-audience apps, needs no review, and the
   OAuth shape (refresh token held server-side, short-lived access tokens minted
   on demand and cached in KV) is exactly the pattern `fns/dropbox.ts` already
   implements and the daily cron in `index.ts` already maintains for Kroger.
2. **Wearable/fitness data (steps, HR, sleep, workouts from Apple Watch)** —
   this lives only in HealthKit on the phone, has **no cloud API at all**, and
   the practical pipe is the **Health Auto Export** app POSTing JSON to a new
   authenticated ingest endpoint on the Worker.

Apple Health *as a route to clinical records* was evaluated and rejected as the
primary path (§4): HealthKit clinical records are readable only by an on-device
iOS app with the clinical-records entitlement, there is no Mac/iCloud/Shortcuts
access, and Epic exposes the same FHIR API to us directly anyway.

## 1. Why direct Epic, concretely (research findings)

All from the Epic research pass (fhir.epic.com docs; Josh Mandel's Feb-2026
activation journal, github.com/jmandel/health-skillz; Medblocks' 48-hour guide):

- **Free, no review.** A patient-audience app registered at fhir.epic.com gets
  sandbox + production client IDs immediately. Patient-standalone apps using
  **only USCDI read APIs** qualify for *Automatic Client ID Distribution*: the
  client ID syncs to essentially every Epic org (~48h; config changes propagate
  in ~12h) with no per-org approval. Info-blocking rules mean orgs can't refuse
  patient-directed access.
- **The catch — refresh tokens.** `offline_access` (advertised as
  `permission-offline` in Epic's `.well-known/smart-configuration`) requires a
  **confidential client**, and the client secret (or JWKS public key) must be
  provisioned **per health system** via fhir.epic.com → *Review & Manage
  Downloads*. Orgs also choose the refresh-token lifetime at download time. For
  a single user with one or two health systems this is a few clicks, not the
  500-org slog Mandel automated. Without refresh tokens the app auto-syncs
  everywhere but every pull needs an interactive MyChart login.
- **Escape hatch:** Epic supports OAuth 2.0 **Dynamic Client Registration**
  ("Can Register Dynamic Clients" checkbox): after one interactive login the
  app registers a per-install keypair and thereafter mints tokens via
  `jwt-bearer` grant indefinitely — no shared secret to provision. Org support
  varies; Mere Medical (meremedical.co) uses this successfully against Epic.
  Worth enabling on the app registration as a fallback lever.
- **App registration is immutable once marked ready-for-production** — scope
  list can't change without a new client ID. Choose APIs generously up front
  (but USCDI-only, or auto-sync is forfeited).
- **Resources available** (Epic USCDI R4 read set): Patient, Observation (labs,
  vitals, social history), DiagnosticReport, DocumentReference → Binary
  (clinical notes / After Visit Summaries), Condition, MedicationRequest +
  Medication, AllergyIntolerance, Immunization, Procedure, Encounter, CarePlan,
  CareTeam, Goal, Device (implants), Provenance. **Appointment exists but is
  not USCDI** — selecting it breaks auto-sync; leave it out. **No patient bulk
  `$export`** — iterate per-resource searches.
- **Endpoint discovery:** open.epic.com/MyApps/Endpoints publishes the SMART
  *User-access Brands* bundle (Endpoint + Organization with patient-facing
  names). Epic says don't query at runtime — snapshot it. For a single-user
  deployment the org's FHIR base URL is just a config var; the bundle is only
  needed once to find it. Then `{base}/.well-known/smart-configuration` gives
  the authorize/token endpoints; the base URL is passed as `aud`.
- **PKCE S256 always** (the sandbox advertises S256 only).
- **TEFCA IAS** (network-wide individual access via QHINs) is the future
  alternative that skips per-EHR registration, but is not practical for a solo
  hobbyist in 2026 (QHIN contracts, IAL2 identity proofing). Revisit yearly.

## 2. Architecture — what gets built

Three small pieces, all following existing sux patterns:

```
                         ┌────────────────────────────────────────────┐
 (a) one-time browser →  │  /mychart/connect ── 302 → MyChart login   │
     MyChart OAuth dance  │  /mychart/callback ── code+PKCE → tokens   │──► KV: refresh token
                         │      (public routes, pre-OAuth-gate,       │
                         │       like /health — state+verifier in KV) │
                         ├────────────────────────────────────────────┤
 (b) MCP tool `mychart`  │  ops: status | connect | pull | get        │──► Epic FHIR R4
     + daily cron tick    │  token mint mirrors fns/dropbox.ts;        │◄── access token (KV,
                         │  cron keeps refresh token alive (kroger    │    TTL = expires_in-60)
                         │  pattern in scheduled())                   │
                         ├────────────────────────────────────────────┤
 (c) /apple-health ingest │  POST, bearer-secret gated, receives      │◄── Health Auto Export
     endpoint             │  Health Auto Export JSON → R2 (private)   │    (iPhone, Premium tier)
                         └────────────────────────────────────────────┘
```

### (a) OAuth routes

Two public routes served in `handleObservability()`-style *before* the
OAuthProvider claims paths (same trick as `/health`, `/metrics`):

- **`GET /mychart/connect`** — builds the SMART authorize URL (PKCE S256
  verifier + `state` stored in KV, 10-min TTL), 302s to the org's
  `authorization_endpoint`. Gate it: require the sux GitHub session or a
  one-time secret in the query — it's single-user, but the URL shouldn't let a
  stranger bind *their* MyChart to the Worker.
- **`GET /mychart/callback`** — the registered redirect URI. Exchanges
  `code` (+ verifier, + client secret) at the `token_endpoint`, stores
  `{refresh_token, patient, issued_at}` in KV under `sux:mychart:grant`,
  caches the first access token, returns a plain "connected" page.

**Refresh token lives in KV, not a wrangler secret** — unlike Dropbox's static
refresh token, Epic's may rotate on use and has an org-chosen lifetime, so it
must be writable at runtime. `EPIC_CLIENT_ID`, `EPIC_CLIENT_SECRET`, and
`EPIC_FHIR_BASE` are wrangler vars/secrets.

### (b) The `mychart` fn

One fn, `sux/src/fns/mychart.ts`, registered like every other (gen-index picks
it up; `npm run docs` + skill sync after):

- `op:"status"` — grant present? token mintable? patient ID, org base, scopes,
  refresh-token age. Never returns token material.
- `op:"connect"` — returns the `/mychart/connect` URL to open in a browser
  (the fn can't do the interactive dance itself).
- `op:"pull"` — the sync verb: iterates the resource types (default: the full
  USCDI set; `types:[...]` to narrow), pages through search results
  (`Observation?patient={id}&category=laboratory`, etc.), resolves
  DocumentReference attachments via Binary, and writes raw FHIR JSON bundles to
  R2 under a **private** prefix (see §5). Returns a per-type count summary.
  `since:"2026-01-01"` filters where the server honors date search params
  (`_lastUpdated` support is org-dependent — fall back to client-side diffing
  against the previous pull, which the content-addressed cache makes cheap).
- `op:"get"` — narrow FHIR passthrough for ad-hoc queries:
  `path:"Observation?category=vital-signs&date=ge2026-06-01"` → JSON. Read-only
  GETs only, path-prefix-validated against `EPIC_FHIR_BASE`.

Token minting is a straight port of the `dbxFetch` pattern
(`sux/src/fns/dropbox.ts`): KV-cached access token with `expires_in - 60` TTL,
re-mint from the refresh token on miss, one drop-and-retry on 401. On refresh
response, **persist any rotated refresh_token back to KV** before using the
access token.

Caching: `pull`/`get` results are PHI — set the fn's cache policy to **no KV
result caching** (or a very short TTL keyed private); the generic
`deferCacheWrite` path must not spray lab results across the shared cache
namespace. The access-token cache in `OAUTH_KV` is fine (opaque, short-lived).

Cron: add a `refreshMychartToken(env)` alongside `refreshKrogerToken` in
`maintenanceTick()` — its real job is **keeping the refresh grant alive** (some
orgs expire refresh tokens on inactivity) and optionally running a weekly
`pull`. Same never-throw wrapping.

### (c) Apple Health ingest endpoint

- **`POST /apple-health`** — public route, gated by a constant-time comparison
  against `HEALTH_INGEST_TOKEN` (wrangler secret) in an `Authorization: Bearer`
  header. Body: Health Auto Export's JSON schema (`data.metrics[]` /
  `data.workouts[]`). Writes the raw payload to R2 (private prefix, dated key),
  optionally folds a compact daily rollup into KV for cheap `status` queries.
- Phone side: **Health Auto Export — JSON+CSV** (Premium tier) REST API
  automation → URL + custom auth header, batch mode on. Known constraint:
  HealthKit is unreadable while the phone is locked, so pushes ride Background
  App Refresh and fire when the device is unlocked — cadence jitters; design
  the endpoint as idempotent upsert (`automation-id` + period headers come with
  each request) and never assume completeness.

## 3. Registration checklist (the one-time human steps)

1. fhir.epic.com account → Build Apps → **Application Audience: Patients**.
2. Select USCDI R4 **read** APIs only (the §1 resource list; *no Appointment*).
3. Redirect URI: `https://sux.colinxs.workers.dev/mychart/callback`.
4. Request `offline_access` scopes; tick **Can Register Dynamic Clients** (free
   fallback lever); confidential client with a client secret.
5. Fill the Data Use Questionnaire (patients see it on the consent screen).
6. Sandbox-test against `https://fhir.epic.com/interconnect-fhir-oauth/...`
   (test patients: Camila Lopez etc.), then **Save & Mark Ready for
   Production** — remembering the registration is then immutable.
7. In *Review & Manage Downloads*, provision the client secret for the owner's
   health system(s) so refresh tokens work there (org sets the lifetime).
8. Find the org's production FHIR base in the open.epic Brands bundle → set
   `EPIC_FHIR_BASE`, `EPIC_CLIENT_ID`, `EPIC_CLIENT_SECRET`.
9. Open `/mychart/connect`, log into MyChart once, approve. Done — `mychart
   op:"pull"` works headlessly from then on.

## 4. The Apple Health clinical-records route — assessed, kept as fallback

Findings from the Apple-side research pass:

- The Health app's Health Records feature speaks the *same* SMART on FHIR API
  we'd use directly; data flows institution→device over TLS, never through
  Apple's servers, and iCloud sync is E2E-encrypted — **there is no cloud API**.
- Third-party read access exists (`HKClinicalRecord` → raw FHIR JSON via
  `fhirResource.data`) but only from an iOS app carrying the clinical-records
  entitlement (`com.apple.developer.healthkit.access = ["health-records"]`).
  No Apple approval gate for a personal Xcode-installed app (App Review only
  applies to Store/TestFlight distribution) — so a ~100-line personal app that
  `HKSampleQuery`s the eight clinical types and POSTs to `/apple-health` is
  genuinely feasible on a paid developer account.
- But: **no Shortcuts access** to clinical records, **no Mac HealthKit**
  (`isHealthDataAvailable()` is false on macOS even in 2026), and no shipping
  app auto-pushes clinical records ("Health Record Export" by HealthyApps does
  manual FHIR-JSON export only).
- The Health app's *Export All Health Data* ZIP does include
  `clinical-records/*.json` raw FHIR — a fine manual, zero-code fallback.

**When this route wins:** a health system too small/hostile for direct FHIR
registration, or aggregating multiple portals through Apple's connector UI
without touching each org's endpoint. Otherwise it's strictly worse than §2 —
device-bound, entitlement-bound, and schedule-unreliable. Keep as Phase 3.

## 5. PHI invariants (new, load-bearing for this fn)

Health data is the most sensitive payload sux will ever hold. Rules:

- **Never route health blobs to `dropbox`** — its shared links are public
  "anyone with the link" URLs by design, and ingest's blob routing must gate on
  content class, not just size.
- **No public `/s/<uuid>` share links for FHIR/HealthKit payloads.** Store
  under a distinct R2 prefix (`phi/`) that the `/s/` handler refuses to serve;
  retrieval goes through the OAuth-gated MCP boundary only.
- **No result-caching of PHI in the generic KV cache** (per-fn cache policy:
  off). Token caches hold only opaque tokens.
- Logs/metrics keep counts and resource types, never values or identifiers.
- These join the three pillars in the pre-ship sanity gate for any change
  touching `mychart` or `/apple-health`.

(Being the patient exercising individual right-of-access, none of this is a
HIPAA-covered activity — the invariants are self-imposed hygiene, not
compliance theater.)

## 6. Decisions & open questions

| # | Decision | Rationale |
|---|---|---|
| D1 | Direct Epic FHIR is the clinical pipe; Apple Health is fitness-only | §1 vs §4 — server-to-server beats device-bound |
| D2 | Confidential client + per-org secret, not public client | refresh tokens = headless pulls; one org ≈ minutes of clicking |
| D3 | Refresh token in KV, not wrangler secret | rotates at runtime; org-chosen lifetime |
| D4 | USCDI-only scope selection | preserves automatic client-ID distribution |
| D5 | Health Auto Export over a custom HealthKit app (Phase 1) | zero code on the phone; custom app deferred to Phase 3 |
| D6 | PHI: no dropbox, no `/s/` links, no KV result cache | §5 |

Open: (O1) does the owner's specific health system honor `_lastUpdated` search
and what refresh-token lifetime does it set — discoverable only after step 7 of
§3; (O2) whether `pull` should auto-project summaries into the Obsidian vault
via `ingest` (nice for "ask about my labs" flows, but multiplies PHI copies —
default off, explicit opt-in); (O3) DCR instead of client secret if the org's
download flow misbehaves.

## 7. Build order

1. **Routes + grant plumbing** — `/mychart/connect`, `/mychart/callback`, KV
   grant record, token mint helper (port of `dbxFetch`), sandbox-tested against
   fhir.epic.com test patients. *(Registration steps 1–6 happen here.)*
2. **`mychart` fn** — status/connect/get first (thin, testable), then `pull`
   with per-type pagination + R2 `phi/` writes; cron refresh in
   `maintenanceTick`. `npm run docs` + skill sync.
3. **`/apple-health` ingest** — endpoint + HAE automation on the phone.
4. **Phase 3 (optional)** — personal `HKClinicalRecord` iOS app; vault
   projection (O2); TEFCA re-evaluation.

Tests: token mint/refresh/rotation against a mocked token endpoint (incl.
rotated-refresh-token persistence and the 401 drop-and-retry); callback
state/PKCE round-trip; `pull` pagination + Binary resolution on canned FHIR
fixtures; `/apple-health` auth rejection + idempotent re-POST; the §5 PHI
gates (dropbox routing refusal, `/s/` refusal on `phi/`, cache-off) asserted
explicitly.
