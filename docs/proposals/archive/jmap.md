---
title: jmap — the JMAP conduit
status: shipped
cluster: namespaces
type: proposal
summary: "The full JMAP protocol as one typed conduit verb forwarding raw batches to Fastmail; _jmap.ts session/limit engine; MaskedEmail/Contacts/Calendars."
tags: [sux, namespaces, designed]
updated: 2026-07-09
---

# sux fn design: `jmap` — the full JMAP protocol as one lean generic verb (FINAL)

Post-tournament synthesis. The raw-passthrough winner is the spine; every judge graft and every one of the 43 adversarial issues (9 blockers, 19 majors, the rest minors) is folded in as if always intended. `jmap` is **one fn** that is a typed conduit to a JMAP endpoint (Fastmail today): the caller sends a raw JMAP batch, sux injects auth, discovers+caches the Session, resolves the reference graph for safe splitting, transparently paginates around the per-request limits, gates the irreversible mutations, and returns the raw `methodResponses` byte-exact. It curates nothing — it forwards method names — so the whole of Email/Mailbox/Thread/Identity/EmailSubmission/VacationResponse/Contacts/Calendars **and** Fastmail's MaskedEmail extension is reachable through the same verb. The escape hatch is the product.

Two hard facts every section respects: **`FN_DEADLINE_MS = 60_000`** wraps every `fn.run` (`index.ts:41/:252`) and abandons the run with zero partials on timeout; **`CACHE_STALE_GRACE_SECONDS = 86_400`** (`mcp-util.ts:58`) means any `cacheable:true` result is served stale for up to 24h. Both drive load-bearing decisions below (`cacheable:false`; a 55s soft budget with an outer-variable cursor).

---

## 0. Resolved decisions

Every contradiction between the winner, the grafts, and the issues, resolved in one line each.

| # | Question | Decision |
|---|---|---|
| D1 | Read caching | **`cacheable:false`** (like `kv_get`). The 24h global stale-grace defeats any short ttl and caching mail persists decrypted bodies + Session PII to shared KV. Freshness comes from JMAP's own state tokens, not the response cache. |
| D2 | fn-count | **89 → 90, +1.** Real baseline is 89 non-test fn files / 86 registered. Judge 1's "94→96, two fns" is wrong on both count and cardinality; the single `jmap` verb is v1. |
| D3 | Second `mail` fn | **Deferred.** Ship the raw verb only; add `mail` in a later cycle *iff* the long tail earns the slot. The session/postBatch/limit engine is factored into `_jmap.ts` so a future `mail` is cheap. |
| D4 | Destroy gating | **Gated.** `Email/set {destroy}` permanently expunges (it does NOT move to Trash); `Mailbox/set` with `onDestroyRemoveEmails` wipes a folder. A new `allow_destroy` gate rejects any non-empty `destroy`. The winner's "destroy is recoverable" prose was factually wrong and is corrected. |
| D5 | Persistent-egress gating | **Gated under `allow_destroy`** (the "establishes lasting outbound/exfil" class): `VacationResponse/set` and any Sieve/rule/forwarding method the live Session advertises. The winner's "reachable with no code" brag is deleted. |
| D6 | What the gates actually defend | **Accidental mutation only.** `allow_send`/`allow_destroy` are LLM-set booleans; an injected instruction can set them true. They are NOT an injection boundary. Real containment for irreversible ops is a **scoped (read-only where possible) token** + out-of-band confirmation the MCP surface can't provide. Documented honestly, not marketed as safe. |
| D7 | `Foo/set` over `maxObjectsInSet` | **Refuse, never auto-split.** Creation-ids and `ifInState` are single-call-scoped; splitting corrupts references and fakes atomicity. Emit a teaching `bad_input` and let the caller chunk. (Kills the non-atomic-write hole entirely — there is no split-write path.) |
| D8 | Split-safety graph | **Weakly-connected components over BOTH reference forms**: `resultOf` ResultReferences AND creation-id (`#name`) references in id-value positions. Refuse (`bad_input` naming the component) if any component exceeds `maxCallsInRequest`; only split *between* independent components. |
| D9 | Query pagination key | **`anchor`/`anchorOffset`** from the first page (stable across mutation), never `position`; dedup accumulated ids by value; validate `queryState` per page and on `cursor` resume. |
| D10 | Paginated back-referenced get | **Collapse** the N hydration pages into ONE synthetic `methodResponse` under the original callId with a concatenated `list`; copy ALL non-`#ids` args verbatim onto each synthesized chunk. |
| D11 | Response merge | **Verbatim order, never re-key/dedupe by callId.** `onSuccessUpdateEmail` injects an extra Email/set response sharing a callId; keying by callId is ambiguous. Preserve each sub-POST's order, concatenate sub-POSTs in dispatch order. Reject caller batches with duplicate callIds up front. |
| D12 | `using` derivation | **Over-declare + union.** When EmailSubmission is present add `mail` too (onSuccess\*Email implies it); include every advertised capability the batch touches; explicit `using` is UNIONed, never allowed to suppress a required capability. |
| D13 | Send ergonomics | **Teach, don't rewrite.** Ship the two-step send skeleton in the description/docs; do NOT auto-inject Identity/get or rewrite the batch (that would violate "pure conduit"). Gate exactly the EmailSubmission/set-create behind `allow_send`. |
| D14 | MaskedEmail accountId | Resolve to the account whose `accountCapabilities` includes the capability URN (scan `session.accounts`), NOT `primaryAccounts[maskedemail-urn]` (undefined). Same rule for any non-primary capability. |
| D15 | `upload.data` sources | **base64 or a sux `/s/<uuid>` CAS ref only.** Drop "https URL to fetch" — a server-side fetch of a caller URL is an SSRF into the documented internal Tailscale/Funnel hosts. |
| D16 | Blob size | Inline base64 ceiling ~**190KB** (bounded by `MAX_ARG_BYTES=256KB`). The `/s/<uuid>` R2 store-ref is the PRIMARY path for real attachments; honored upload capped well under `FETCH_BYTES_MAX_BYTES` (32MB), never the mythical 250MB. |
| D17 | Deadline math | Per-POST `AbortSignal.timeout(min(30_000, 55_000 − elapsed))`; `withRetry` disabled on the near-deadline final POST; cursor + accumulated ids held in an OUTER variable so a mid-POST timeout still returns a resumable cursor. |
| D18 | Output ceiling | An accumulated-OUTPUT byte ceiling on the paginate/hydrate loop, **independent of `raw:true`** (raw opts out of `MAX_OUTPUT_CHARS`, so a huge pull could blow context) — stop and return a cursor / spill to R2 when hit. |
| D19 | `raw` | **`raw:true`.** JSON passes byte-exact through `safeStringify` (U+2028/2029 escaped); the close-boundary `normalizeText` would corrupt MIME/emoji/blob bytes. |
| D20 | Self-cap constants | One table (§6.0): calls `min(advertised, 40)` for independent batching, `advertised` as the hard cap for indivisible chains; get/set/query-page objects `min(advertised, 200)`; RFC minimums (16/500) fallback only. |
| D21 | FailCode text | Map only the JMAP error TYPE token; never interpolate the server `description` or the offending args (they echo addresses/filter strings into the Grafana `err` field). |

---

## 1. The one-sentence thesis

JMAP is already a generic-dispatch RPC — `{using, methodCalls:[[method, args, callId], …]}` with `#` back-references — which *is* the Julia-generic-verb ideal in wire form. So the fn is **`jmap`, a typed conduit to the JMAP endpoint**, not a mail toolkit. It adds exactly the five things an edge proxy is uniquely positioned to add and nothing else: **injected auth**, **cached Session discovery**, **transparent limit-safe batching/pagination**, **mutation gates against accidental sends/destroys**, and **composability with the sux algebra** (`pipe`/`filter`/`map`/`reduce`/`augment` over live mail). It forwards the protocol; it does not translate it.

Name `jmap` verified free (`grep -niE "jmap|mail|fastmail|email" sux/src/fns/index.ts` empty; no `fns/*mail*` file). It reads bidirectionally — `jmap({method})` and `jmap({calls})` are both natural — and `jmap` is the honest altitude (protocol wrapper, not vendor wrapper), letting a future Topicbox/other-JMAP-host reuse it via one env var. **fn-count delta: +1 (89 → 90).** One fn, not 29 tools. This is the entire point vs. the existing 29-tool connector (`33ff6083…`: `send_email`, `read_email`, `draft_email`, `search_email`, `archive_email`, `list_labels`, `list_identities`, `create_contact`, …) — that surface eats context, can't reach MaskedEmail, and adds no caching/proxy/algebra composability.

---

## 2. Input schema (JSON Schema, verbatim)

Dual-mode: a raw `calls` array (full power) OR a single `method`+`args` shorthand (ergonomic single call), plus the two non-batch sub-actions `upload`/`download`. Exactly one of `{calls, method, upload, download}` must be present.

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "calls": {
      "type": "array",
      "description": "Raw JMAP method-call batch: an array of [methodName, argsObject, callId] Invocations executed in order (RFC 8620 §3.2). Back-reference a prior result by prefixing an arg name with '#' and giving a ResultReference {resultOf, name, path} — e.g. Email/query then Email/get with \"#ids\":{resultOf:'q',name:'Email/query',path:'/ids'} chains query→get in one round-trip. Creation-id references (a '#name' string in an id-VALUE position, e.g. EmailSubmission emailId:'#draft') chain a Foo/set create into a later call in the SAME batch. Omit accountId per-args and it is auto-filled from the Session. callIds must be present; duplicate callIds across the batch are rejected (they make back-references ambiguous). Any JMAP method is reachable (Email/*, Mailbox/*, Thread/get, Identity/get, EmailSubmission/set, MaskedEmail/get|set, Contact/*, Calendar*/*, VacationResponse/*).",
      "items": {
        "type": "array", "minItems": 3, "maxItems": 3,
        "prefixItems": [
          { "type": "string", "description": "JMAP method name, e.g. 'Email/query'." },
          { "type": "object", "description": "Method arguments." },
          { "type": "string", "description": "callId echoed back and used as a back-reference anchor. Must be unique within the batch." }
        ]
      }
    },
    "method": { "type": "string", "description": "Single-call shorthand: one JMAP method name (e.g. 'Mailbox/get'). Wrapped into a one-element batch with callId 'c0'. Use `calls` for >1 call or back-references." },
    "args": { "type": "object", "additionalProperties": true, "description": "Arguments for `method`. accountId auto-filled if omitted." },
    "using": {
      "type": "array", "items": { "type": "string" },
      "description": "Capability URNs to declare. OPTIONAL — sux auto-derives the set from the method names present and UNIONS your value in (it never suppresses a required capability). core is always added; mail for Email/Mailbox/Thread/SearchSnippet AND whenever EmailSubmission appears; submission for Identity/EmailSubmission; vacationresponse for VacationResponse/*; the Fastmail maskedemail URN for MaskedEmail/*; contacts/calendars for those. Pass it to ADD capabilities the derivation can't infer (custom/future methods)."
    },
    "paginate": { "type": "boolean", "default": false, "description": "When true, a single Foo/query in the batch is auto-paginated past the server page limit via stable anchor paging, accumulating ids up to max_results / a 55s deadline / an output byte ceiling; a Foo/get back-referenced off that query is hydrated in chunks and COLLAPSED into one response. Returns a `cursor` + partial:true when a bound stops the pull." },
    "max_results": { "type": "integer", "minimum": 1, "maximum": 10000, "default": 500, "description": "Cap on ids accumulated when paginate=true." },
    "cursor": { "type": "string", "description": "Opaque cursor from a prior paginate=true response — resumes at the saved anchor after re-validating queryState/filter against a fresh probe." },
    "upload": {
      "type": "object", "additionalProperties": false,
      "description": "Blob upload (RFC 8620 §6.1). POSTs bytes to the Session uploadUrl, returns {blobId, type, size}. Reference the blobId in a later Email/set attachment. Mutually exclusive with calls/method.",
      "properties": {
        "data": { "type": "string", "description": "Base64-encoded bytes (inline, ≤ ~190KB after the 256KB arg limit), OR a sux /s/<uuid> CAS ref (the primary path for real attachments). A raw https URL is NOT accepted (SSRF)." },
        "type": { "type": "string", "default": "application/octet-stream", "description": "Content-Type of the blob." }
      },
      "required": ["data"]
    },
    "download": {
      "type": "object", "additionalProperties": false,
      "description": "Blob download (RFC 8620 §6.2). Expands the Session downloadUrl and GETs the blob. as:'base64' returns bytes inline (auto-spills to R2 if over the output cap); as:'store' always spills to R2 and returns a /s/<uuid> ref. Mutually exclusive with calls/method.",
      "properties": {
        "blobId": { "type": "string" },
        "type": { "type": "string", "default": "application/octet-stream" },
        "name": { "type": "string", "default": "download" },
        "as": { "type": "string", "enum": ["base64", "store"], "default": "base64" }
      },
      "required": ["blobId"]
    },
    "allow_send": { "type": "boolean", "default": false, "description": "GATE for dispatching mail. An EmailSubmission/set with a non-empty `create` is REJECTED unless true. Accidental-send guard only — an injected instruction can set this; it is NOT an injection boundary. Drafts/moves/flags do not need it." },
    "allow_destroy": { "type": "boolean", "default": false, "description": "GATE for irreversible/persistent-egress mutation. Any Foo/set with a non-empty `destroy` array — AND Mailbox/set with onDestroyRemoveEmails, VacationResponse/set, and any Sieve/rule/forwarding method — is REJECTED unless true. Email/set destroy PERMANENTLY expunges (it does not go to Trash). Accidental-mutation guard only, not an injection boundary. Use a read-only token for read/compose workflows." },
    "session_refresh": { "type": "boolean", "default": false, "description": "Force re-discovery of the JMAP Session (bypass the KV-cached Session) before dispatching. Use if apiUrl/accountId/limits may have changed." }
  }
}
```

There is deliberately **no `action` enum** (contrast `obsidian`/`kroger`). JMAP's own method names *are* the action vocabulary; an sux-level enum would be a second redundant curation layer and would collapse `jmap` into a mail toolkit. The only sux-level sub-actions are the two things that are *not* JMAP method calls — `upload`/`download` (raw HTTP to the upload/download URLs, not the `apiUrl` batch endpoint).

---

## 3. Auth model

Secrets on `RtEnv` (`registry.ts:52-72`, added near kroger/ebay), all optional:

```ts
FASTMAIL_TOKEN?: string;        // Bearer, JMAP-scoped (NOT an MCP-type token)
FASTMAIL_ACCOUNT_ID?: string;   // optional override; normally derived from the Session
FASTMAIL_SESSION_URL?: string;  // optional override; default https://api.fastmail.com/jmap/session
```

`not_configured` guard at the very top of `run`, before any fetch (kroger.ts:147 pattern):

```ts
if (!env.FASTMAIL_TOKEN) return failWith("not_configured",
  "Fastmail JMAP not configured. Set FASTMAIL_TOKEN to a JMAP-scoped API token (Fastmail → Settings → Privacy & Security → API tokens → New token, type JMAP). For read/compose workflows mint a READ-ONLY token so send/destroy are impossible at the credential layer. A 'MCP'-type token will NOT work.");
```

Every egress carries `Authorization: Bearer ${env.FASTMAIL_TOKEN}`, `Content-Type: application/json`, `Accept: application/json`.

**Scope guidance is a first-class security control**, repeated in the not_configured message and the fn description: the token is full-mailbox-powerful, so scope it minimally — a read-only token makes the mutation gates redundant *at the credential layer* (the only real containment against an injected instruction; §10).

**Egress: plain `fetch` wrapped in `withRetry`** (kroger.ts:22/58 pattern), NOT `smartFetch`. `api.fastmail.com` is a clean authed host with no bot wall and no residential-IP need; going direct avoids the Tailscale ladder. A `proxy` opt-in flag (routing via `smartFetch(env, …, "auto")` like `search`) is a noted follow-up, **not v1** — and even if added, an https `upload.data` URL would never be routed through the tailnet exit (§8, SSRF).

---

## 4. Session discovery + KV cache (never hardcode endpoints)

Exactly one URL is fixed: `FASTMAIL_SESSION_URL` (default `https://api.fastmail.com/jmap/session`). Everything else — `apiUrl`, `uploadUrl`, `downloadUrl`, `primaryAccounts`, per-account `accountCapabilities`, and the **limits** (`maxCallsInRequest`, `maxObjectsInGet`, `maxObjectsInSet`, `maxSizeRequest`, `maxSizeUpload`) — is read from the Session.

Model on kroger's token lifecycle (kroger.ts:17-66), caching the whole Session JSON blob in `OAUTH_KV` (already bound — no new binding):

```
SESSION_KEY = "sux:fastmail:session"        // mirrors TOKEN_KEY = "sux:kroger:token"
discoverSession(env): GET session URL with Bearer → parse → OAUTH_KV.put(SESSION_KEY, JSON.stringify(session), {expirationTtl: 3600})
getSession(env):      read KV; on miss → discoverSession
```

The **token is never written to KV** — only the Session response body, which contains no secret. The Session does carry account email addresses (PII); it is held with a tight 3600s TTL and invalidated on `sessionState` change. This is the minimal state needed to route and is why mail *bodies* are never cached (§9).

**Self-heal — three triggers** (kroger.ts:54-65 pattern), all re-discovering **directly** (not via `getSession`, so KV read-after-delete eventual consistency can't hand back a stale Session):

1. **401/403** on an `apiUrl` POST → `delete(SESSION_KEY)` → `discoverSession` → retry once. `withRetry` deliberately does not retry 401/403 (proxy.ts:201), so this fires on the first rejection. Framed honestly: rediscovery re-uses the SAME static `FASTMAIL_TOKEN`; a genuine 401 means the token is revoked and the retry 401s again → returns `not_configured`. This is a fall-through, not a heal.
2. **404 / 405 / 410 / redirect** on an `apiUrl` POST → the actual "apiUrl moved" signal (401 can't catch it) → invalidate + re-discover + retry once.
3. **`sessionState` mismatch**: every JMAP API response carries `sessionState`; the cached Session carries `state`. On divergence the capabilities/quotas/accounts changed → delete + re-discover on the *next* call (cheap; don't block the current response). `session_refresh:true` forces this synchronously before dispatch.

A fourth self-heal on a request-level `limit` error is in §6.4 (a live limit dropped mid-window).

**accountId routing (generalized — fixes the MaskedEmail blocker).** For each Invocation, if `args.accountId` is absent, resolve in order:
1. `FASTMAIL_ACCOUNT_ID` env override, if set;
2. `session.primaryAccounts[urn]` for the method's capability urn;
3. **else scan `session.accounts` for the account whose `accountCapabilities` includes `urn`** — this is how Fastmail's `https://www.fastmail.com/dev/maskedemail` (and any non-primary capability) is reached, since it is NOT a key in `primaryAccounts` (in practice it lives on the mail-primary account). The winner's `primaryAccounts[maskedemail-urn]` returned `undefined` and broke the headline differentiator.

**Cron warm (optional, follow-up).** `maintenanceTick` (index.ts:377-404) already re-mints kroger; a drop-in `refreshFastmailSession(env)` writes the same `sux:fastmail:session` key. Not required for v1 (the fn self-populates on first call).

---

## 5. The core call surface + both reference forms

Raw passthrough is the default and the full-power path. The caller sends `calls` verbatim; sux does four transforms and forwards:

1. **Inject `accountId`** into any args lacking it (§4).
2. **Derive + union `using`** (§7) — solves the #1 hand-rolled-wrapper bug (`unknownCapability`).
3. **Limit-safe batch/paginate** (§6).
4. POST `{using, methodCalls, createdIds?}` to `apiUrl`, return the raw `methodResponses` (§11 merge).

**Both reference forms pass through untouched to the server, but both are first-class edges in sux's split graph (§6.1):**

- **ResultReferences** — a `#`-prefixed arg name + `{resultOf, name, path}`. The canonical query→get chain:

```json
{"calls":[
  ["Email/query",{"filter":{"inMailbox":"<inboxId>"},"sort":[{"property":"receivedAt","isAscending":false}],"limit":50},"q"],
  ["Email/get",{"#ids":{"resultOf":"q","name":"Email/query","path":"/ids"},"properties":["id","subject","from","receivedAt","preview"]},"g"]
]}
```

- **Creation-id references** — a `#name` string in an id-VALUE position, where `name` keys an earlier call's `create` map (e.g. `EmailSubmission emailId:"#draft"`, `Mailbox` child `parentId:"#parent"`, `onSuccessUpdateEmail` keyed by `#submissionId`). These resolve ONLY within a single POST unless the client threads the returned `createdIds` map into the next request's top-level `createdIds`.

The `*` array-flatten path extension (`/list/*/threadId` → feed thread ids into `Thread/get`) also passes straight through. sux improves on none of JMAP's composition — it forwards it — and its only value-add over the wire is making sure a split never severs either reference form.

**Ergonomics.** The description names the common methods and ships the query→get and two-step-send skeletons (§12); the `calls` schema spells out the Invocation triple and both reference forms. Because sux auto-fills `accountId` and auto-derives `using`, the model's batch is *just* method names + JMAP args. The single-call `method`/`args` mode makes "get my mailboxes" `jmap({method:"Mailbox/get", args:{}})` with zero envelope ceremony.

---

## 6. Limit / split / pagination engine (`_jmap.ts`)

The session/postBatch/limit/pagination engine lives in **`sux/src/fns/_jmap.ts`** (a shared core; `jmap.ts` is a thin schema+dispatch shell). This is what makes a future `mail` ergonomic fn nearly free (§14 deferred).

### 6.0 Constants — one table, used everywhere

Read live from `session.capabilities["urn:ietf:params:jmap:core"]`; RFC "suggested minimums" only as a fallback when a field is absent.

| Dimension | Self-cap (splitting convenience) | Hard cap (viability) |
|---|---|---|
| calls per POST | `min(advertised, 40)` for INDEPENDENT-call batching | `advertised maxCallsInRequest` (Fastmail 50) for an INDIVISIBLE dependency chain |
| objects per `Foo/get` | `min(advertised, 200)` | `advertised maxObjectsInGet` (4096) |
| objects per `Foo/set` | not split (D7); refuse over-limit | `advertised maxObjectsInSet` (4096) |
| query page limit | `min(advertised, 200)` | `advertised` |
| request body size | steer to blob upload before `maxSizeRequest` | `advertised maxSizeRequest` (10MB) |
| RFC fallbacks | calls 16, objects 500 | — |

The two call thresholds are the fix for the "self-cap below the real limit" major: a 41–50-call indivisible chain the server *would* accept in one POST is never force-split into failure by the 40-soft-cap; the soft cap only shrinks *independent* batching.

### 6.1 Reference dependency graph → weakly-connected components (blocker fix)

Before any split, build a graph over the batch where nodes are Invocations and edges are references in **both forms** (§5): scan each call's args recursively for `{resultOf, name}` ResultReferences AND for any string value of the form `#<name>` where `<name>` keys some earlier call's `create` map (plus `onSuccess*Email`/`createdIds` usage). Compute **weakly-connected components**.

- A `#` reference (either form) cannot cross a request boundary. So: if ANY component's call-count exceeds `maxCallsInRequest` → `failWith("bad_input", "…")` naming the component (never sever an edge). This catches a **wide fan-out** (1 Email/query feeding 45 Email/get) that a "never split a linear chain" predicate misses — one producer + many consumers is a single component larger than the cap.
- Only split **between** independent components. Post-split, assert every sub-POST contains, for each `#`-ref it holds, that ref's producer — else abort with `upstream_error` (invariant violation, never ship a corrupt batch).
- When a component-preserving split is unavoidable across a creation-id boundary that *does* fit, capture each sub-POST's response `createdIds` and thread the accumulated map into the next sub-POST's top-level `createdIds` (keeps creation-ids resolvable). In practice the WCC rule keeps such pairs together, so this is a belt-and-suspenders guard.

### 6.2 `Foo/set` over `maxObjectsInSet` — refuse, never split (blocker fix)

Creation-ids and `ifInState` are single-call-scoped; splitting a `Foo/set {create}` into disjoint subsets (a) breaks an intra-set `#id` create-references-create edge → `invalidResultReference`/`notCreated`, and (b) fakes atomicity — chunk 1 commits, chunk 2 hits `stateMismatch`, leaving a half-applied write the caller believed `ifInState` made all-or-nothing. So sux **never auto-splits a `Foo/set`** containing `create` or any intra-set reference. Over `maxObjectsInSet` → `failWith("bad_input", "Foo/set exceeds maxObjectsInSet (<n>) — chunk the create/update/destroy map into separate calls; sux will not split a set (creation-ids and ifInState are single-call-scoped and splitting corrupts them)")`. This deletes the non-atomic-write path entirely, so there is no chunked-write cursor to lose.

### 6.3 `Foo/query` pagination — anchor-based, dedup, queryState-validated (major fixes)

`paginate:true` loops in `_jmap.ts`, using **`anchor`/`anchorOffset` from the FIRST page** (stable under mutation), never `position`:

```
anchor = cursor?.anchor ?? null; offset = cursor?.anchorOffset ?? 0
ids = new Set(cursor?.ids ?? []); qs = cursor?.queryState
outer = { ids, anchor, offset, qs }        // held OUTSIDE the loop for the timeout catch (§7)
loop:
  page = POST [Foo/query {…filter…, anchor, anchorOffset: offset, limit: pageLimit(200), calculateTotal: first}]
  if qs && page.queryState !== qs:          // list shifted mid-pull
      return partial(outer.ids, cursorFrom(outer), reason:"queryState_changed")   // never mix snapshots
  qs = page.queryState
  for id in page.ids: if !ids.has(id) ids.add(id)     // hard dedup by value
  anchor = last(page.ids); offset = 1                 // next page anchored on last-seen id
  until page.ids.length < pageLimit  OR  ids.size >= max_results  OR  55s deadline  OR  output-byte ceiling
```

- **anchorNotFound** (the anchor email was destroyed between pages — routine on a live inbox): catch it and degrade to `partial(ids, cursor)`, never error.
- **Foo/get hydration (D10).** If the batch had a `Foo/get` back-referenced off the paginated query, sux discards the caller's `#ids` ResultReference and hydrates the accumulated ids client-side in `min(advertised, 200)`-chunks — **copying ALL non-`#ids` args of the original get verbatim onto each chunk** (`properties`, `bodyProperties`, `fetchTextBodyValues`, `maxBodyValueBytes`, …); silent arg loss yields empty bodies. The N get-pages are then **collapsed into ONE synthetic `methodResponse` under the original callId** with a concatenated `list` (never N responses echoing one callId — that would make the merge (§11) ambiguous). Document that `paginate:true` replaces server-side back-references with client-side hydration so the behavioral difference is visible.
- **queryChanges is wired, not mentioned.** For incremental list patching the resume path calls `Foo/queryChanges {sinceQueryState}` → `{added, removed}` and patches the accumulated set, falling back to a full re-query (from a still-present anchor) only if the server can't compute changes. `Foo/changes {sinceState}` → `{created, updated, destroyed, hasMoreChanges, newState}` is the object-sync analog; `paginate:true` auto-loops it while `hasMoreChanges` (bounded by the deadline) so one call drains the delta.

### 6.4 Live-limit self-heal (major fix)

On a request-level `urn:ietf:params:jmap:error:limit`, read its problem-details `limit` property to learn WHICH dimension overflowed (`maxCallsInRequest` / `maxSizeRequest` / `maxObjectsInSet`). If the cached Session's advertised limit exceeds it, Fastmail lowered it mid-window: **mirror the 401 self-heal** — delete `SESSION_KEY`, `discoverSession` directly, re-split against the fresh (smaller) limit, retry once. If it still overflows → `rate_limited` (or `bad_input` for a body/object dimension the caller must chunk).

### 6.5 `maxSizeRequest` — teach, don't split

Inline base64 attachments blow the size limit before the call-count limit. sux never silently splits a body; the docs steer callers to `upload` a blob and reference `blobId` in `Email/set.attachments` (§8). If a POST body still exceeds `maxSizeRequest` → `failWith("bad_input", "batch body exceeds maxSizeRequest (10MB) — upload attachments as blobs and reference blobId instead of inlining base64")`.

### 6.6 Cursor across calls (major fix)

The `cursor` (opaque base64 of `{anchor, anchorOffset, queryState, method, filterHash, ids?}`) is returned whenever the 55s deadline, `max_results`, or the output ceiling bounds the pull. **On resume, re-validate before replaying**: reject a cursor whose `filterHash` ≠ the current call's filter (`bad_input`); compare the cursor's `queryState` against a fresh single-page probe — if they differ, resume from the still-present `anchor` (or restart from offset 0, documented), never blindly replay a stale position. This closes the cross-call dup/skip hole.

---

## 7. `using` derivation — over-declare + union (major fix)

The derivation table maps method prefix → capability, read against the live `session.capabilities`:

| Method prefix | Adds |
|---|---|
| always | `urn:ietf:params:jmap:core` |
| `Email/*`, `Mailbox/*`, `Thread/*`, `SearchSnippet/*` | `…:mail` |
| `Identity/*`, `EmailSubmission/*` | `…:submission` **and `…:mail`** (onSuccess\*Email performs a server-side Email mutation) |
| `VacationResponse/*` | `…:vacationresponse` |
| `MaskedEmail/*` | `https://www.fastmail.com/dev/maskedemail` |
| `ContactCard/*` (RFC 9610 JSCard — Fastmail's contacts object), `Contact/*` (legacy), `AddressBook/*` | `…:contacts` (fallback `https://www.fastmail.com/dev/contacts` if the live Session advertises that instead) |
| `Calendar*/*` | `…:calendars` |

Two rules fix the traps:
1. **Over-declare.** When EmailSubmission is present, always add `mail` (a send batch expressed as a lone `EmailSubmission/set` with `onSuccessUpdateEmail` fails `unknownCapability` otherwise — the exact bug auto-derivation claims to kill).
2. **Union, never replace.** A caller-provided `using` is UNIONed with the derived set; it can only ADD (for custom/future methods the table doesn't know), never suppress a required capability. A partial explicit `using` (`["…:core"]` alongside an `Email/query`) must not disable the safety net.

For a method whose capability can't be derived and the Session lists it under no advertised capability → `failWith("bad_input", "cannot derive a capability for method '<name>' — pass `using` explicitly")`. The winner's "VacationResponse/Sieve reachable with no code" brag is deleted: their URNs are now in the table (and gated, §10).

---

## 8. Blob upload / download

Neither is a `methodCalls` batch — both are raw HTTP to Session URLs, dedicated sub-actions, mutually exclusive with `calls`/`method`. Both `noCache` is moot (the whole fn is `cacheable:false`, §9).

**`upload`** — resolve `data` to bytes, then POST to the expanded `uploadUrl` (`{accountId}` filled) with `Content-Type: <type>`; return `ok(safeStringify({blobId, type, size}))`.
- Source dispatch (the real `loadBytes(env, {url?, base64?}, maxBytes)` signature has NO CAS branch, so sux resolves it): if `data` is a `/s/<uuid>` CAS ref → read the object from the sux store, pass its bytes; else treat `data` as base64. **No https-URL branch** (SSRF into internal Tailscale/Funnel hosts — dropped, D15).
- **Size reality (D16).** Inline base64 is bounded by `MAX_ARG_BYTES = 256_000` enforced by `checkArgs` BEFORE the fn runs (index.ts:43/186); base64 inflates ~4/3, so the max INLINE attachment is **~190KB**. A pre-check fails with a teaching `bad_input` when `data` base64 would blow `MAX_ARG_BYTES`, steering to store-a-blob-then-reference. The `/s/<uuid>` R2 store-ref is the PRIMARY path for real attachments. Honored upload is capped at the isolate-safe bound (well under `FETCH_BYTES_MAX_BYTES = 32MB`), NOT Fastmail's 250MB `maxSizeUpload` — a Worker isolate cannot buffer that.

**`download`** — expand the `downloadUrl` template (`{accountId}`,`{blobId}`,`{type}`,`{name}`), GET.
- `as:"base64"` returns `{blobId, type, size, data}` — but if the base64 would exceed the output byte ceiling (D18; `raw:true` bypasses `MAX_OUTPUT_CHARS`), it **auto-spills to R2** and returns a `/s/<uuid>` ref instead of unbounded base64.
- `as:"store"` always spills to R2, returns `{blobId, type, size, ref:"/s/<uuid>"}` — the path for multi-MB attachments.

The composition is explicit: `upload` → `blobId` → a follow-on `jmap({calls:[["Email/set",{create:{draft:{…, attachments:[{blobId, type, name}]}}}, "c"]]})`. Visible, thin-wrapper altitude.

---

## 9. Cache contract — `cacheable:false` + `raw:true` (blocker fix)

The winner's `cacheable:true, ttl:30` is **wrong against the real harness**: `deferCacheWrite` unconditionally sets `expirationTtl = softTtl + CACHE_STALE_GRACE_SECONDS` (mcp-util.ts:58/119, `= 86_400`), and the read path serves any soft-expired-but-hard-alive entry immediately, refreshing only in the background (index.ts:289-291). So a `ttl:30` `Email/query` would be served stale for **up to 24 hours** with no staleness signal in the caller payload — an LLM asked "any new/urgent email?" could confidently return a day-old inbox as authoritative. There is no per-fn override of the grace constant.

**Decision: `cacheable:false`** — exactly like `kv_get` (`cacheable:false, raw:true`). Rationale is twofold: the stale-grace defeats a short ttl, AND caching mail reads would persist decrypted bodies + Session PII to shared KV (revocable-token exposure until TTL). Freshness comes from JMAP's own state tokens (`Foo/changes`/`queryChanges`, §6.3), and the harness's single-flight coalescing already dedups a burst. Because the fn is uncacheable, there is **no response cache to poison** — the winner's `noCacheOnJmapWrite`/`noCacheOn4xx` helpers are unnecessary; the only cache is the KV Session blob (§4), which never holds body content or the token.

**`raw:true`** (D19). JMAP responses carry byte-exact payloads — base64 blob bytes, raw RFC822 for `Email/import`, user-composed bodies (CRLF→LF corrupts MIME; folding U+2028/2029 to `\n` produces control chars that are *invalid unescaped in JSON* and would poison the envelope; `stripZeroWidth` breaks ZWJ emoji). `raw:true` opts the whole fn out of `normalizeArgs`/`normalizeText`/`MAX_OUTPUT_CHARS` (index.ts:197/216/242); emission uses `safeStringify` (which escapes U+2028/2029, `_records.ts` R7) so JSON passes byte-exact. This mirrors `kv_*`/`pipe`/`batch`/`pdf`.

Because `raw:true` removes `MAX_OUTPUT_CHARS`, the paginate/hydrate loop enforces its own **independent accumulated-output byte ceiling** (D18/§6.3) — on overflow it stops with `ids` + `cursor`, and `download` auto-spills to R2 (§8).

Return shape is stable JSON with named fields so the sux algebra composes off `r.content[0].text`:

```json
{ "methodResponses": [...], "sessionState": "…", "accountId": "u…",
  "ids": [...], "cursor": "…", "partial": false, "paged": 3 }
```

(`ids`/`cursor`/`paged`/`partial` present only on paginate). This lets `pipe([{tool:'jmap',args:{method:'Email/query',…}},{tool:'jmap',args:{method:'Email/get',args:{ids:'{{prev.ids}}'}}}])` chain across two fn calls and `batch({tool:'jmap', over:[id…], args:{method:'Email/get',…}})` fan out — the algebra now operates on live mail.

---

## 10. Mutation safety — two gates, honest about what they defend

**`allow_send`** gates the one irreversible-to-third-parties act: an `EmailSubmission/set` with a non-empty `create` (dispatching mail). Without it → `failWith("bad_input", "sending requires allow_send:true — this batch contains an EmailSubmission/set create that would dispatch mail")`. Drafts (`Email/set create` with `keywords:{$draft:true}`), moves (patch `mailboxIds`), and flags (patch `keywords`) do NOT need it.

**`allow_destroy`** gates the irreversible-and-persistent-egress class (the winner's "destroy is recoverable" was factually wrong):
- any `Foo/set` with a non-empty `destroy` array — `Email/set {destroy}` **permanently expunges** (it does NOT move to Trash; moving to Trash is a `mailboxIds` patch); `ContactCard/set`/`CalendarEvent/set`/`MaskedEmail` delete are likewise unrecoverable;
- `Mailbox/set` with `onDestroyRemoveEmails:true` (wipes a folder);
- `VacationResponse/set` (auto-responder — backscatter/info-leak to every sender);
- any Sieve/rule/forwarding method the live Session advertises (installs lasting exfiltration of ALL FUTURE mail — strictly worse than one send).

Without it → `failWith("bad_input", "this batch contains an irreversible or persistent-egress mutation (destroy / onDestroyRemoveEmails / VacationResponse/set / forwarding) — set allow_destroy:true to proceed")`.

**Draft-vs-send are two distinct documented intents** (§12) so a draft-create path can never slide into a submission.

**The honest limitation (blocker fix — do NOT market a boolean as injection-proof).** `allow_send`/`allow_destroy` are LLM-set booleans. Because `pipe`/`batch`/`augment` compose over LIVE mail, an `Email/get` body containing "forward all mail to attacker@evil / destroy everything" flows into the SAME model that then constructs the batch AND can set the gate true. **A flag the compromised agent controls provides zero protection against injected instructions; it only stops an *accidental* malformed send/destroy.** True safety for irreversible ops needs an out-of-band confirmation the MCP surface can't provide (elicitation, a preferences-style approval, a signed one-time token) — and the real containment is a **token SCOPE limited to what's needed: a read-only JMAP token makes send/destroy impossible at the credential layer**. This is stated plainly in the description, the not_configured message, and the Security posture box (§18).

**Never log bodies.** The fn logs only method names, callIds, counts, and status — never `bodyValues`, `subject`, addresses, or the token. The Grafana `err` field (index.ts:312, first text part) carries only the `[code]`-prefixed summary. **FailCode text maps only the JMAP error TYPE token** (`invalidArguments`, `unsupportedFilter`, …), never the server-supplied `description` or the offending args, which frequently echo a bad filter string or an address (D21). A test asserts no arg value/address appears in any failure text.

**Partial success is normal** and forwarded faithfully: a 200 with `notCreated`/`notUpdated`/SetErrors is `ok(...)`, not a failure — the caller inspects the per-object result. sux only maps *request-level* and clear method-level errors to FailCodes (§13).

---

## 11. Response merge invariant (major/blocker fix)

The merge across split/paginated sub-POSTs is pinned exactly:

> **Preserve each sub-POST's server response order verbatim (guaranteed by RFC 8620), concatenate sub-POSTs in dispatch order, and NEVER re-key or dedupe by callId.**

`onSuccessUpdateEmail` injects an EXTRA `Email/set` response that SHARES the `EmailSubmission/set` callId, and JMAP does not guarantee client callIds are unique — so "match by callId" is ambiguous (two responses, one callId) and "match by count" mis-aligns across a split boundary. Both are rejected. sux returns every `methodResponse` verbatim in order, including the duplicate-callId injected one. To keep back-reference resolution unambiguous in the first place, **caller batches with duplicate callIds are rejected up front** (`bad_input`). The collapsed paginated-get (§6.3/D10) is the one synthetic exception — one response under the original callId — and it is produced by sux, not the server, so ordering is deterministic.

A test covers a send batch that injects the extra same-callId response AND a paginated get whose query mutates mid-pull, asserting order is preserved and nothing is dropped or re-keyed.

---

## 12. The send flow — teach the skeleton, keep the transport pure (major fix)

Auto-resolving `identityId` via an injected `Identity/get` (as some grafts proposed) would require sux to semantically recognize an EmailSubmission/set create, inject a method call, and rewrite the create — that IS curation of one method's semantics and violates the "pure conduit, curates nothing" thesis. It is also not doable with a plain ResultReference (`Identity/get` returns a LIST; a create needs a scalar `identityId` matched to the draft's From). **Decision: do NOT auto-inject or auto-rewrite.** Ship the explicit two-step skeleton in the tool DESCRIPTION/docs and let a frontier LLM construct it (it does so easily given the recipe), gating exactly the EmailSubmission/set-create behind `allow_send`:

```json
// 1) Pick an identity (once): jmap({method:"Identity/get", args:{}}) → choose identityId whose email == your From
// 2) One batch: draft → submit → strip $draft + move Drafts→Sent, all via one back-referenced send:
{"calls":[
  ["Email/set",{"create":{"draft":{
      "mailboxIds":{"<draftsId>":true},"keywords":{"$draft":true},
      "from":[{"email":"me@x.com"}],"to":[{"email":"you@y.com"}],
      "subject":"…","bodyStructure":{"type":"text/plain","partId":"b"},
      "bodyValues":{"b":{"value":"…"}}}}},"c"],
  ["EmailSubmission/set",{
      "create":{"sub":{"emailId":"#draft","identityId":"<identityId>"}},
      "onSuccessUpdateEmail":{"#sub":{
          "keywords/$draft":null,
          "mailboxIds/<draftsId>":null,"mailboxIds/<sentId>":true}}},"s"]
]}
// allow_send:true required — the EmailSubmission/set create dispatches mail.
```

`#draft` is a creation-id reference (§5); the WCC split-safety (§6.1) keeps the Email/set and EmailSubmission/set in the same POST. The description states plainly that `identityId` is not auto-resolved — pick it from `Identity/get` and inject the scalar; omit it and the server rejects with `invalidArguments`.

---

## 13. FailCode mapping

`failWith(code, …)` throughout (kroger style), never bare `fail()`. Text carries only the JMAP error TYPE token (§10/D21).

- **`not_configured`** — missing `FASTMAIL_TOKEN`; or a 401/403 that survives the re-discover fall-through (token revoked/wrong-type — a static token can't self-heal a revocation).
- **`bad_input`** — malformed `calls` (not a 3-tuple, or a duplicate callId); none of `{calls, method, upload, download}` present; send without `allow_send`; destroy/persistent-egress without `allow_destroy`; over-`maxSizeRequest` body; over-`maxObjectsInSet` set (refuse-and-teach); a reference component over `maxCallsInRequest`; a cursor whose `filterHash` mismatches; an undecidable `using`; inline base64 over `MAX_ARG_BYTES`; and caller-fault JMAP method errors `["error",{type:"invalidArguments"|"invalidResultReference"|"unknownMethod"|"unsupportedFilter"|"unsupportedSort"},id]` (type token only). `unknownMethod` additionally routes through the teaching handler (§15).
- **`rate_limited`** — HTTP 429 after `withRetry` exhausts; a request-level `urn:ietf:params:jmap:error:limit` that survives the limit self-heal (§6.4); or a `rateLimit` SetError as the dominant outcome (MaskedEmail create throttling).
- **`not_found`** — a `Foo/get` whose `notFound` holds the requested id(s), or HTTP 404 on a blob download.
- **`upstream_error`** — HTTP 5xx, network throw, a post-split invariant violation, or any JMAP failure with no more precise attribution (run try/catch catch-all, kroger.ts:185).
- **`layout_change`** — 2xx but the envelope no longer parses (missing `methodResponses`, non-JSON body).
- **`timeout`** — `AbortError`/`TimeoutError` name in the catch (a valid FailCode, `registry.ts:112`); the paginate loop instead returns `partial:true` + cursor from its outer-variable state (§7) rather than throwing.
- **`blocked`** — unused (authed JMAP has no bot wall; a rejected token is `not_configured`).

---

## 14. The 55s deadline + output ceiling (major/blocker fixes)

`FN_DEADLINE_MS = 60_000` wraps every `fn.run` and kills the run with zero partials on timeout. The engine self-bounds well inside it:

- Each `apiUrl` POST uses **`AbortSignal.timeout(min(30_000, 55_000 − elapsed))`** — deadline-aware, so a POST that starts at ~40s can't burn 30s past the wrapper (D17). `withRetry` is **disabled on the near-deadline final POST** (its backoff could stack 30s + backoff + 30s > 55s).
- The pagination loop checks `Date.now() − start` before each POST and stops when `remaining < worst-case single-POST time` (not `< 5s`).
- The cursor + accumulated ids live in an **OUTER variable** (§6.3), returned as `partial:true` from the `catch` on `TimeoutError`/`AbortError` — so a mid-POST timeout still yields a resumable cursor instead of a hard kill that loses the whole pull.
- The **accumulated-output byte ceiling** (§9/D18) is independent of `raw:true`: a paginated pull with `max_results` up to 10000 × per-email metadata could blow the Workers response / MCP transport / caller context even under the deadline. On overflow the loop stops with `ids` + `cursor`; `download` spills to R2. `maxBodyValueBytes` caps a single body but not count×metadata — the byte ceiling is the real guardrail.

---

## 15. `unknownMethod` teaching handler (major fix)

The task demands targeted teaching for 29-tool-connector muscle memory. On a call whose name isn't `Foo/verb`-shaped, or a server `["error",{type:"unknownMethod"},…]`, the handler returns a hint mapping the old verb to raw JMAP instead of a generic `[bad_input] unknownMethod`:

| Muscle-memory verb | Hint |
|---|---|
| `search_email` | `Email/query` (filter) + `Email/get` (fetch) — see the query→get skeleton |
| `read_email` | `Email/get` |
| `send_email` | the two-step send skeleton (Email/set draft → EmailSubmission/set, allow_send:true) |
| `list_labels` | `Mailbox/get` |
| `list_identities` | `Identity/get` |

Example text: `[bad_input] unknown JMAP method "search_email" — this fn speaks raw JMAP; use Email/query (search) + Email/get (fetch); see the description for the query→get skeleton.` A shape-specific `bad_input` fires when a call tuple isn't `[name, args, callId]`, and the missing-`using` case is auto-healed by §7 rather than erroring.

---

## 16. MaskedEmail + Contacts + Calendars + VacationResponse through the same verb

Nothing special — method names + an auto-derived `using` URN (§7) + generalized accountId routing (§4):

- **MaskedEmail** (the differentiator a 29-tool set can't reach): `jmap({calls:[["MaskedEmail/get",{},"g"]]})` auto-adds `using:["…core","https://www.fastmail.com/dev/maskedemail"]` and resolves `accountId` by scanning `accountCapabilities` (§4/D14). Create: `["MaskedEmail/set",{create:{m:{forDomain:"example.com", emailPrefix:"shop", description:"…"}}},"s"]`. Lifecycle (`pending`→`enabled`→`disabled`→`deleted`) is a `state` patch, not `/destroy`; the description names the trap. Server-side query is limited, so the get-all-then-filter pattern is documented and the result can `pipe` into a sux `filter`.
- **Contacts**: `ContactCard/query|get` (RFC 9610 JSCard — Fastmail's contacts object, **not** the legacy `Contact`), `AddressBook/get` → `…:contacts` (fallback `https://www.fastmail.com/dev/contacts` if that is what the live Session advertises).
- **Calendars**: `Calendar/get`, `CalendarEvent/query|get|set` → `…:calendars`, **feature-detected**: if the URN is absent from the live `capabilities` (JMAP-calendars is still an IETF draft) → `failWith("bad_input", "this Fastmail account does not advertise JMAP calendars — use CalDAV")`.
- **VacationResponse**: `VacationResponse/get|set` → `…:vacationresponse`; `set` is `allow_destroy`-gated (§10).

The `using`-derivation table is the only vendor-specific knowledge in the fn, and it is a pure lookup — the method surface stays uncurated.

---

## 17. Description (the LLM-facing string, ~95 words)

> "Full Fastmail/JMAP protocol via one generic verb (RFC 8620/8621 + Fastmail MaskedEmail). Send a raw JMAP batch `calls:[[method, args, callId], …]` (Email/query|get|set, Mailbox/get, Thread/get, Identity/get, EmailSubmission/set, MaskedEmail/get|set, Contact/*, CalendarEvent/*, VacationResponse/*), or the single-call `method`+`args` shorthand. sux injects the Bearer token, discovers+caches the Session (accountId/apiUrl/limits auto-filled), unions the `using` capabilities, resolves `#` back-references (query→get in one round-trip), and safely batches/paginates past maxCallsInRequest/maxObjectsInGet (paginate:true → full results + cursor). Blob upload/download sub-actions for attachments. Returns raw methodResponses (byte-exact, uncached). Sending needs allow_send:true; destroy/vacation/forwarding need allow_destroy:true — these guard ACCIDENTAL misuse only, not injection; use a read-only token for real containment. Needs FASTMAIL_TOKEN (a JMAP-scoped token, not an MCP one)."

Per-arg JMAP mechanics live in `inputSchema` (§2), never inlined here. gen-docs' `one()` truncates to the first sentence for the FUNCTIONS.md table — the first sentence is self-describing.

---

## 18. fn-count + docs/test impact + build order

**fn-count: 89 → 90, +1** (89 non-test fn files / 86 registered entries verified; Judge 1's "94→96, two fns" is wrong on both count and cardinality). The single `jmap` verb is v1.

Files touched to register +1 fn (the sync ritual):
1. `sux/src/fns/jmap.ts` — `export const jmap: Fn = {…}` (thin schema+dispatch shell).
2. `sux/src/fns/_jmap.ts` — the shared session/postBatch/limit/pagination/graph engine (so a future `mail` is cheap).
3. `sux/src/registry.ts` — add `FASTMAIL_TOKEN?`, `FASTMAIL_ACCOUNT_ID?`, `FASTMAIL_SESSION_URL?` to `RtEnv` near kroger (registry.ts:52).
4. `sux/src/fns/jmap.test.ts` — Session-discovery mock, generalized accountId routing (incl. MaskedEmail via `accountCapabilities`), `using` union/over-declare, both-reference-form WCC split (incl. a 1→45 fan-out over the cap → `bad_input`), refuse-over-`maxObjectsInSet`, anchor pagination + dedup + queryState-change → partial, collapsed paginated get with args copied, cross-call cursor re-validation, limit self-heal, deadline-aware POST + outer-cursor timeout, output byte ceiling, `allow_send`/`allow_destroy` gates (send + destroy + VacationResponse + forwarding), response-merge verbatim (send batch injecting an extra same-callId response + paginated-get-mid-mutation), SSRF-drop on `upload.data`, blob up/down round-trip with `/s/<uuid>` + R2 spill, FailCode type-token-only (assert no address/arg leaks), unknownMethod teaching. Marks `✓` tested in gen-docs.
5. `npm run gen:index` → regenerates `sux/src/fns/index.ts` (import + importance-ordered entry) — importance ordering computed against the real 89 baseline.
6. `npm run docs` → regenerates `sux/FUNCTIONS.md`; add `jmap` to a CATEGORIES bucket (a new "Mail" row) in `sux/scripts/gen-docs.mjs` or it lands in "Other".
7. Name `jmap` in `.claude/skills/sux/SKILL.md` prose (checker invariant #2).
8. `node scripts/check-skill-sync.mjs --write` → byte-mirrors `.claude/skills` → `plugins/sux-router/skills`.
9. (soft) add to `docs/claude-profile-snippet.md`.
10. Verify `node scripts/check-skill-sync.mjs --offline` exits 0; CI `skill-sync.yml` gates the PR.
11. `wrangler secret put FASTMAIL_TOKEN --config sux/wrangler.jsonc` (the `sux` worker; per MEMORY the root kagi-mcp is stale). `OAUTH_KV` already bound.

**Build order (one change per plan→test→deploy→push cycle, each independently shippable):**

1. **Skeleton + Session discovery + single-call passthrough** — `_jmap.ts` session cache + 3-trigger self-heal (401 / apiUrl-moved / sessionState), generalized accountId routing, `using` union, `method`/`args` → one-element batch, FailCode map, `raw:true`, `cacheable:false`. Ship: "get my mailboxes" and MaskedEmail/get work.
2. **Multi-call `calls` + reference graph** — verbatim forward; WCC over both reference forms; duplicate-callId reject; the verbatim response merge. Ship: query→get and a back-referenced send skeleton in one round-trip.
3. **Limit handling** — call-split between components with the two thresholds; refuse-over-`maxObjectsInSet`; `paginate:true` anchor loop + dedup + queryState guard + queryChanges resume; collapsed hydration; cursor re-validation; limit self-heal; 55s deadline + outer-cursor; output byte ceiling. Ship: full-inbox pulls.
4. **Write safety** — `allow_send` + `allow_destroy` (send/destroy/onDestroyRemoveEmails/VacationResponse/forwarding); teaching gate messages; the send skeleton in the description. Ship: drafts/moves/flags/gated send + destroy.
5. **Blob `upload`/`download`** — Session upload/download URLs, CAS-ref resolution + base64 (no URL), R2 spill on `as:store` and over-cap `as:base64`. Ship: attachments.
6. **unknownMethod teaching + polish**; (follow-up) cron `refreshFastmailSession` warm; optional `proxy` flag; the deferred `mail` ergonomic fn IF the long tail earns it.

---

## 19. Deliberate scope cuts

- **The `mail` ergonomic fn is deferred**, not shipped. v1 is the single raw `jmap` verb; a second fn is a later one-change-per-cycle only if the long tail proves it earns the slot. The `_jmap.ts` core makes it nearly free when/if that day comes. (Judge 1's mandate to ship two fns in v1 is rejected in favor of Judge 0/2's single-verb spine — this is the load-bearing "cap ~50 fns" discipline.)
- **Push / EventSource (`eventSourceUrl`) is out of scope.** A stateless edge fn under a 60s deadline can't hold a long-lived push connection; incremental freshness is served by `Foo/changes`/`queryChanges` state tokens (§6.3), which fit the request/response model.
- **`Foo/set` auto-splitting is cut** (D7) — refuse-and-teach, because splitting corrupts creation-ids/`ifInState`. No chunked-write path means no chunked-write cursor to lose.
- **Server-side URL fetch for `upload`** is cut (SSRF, D15) — base64 or CAS-ref only.
- **Auto-injecting Identity/get / rewriting the send batch** is cut (D13) — teach the skeleton, keep the transport pure.
- **`proxy` residential-egress flag** is a follow-up (api.fastmail.com is a clean authed host); noted, not v1.

---

## 20. Security posture

> **Scoped token is the real boundary.** `FASTMAIL_TOKEN` is full-mailbox-powerful; the not_configured message, description, and gates all steer toward a READ-ONLY JMAP token for read/compose workflows, which makes send/destroy impossible at the credential layer regardless of what the model does.
>
> **Accidental vs adversarial, stated plainly.** `allow_send`/`allow_destroy` are LLM-set booleans. They stop an *accidental* mis-constructed send/destroy. They are **not** an injection boundary: `pipe`/`batch`/`augment` compose over live mail, so an injected body instruction reaches the same model that sets the flag. True safety for irreversible ops needs an out-of-band confirmation the MCP surface can't provide — the design does not pretend otherwise.
>
> **No SSRF.** `upload.data` accepts only base64 or an internal `/s/<uuid>` CAS ref; a caller-supplied https URL is refused so the Worker never fetches internal Tailscale/Funnel hosts.
>
> **No body logging.** Only method names, callIds, counts, and status are logged. FailCode text carries the JMAP error TYPE token only — never the server `description`, args, addresses, or the token.
>
> **`cacheable:false`.** Mail bodies and Session PII are never written to shared response KV. The only KV state is the Session blob (tight 3600s TTL, sessionState-invalidated, token-free). Freshness comes from JMAP state tokens, not a stale-grace-poisoned cache.

---

## Why this is the right shape

The existing 29-tool connector is a *translation layer* over JMAP — it re-encodes a batched RPC as flat tools, loses back-references, can't reach MaskedEmail, and burns 29 tool-slots of context. `jmap` is a *transport* — it forwards the protocol and adds exactly the five things an edge proxy is uniquely positioned to add: injected auth, cached Session discovery, limit-safe batching/pagination over a correctly-computed reference graph, accidental-mutation gates with honest limits, and composability with the sux algebra over live mail. One fn, the whole protocol, the generic-verb ideal made literal. The cost — the LLM must know JMAP method names — is the cost JMAP's designers already decided was worth paying, and a frontier model pays it easily given the method list and the two skeletons in the description.

## Related

- [[jmap-conduit]]
- [[mail]]
- [[unblocked-gated-law]]
- [[Namespaces-MOC]]
