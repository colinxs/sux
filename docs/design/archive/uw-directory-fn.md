---
title: "uw — University of Washington directory fn (PWS)"
status: blocked
cluster: fns
type: design
summary: "Design + resume plan for a `uw` people-directory fn over UW's Person Web Service. Research killed the build: PWS has no public tier — it is single-tier mutual-TLS. Blocked on colinxs obtaining a UW PWS client cert; this is the resume-here spec once it lands."
tags: [sux, fns, design, blocked, uw, mtls]
updated: 2026-07-11
related: ["[[keys]]", "[[token-setup]]", "[[Functions-MOC]]"]
---

# uw — University of Washington directory fn (PWS)

> Task #27. Original ask: a `uw` fn over UW's **Person Web Service (PWS)** with a
> **public tier** (published name/dept/email) for `search`/`get`, plus a cert-gated
> restricted tier held `not_configured` for later.

## Decision

**BLOCKED — build deferred, not designed-away.** Research invalidated the task's core
premise. PWS has **no public/anonymous tier**: it is a **single tier**, gated by
**mutual TLS (x509 client cert)** at the TLS handshake. A plain `fetch()` — what all
~91 existing fns use — cannot reach it. Getting a cert is a real UW-IT approval
workflow, not a config toggle, so it can't be satisfied inside this session or by a
Worker secret alone.

We are **not** shipping a `uw.ts` now. Doing so would either (a) ship a fn that 100%
fails at the TLS layer and errors forever, or (b) require a test suite that fully
fakes mTLS and asserts a **fabricated** response contract we can never validate. Both
are worse than nothing. Instead: track task #27 as **blocked-on-external-credential**
and keep this doc as the resume-here spec.

**Unblock condition:** colinxs (UW alum/affiliate) requests + obtains a UW PWS x509
client cert via `pws-support@uw.edu`, then `wrangler mtls-certificate upload`s it and
binds it. Then the "Build (when unblocked)" section below is executable in one PR.

## What research found

| # | Finding | Evidence |
|---|---|---|
| 1 | **No public tier.** UW-IT's own PWS page states *"All the resources are private, and access requires approval."* There is exactly **one** tier — the task's public-vs-restricted split does not exist. | UW-IT PWS service page; PWS docs |
| 2 | **Auth is mutual TLS, not a header.** The server issues a TLS `Request CERT` handshake message *before any HTTP request is processed* — verified with `curl -v https://ws.admin.washington.edu/identity/v2/person.json`. There is **no** bearer-token / API-key path. | Empirical `curl -v` handshake trace |
| 3 | **The cert is an approval workflow.** Requires a UW affiliation (student/staff/faculty) + a sponsor, a request to `pws-support@uw.edu`, and UW-IT approval. Not something a session or a lone Worker secret can produce. | `node-pws` README; UW-IT wiki |
| 4 | **A cert IS pluggable into a Worker.** Cloudflare exposes uploaded client certs as an `mtls_certificates` binding (`env.<BINDING>.fetch(...)`). So once colinxs holds a cert, this becomes buildable — same "keyed-but-dormant" shape as Todoist / Dropbox Mode B. | Cloudflare mTLS docs |

### Why plain `fetch()` cannot work here (the load-bearing point)

Every other keyed fn (`todoist.ts`, `crossref.ts`, …) authenticates *inside* the HTTP
request — a `Authorization: Bearer …` header on a global `fetch`. PWS authenticates
*underneath* HTTP: the client cert is presented during the TLS handshake, before the
first byte of the request line. A global `fetch` has no client cert to present, so the
handshake completes without one and PWS refuses every request. The only transport in a
Cloudflare Worker that presents a client cert is the `Fetcher` returned by an
`mtls_certificates` binding. This is a transport swap, not a header tweak — which is
exactly why it can't be faked convincingly in a test and shouldn't be written blind.

## Build (when unblocked)

The shape mirrors `todoist.ts` (keyed-fn skeleton: `not_configured` gate, small
transport helper, `codeFor()` status mapper). The one difference — and it's the whole
point — is the transport: `env.UW_PWS_CERT.fetch(...)` instead of global `fetch`.

### 0. Prereq — upload the cert, get its id

```
wrangler mtls-certificate upload \
  --cert /path/to/uw-pws.pem \
  --key  /path/to/uw-pws.key \
  --name uw-pws
# → prints a certificate_id (account-scoped)
```

### 1. Binding — `sux/wrangler.jsonc`

Add **only after** the cert exists (a dangling `certificate_id` risks the
`wrangler deploy --dry-run` CI gate and the `main`→prod deploy):

```jsonc
// UW Person Web Service client cert (uw fn) — presented at the TLS handshake;
// PWS is mutual-TLS only, no bearer path. Absent → the fn is not_configured.
"mtls_certificates": [
  { "binding": "UW_PWS_CERT", "certificate_id": "<id from step 0>" }
]
```

### 2. Env type + gate — `sux/src/registry.ts`

`Fetcher` is a global from `worker-configuration.d.ts` — no import needed. The field
is type-only and harmless to add early; the binding (step 1) is what actually makes it
present at runtime.

```ts
// UW Person Web Service (uw fn) — a client cert presented via mutual TLS (PWS has no
// bearer/anonymous path). Uploaded with `wrangler mtls-certificate upload` and bound
// as an mtls_certificate. Absent → the fn returns not_configured; nothing runs.
UW_PWS_CERT?: Fetcher;
```

Gate, mirroring `hasTodoist` (define it in `uw.ts`):

```ts
export const hasUwPws = (env: RtEnv): boolean => Boolean(env.UW_PWS_CERT);
```

### 3. The fn — `sux/src/fns/uw.ts`

Skeleton (illustrative — do not commit until the cert lands and the real response
shape is observed; see "Open questions"):

- `const API = "https://ws.admin.washington.edu/identity/v2";`
- `not_configured` gate first: `if (!hasUwPws(env)) return failWith("not_configured", "UW PWS not configured — needs a UW PWS x509 client cert uploaded via `wrangler mtls-certificate upload` and bound as UW_PWS_CERT. Access is approval-gated (pws-support@uw.edu).")`
- `async function papi(env, path)` = `todoist.ts`'s `tapi` but the transport line is
  `await env.UW_PWS_CERT.fetch(`${API}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) })`. Read-only: GET only, no bodies.
- `codeFor(status)` — same taxonomy map as `todoist.ts`. Nuance: a **403** from PWS
  can mean *"cert valid but not authorized for this resource/field"* (a scope wall),
  not "no cert." Mirror Todoist (401/403 → `not_configured`) but consider surfacing a
  restricted-resource 403 as `blocked` with a message that the cert lacks that scope.

Actions:

| action | request | returns |
|---|---|---|
| `search` | `GET /person.json?name=<q>&page_size=…&page_start=…` (also `first_name`/`last_name`/`department`/`email`/`phone`) | paginated list, each normalized to `{ netid, regid, displayName, department?, email?, phone? }` |
| `get` | `GET /person/{netid_or_regid}.json` | one normalized person (same shape) |

- **Normalize, don't passthrough.** PWS returns a verbose affiliations envelope
  (`Persons[]`, `UWNetID`, `UWRegID`, `DisplayName`, employee/student affiliation
  sub-objects). Map to the small `{ netid, regid, displayName, department?, email?, phone? }`.
  `department`/`email`/`phone` live under the employee "white pages" affiliation and
  may be absent (directory suppression **or** the cert not being authorized for them).
- **Restricted fields stay gated.** Student/employee affiliation records (course,
  status, home dept detail, etc.) are omitted / `not_configured` unless the cert is
  later authorized for them. Cert authorization level is **opaque until the cert is in
  hand**, so this can't be fully specced now.

### 4. Register + doc (CI gates 4 & 5)

```
npm run gen:index   # adds uw to sux/src/fns/index.ts — commit it
npm run docs        # regenerates sux/FUNCTIONS.md — commit it
```

Hand-editing either fails CI.

### 5. Tests — `sux/src/fns/uw.test.ts`

Mock the **binding's** transport, not global `fetch` (this is the one departure from
`todoist.test.ts`, which stubs `globalThis.fetch`). Pattern:

```ts
const ENV = { UW_PWS_CERT: { fetch: vi.fn(async (u) => new Response(JSON.stringify({/* PWS shape */}), { status: 200 })) } } as any;
```

- `not_configured` when `UW_PWS_CERT` is absent (`uw.run({}, { action: "search", ... })`).
- `search` builds the right query string and normalizes `Persons[]` → the small shape.
- `get` hits `/person/{id}.json` and normalizes one record.
- status mapping: 404 → `not_found`, 403 → `not_configured`/`blocked`, 429 → `rate_limited`.

## Open questions (resolve against a real cert, not now)

1. **Returned field shape is per-cert.** PWS scopes which fields a cert may read. The
   normalized `{ department, email, phone }` are aspirational until a real response is
   seen — the fn's normalize map and the test fixtures must be written **against the
   actual response**, which is precisely why writing it blind now is wrong.
2. **Authorization level is opaque.** We won't know which affiliation records the cert
   unlocks (directory-only vs employee vs student) until UW-IT grants it. That governs
   how much of the "restricted" surface is reachable at all.
3. **NetID vs UWRegID on `get`.** Confirm `/person/{id}.json` accepts both a UWNetID
   and a 32-hex UWRegID, or whether one requires a different path.
4. **Rate/usage terms.** PWS is an internal UW service; confirm acceptable-use limits
   before pointing an MCP connector at it.

## Resume checklist

- [ ] colinxs emails `pws-support@uw.edu`, requests PWS access + a client cert (needs a UW sponsor/affiliation).
- [ ] Receive `uw-pws.pem` + `uw-pws.key`; note which resources/fields the cert is authorized for.
- [ ] `wrangler mtls-certificate upload --cert uw-pws.pem --key uw-pws.key --name uw-pws` → capture `certificate_id`.
- [ ] Branch `feat/uw-directory-fn`. Add: `mtls_certificates` binding (wrangler.jsonc), `UW_PWS_CERT?: Fetcher` + `hasUwPws` (registry/uw.ts), `uw.ts`, `uw.test.ts` written **against the real response shape**.
- [ ] `npm run gen:index && npm run docs`; commit `index.ts` + `FUNCTIONS.md`.
- [ ] `npm test && npm run type-check` green; PR; `/code-review ultra`; merge.
- [ ] Record the secret/binding in [[keys]] (Currently-wired table) once live.

## Alternatives considered

- **Ship dormant now like Todoist (mocked tests, `not_configured` gate), defer only the
  wrangler binding.** Rejected. Todoist's transport is plain `fetch`, already exercised
  by 90 other fns and real the instant a token is set; its response shape is a stable
  public REST contract. `uw`'s transport (`env.UW_PWS_CERT.fetch`) can be exercised by
  *nothing* until a cert exists, and its response shape is **per-cert and opaque**. A
  dormant `uw.ts` would bake guessed field mappings into code + tests that green only
  because they assert against our own fabrication. Deferring until we can see a real
  response is strictly better.
- **Scrape the public UW directory web UI instead of PWS.** Out of scope for a "PWS
  fn," and the web directory is itself backed by PWS with its own suppression rules;
  the sux scrape/render ladder already exists if a directory-scrape fn is ever wanted.
