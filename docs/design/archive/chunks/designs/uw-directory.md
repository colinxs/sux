---
title: uw person-lookup fn — buildable path
status: reference — build gated, PR
source: research 2026-07-12 (verified live against ws.admin.washington.edu + directory.uw.edu)
---

Prior "blocked-on-cert" was true only for **direct PWS**. The **directory.uw.edu scrape is the
unblocked ship-today path** — and it's literally the public face of PWS (holds the cert server-side).

**Default mode (works today, no secret): scrape directory.uw.edu.** Server-rendered classic form:
`GET /` sets a short-lived `edu.uw.directory.session` cookie → `POST /` multipart with `query` +
`method` ∈ {name, department, email, box, phone} + `length` ∈ {summary, full} → parse rows.
Faculty/**staff only, no auth**; **students require SAML login** (the FERPA gate — return "sign-in
required", never try to defeat it). robots.txt = 404 (none); only `noarchive`. Each row's "More Info"
`person_href` = base64 of `/identity/v2/person/{REGID}/full.json` → follow for full detail.
Return `{ displayName, netid, email, title, department, boxNumber, phone, category, regid? }`.
Input routing: name→`name`; email/NetID→`email` (NetID = `{netid}@uw.edu`).

**Optional PWS tier gated behind `UW_PWS_CERT`:** mutual-TLS fetch to PWS `/identity/v2/person/...`
for the richer/student-inclusive record. On CF Workers this needs an `mtls_certificate` binding, so
"cert set" = the binding exists. **Fail-closed = scrape-only when absent**, never erroring.

**Privacy/ToS (RCW 42.56):** non-commercial, **single online look-up only** — no bulk/mass-scrape,
no cache-and-redistribute, no auth use. FERPA-safe by construction (students login-gated; suppressed
people simply don't appear — honor it). Set an identifying User-Agent + light rate-limit; on-demand
single lookups only.

**Lane: feature → PR.** Ship the scrape path; PWS mTLS is a clean later enhancement.
Refs: webservices.washington.edu/pws/ · directory.uw.edu
