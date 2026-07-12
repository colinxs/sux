---
title: mail — Fastmail verbs
status: shipped
cluster: namespaces
type: proposal
summary: "A dozen ergonomic mail_* verbs over the jmap conduit — scheduled send, remote search, batching, pagination; open 13-fns-vs-one decision."
tags: [sux, namespaces, designed]
updated: 2026-07-09
---

# sux design: the Fastmail MCP — ergonomic verbs over the `jmap` conduit (`/mail/mcp` + the `sux-mail` plugin)

> **⚠️ Superseded framing — point-in-time design record.** This doc designs mail as its own connector (`/mail/mcp`) and plugin (`sux-mail`), mirroring the then-planned `/vault/mcp`. That per-domain-connector split was later **retired into the single `/mcp` front door**: the `mail_*` (+ `cal_*`/`contact_*`) verbs and the raw `jmap` conduit now ship on the one `sux` connector, no separate `/mail/mcp` connector or `sux-mail` plugin. The verb design below is live and accurate; read the endpoint/plugin packaging as history. Current shape: [[namespace-architecture]] / [[connector-surface-policy]].

Companion to [`jmap.md`](./jmap.md). That doc designs the **raw conduit**: one `jmap` verb that forwards a JMAP `Request` byte-exact and adds the five things an edge proxy is uniquely positioned to add (injected auth, cached Session discovery, limit-safe batching/pagination, mutation gates, sux-algebra composability). This doc designs the **product surface on top of it**: a small set of ergonomic verbs served at `/mail/mcp`, packaged as the `sux-mail` plugin, that make the 80% path one call — while the `jmap` verb underneath guarantees the **superset** property (anything JMAP or the Fastmail API can express is still reachable even when unwrapped).

The whole surface is a **superset of JMAP + the Fastmail API**: full coverage of both. Every ergonomic verb compiles to a specific JMAP method (or a back-referenced batch of them) that we name explicitly; the four superpowers Colin called out — **native scheduled send, efficient remote search, batching, variable pagination** — are first-class, not afterthoughts; and the raw `jmap` escape hatch is the floor that makes the coverage total.

> **Grounding discipline.** Every Fastmail-specific claim below traces to the verified facts brief that accompanies this design (RFC 8620 core, RFC 8621 Mail, RFC 4865 FUTURERELEASE, Fastmail dev docs). Items the brief marked **FLAG** (mechanism confirmed, exact wording/limits not verbatim-verified, or must be checked against a live Session) are marked `FLAG` inline. We invent **no** JMAP methods.

---

## 0. The cross-cutting rule this whole surface is built to (LOCKED)

**Verbs pass REFERENCES, not payloads.** This is the load-bearing constraint, applied to every verb in Layer A:

- A verb that **finds / lists** returns **handles** — message-ids, thread-ids, mailbox-ids, identity-ids, masked-email-ids, blob-ids, plus light metadata (subject, from, receivedAt, preview snippet) — **never the bytes or full bodies**. The one exception is a caller that explicitly reads **one** message (`mail_read`), which returns that message's body because that is the deliberate act of reading it.
- A verb that **stores / transforms / mutates** **accepts a handle** and does the fetch / move / flag / write **server-side**, so large data never transits the model context. `mail_archive(ids)` patches mailboxes given ids; it never round-trips bodies through the model.
- Every list-producing verb has a **batch form** that takes a **list of references** and fans out server-side in **one** JMAP round-trip (via back-references, §B.3). This is what lets an agentic skill do bulk work: **100 messages = a few calls, not hundreds, with zero bytes in context.** The batch form extends the existing `batch` / `batch_fetch` fns rather than reinventing fan-out.

The per-verb tables in §A state, for every verb, **what handle it returns**, **what handle it accepts**, and **its batch form** — explicitly, because designing to this rule is the point.

Why this is natural here and not a bolt-on: JMAP's own shape already separates **`Foo/query` (returns ids)** from **`Foo/get` (hydrates ids → objects)**. Our reference-not-payload rule is that seam made into the verb boundary. `mail_search` is `Email/query` (handles out); `mail_read`/`mail_thread` are `Email/get` (hydrate on demand); the mutators are `Email/set` patches keyed by id. We are not fighting the protocol — we are exposing its native handle/hydrate split as the ergonomic contract.

---

## 1. Where this sits: endpoint, plugin, and the fn underneath

Three artifacts, mirroring the vault surface (`/vault/mcp` + `sux-vault` plugin + the `obsidian` fn):

| Artifact | What it is | Precedent in this repo |
|---|---|---|
| **`/mail/mcp`** | An MCP endpoint on the `sux` worker exposing the Layer-A ergonomic verbs (+ `mail_batch`, + `jmap` as the escape hatch). A tiered/gated route like `/vault/mcp`. | `/vault/mcp` (PR #30, `sux-vault`) |
| **`sux-mail` plugin** | A Claude plugin that auto-registers the `/mail/mcp` connector and ships the `sux-mail` skill (the retrieval/compose ladder + the send/search/attachment recipes). | `sux-vault` plugin (commit `220ed15`) |
| **`jmap` fn** | The raw conduit (`jmap.md`). The ergonomic verbs are **thin compilers** that build a JMAP `calls` batch and hand it to the same `_jmap.ts` engine — one Session cache, one limit/split/pagination engine, one auth injection, one gate implementation. | `obsidian` fn + `_jmap.ts` core |

**Everything ergonomic is a compiler over `_jmap.ts`.** A verb like `mail_search` does not open its own connection or reimplement pagination — it constructs the `Email/query` (+ optional `SearchSnippet/get`) invocation, calls the shared engine, and shapes the result into handles. This is the same "no private reimplementations" algebra rule that governs the rest of sux: augment / compress-to-KV / parallel fan-out / map-filter-reduce are shared, and here **session discovery, limit-safe batching, anchor pagination, mutation gating, and `raw:true` emission are shared too** — inherited from `_jmap.ts`, never re-rolled per verb.

Consequence: the ergonomic layer is cheap to build and impossible to drift from the conduit. If Fastmail changes a limit or the Session shape, `_jmap.ts` adapts once and all twelve verbs follow.

---

## 2. Auth: token as a worker secret, never in args or logs

Identical to the conduit (`jmap.md` §3), because it **is** the conduit's auth:

```ts
FASTMAIL_TOKEN?: string;        // Bearer, JMAP-scoped — a worker secret, NEVER a verb argument
FASTMAIL_ACCOUNT_ID?: string;   // optional override; normally derived from the Session
FASTMAIL_SESSION_URL?: string;  // optional; default https://api.fastmail.com/jmap/session
```

- The token is a **worker secret** (`wrangler secret put FASTMAIL_TOKEN --config sux/wrangler.jsonc` — the `sux` worker; the root kagi-mcp is stale per MEMORY). It is **never** a verb parameter, never echoed, never logged. No verb schema has a token field.
- **Scope guidance is a first-class control.** A read-only JMAP token makes `mail_send` / `mail_delete(destroy)` / `mail_masked(create)` impossible **at the credential layer** — the only real containment against an injected instruction (§5). The `not_configured` message and every gated verb's description steer toward minting a read-only token for read/compose workflows.
- **Logging:** only method names, ids, counts, and status. Never `bodyValues`, subjects, addresses, or the token. FailCode text carries the JMAP error **type token** only (`invalidArguments`, `rateLimit`, …), never the server `description` or the offending args (which echo addresses / filter strings). Inherited verbatim from `jmap.md` §10/D21.

**`cacheable:false` on every verb that reads or writes mail** (`jmap.md` §9/D1): the harness's 24h `CACHE_STALE_GRACE_SECONDS` defeats any short ttl, and caching would persist decrypted bodies + Session PII to shared KV. Freshness comes from JMAP's own state tokens (`queryState`, `Foo/changes`, `queryChanges`), not the response cache. The only KV state is the Session blob (tight 3600s TTL, `sessionState`-invalidated, token-free). Per-verb `cacheable` is called out in the §A tables — and it is `false` for all of them; the `cacheable:false + gated` combo Colin flagged applies specifically to `mail_send`, `mail_delete` (destroy), and `mail_masked` create.

---

## 3. The three layers at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│ (C) ESCAPE HATCH — jmap: full JMAP Request passthrough.             │
│     Guarantees the SUPERSET. Anything Email/Mailbox/Thread/         │
│     EmailSubmission/Identity/SearchSnippet/Contact/Calendar can do  │
│     is reachable even if no ergonomic verb wraps it.                │
├─────────────────────────────────────────────────────────────────────┤
│ (B) FOUR SUPERPOWERS — first-class features, not verbs of their own:│
│     scheduled send · remote search · batching · variable pagination │
│     (surfaced through the Layer-A verbs + mail_batch)              │
├─────────────────────────────────────────────────────────────────────┤
│ (A) ERGONOMIC VERBS — the 80% path, one call each. Handles in/out.  │
│     search read thread send draft archive move label delete        │
│     masked identities mailboxes                                     │
└─────────────────────────────────────────────────────────────────────┘
             all three compile down to  ─►  _jmap.ts  ─►  api.fastmail.com
```

The layers are strictly nested: Layer A verbs are compilers that emit the same `calls` batches you could write by hand in Layer C; Layer B superpowers are options on the Layer A verbs that expose specific JMAP mechanisms; Layer C is the uncurated floor. Nothing in A or B can do something C cannot — that is what makes the surface a provable superset.

---

## A. Ergonomic verbs (the 80% path)

Twelve verbs. Each row states: **signature**, the **JMAP method(s)** it compiles to, **cacheable**, **gating**, and — per the LOCKED rule — the **handle it returns**, the **handle it accepts**, and its **batch form**.

Common conventions:
- Ids are opaque JMAP ids echoed back as handles; a caller never constructs one.
- Every mutator returns the **new state token** (`Email/set`'s `newState`) so a follow-up can `ifInState` for optimistic concurrency, and the per-object `notUpdated`/SetError map verbatim (partial success is normal, not a failure — `jmap.md` §10).
- All twelve are `cacheable:false` (§2).

### A.1 `mail_search` — find, return handles

```
mail_search(query?, filter?, in?, from?, to?, subject?, hasAttachment?,
            before?, after?, unread?, limit?, anchor?, position?,
            collapseThreads?, snippets?, cursor?, sort?)
```

| Aspect | Detail |
|---|---|
| Compiles to | `Email/query` (server-side, §B.2) — filter built from the args into an RFC 8621 `FilterCondition` / `FilterOperator`. If `snippets:true`, a back-referenced `SearchSnippet/get` in the same batch. `FLAG` — verify `SearchSnippet/get` field names (`emailIds`, `filter`, result `subject`/`preview`) and the "same filter as the query" constraint against RFC 8621 §5 before coding. |
| Returns (HANDLE) | A list of **message-ids** + **thread-ids** + light metadata only (`subject`, `from`, `receivedAt`, `preview`, `hasAttachment`, keyword flags) via a bounded back-referenced `Email/get` on a fixed light `properties` set — **never bodies**. Plus `cursor`, `total` (if requested), `queryState`, `position`. This is the list-producer; its output feeds `mail_read`/`mail_thread`/the mutators. |
| Accepts (HANDLE) | `in` accepts a mailbox-id (or role name → resolved to id via a cached `Mailbox/get`); `cursor` accepts an opaque pagination cursor from a prior call. |
| cacheable | `false` |
| gating | none (read) |
| Batch form | **This verb is the fan-out source.** Its "batch" is (a) variable pagination — one call drains up to `limit` across pages server-side (§B.4) — and (b) the fact that its returned id list is exactly the input list for the batch forms of every downstream verb. A caller does not batch `mail_search`; it batches *on* `mail_search`'s output. |

`filter` is a raw escape for the full RFC 8621 FilterCondition when the named args aren't enough (`minSize`, `maxSize`, `header`, `allInThreadHaveKeyword`, `inMailboxOtherThan`, nested `FilterOperator{AND|OR|NOT}`) — all CONFIRMED field names. The named args are sugar that compile into the same condition.

### A.2 `mail_read` — hydrate ONE (the deliberate read)

```
mail_read(id, format?, bodyProperties?, maxBodyBytes?)
```

| Aspect | Detail |
|---|---|
| Compiles to | `Email/get` with `bodyProperties` / `fetchTextBodyValues` / `fetchHTMLBodyValues` / `maxBodyValueBytes`. |
| Returns | The **full message body** + headers + attachment metadata **including each attachment's `blobId`** (the handle for §6 attachment reach). This is the one verb that returns bytes — because reading one message is the explicit act of wanting them. `format:"markdown"` can post-process the HTML part through the sux `markdown` fn to shrink context. |
| Accepts (HANDLE) | a single **message-id**. |
| cacheable | `false` |
| gating | none |
| **Batch form** | **`mail_read(ids: string[])`** → a single `Email/get` with all ids server-side, one round-trip, honoring `maxObjectsInGet` (auto-chunked + collapsed by `_jmap.ts` if over the cap). This is the `batch_fetch` extension: 100 message bodies in ~1 call. Because bodies are large, the batch form defaults to a **light** `bodyProperties` and warns via `maxBodyBytes`; a caller pulling 100 full bodies is opting into the context cost deliberately. |

### A.3 `mail_thread` — hydrate a conversation

```
mail_thread(id, bodies?, limit?)
```

| Aspect | Detail |
|---|---|
| Compiles to | `Thread/get` (thread-id → its ordered `emailIds`) back-referenced into `Email/get` — one batch, one round-trip. |
| Returns (HANDLE) | the thread's **message-ids** in order + light metadata by default (handles, per the rule); full bodies **only if `bodies:true`** (opt-in, since a long thread is large). |
| Accepts (HANDLE) | a **thread-id** (as returned by `mail_search`). |
| cacheable | `false` |
| gating | none |
| **Batch form** | **`mail_thread(ids: string[])`** → `Thread/get` over all thread-ids, then one back-referenced `Email/get` over the flattened `emailIds` (using the `/list/*/emailIds` array-flatten path), collapsed to one response. N threads in one call. |

### A.4 `mail_send` — dispatch (with native scheduling, §B.1)

```
mail_send(to, subject, body, from?, cc?, bcc?, replyTo?, inReplyTo?,
          attachments?, draftId?, sendAt?, identityId?, allow_send)
```

| Aspect | Detail |
|---|---|
| Compiles to | A back-referenced batch: `Email/set{create}` (the draft, unless `draftId` is given) → `EmailSubmission/set{create:{emailId:"#draft", identityId, envelope?}}` with `onSuccessUpdateEmail` stripping `$draft` and moving Drafts→Sent. Exactly the two-step skeleton from `jmap.md` §12, compiled. |
| Returns (HANDLE) | the sent/queued **message-id** + **submission-id** + `newState`. Never the body back. |
| Accepts (HANDLE) | `draftId` (a message-id from `mail_draft`) to send an existing draft; `attachments` accept **blob-ids** (from `mail_masked`-style upload or a `jmap` upload / a `/s/<uuid>` CAS ref) — the bytes are attached server-side, never inlined through the model (§6). `identityId` from `mail_identities`. |
| cacheable | **`false` + gated** |
| gating | **`allow_send:true` required** — the `EmailSubmission/set` create dispatches mail. Accidental-send guard only, not an injection boundary (§5). |
| **Batch form** | **`mail_send(messages: [...])`** compiles one JMAP request containing N (draft→submit) component pairs. Each pair is a weakly-connected component (`jmap.md` §6.1) kept intact; `_jmap.ts` refuses to split a set (D7) so atomicity per message is preserved. Sending a newsletter to a computed list = one call. Still `allow_send`-gated as a whole. |

**Scheduled send is `sendAt` — see §B.1** for the exact `envelope.mailFrom.parameters.HOLDFOR`/`HOLDUNTIL` compilation and the `submissionExtensions`/`maxDelayedSend` gating. There is deliberately **no** top-level `holdFor` property on the wire — the brief's correction.

### A.5 `mail_draft` — compose without sending

```
mail_draft(to?, subject?, body?, from?, cc?, bcc?, attachments?, updateId?)
```

| Aspect | Detail |
|---|---|
| Compiles to | `Email/set{create}` (or `{update}` if `updateId`) with `keywords:{$draft:true}` and `mailboxIds:{<draftsId>:true}` (Drafts resolved by `role:"drafts"` via cached `Mailbox/get`). |
| Returns (HANDLE) | the draft's **message-id** + `newState`. |
| Accepts (HANDLE) | `updateId` (a message-id) to revise an existing draft; `attachments` as **blob-ids**. |
| cacheable | `false` |
| gating | **none** — a draft is not a send; drafts never need `allow_send`. Keeping draft and send as two distinct documented intents (`jmap.md` §12) means a compose path can never silently slide into a dispatch. |
| **Batch form** | **`mail_draft(drafts: [...])`** → one `Email/set` with N creates (bounded by `maxObjectsInSet`; over-cap refuses-and-teaches per D7, never silently splits). |

### A.6 `mail_archive` — remove from Inbox

```
mail_archive(id | ids)
```

| Aspect | Detail |
|---|---|
| Compiles to | `Email/set{update}` patching `mailboxIds/<inboxId>` → `null` (JMAP archive = remove the Inbox mailbox membership; the message stays in All Mail). |
| Returns (HANDLE) | the updated **message-id(s)** + `newState` + any per-id SetError. |
| Accepts (HANDLE) | one or a **list of message-ids**. |
| cacheable | `false` |
| gating | none (reversible: re-add the Inbox mailbox). |
| **Batch form** | **native** — `ids` is the batch form: one `Email/set` with N id patches, one round-trip. Archive 100 = one call. |

### A.7 `mail_move` — change mailbox

```
mail_move(id | ids, to, from?)
```

| Aspect | Detail |
|---|---|
| Compiles to | `Email/set{update}` setting `mailboxIds/<toId>` → `true` and (optionally) clearing `from`/all others. `to` accepts a mailbox-id **or** a role/name resolved via cached `Mailbox/get`. |
| Returns (HANDLE) | updated **message-id(s)** + `newState`. |
| Accepts (HANDLE) | **message-id(s)** + a **mailbox-id** (or role name). |
| cacheable | `false` |
| gating | none (reversible). Moving to Trash is a *move* (`to:"trash"`), **not** a destroy — deletion is `mail_delete` (§A.9). |
| **Batch form** | **native** — `ids` → one `Email/set`. Move-to-folder for a filtered set = one call after `mail_search`. |

### A.8 `mail_label` — flag / keyword / (un)read

```
mail_label(id | ids, add?, remove?, read?, flagged?)
```

| Aspect | Detail |
|---|---|
| Compiles to | `Email/set{update}` patching `keywords/<kw>` (`$seen`, `$flagged`, `$answered`, or a user keyword) → `true`/`null`. `read:true` sets `$seen`; `flagged:true` sets `$flagged`. Fastmail "labels" that are mailboxes are handled by `mail_move` instead; keyword labels are here. |
| Returns (HANDLE) | updated **message-id(s)** + `newState`. |
| Accepts (HANDLE) | **message-id(s)** + keyword strings. |
| cacheable | `false` |
| gating | none (reversible). |
| **Batch form** | **native** — `ids` → one `Email/set`. "Mark all these read" = one call. |

### A.9 `mail_delete` — trash (default) or destroy (gated)

```
mail_delete(id | ids, permanent?, allow_destroy?)
```

| Aspect | Detail |
|---|---|
| Compiles to | Default: `Email/set{update}` moving to Trash (`mailboxIds` → `{<trashId>:true}`) — **recoverable**. `permanent:true`: `Email/set{destroy:[ids]}` — **permanently expunges** (does NOT go to Trash; `jmap.md` D4). |
| Returns (HANDLE) | destroyed/updated **message-id(s)** + `newState` + `notDestroyed` map. |
| Accepts (HANDLE) | **message-id(s)**. |
| cacheable | **`false` + gated** (only on `permanent`) |
| gating | Trash-move needs nothing. **`permanent:true` requires `allow_destroy:true`** — irreversible expunge (`jmap.md` §10). Without it → teaching `bad_input`. |
| **Batch form** | **native** — `ids`. Empty-the-trash / bulk purge = one gated call. |

### A.10 `mail_masked` — Masked Email (the differentiator)

```
mail_masked(list? | create? | patch?)
  create: {forDomain, prefix?, description?}
  patch:  {id, state}   // pending→enabled→disabled→deleted
```

| Aspect | Detail |
|---|---|
| Compiles to | `MaskedEmail/get` (list), `MaskedEmail/set{create}` (mint), `MaskedEmail/set{update:{<id>:{state}}}` (lifecycle). Capability URN `https://www.fastmail.com/dev/maskedemail` (CONFIRMED verbatim), auto-added by the `using` derivation; accountId resolved by scanning `accountCapabilities` (`jmap.md` §4/D14) since maskedemail is **not** in `primaryAccounts`. |
| Returns (HANDLE) | masked-email **ids** + the generated **address** (server generates domain + address; `prefix` ≤64 chars `[a-z0-9_]`, create-only, not returned on fetch — CONFIRMED). |
| Accepts (HANDLE) | masked-email **id** for `patch`. |
| cacheable | `false`; **create is gated** |
| gating | `list`/`patch` (except delete) need nothing. **`create` is `cacheable:false` + gated** behind `allow_masked_create` (create is rate-limited → `rateLimit` SetError; a runaway loop could mint hundreds). Lifecycle **delete** is `state:"deleted"` — a `state` patch, **not** `/destroy` (`jmap.md` §16) — and is gated with `allow_destroy`. |
| Batch form | `create`/`patch` accept a **list** → one `MaskedEmail/set` with N create/update entries. Server-side query is limited, so `list` returns all and a caller `filter`s client-side (documented; pipes into the sux `filter` fn). |

### A.11 `mail_identities` — who I can send as

```
mail_identities()
```

| Aspect | Detail |
|---|---|
| Compiles to | `Identity/get` (`urn:ietf:params:jmap:submission`). |
| Returns (HANDLE) | identity **ids** + `email` + `name` + `replyTo` — the handles `mail_send`/`mail_draft` consume as `identityId`/`from`. |
| Accepts | none. |
| cacheable | `false` (inherits the conduit posture; identities are low-PII and stable, so a short cache is a *possible* future relaxation — noted, not v1). |
| gating | none. |
| Batch form | n/a (single small list; already one call). |

### A.12 `mail_mailboxes` — the folder/label tree

```
mail_mailboxes(counts?)
```

| Aspect | Detail |
|---|---|
| Compiles to | `Mailbox/get` (`urn:ietf:params:jmap:mail`). |
| Returns (HANDLE) | mailbox **ids** + `name` + `role` (inbox/drafts/sent/trash/archive) + `parentId` + (if `counts`) `totalEmails`/`unreadEmails`. These ids are what `mail_move`/`mail_archive`/`in:` consume; the role→id map is cached in `_jmap.ts` for name-resolution. |
| Accepts | none. |
| cacheable | `false` (same stable-structure relaxation note as identities). |
| gating | none. |
| Batch form | n/a. |

---

## B. The four superpowers (first-class, grounded)

These are the features Colin named as must-be-first-class. Each is a specific, verified JMAP mechanism surfaced through Layer A (and `mail_batch`).

### B.1 Native scheduled send — `envelope.mailFrom.parameters` (CORRECTED)

`mail_send(..., sendAt: "2026-07-10T09:00:00Z" | "+86400s")`.

**The correction the brief makes explicit:** there is **no `holdFor`/`holdUntil` property on the EmailSubmission object.** Delayed send is expressed through EmailSubmission's **`envelope`** property, whose `mailFrom` is an **Address** object carrying a **`parameters: "String[String]|null"`** member for SMTP MAIL-FROM extension parameters (RFC 8621 §7.1, CONFIRMED). The delay keywords come from **RFC 4865 FUTURERELEASE** (CONFIRMED verbatim): `HOLDFOR=<seconds>` or `HOLDUNTIL=<UTC timestamp>`.

So `mail_send` compiles `sendAt` into:

```json
["EmailSubmission/set", {
  "create": { "sub": {
    "emailId": "#draft",
    "identityId": "<id>",
    "envelope": {
      "mailFrom": { "email": "me@x.com",
                    "parameters": { "HOLDUNTIL": "2026-07-10T09:00:00Z" } },
      "rcptTo":   [ { "email": "you@y.com" } ]
    }
  } }
}, "s"]
```

- A relative `sendAt:"+86400s"` compiles to `{"HOLDFOR":"86400"}`; an absolute ISO timestamp compiles to `{"HOLDUNTIL":"<utc>"}`.
- `FLAG` — the literal RFC 8621 example JSON showing `{"HOLDFOR": …}` inside `mailFrom.parameters` could not be pulled byte-exact (§7 fetches truncated). The mechanism is confirmed by composing RFC 8621 §7.1 (`Address.parameters`) with RFC 4865 (HOLDFOR/HOLDUNTIL) and matches Fastmail's documented behavior; treat the exact serialization as **spec-consistent, not verbatim-verified**, and confirm against a live submission before shipping.

**Capability-aware gating (must-do, from the brief).** Before injecting the param, `mail_send` checks the **`urn:ietf:params:jmap:submission`** capability object on the live Session:
1. `submissionExtensions` (`"String[String[]]"`, keys = SMTP `ehlo-name`) must advertise **`FUTURERELEASE`**; and
2. `maxDelayedSend` (UnsignedInt seconds; `0` = unsupported) must be `>= ` the requested delay.

If either fails → `failWith("bad_input", "this account does not advertise FUTURERELEASE / requested delay exceeds maxDelayedSend")` rather than silently sending immediately. Both `submissionExtensions` and `maxDelayedSend` are surfaced (e.g. via a `mail_capabilities` read or the `jmap` Session dump) so a caller can discover the ceiling. The `using` set adds `submission` **and** `mail` (the `onSuccessUpdateEmail` mutation implies mail — `jmap.md` §7). Still `allow_send`-gated.

**Handle discipline:** unchanged — `mail_send` still returns only the submission-id + message-id; scheduling adds no payload to the response.

### B.2 Efficient remote search — server-side `Email/query` + SearchSnippet + cursor

`mail_search` runs **entirely server-side** (CONFIRMED: `Email/query` executes on the server). The named args compile into an RFC 8621 `FilterCondition`; the CONFIRMED-verbatim field names we expose:

| Verb arg | JMAP FilterCondition field |
|---|---|
| `query` | `text` (the full-text superset of from/to/cc/bcc/subject/body) |
| `from` / `to` / `subject` | `from` / `to` / `subject` |
| `in` | `inMailbox` (id); `filter` escape → `inMailboxOtherThan` |
| `hasAttachment` | `hasAttachment` |
| `before` / `after` | `before` / `after` (UTCDate bounds) |
| `unread` | `notKeyword:"$seen"` |
| `filter` (escape) | any of `minSize`,`maxSize`,`cc`,`bcc`,`body`,`header`,`allInThreadHaveKeyword`,`someInThreadHaveKeyword`,`noneInThreadHaveKeyword`,`hasKeyword`, composed with `FilterOperator{operator:AND|OR|NOT, conditions:[…]}` |

- **Snippets:** `snippets:true` adds a back-referenced **`SearchSnippet/get`** (RFC 8621 §5) returning per-message highlighted `subject`/`preview` fragments for the *same* filter — the preview mechanism, so a caller sees *why* each hit matched without pulling bodies. `FLAG` — verify §5 field names (`emailIds`, `filter`, result `subject`/`preview`) and that the SearchSnippet filter must equal the query filter, before coding.
- **Returned cursor:** `mail_search` always returns a pagination `cursor` (opaque `{anchor, anchorOffset, queryState, filterHash}`) plus `queryState` and (on request) `total` — see §B.4.
- **Efficiency = handles, not bytes:** the result is ids + light metadata + optional snippets, so a broad search over a huge mailbox costs a bounded, near-constant amount of context regardless of match count; the caller then hydrates only what it needs via `mail_read`/`mail_thread`. This is the reference-not-payload rule paying off directly.

### B.3 Batching — one JMAP Request, back-references, one round-trip

Native JMAP batching (RFC 8620 §3.2–3.7, CONFIRMED verbatim) is used **two ways**:

1. **Internally** — every multi-step ergonomic verb is already a single back-referenced batch: `mail_search`(query→get→snippet), `mail_thread`(Thread/get→Email/get), `mail_send`(Email/set→EmailSubmission/set with `onSuccessUpdateEmail`). Each is **one round-trip**, composed via `#`-prefixed `ResultReference{resultOf,name,path}` args and creation-id (`#name`) references. The caller never sees the plumbing.

2. **Explicitly — `mail_batch`** — a first-class verb that accepts a **list of ergonomic ops** (or raw invocations) and compiles them into **one** JMAP `Request`, letting later ops back-reference earlier results:

```
mail_batch(ops: [ {verb, args}, ... ], allow_send?, allow_destroy?)
```

`mail_batch` is where the reference-not-payload rule gets its "batch form" teeth: `mail_batch([{search…}, {archive: "{{0.ids}}"}])` searches and archives the matches in **one** round-trip, ids flowing server-side via a `ResultReference` — **zero message bytes in context**. It is the ergonomic face of the conduit's raw `calls` batch; for arbitrary cross-method composition a caller drops to `jmap` (§C). Response invariant is the conduit's (`jmap.md` §11): verbatim server order, never re-keyed by callId, gates evaluated across the whole batch.

> **Relation to the algebra.** `mail_batch` is the mail-typed instance of the shared `batch`/`batch_fetch` fan-out — not a private reimplementation. The list-of-references-in, fan-out-server-side, one-call contract is exactly `batch`'s, specialized to JMAP invocations. `pipe`/`filter`/`map`/`reduce` compose over `mail_search`'s `ids` the same way they compose over any list-producing sux verb.

### B.4 Variable pagination — `limit` / `anchor` / `position` / `collapseThreads` + cursor/total/queryState

`mail_search` exposes the full RFC 8620 §5.5 `/query` pagination surface (CONFIRMED field names + defaults):

| Verb arg | JMAP `Email/query` arg | Semantics |
|---|---|---|
| `limit` | `limit` (`UnsignedInt|null`) | page size |
| `position` | `position` (`Int`, default 0) | zero-based; negative counts from the end |
| `anchor` | `anchor` (`Id|null`) | when set, **`position` is ignored**; window located at that id |
| — | `anchorOffset` (`Int`, default 0) | offset relative to the anchor (managed by the cursor) |
| `total:true` | `calculateTotal` (`Boolean`, default false) | returns `total` |
| `collapseThreads` | `collapseThreads` (`Boolean`, default false) | one row per thread (RFC 8621 Email/query addition) |
| `sort` | `sort` | e.g. `receivedAt desc` |

Response surfaces the CONFIRMED fields: `queryState`, `ids`, `total` (if requested), `position`, and `canCalculateChanges` (whether `Email/queryChanges` is usable for incremental resume).

**The cursor is the ergonomic wrapper over anchor paging.** `mail_search` returns an opaque `cursor`; passing it back resumes at the saved **`anchor`/`anchorOffset`** from the first page (stable under concurrent mutation — the exact reason RFC 8620 provides `anchor`), re-validating `queryState`/`filterHash` before replaying (`jmap.md` §6.3/§6.6/D9). "Never `position`, always `anchor`; validate `queryState` per page" is spec-correct and inherited from the conduit's engine. A caller who wants raw `position` windows can still pass `position` for a one-shot page; the cursor path is what makes multi-page drains correct on a live inbox.

Large drains obey the conduit's guards: 55s deadline, `max_results` cap, and an output-byte ceiling — on any bound the call returns `partial:true` + a resumable `cursor` (`jmap.md` §14), never a silent truncation.

---

## C. The raw escape hatch — `jmap` (the SUPERSET guarantee)

The `jmap` verb (designed in full in [`jmap.md`](./jmap.md)) is exposed on `/mail/mcp` unchanged: a **full JMAP `Request` passthrough** —

```
jmap(calls: [[method, args, callId], …], using?, paginate?, cursor?,
     allow_send?, allow_destroy?)   // or the single-call method/args shorthand
     + upload / download sub-actions for blobs
```

This is what makes the whole surface a **provable superset of JMAP + the Fastmail API**: arbitrary methods across **Email / Mailbox / Thread / EmailSubmission / Identity / SearchSnippet / ContactCard / Calendar / VacationResponse / MaskedEmail** are reachable even when no ergonomic verb wraps them. Anything the Fastmail API can express, a caller can express here — the ergonomic verbs are conveniences, never a ceiling.

- **Contacts:** `ContactCard/query|get` (RFC 9610 JSCard — Fastmail's contacts object, **not** the legacy `Contact`), `AddressBook/get` → `urn:ietf:params:jmap:contacts`. The shipped `contact_*` ergonomic verbs (`mail-mcp.ts`) compile to `ContactCard/*` and shape the JSCard fields (`name.full`|`components`, hash-keyed `emails`→`.address` / `phones`→`.number`, `organizations`). `FLAG` — the `https://www.fastmail.com/dev/contacts` fallback URN was **not** found in current docs (only `urn:ietf:params:jmap:contacts` was listed); verify against a live Session before relying on the fallback branch.
- **Calendars:** `Calendar/*`, `CalendarEvent/*` → `urn:ietf:params:jmap:calendars`, **feature-detected and refused** if the URN is absent. `FLAG`/CONFIRMED — Fastmail states calendar access is via **CalDAV**; JMAP calendars "will be opened when the spec is finalized," so the URN is **not reliably advertised today**. The conduit's detect-and-refuse (`jmap.md` §16) is the correct posture; do not assume a calendars URN is present.
- **Everything ergonomic has a raw twin:** `mail_send` ≡ the two-step Email/set→EmailSubmission/set batch; `mail_search` ≡ `Email/query`(+`SearchSnippet/get`); `mail_masked` ≡ `MaskedEmail/get|set`. A caller who needs a method or argument the sugar doesn't expose drops one layer with no loss.

**Capability URNs a Fastmail Session advertises** (CONFIRMED from Fastmail dev docs), which the `using`-derivation targets: `urn:ietf:params:jmap:core`, `:mail`, `:submission`, `:vacationresponse`, `:contacts`, and `https://www.fastmail.com/dev/maskedemail`. Core limits (`maxCallsInRequest`, `maxObjectsInGet`, `maxObjectsInSet`, `maxSizeRequest`, `maxSizeUpload`) are read **live** from the Session — `FLAG`: do not hardcode Fastmail's numeric values; confirm at runtime (the brief could not re-verify the "50 / 4096 / 10MB" figures against a live Session).

---

## 6. Attachment reach — the cross-store shrink-to-Dropbox workflow

Attachments are handles all the way down, so a large attachment never transits the model. The chain:

1. **`mail_search(hasAttachment:true, from:…, after:…)`** → message-ids (handles), no bytes. (`hasAttachment` is a CONFIRMED FilterCondition field.)
2. **`mail_read(id)`** (or its batch form over the ids) → the message's attachment metadata **including each attachment's `blobId`** (a handle) — filename, type, size. Still no attachment bytes in context.
3. **`jmap({download:{blobId, as:"store"}})`** → the conduit expands the Session `downloadUrl`, GETs the blob **server-side**, and spills it to R2, returning a `/s/<uuid>` CAS ref (`jmap.md` §8). The bytes go edge→R2, never through the model.
4. **Dropbox store** — the `/s/<uuid>` ref is handed to the Dropbox store op, which moves the object into the app folder server-side.

Net: a "move all invoice PDFs from last quarter to Dropbox" workflow over 50 attachments is **a handful of calls with zero attachment bytes in context** — the reference-not-payload rule end-to-end, across two stores. The batch forms make step 2 one call and step 3/4 fan out over the blob-id list.

- **Upload (compose with attachment):** `mail_send`/`mail_draft` `attachments` accept **blob-ids** (or a `/s/<uuid>` CAS ref, which `jmap upload` turns into a blobId). No inline base64 through the model beyond the ~190KB arg ceiling (`jmap.md` §8/D16); real attachments go via CAS ref → `uploadUrl` → blobId, server-side. **No https-URL upload source** (SSRF, D15).

---

## 5. Mutation safety & effectful verbs — `cacheable:false` where effectful, gates that are honest

Every verb's `cacheable` and gating is in the §A tables. Summarizing the effectful contract:

| Verb | `cacheable` | Gate |
|---|---|---|
| `mail_search`, `mail_read`, `mail_thread`, `mail_identities`, `mail_mailboxes` | `false` | none (read) |
| `mail_draft`, `mail_archive`, `mail_move`, `mail_label` | `false` | none (reversible mutation) |
| `mail_delete` (trash) | `false` | none |
| `mail_send` | **`false`** | **`allow_send`** |
| `mail_send(sendAt)` | **`false`** | `allow_send` + capability check (§B.1) |
| `mail_delete(permanent)` | **`false`** | **`allow_destroy`** |
| `mail_masked` (create) | **`false`** | **`allow_masked_create`** (rate-limited) |
| `mail_masked` (delete state) | **`false`** | **`allow_destroy`** |
| `mail_batch`, `jmap` | **`false`** | `allow_send`/`allow_destroy` as the contained ops require |

**The gates are accidental-misuse guards, not an injection boundary — stated plainly** (`jmap.md` §10/D6). `allow_send`/`allow_destroy`/`allow_masked_create` are LLM-set booleans; because `mail_batch`/`pipe`/`augment` compose over **live** mail, an injected instruction inside a message body reaches the same model that sets the flag. A flag the compromised agent controls provides **zero** protection against injected instructions — it only stops an *accidental* malformed send/destroy. **Real containment is a scoped token:** a read-only JMAP token makes send/destroy/masked-create impossible at the credential layer regardless of what the model does. This is the only honest security story and it is repeated in the not_configured message, every gated verb's description, and the security box below.

`cacheable:false` is not a security nicety — it is required (§2): the 24h stale-grace would otherwise serve a day-old inbox as authoritative and persist bodies to shared KV. Freshness is JMAP state tokens, not the cache.

---

## 7. Return shape (composes with the sux algebra)

Every verb returns stable named-field JSON (via `raw:true`, byte-exact — `jmap.md` §9/D19) so `pipe`/`filter`/`map`/`reduce`/`batch` compose off `r.content[0].text`:

```json
{ "ids": ["M1","M2"], "threadIds": ["T1"], "items": [ {light metadata} ],
  "cursor": "…", "total": 128, "queryState": "…", "position": 0,
  "newState": "…", "notUpdated": {}, "partial": false }
```

- List verbs (`mail_search`) populate `ids`/`threadIds`/`items`/`cursor`/`total`/`queryState`.
- Mutators populate `ids` (the affected) + `newState` + `notUpdated`/SetError map.
- `mail_read`/`mail_thread(bodies:true)` add a `messages` array with hydrated bodies (the deliberate-read exception).

This makes `pipe([{verb:'mail_search', args:{query:'invoice', hasAttachment:true}}, {verb:'mail_read', args:{ids:'{{prev.ids}}'}}])` and `batch({verb:'mail_read', over:'{{ids}}'})` operate on live mail with handles flowing between steps and no bodies in the model until the final deliberate read.

---

## 8. Build order & repo impact

Mirrors `jmap.md` §18 — **the conduit ships first; the ergonomic verbs are thin compilers layered after.**

1. **`jmap` fn + `_jmap.ts` engine** (per `jmap.md` build order 1–6). This is the whole substrate: Session cache, self-heal, `using` derivation, limit/split/pagination, gates, blob up/down, `raw:true`, `cacheable:false`. Ship the escape hatch (Layer C) first.
2. **Layer-A compilers** — `sux/src/fns/mail_*.ts`, each a thin function that builds a `calls` batch and delegates to `_jmap.ts`, then shapes handles. Group behind a `mail` category in `gen-docs.mjs`. Ship in dependency order: `mail_mailboxes`/`mail_identities` (id resolution the others need) → `mail_search`/`mail_read`/`mail_thread` (read) → `mail_draft`/`mail_archive`/`mail_move`/`mail_label` (reversible mutation) → `mail_send` (+ `sendAt` superpower, capability-gated) → `mail_delete` → `mail_masked`.
3. **`mail_batch`** — the ergonomic fan-out over `_jmap.ts`'s batch path.
4. **`/mail/mcp` endpoint** — register the mail verbs (+ `jmap`) on a gated route like `/vault/mcp`.
5. **`sux-mail` plugin** — auto-register the `/mail/mcp` connector (mirror `sux-vault`, commit `220ed15`) + ship the `sux-mail` skill (retrieval/compose/attachment recipes; the send skeleton; the scheduled-send capability check; the shrink-to-Dropbox chain).
6. **Secrets & sync** — `wrangler secret put FASTMAIL_TOKEN --config sux/wrangler.jsonc`; regen `index.ts`/`FUNCTIONS.md`; name the mail verbs in `SKILL.md`; `check-skill-sync.mjs --write`.

**fn-count:** `jmap` is +1 (`jmap.md`). The twelve `mail_*` verbs + `mail_batch` are +13 — but per the scope discipline (`scope-50-lean-kagi`, "cap ~50 fns"), these could instead be **one `mail` fn with an `action` enum** (contrast: `jmap` deliberately has no enum because JMAP method names *are* the vocabulary; the ergonomic layer, being curated sugar, is exactly where an `action` enum belongs). **Open decision for Colin:** thirteen `mail_*` fns (best ergonomics, most slots) vs. one `mail{action}` fn (one slot, matches the vault/kroger/obsidian pattern). Recommendation: **one `mail{action}` fn** — it keeps the ~50-fn cap, matches the existing multi-action fns, and the `_jmap.ts` engine already unifies them; the twelve verbs become twelve `action` values with the same per-action signatures/gates/handles documented above.

---

## 9. Open items to verify against a live Session (from the brief)

Before coding, confirm these `FLAG`ged items against a live Fastmail Session (a single `jmap({method:"Session"})`-style dump resolves most):

1. **Scheduled-send serialization** — that `envelope.mailFrom.parameters = {"HOLDFOR"|"HOLDUNTIL": …}` is accepted and honored (mechanism confirmed; exact example not verbatim-verified).
2. **`submissionExtensions` advertises `FUTURERELEASE`** and the concrete **`maxDelayedSend`** ceiling.
3. **`SearchSnippet/get`** field names (`emailIds`, `filter`, result `subject`/`preview`) and the same-filter-as-query constraint (RFC 8621 §5).
4. **Contacts fallback URN** — whether anything beyond `urn:ietf:params:jmap:contacts` is advertised (the `dev/contacts` fallback was not found in docs).
5. **Calendars** — confirm the calendars URN is **absent** (CalDAV-only) so the detect-and-refuse stays correct.
6. **Concrete core limits** — read `maxCallsInRequest`/`maxObjectsInGet`/`maxObjectsInSet`/`maxSizeRequest`/`maxSizeUpload` live; do not hardcode the "50 / 4096 / 10MB" figures.

---

## Why this shape

The existing 29-tool Fastmail connector is a *translation layer*: flat tools that lose back-references, can't reach MaskedEmail, and burn 29 context slots. This design is a **two-layer** answer: a raw `jmap` **transport** that guarantees total JMAP+Fastmail coverage (the superset floor), plus a **thin ergonomic skin** of a dozen handle-passing verbs for the 80% path — both compiling to the same `_jmap.ts` engine, both obeying the reference-not-payload rule so an agent does bulk mail work in a few calls with zero bodies in context. The four superpowers Colin required are first-class and grounded in verified spec: **scheduled send** is the corrected `envelope.mailFrom.parameters.HOLDFOR/HOLDUNTIL` (capability-gated), **remote search** is server-side `Email/query`+`SearchSnippet` with a stable cursor, **batching** is native one-request back-references (`mail_batch`), and **variable pagination** is the full `anchor`/`position`/`collapseThreads`+`queryState` surface. Nothing is invented; everything unwrapped is still reachable.

## Related

- [[jmap-conduit]]
- [[jmap]]
- [[handle-discipline]]
- [[unblocked-gated-law]]
- [[Namespaces-MOC]]
