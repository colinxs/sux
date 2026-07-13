---
title: sux integration program — ultracode workflow
status: superseded
cluster: meta
type: workflow
summary: "The end-to-end ultracode build workflow that specced mail hardening, the CalDAV calendar+tasks subsystem, vault graph features, and Todoist repositioning — now shipped on main (cal/contact/caldav fns, vault_query/vault_patch). Provenance/reference only."
tags: [sux, meta, workflow]
updated: 2026-07-11
---

# sux integration program — ultracode workflow

One end-to-end build workflow for the `sux` Cloudflare Worker (MCP at `sux.colinxs.workers.dev/mcp`). Covers every piece of feedback: mail hardening, a new CalDAV calendar+tasks subsystem, vault graph features, and Todoist repositioning. Execute phases in order; each ends in a live verification gate. Everything needed is inline — no external files required.

Account under test: Fastmail `ua5f1401b`, primary identity `m@colinxs.com` (id `128338560`).

---

## Global conventions (apply to every phase)

- Thin raw escape-hatch verb per protocol (`jmap`, new `caldav`) + ergonomic sugar on top. Never make callers hand-roll a protocol when a typed verb can.
- Paste-clean code: **no inline/trailing comments** in any language; commentary lives outside code blocks only. No trailing comments in comment-less shells (bash).
- Fail loud on missing credentials with a clear "X not configured" message; never silently no-op.
- Every side-effectful write supports **stage-then-commit** (Phase 0). Boolean `allow_*` flags are accidental-misuse guards, NOT injection boundaries — do not rely on them alone for anything that sends or destroys.
- Keep raw `methodResponses` / raw DAV bodies reserved for the raw verbs; ergonomic verbs return typed objects.

## Credential + scope map (verified 2026-07-10)

| Credential | Protocol | Covers | Notes |
|---|---|---|---|
| `FASTMAIL_TOKEN` | JMAP Bearer | Email, Mailbox, Thread, Identity, EmailSubmission (incl. FUTURERELEASE), MaskedEmail | currently mail+submission+maskedemail only |
| `FASTMAIL_TOKEN` (after re-scope) | JMAP Bearer | + Contacts (`ContactCard`, RFC 9610) | re-mint with the Contacts scope. **Shipped correction:** Fastmail API tokens do **not** grant `vacationresponse` or `quota` — no re-mint exposes them (a platform limit), so `mail_vacation`/`mail_quota` permanently gate to `not_configured`. |
| `FASTMAIL_CALDAV_USER` + `FASTMAIL_APP_PASSWORD` | CalDAV Basic | Calendar (VEVENT) + Tasks (VTODO) | app password, NOT the token, NOT login pw |

Hard limit: **Calendar is never reachable over JMAP** — Fastmail exposes no `jmap:calendars` scope (spec is an IETF draft). No token fixes it; calendar is CalDAV-only.

---

## Phase 0 — Cross-cutting primitives (build first, everything depends on these)

**0a. Stage-then-commit.** Add an optional `stage:true` to every side-effectful verb (`mail_send`, `mail_schedule`, `mail_masked` create, any `*_delete`/destroy, all CalDAV writes). `stage:true` returns `{ preview, commit_token }` where `commit_token` is opaque, short-TTL (e.g. 5 min), and bound to a hash of the exact payload; it performs no mutation. A second call passing the token commits iff the token is unspent, unexpired, and the payload hash matches. A token cannot be minted and spent in the same turn.

**0b. `jmap` session-capabilities dump.** Add `session:true` (or method `Session/get`) to the `jmap`/`mail:jmap` verb returning the raw JMAP Session `capabilities` object — so callers can read `urn:ietf:params:jmap:submission.maxDelayedSend` / `submissionExtensions`, plus `maxSizeUpload`, `maxObjectsInGet`, etc. The tool already discovers the Session internally; stop discarding it.

**0c. `jmap` scope-probe helper.** A helper that runs single-capability `Foo/get` calls (one capability per request — mixing an out-of-scope capability into a batch forces a Session re-discovery that fails the whole batch) and returns a reachable-capability map without failing on the unreachable ones.

**Gate 0:** `session:true` returns capabilities incl. a non-zero `maxDelayedSend`; scope-probe returns `{mail:true, submission:true, maskedemail:true, contacts:false, vacationresponse:false, quota:false, calendars:false}` on the current token.

---

## Phase 1 — Mail hardening (existing JMAP token, no re-scope needed)

**1a. Wildcard-identity From resolution (correctness footgun — do this first).** From→identityId resolution must NOT use strict string equality (`identity.email === from`); that never matches a concrete address against a stored `*@domain` wildcard identity and throws "From address is not verified" before any API call. Fix: if an identity's email starts with `*@`, match by domain suffix.

```js
function resolveIdentity(identities, from) {
  const f = from.toLowerCase();
  return identities.find(i => i.email.toLowerCase() === f)
    || identities.find(i => i.email.startsWith('*@') && f.endsWith(i.email.slice(1).toLowerCase()));
}
```

Apply in `mail_send`, `mail_draft`, and `mail_schedule`. Account wildcards: `m@colinxs.com`→`128338560`; any other `@colinxs.com`→`149187368`; `*@lyres.org`→`149187376`; `*@lyceum-research.com`→`149187400`. Expose a `from` arg that accepts arbitrary addresses at owned domains (send-as-any).

**1b. `mail_schedule` (FUTURERELEASE) — verified working.** Scheduled send is standard JMAP: `EmailSubmission/set` with envelope param `FUTURERELEASE` (RFC 4865 `HOLDFOR` seconds or `HOLDUNTIL` absolute), read back via `sendAt`. Capability is the plain `urn:ietf:params:jmap:submission` already unioned — no vendor URN. Signature `mail_schedule(to, subject, text, sendAt, cc?, bcc?, from?)`. Flow: `Identity/get` (resolve From via 1a) → `Email/set` draft in Drafts (`keywords:{$draft:true}`) → `EmailSubmission/set` create `{emailId:'#draft', identityId, envelope:{mailFrom:{email, parameters:{HOLDFOR:'<sec>'}}, rcptTo:[...]}}` with `onSuccessUpdateEmail` moving Drafts→Sent. Requires `allow_send:true`; route through stage-then-commit. Cancel = `EmailSubmission/set update {id:{undoStatus:'canceled'}}` while `pending`; the record disappears after cancel, so a `mail_unschedule` verb treats `notFound`-after-cancel as success.

**1c. Typed returns** on `mail_read`/`mail_search`: `{id, threadId, subject, from, to, cc, receivedAt, isRead, isFlagged, isDraft, folder|labels}`. Raw `methodResponses` stay behind the `jmap` verb only.

**1d. `mail_masked` state transitions.** Extend beyond list/create with `disable`/`enable`/`delete` via `MaskedEmail/set` state transitions (`enabled`/`disabled`/`deleted`). In scope on the current token.

**1e. Efficient attachments.** Core principle: **attachment bytes never round-trip through the model/context** — reference by URL/CAS, upload server-side, stream not buffer.

- Add an `attachments[]` arg to `mail_send`/`mail_draft`/`mail_schedule`. Each item is one of:
  - `{ ref: '/s/<uuid>' }` — a sux CAS ref; Worker streams R2 → JMAP uploadUrl. **This is the primary path for real attachments.**
  - `{ blobId }` — an already-uploaded JMAP blob (reuse; see `mail_upload`).
  - `{ dropbox: path }` / `{ drive: id }` — server-side pull from a connected store, piped straight to upload.
  - `{ data, type, filename }` — small inline base64 only, ≤ the inline cap (~190KB); reject larger with "use a ref".
  - Common fields: `filename`, `type` (contentType), `disposition:'attachment'|'inline'`, optional `cid` for inline HTML images.
- Pipeline: resolve source → `ReadableStream` server-side → POST to the Session `uploadUrl` **streamed, not buffered** → `{blobId,type,size}`; then `Email/set` with `bodyStructure` = `multipart/mixed` (or `multipart/related` when `cid` inline images are present) containing the body part(s) plus one part per attachment `{blobId, type, name, disposition, cid?}`.
- Dedicated `mail_upload(ref|dropbox|drive|data)` → `{blobId,type,size}`, so a large file is uploaded once and reused across many sends (upload-once / send-many).
- Efficiency guards: (1) read `maxSizeUpload` from the Session dump (Phase 0b) and reject oversize **before** streaming; surface that the total *message* size limit is separate from the per-blob upload cap. (2) Dedup by content hash in KV (`sha256 → blobId`) to skip re-uploading a blob already present. (3) Pipe the fetched body directly into the upload POST; never buffer a whole file in Worker memory (128 MB ceiling). (4) `https` URLs are SSRF-refused on the raw `data` param, so the sanctioned big-file path is: land bytes in sux storage first (`files_upload`/`store` → `/s/<uuid>`), then attach by `ref`.

**Gate 1:** send-as-wildcard from `probe@colinxs.com` resolves to `149187368` and delivers (throwaway to self, then delete); `mail_schedule` HOLDFOR 120s returns a future `sendAt`, then `mail_unschedule` cancels and it does not deliver; `mail_read` returns the typed shape; attach a multi-MB file by `/s/<uuid>` ref → confirm it streams server-side to a `blobId` and sends (throwaway to self, then delete) with **no bytes through the model**; `mail_upload` returns a reusable `blobId` and a second send referencing it skips re-upload.

---

## Phase 2 — Re-scoped JMAP verbs (after `FASTMAIL_TOKEN` re-mint)

Prerequisite: reissue `FASTMAIL_TOKEN` in Fastmail Settings → Privacy & Security → API tokens with Mail read+write, Masked Email, Contacts read+write (Vacation/Quota are **not** grantable on a Fastmail API token — a platform limit, so `mail_vacation`/`mail_quota` stay `not_configured` no matter how the token is scoped); update the Worker secret; force `session_refresh` to bust the KV-cached Session.

**2a. `mail_vacation`** get/set over `VacationResponse` (needs vacationresponse scope). Route set through stage-then-commit / `allow_destroy`.
**2b. `mail_quota`** over `Quota/get` (needs quota scope).
**2c. Contacts verbs** over `urn:ietf:params:jmap:contacts` (`AddressBook`/`ContactCard` — RFC 9610): `contact_search`, `contact_get`, `contact_create/update/delete` (destroys staged).

**Gate 2:** re-run the Phase-0 scope-probe; **Contacts** flips to `true` — but **Vacation/Quota do NOT** (Fastmail API tokens can't carry those scopes; they stay `not_configured`, a platform limit, not a bug), and Calendars stays `false`. `contact_search` returns typed rows; `mail_vacation`/`mail_quota` gate cleanly with the re-mint hint rather than erroring.

---

## Phase 3 — Calendar + tasks (new CalDAV subsystem, app password)

Prerequisite: `FASTMAIL_CALDAV_USER` + `FASTMAIL_APP_PASSWORD` (Calendars scope) secrets set.

Endpoints: base `https://caldav.fastmail.com/`; well-known `/.well-known/caldav` (301→principal, keep auth on redirect); principal `/dav/principals/user/{user}/`; home `/dav/calendars/user/{user}/`; object `.../{calendarId}/{urlencode(uid)}.ics`. Auth `Authorization: Basic base64(user:app_password)`, TLS only. Tasks = VTODO in the same collections as VEVENT.

**3a. Raw `caldav` verb**: `caldav({method, path, headers?, body?, depth?})` over `PROPFIND|REPORT|GET|PUT|DELETE|MKCALENDAR|PROPPATCH` → `{status, etag, headers, text, responses[]}`. Worker has no `DOMParser`; use `fast-xml-parser` or a hand-rolled 207 Multi-Status walker, namespace-aware across `DAV:`, `urn:ietf:params:xml:ns:caldav`, `http://calendarserver.org/ns/`.
**3b. Discovery**: PROPFIND principal → `calendar-home-set` → Depth-1 PROPFIND home-set for `displayname`, `resourcetype`, `supported-calendar-component-set`, `getctag`, `sync-token`; cache `{calendarId→{href,name,comps,color,ctag,syncToken}}` in KV keyed on ctag; `refresh` flag to force.
**3c. Read**: `cal_list`; `cal_events(calendar,start,end)` via `calendar-query` REPORT with a VEVENT `time-range` filter; `cal_event_get(href)`; `cal_sync(calendar,syncToken)` via `sync-collection`.
**3d. iCal builder/parser** (VEVENT/VTODO; `ical.js` works in Workers): RFC 5545 fold at 75 octets, CRLF, escape `\ , ;`+newlines in TEXT, UTC (`Z`) or `VTIMEZONE`+`TZID`.
**3e. Write** with ETag concurrency: `cal_create` (PUT, `If-None-Match:*`), `cal_update` (GET etag→rebuild→PUT `If-Match:<etag>`; 412→re-GET+retry), `cal_delete` (DELETE, optional `If-Match`). `Content-Type: text/calendar; charset=utf-8`.
**3f. Tasks (VTODO)**: `task_list` (calendar-query VTODO), `task_create`, `task_update`, `task_complete` (`STATUS:COMPLETED`+`PERCENT-COMPLETE:100`+`COMPLETED:<utc>`), `task_delete`.
**3g. Recurrence**: `RRULE` on master; single-occurrence override = second VEVENT, same `UID`, `RECURRENCE-ID`, same `.ics`; `EXDATE` for deletions; `occurrence` arg (this / this-and-following / series).
**3h. `cal_rsvp`** sets the user's `ATTENDEE;PARTSTAT`.
**3i. Event attachments** follow the same reference-don't-inline rule: prefer `ATTACH;VALUE=URI` pointing at a sux `/s/<uuid>` share (or Fastmail Managed Attachments via the calendarserver POST endpoint returning a `MANAGED-ID`) over inline base64 for anything non-trivial. Reuse the Phase-1e source-resolution helper.

**iMIP side-effect — critical:** adding/changing/removing `ATTENDEE` lines makes Fastmail email invitations/updates/cancellations on PUT (real, irreversible sends). Route every attendee-bearing write through stage-then-commit; never silent PUT.

**Gate 3:** discovery PROPFIND (read-only) lists calendars with their `comps`; one-week calendar-query returns events; throwaway no-attendee VEVENT create→GET→delete; VTODO create→complete→delete; one recurring event + single-occurrence override; an attendee event **stages** rather than sends (no real invitee).

---

## Phase 4 — Vault graph features

Keep the git-backed cloud store + `daily_append` capture (the moat). Add, to pull ahead of local obsidian-mcp:
**4a. Link graph** — resolve `[[wikilinks]]`, list backlinks, follow the graph.
**4b. Frontmatter-as-query** — list/filter notes by frontmatter field, not just folder/path.
**4c. Tag index** — `#tag` enumeration + search.

**Gate 4:** backlinks for a known note resolve; a frontmatter field query returns the expected set; tag index enumerates.

---

## Phase 5 — Todoist repositioning (don't reinvent 50 tools)

Reposition `sux:todoist` as a **batch/pipeline primitive** for `pipe`/`batch` (array-in bulk ops, NL due-date/recurrence parse), and defer interactive task management to the official Todoist MCP. Do not cross-sync with Phase-3 VTODO tasks unless explicitly asked (Fastmail-native calendar tasks vs Todoist are deliberately distinct).

**Gate 5:** `sux:todoist` bulk-create/complete over an array works inside a `pipe`; NL due date ("every weekday 9am") parses.

---

## Execution notes

- Phases 1, 4, 5 need no new credentials — start there in parallel with the Phase-0 primitives.
- Phase 2 blocks on the token reissue; Phase 3 blocks on the app-password secret. Stub the verbs and their tests now; flip them on when the creds land.
- After each write verb, wire it through stage-then-commit before writing its live test.
- Live gates use the throwaway-and-cancel/delete pattern throughout: never leave test artifacts, never touch a real third party (no real invitees, no real sends).
