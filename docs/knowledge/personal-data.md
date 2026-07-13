# Personal-data connectors — durable reference

The four personal-data backends sux talks to: **Fastmail** (mail via JMAP, calendar/tasks
via CalDAV, contacts via JMAP), **Dropbox** (two independent credential scopes),
and **Obsidian** (two independent backends). This is the ground-truth map of *exactly*
which protocol methods / HTTP endpoints sux calls, the env vars, and the gotchas — so a
future session never re-derives them by reading the code or re-fetching the specs.

Everything runs inside one Cloudflare Worker; every fn is wrapped by a 60s
`FN_DEADLINE_MS`. `line` refs below are `<file>:<line>` at the time of writing — treat as
a pointer, re-grep if drifted.

---

## Fastmail — JMAP (mail)

- **Purpose** — All email flow (search / read / thread / draft / send / schedule / move /
  archive / masked-email / vacation / quota). The ergonomic `mail` verb
  (`fns/mail.ts`) and the raw `jmap` conduit (`fns/jmap.ts`) both compile down to the
  shared engine `fns/_jmap.ts`. `mail-mcp.ts` holds the ergonomic tool implementations
  (`mail_search`, `mail_read`, …) that call the engine via `jmapCall`.

- **Auth** — `FASTMAIL_TOKEN` = a **JMAP-scoped** Fastmail API token (Settings → Privacy &
  Security → API tokens). An **"MCP"-type token does NOT work**. Sent as
  `Authorization: Bearer <token>` (`_jmap.ts:67`). For read/compose workflows, mint a
  **read-only** token so send/destroy are impossible at the credential layer — the write
  gates (`allow_send`/`allow_destroy`) are only accidental-misuse guards, not an injection
  boundary.

- **Base URL / session discovery** — `FASTMAIL_SESSION_URL` (default
  `https://api.fastmail.com/jmap/session`, `_jmap.ts:29`). `GET` the session → validate
  `apiUrl`/`accounts`/`primaryAccounts` → cache the **token-free** body in `OAUTH_KV` under
  `sux:fastmail:session`, TTL 3600s (`discoverSession`, `_jmap.ts:80`). `apiUrl`,
  `uploadUrl`, `downloadUrl`, per-account `accountCapabilities`, and core limits
  (`maxCallsInRequest` 16, `maxObjectsInGet` 500, …) all come from the session — never
  hard-code them. Self-heal: 401/403 or 404/405/410 → delete KV, re-discover once, retry.
  `FASTMAIL_ACCOUNT_ID` optionally overrides account routing.

- **Methods sux calls** (RFC 8620 core + RFC 8621 mail + Fastmail extensions):
  - `Email/query` + `Email/get` round-trip (`mail-mcp.ts:366`, `:388`) — `#ids` back-ref.
  - `Mailbox/get` (`mail-mcp.ts:302`, `:368`) — id→name map, mailbox list.
  - `Thread/get` → `Email/get` on `/list/*/emailIds` (`mail-mcp.ts:416`).
  - `Identity/get` (`mail-mcp.ts:447`) — pick the From identity before send.
  - `Email/set` create (draft) (`mail-mcp.ts:1026`, `:1065`).
  - `EmailSubmission/set` create + `onSuccessUpdateEmail` (Drafts→Sent) (`mail-mcp.ts:1065`);
    `update {undoStatus:"canceled"}` cancels a scheduled send (`:529`).
  - `MaskedEmail/get`/`set` (Fastmail ext `https://www.fastmail.com/dev/maskedemail`) (`mail-mcp.ts:588`).
  - `VacationResponse/get`/`set` singleton (`mail-mcp.ts:630`).
  - `Quota/get` (`mail-mcp.ts:656`).
  - Blob `upload`/`download` sub-actions hit the session `uploadUrl`/`downloadUrl`
    (`_jmap.ts:635`, `:652`), not `apiUrl`.
  - **`PushSubscription` is NOT implemented in sux** — the JMAP push spec (RFC 8620 §7) is
    viable on Fastmail (memory: "PushSubscription works") but no code path creates one.
    Mail freshness comes from polling + state tokens, not push.

- **Code pattern** — the canonical query→get in one round-trip (back-reference resolved
  server-side):
  ```js
  jmapCall(env, { calls: [
    ["Email/query", { filter, sort:[{property:"receivedAt",isAscending:false}], limit }, "q"],
    ["Email/get",   { "#ids": {resultOf:"q", name:"Email/query", path:"/ids"},
                      properties:["id","threadId","subject","from","receivedAt","preview"] }, "g"],
  ]});
  ```
  Send is two steps: `Identity/get` for the From identity, then one batch of
  `Email/set` create draft + `EmailSubmission/set` create with `onSuccessUpdateEmail`
  (`allow_send:true` required).

- **Limits/gotchas**
  - **Session URL discovery is mandatory** — `apiUrl`/limits/`accountId` are all session-derived and KV-cached; a stale session self-heals on 401/404.
  - `using` capability URNs are **auto-derived** from method names and unioned
    (`deriveUsing`, `_jmap.ts:177`); `EmailSubmission` implies `mail`.
  - Batch cap is the session's `maxCallsInRequest` (16) — sux **refuses** an over-cap
    batch, it does not auto-split a reference graph.
  - `paginate:true` walks a single `Foo/query` past the page limit via stable anchor
    paging (`runPaginate`, `_jmap.ts:434`) → `{ids, cursor, partial}`; degrades to
    `partial` on `anchorNotFound`/`queryState` drift.
  - Mail bodies + session PII are **never** written to the response cache (`cacheable:false`, `raw:true`).
  - `jmap({session:true})` dumps the raw session; `jmap({scope_probe:true})` returns a
    reachable-capability map — **`calendars` is always `false`** (Fastmail exposes no
    `urn:ietf:params:jmap:calendars`; calendar is CalDAV-only).

- **Refs** — [RFC 8620 (JMAP core)](https://www.rfc-editor.org/rfc/rfc8620) ·
  [RFC 8621 (JMAP Mail)](https://www.rfc-editor.org/rfc/rfc8621) ·
  [Fastmail JMAP docs](https://www.fastmail.com/for-developers/integrating-with-fastmail/) ·
  MaskedEmail ext URN `https://www.fastmail.com/dev/maskedemail`.

---

## Fastmail — CalDAV (calendar + tasks)

- **Purpose** — Calendars (VEVENT) and tasks (VTODO). Fastmail has **no `jmap:calendars`
  capability**, so calendar rides CalDAV on a separate credential. Engine `fns/_caldav.ts`;
  ergonomic verbs via `fns/cal.ts` (`cal_list`/`cal_events`/`cal_create`/`cal_update`/
  `cal_delete`/`task_*`/`caldav` raw, implemented in `mail-mcp.ts`).

- **Auth** — **Basic auth**, distinct from JMAP: `FASTMAIL_CALDAV_USER` (your Fastmail
  login/email) + `FASTMAIL_APP_PASSWORD` (Settings → Privacy & Security → **App passwords**,
  with Calendars/CalDAV access). `Authorization: Basic base64(user:pass)` (`_caldav.ts:22`).
  Both must be set or every verb returns `not_configured` (`hasCalDav`, `_caldav.ts:15`).
  This is an **app password, not a JMAP token** — the #1 gotcha.

- **Base URL / discovery** — host `https://caldav.fastmail.com` (`_caldav.ts:13`).
  Calendar-home collection: `/dav/calendars/user/<user>/` (`calendarHome`, `_caldav.ts:51`).

- **Methods/endpoints sux calls** (WebDAV/CalDAV verbs):
  - `PROPFIND` Depth:1 on the calendar-home → list calendar collections; requests
    `displayname`, `resourcetype`, `supported-calendar-component-set`,
    `calendar-description` (`listCalendars`, `_caldav.ts:73`). `VTODO`-only collection ⇒ `isTasks`.
  - `REPORT` (`calendar-query`) on a collection, filtered by
    `comp-filter VCALENDAR > comp-filter VEVENT|VTODO` + a `time-range`; requests
    `getetag` + `calendar-data` (`reportObjects`, `_caldav.ts:345`). Events default to
    **now..+90d** (caller-overridable); VTODO unbounded unless a window is given (a
    time-range would drop undated tasks per RFC 4791 §9.9).
  - `PUT`/`DELETE` with `If-Match`/`If-None-Match` ETag preconditions for mutation
    (`caldavFetch`, `_caldav.ts:33`).

- **Code pattern** — iCal is **built and parsed in-Worker** (no DOMParser; regex-based
  against Fastmail's response shape). `buildVEvent`/`buildVTodo` (`_caldav.ts:146`, `:168`)
  emit RFC 5545 with 75-**octet** content-line folding; `parseICal` (`_caldav.ts:234`)
  unfolds + tokenizes top-level VEVENT/VTODO, tracking a `sub` counter so a VALARM/VTIMEZONE
  child's props never bleed into the event; `replaceProps` (`_caldav.ts:277`) surgically
  rewrites one component's properties for updates. Multistatus XML is split via
  `multistatusResponses` (regex, `_caldav.ts:61`).

- **Limits/gotchas** — separate app-password credential (not the JMAP token);
  time-range bounds events by default so a multi-year calendar can't blow the deadline;
  iCal parse is regex, curating common props only (not the whole RFC 5545 spec); ETag
  preconditions guard concurrent edits.

- **Refs** — [RFC 4791 (CalDAV)](https://www.rfc-editor.org/rfc/rfc4791) ·
  [RFC 5545 (iCalendar)](https://www.rfc-editor.org/rfc/rfc5545) ·
  [RFC 4918 (WebDAV / PROPFIND)](https://www.rfc-editor.org/rfc/rfc4918).

---

## Fastmail — JMAP Contacts

- **Purpose** — Fastmail contacts as **JSContact `ContactCard`** objects. Verbs via
  `fns/contact.ts` (`contact_search`/`get`/`create`/`update`/`delete`), implemented in
  `mail-mcp.ts` over the same JMAP engine + `FASTMAIL_TOKEN`.
  (Note: `fns/contacts.ts` is an **unrelated** page/text scraper for emails/phones/socials —
  not this backend.)

- **Auth / base URL** — same as JMAP mail: `FASTMAIL_TOKEN`, session discovery, `apiUrl`.
  Contacts capability URN is `urn:ietf:params:jmap:contacts` or Fastmail's dev URN
  `https://www.fastmail.com/dev/contacts` — whichever the live session advertises
  (`contactsCap`, `_jmap.ts:155`). `accountId` for contacts may be a **non-primary** account,
  resolved by scanning `accountCapabilities` (`accountIdFor`, `_jmap.ts:200`).

- **Methods sux calls**:
  - `ContactCard/query` + `ContactCard/get` (`mail-mcp.ts:674`) — search.
  - `ContactCard/get` by ids (`mail-mcp.ts:691`).
  - `ContactCard/set` create / update(patch) / destroy (`mail-mcp.ts:711`, `:736`, `:759`;
    destroy passes `allow_destroy:true`).

- **Code pattern** — create sends a JSCard: `{"@type":"Card","version":"1.0",...card}`;
  ergonomic string args are mapped to a JSCard patch (`mail-mcp.ts:208`).

- **Limits/gotchas** — JMAP Contacts uses **`ContactCard`** (JSContact/RFC 9553), not the
  legacy `Contact` object; the contacts URN and account are session-derived, not assumed.

- **Refs** — [RFC 9553 (JSContact)](https://www.rfc-editor.org/rfc/rfc9553) ·
  RFC 8620 (JMAP core) · JMAP Contacts is Fastmail-extension territory (no finalized IETF
  JMAP-contacts RFC at time of writing).

---

## Dropbox — Mode A (app-folder) and Mode B (whole-Dropbox)

Two **independent** credential scopes sharing the token lifecycle in
`fns/_dropbox-core.ts` (mint short-lived access token from a long-lived refresh token,
cache in `OAUTH_KV` until `expires_in-60`, self-heal a 401 by re-minting once). Both
support **confidential** (app secret → HTTP Basic) and **public/PKCE** (no secret →
`client_id` in body) OAuth refresh; a static token is a quick-test fallback. API bases:
`https://api.dropboxapi.com/2` (RPC), `https://content.dropboxapi.com/2` (content),
`https://api.dropbox.com/oauth2/token` (refresh) (`_dropbox-core.ts:15`).

### Mode A — app-folder (`fns/dropbox.ts`)

- **Purpose** — human-facing blob store; files land in `/Apps/<app>/` and sync to every
  device. **The App-folder credential structurally cannot see the rest of Dropbox** — the
  scope *is* the safety boundary, so no mutation gates are needed.
- **Auth** — `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` (+ optional `DROPBOX_APP_SECRET`)
  for the durable flow, or `DROPBOX_TOKEN` (short-lived `sl.` access token) for a quick
  test. KV token key `sux:dropbox:token`. Scopes needed:
  `files.content.read/write`, `files.metadata.read`, `sharing.read/write`. Gate on
  `hasDropbox(env)` (`dropbox.ts:30`), never on `DROPBOX_TOKEN` alone.
- **Endpoints** — `POST /files/upload` (content host), `/files/get_metadata`,
  `/files/download` (content), `/files/list_folder` + `/list_folder/continue`,
  `/files/delete_v2`, `/files/move_v2`, `/sharing/create_shared_link_with_settings` +
  `/sharing/list_shared_links` (reuse on 409). Ops: `put·get·list·delete·share·move`.
- **Gotchas** — the `Dropbox-API-Arg` header must be **HTTP-header-safe JSON** (every char
  ≥ 0x7F `\uXXXX`-escaped, `headerSafeJson`, `_dropbox-core.ts:25`). Files stored
  **verbatim** (no gzip — Dropbox is the human mirror; R2 `store` is the machine twin that
  compresses). `get` checks metadata size first (never buffers an oversize file into the
  128MB isolate); >4MB → metadata + shared link. Shared links are **public** "anyone with
  the link" URLs. `delete` requires `confirm:true` (lands in recoverable "Deleted files").

### Mode B — whole-Dropbox (`fns/_dropbox-full.ts`)

- **Purpose** — READ + SEARCH (and gated WRITE/MOVE/DELETE/TRANSFORM) over the **whole**
  Dropbox, behind a **separate** full-scope credential at a **distinct** KV key. Never
  touches Mode A. **LIVE** as of 2026-07-12 (`DROPBOX_FULL_*` set; PKCE/secretless).
- **Auth** — `DROPBOX_FULL_REFRESH_TOKEN` + `DROPBOX_FULL_APP_KEY` (+ optional
  `DROPBOX_FULL_APP_SECRET`), or `DROPBOX_FULL_TOKEN`. KV token key
  `sux:dropbox:full:token`. PKCE/secretless: the Worker holds only the public app key +
  refresh token, no long-lived app secret. Gate on `hasDropboxFull(env)`
  (`_dropbox-full.ts:30`).
- **Endpoints** — reads: `/files/search_v2` + `/files/search/continue_v2`
  (`searchFull`, `:45`), `/files/list_folder` (+ continue) (`listFull`, `:61`),
  `/files/get_metadata` + `/files/download` + `/files/get_temporary_link` (`readFull`, `:71`).
  Writes (gated): `/files/upload`, `/files/delete_v2`, `/files/move_v2`, `/files/copy_v2`
  (for the pre-op `.sux-trash` backup).
- **Gotchas — the Mode B write firewall (accident guard, not an injection boundary):**
  - **`DROPBOX_FULL_PROTECT_PREFIXES`** — comma-separated absolute prefixes that are a
    hard mutation deny-list. `fenceFull` (`:115`) refuses the account root **and** any path
    under a protected prefix on every write/move/delete/transform.
  - **dry-run by default** — every mutating verb returns a plan unless `dry_run:false`
    (delete also needs `confirm:true`).
  - **recoverability** — overwrite first copies the target to `/.sux-trash/<ts>/<path>`
    via `copy_v2`; Dropbox version history + "Deleted files" back it up.
  - **rev-conditioning** — a write with `rev` fails loudly on a concurrent edit instead of
    clobbering; reading a *specific* revision is intentionally unsupported (would let the
    size-gate check one object and the download fetch another → injection-reachable OOM).
  - Oversize read → a **temporary** (~4h, non-public) link, never a permanent share.
  - `files_operate` (`operateFull`, `:195`) is a find→plan→apply firewall over the gated
    primitives, blast-radius capped (max 500) + time-budgeted; `transformFull` (`:315`)
    does merge/extract through the same `writeFull` firewall.

- **Refs** — [Dropbox HTTP API v2 docs](https://www.dropbox.com/developers/documentation/http/documentation) ·
  [API Explorer](https://dropbox.github.io/dropbox-api-v2-explorer/) · endpoints under
  `https://{api|content}.dropboxapi.com/2/`.

---

## Obsidian — git backend and remote (Local REST API) backend

`fns/obsidian.ts`, one fn with `backend: git (default) | remote | local`. Actions:
`list·read·search·append·write·edit·delete` (+ `tools·call` remote-only). Mutating actions
refuse dot-prefixed path segments (`.github/`, `.obsidian/`, dotfiles) via `badVaultPath`
(`:110`) — repo/vault infra is unreachable.

### git backend (default) — GitHub Contents API

- **Purpose** — a git-backed vault; every write is a commit, so **git history is the undo**.
  Async/versioned (a git mirror, not the live vault).
- **Auth** — `OBSIDIAN_VAULT_REPO='owner/repo'` (required), `OBSIDIAN_VAULT_BRANCH`
  (default `main`), `OBSIDIAN_VAULT_DIR` (subdir prefix). `GITHUB_TOKEN` needed for private
  repos + writes (writes go through `smartFetch`/`ghJson`). Config via `vaultCfg` (`:28`).
- **Endpoints** (`https://api.github.com`):
  - `GET /repos/{repo}/git/ref/heads/{branch}` — HEAD sha for the read-through cache (`vaultHead`, `:85`).
  - `GET /repos/{repo}/git/trees/{branch}?recursive=1` — `list` (filter `.md`) (`:382`).
  - `GET /repos/{repo}/contents/{path}?ref={branch}` — `read` (refetches `raw` accept for >1MB
    notes, which the Contents API returns with `content:""`; `readGitContents`, `:156`).
  - `PUT /repos/{repo}/contents/{path}` — write/append/edit (base64 body, optimistic-concurrency
    `sha`; 409 = "note changed since read"; `vaultPut`, `:119`).
  - `DELETE /repos/{repo}/contents/{path}` — delete (`:467`).
  - `GET /search/code?q=<q>+repo:<repo>+extension:md` — `search` (`:408`).
- **Gotchas** — **git can't full-text-search a *private* repo cheaply**: `/search/code`
  needs an authenticated `GITHUB_TOKEN` and only indexes what GitHub indexes (path/filename
  hits, latency, rate limits) — it is NOT the live-vault full-text search the remote backend
  gives. Reads are KV-cached and validated against HEAD sha (rechecked ≤ once/min, stale
  trusted ≤ 10min if the ref fetch fails). `edit` uses the read-time sha so a concurrent
  write 409s instead of silently clobbering.

### remote backend — Obsidian Local REST API over Tailscale Funnel

- **Purpose** — the **LIVE** vault in real time (the plugin's REST API exposed on a public
  HTTPS Funnel URL the cloud Worker can reach directly — no SSRF issue since the Funnel host
  is public, not LAN). `local` backend is a stub (Worker can't reach localhost/LAN).
- **Auth** — `OBSIDIAN_REMOTE_URL` (the Funnel'd Local REST API base, e.g.
  `https://vault.<tailnet>.ts.net`) + `OBSIDIAN_REMOTE_KEY` (the plugin's API key, from
  Obsidian → Local REST API settings). `Authorization: Bearer <key>`, direct `fetch`
  (`remoteFetch`, `:182`).
- **Endpoints** (Local REST API):
  - `GET /vault/<dir>/` — `list`; `GET /vault/<path>` (Accept `text/markdown`) — `read`.
  - `POST /search/simple/?query=<q>&contextLength=100` — `search` (live full-text; `:272`).
  - `POST /vault/<path>` (text/markdown) — `append`; `PUT /vault/<path>` — `write`/`edit`;
    `DELETE /vault/<path>` — `delete`.
  - The plugin also ships a **built-in MCP server at `/mcp/`** (Streamable HTTP, Bearer,
    **stateful**: `initialize` → returns `Mcp-Session-Id` → `notifications/initialized` →
    the real call, all carrying the session id; handshake run per call, `obsidianMcp`, `:201`).
    `action=tools` lists its ~15 vault tools, `action=call` runs one (`tool` + `tool_args`).
- **Gotchas** — `read` writes through to KV and **falls back to the cached copy** when the
  Mac is unreachable (fetch failure or 5xx from the Funnel edge); `list`/`search` are
  uncached (fail if the Mac is asleep). This is the backend for **live full-text search**
  that git can't do on a private repo.

- **Refs** — [obsidian-local-rest-api (repo)](https://github.com/coddingtonbear/obsidian-local-rest-api) ·
  [interactive API docs](https://coddingtonbear.github.io/obsidian-local-rest-api/) ·
  [OpenAPI spec](https://coddingtonbear.github.io/obsidian-local-rest-api/openapi.yaml) ·
  [GitHub REST Contents API](https://docs.github.com/en/rest/repos/contents).

---

## Env-var quick map

| Service | Env vars | Method |
|---|---|---|
| Fastmail JMAP (mail + contacts) | `FASTMAIL_TOKEN`, `FASTMAIL_SESSION_URL`, `FASTMAIL_ACCOUNT_ID` | Bearer token, session discovery |
| Fastmail CalDAV (cal + tasks) | `FASTMAIL_CALDAV_USER`, `FASTMAIL_APP_PASSWORD` | Basic auth (app password) |
| Dropbox Mode A (app-folder) | `DROPBOX_REFRESH_TOKEN`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_TOKEN` | OAuth refresh / PKCE / static |
| Dropbox Mode B (whole) | `DROPBOX_FULL_REFRESH_TOKEN`, `DROPBOX_FULL_APP_KEY`, `DROPBOX_FULL_APP_SECRET`, `DROPBOX_FULL_TOKEN`, `DROPBOX_FULL_PROTECT_PREFIXES` | OAuth refresh (PKCE/secretless) + write firewall |
| Obsidian git | `OBSIDIAN_VAULT_REPO`, `OBSIDIAN_VAULT_BRANCH`, `OBSIDIAN_VAULT_DIR`, `GITHUB_TOKEN` | GitHub Contents API |
| Obsidian remote | `OBSIDIAN_REMOTE_URL`, `OBSIDIAN_REMOTE_KEY` | Local REST API (Bearer) over Funnel |
