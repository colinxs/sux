---
title: Health integrations — MyChart (Epic FHIR) + Apple Health (research-backed)
status: reference — build gated, PR-only, PHI edge-private
source: research 2026-07-12 (fhir.epic.com, open.epic.com, healthyapps.dev Health Auto Export)
---

Both are the **most sensitive namespace**. Rules: **PHI edge-private** (parse/filter in the Worker,
never egress raw bundles to a frontier LLM — Workers-AI on-edge for summarize/redact, or an explicit
per-call "fenced" flag); no health values in URLs/logs; **gated fail-closed** (dormant when unconfigured);
OAuth/consent is the **user's** browser action — the agent never handles health credentials.

## MyChart / Epic FHIR (SMART-on-FHIR, patient standalone)
- **Register** free at fhir.epic.com → app audience "Patients", Standalone Launch. Get non-prod
  (sandbox, always-on) + prod client IDs; **one client ID works across all Epic orgs**, but each org
  has its **own FHIR base URL + authorize/token endpoints** (discover per-tenant via
  open.epic.com/MyApps/Endpoints → user picks their hospital → base URL → `.well-known/smart-configuration`).
- **Flow (auth-code + PKCE, public client):** verb generates verifier/challenge(S256)+state → redirect
  browser to tenant `authorize` (`response_type=code`, client_id, redirect_uri=a Worker route, scope,
  `aud=<base>` [must equal base or Epic rejects], state, code_challenge) → **user authenticates in
  MyChart + consents** → callback `?code` → POST token with verifier → access(~1h)+refresh+patient id.
- **Scopes:** `patient/*.read` (or granular) + `openid fhirUser offline_access` (`offline_access` is
  what yields the refresh token). Resources: Patient, Observation (labs/vitals), Condition,
  MedicationRequest, AllergyIntolerance, DiagnosticReport, Immunization, etc.
- **Gating:** dormant unless `{base_url + refresh_token}` stored (encrypted, per-tenant, refresh-token
  only) in the vault namespace. No config ⇒ verb returns "not connected".
- **Minimal build:** verbs `health.connect` (emit authorize URL) → `health.callback` (code→tokens→store)
  → `health.read` (typed resource fetch, edge-filtered to the minimal summary). Mirrors the Dropbox
  user-initiated-OAuth pattern in the digital-life spine.
- Refs: fhir.epic.com/Documentation?docId=oauth2 · open.epic.com/MyApps/Endpoints

## Apple Health (no cloud API — webhook ingest)
- **No Apple web/cloud API** (HealthKit is on-device). Don't parse `export.xml` at the edge — it's
  200MB–1GB+, undocumented, version-drifting; a 128MB Worker footgun.
- **Recommended path: Health Auto Export (healthyapps.dev) → HTTP POST summarized JSON.** First-class
  REST automation: custom auth headers, scheduled / "since last sync", and **"Summarize Data"** daily
  rollups (Min/Avg/Max, not raw samples). (iOS only exports while phone unlocked.)
- **Build:** a bare `POST /health/ingest` route **beside** `/…/mcp` (it's raw POST, not JSON-RPC), gated:
  `X-Sux-Health-Token` timing-safe-compared to `env.HEALTH_INGEST_TOKEN` (missing/empty ⇒ 401 fail-closed);
  body-size cap (~5MB → 413, forces "Summarize"+"Batch"); upsert daily rollups to KV
  `kv:health:<metric>:<yyyy-mm-dd>` (reuse `kv_put.ts` idiom) and/or a dated vault note (`ingest.ts` idiom).
  Store rollups only, never raw samples.
- Refs: help.healthyapps.dev/en/health-auto-export/automations/rest-api/

**Both → PR, never auto-deploy.** Feeds the proactive-nudge design (health signals → "consider discussing
with a clinician", never a diagnosis).
