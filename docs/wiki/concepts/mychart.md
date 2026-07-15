---
title: MyChart / Epic FHIR + Apple Health
status: shipped
cluster: namespaces
type: concept
summary: "Shipped (PR #31 + #342 + #382) — pulls health data via two pipes: clinical records over Epic SMART-on-FHIR + Apple Watch vitals via Health Auto Export; PHI invariants enforced."
tags: [sux, namespaces, shipped, health]
updated: 2026-07-09
related: ["[[namespace-architecture]]", "[[unblocked-gated-law]]", "[[vault-stack]]", "[[Namespaces-MOC]]"]
---

# MyChart / Epic FHIR + Apple Health

**Source:** originally proposed in PR #31 (`docs/proposals/archive/mychart.md`);
shipped via `claude/mychart-build` (PR #342, PR #382). This note is the wiki's
stub; the full proposal (now historical) lives in the archived doc.

Pulls personal health data into sux through **two data planes, two pipes**:

1. **Clinical records → Epic SMART on FHIR** (Worker ↔ Epic directly, skipping
   Apple). A free patient-audience app at fhir.epic.com; **USCDI-read-only
   scopes preserve Automatic Client-ID Distribution** (syncs to ~all Epic orgs
   in ~48h). Catch: `offline_access` refresh tokens need a confidential client +
   per-health-system secret. App registration is **immutable once production**.
   Token mint mirrors [[vault-stack|`dropbox.ts`]], kept warm by the
   `maintenanceTick()` cron like Kroger; refresh token in KV, not a wrangler
   secret. New pre-gate routes `/mychart/connect` + `/mychart/callback`, new
   `mychart` fn (`status|connect|pull|get`).
2. **Apple Watch fitness/vitals → Health Auto Export** POSTing JSON to a
   bearer-gated `/apple-health` route → private R2. (HealthKit has no cloud API;
   this is the only schedulable pipe. Native HKClinicalRecord kept as a Phase-3
   fallback.)

**Durable rule worth surfacing — PHI invariants:** no health blobs to Dropbox or
`/s/<uuid>` links; no generic KV result-caching of PHI; values never logged.
Self-imposed hygiene (patient right-of-access ≠ HIPAA-covered). This tightens the
[[unblocked-gated-law]] for a new, more sensitive data class.

**Shipped:** Epic SMART-on-FHIR + Apple Health ingest routes are live
(`sux/src/fns/mychart.ts` + tests), including the byte-cap hardening fix (#382).
