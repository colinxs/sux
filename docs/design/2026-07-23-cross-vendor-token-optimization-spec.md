# Cross-Vendor AI & Token-Optimization Spec

Status: draft / scoping · Date: 2026-07-23 · Scope: `sux` worker + `../suxlib` + `SuxOS/.github` CI

## 0. Purpose & framing

Three goals, one hard constraint:

1. **Token minimization** — cut what the MCP client pays per session and per call.
2. **Prompt engineering** — make the ~21 internal LLM prompts leaner, consistent, and centrally reasoned-about.
3. **Cross-vendor / adversarial AI** — use a decorrelated second vendor (OpenAI / Gemini) for verification, second-opinion synthesis, and long-context offload, both at runtime and in the dev pipeline.

**Hard constraint (the "gate"):** the vault holds real health, legal, and financial records. Any call to a third-party model is *data egress to another processor*. Nothing cross-vendor ships without a sensitivity gate that provably prevents unconsented personal-data egress. This gate is **Phase 0** — a prerequisite of every cross-vendor feature — and it also retroactively covers an egress point that **already exists un-audited today** (see §1.3).

### Non-goals
- Not replacing Workers-AI as the primary/default processor.
- Not making cross-vendor calls the default for anything — every one is opt-in and gated.
- Not a full DLP product; the redaction pre-pass is defense-in-depth, not the primary control (consent + provenance are).

## 1. Where this hooks in (the existing chokepoints)

Everything below hangs off three existing seams, so the blast radius is small:

1. **`tools/call` boundary** — `sux/src/index.ts` `handleRpc` (fresh/summarize/clamp already live here).
2. **The `llm()` chokepoint** — `sux/src/ai.ts:120`. All 21 text call sites route through it. Today: Workers-AI (`llama-3.2-3b`) → OpenAI (`gpt-5-mini`) **failover only**.
3. **The CI pipeline** — `SuxOS/.github` reusable workflows (`security-review.yml`, `claude*.yml`, `issue-build.yml`), 100% Anthropic via `claude-code-action`.

### 1.3 Existing un-gated egress (the motivating bug)
`_ocr.ts` sends bytes to **Mistral** (`https://api.mistral.ai/v1/ocr`, `mistral-ocr-latest`) with **no sensitivity gate today**. Callers: `study`, `_assimilate`, `_document_radar`, `_scan_ingest`, and the op-engine `markdownFromPdf` leaf (`op-engine/caps.ts`). Those are precisely the scanned-document paths — health PDFs, legal scans. **This spec's gate must retroactively wrap OCR**, not just future OpenAI/Gemini calls. Treat closing this as the Phase-0 acceptance test: "a health PDF cannot reach Mistral OCR without a logged consent grant."

---

## 2. Phase 0 — The sensitivity / egress gate

The foundation. Default-deny, provenance-driven, consent-gated, audited.

### 2.1 Sensitivity classes
Four classes, coarsest sufficient:

| Class | Examples | Third-party LLM? |
|---|---|---|
| `secret` | credentials, tokens, keys, `commit_token`s | **Never any LLM** — redact/strip first |
| `personal` | vault / mail / files / calendar / contacts content, PHI, legal, financial | Only with explicit, logged, per-scope consent |
| `internal` | sux operational data, tool metadata, non-PII logs | First-party default; third-party on org opt-in |
| `public` | public web content (`scrape`/`search`/`crawl`), synthetic examples | Free to route anywhere |

### 2.2 How a call's class is decided (provenance, not scanning)
Precedence, highest wins:

1. **Per-fn declared floor.** New optional field on the `Fn` type: `sensitivity?: Sensitivity` (default `internal`). `vault`/`mail`/`files`/`calendar`/`contact`/`recall`/`oracle`/`study`/`mychart` → `personal`; `scrape`/`search`/`crawl`/`web_search`/`wayback` → `public`; `kv_*`/`store` → `internal`.
2. **Provenance inheritance.** Content threaded through `pipe`/`batch`/`run` carries the max class of its sources — a `pipe` that reads `vault` then hands text to a third-party summarize is `personal` even though the summarize fn itself isn't.
3. **Explicit override** on the call (`sensitivity:"public"`) — allowed only to *raise*, never to lower below the fn floor (a caller can't declare vault content public).

Provenance rides the already-existing per-request `_egress` context (`RtEnv._egress`, `proxy.ts`) — add a `sensitivity` field alongside `login`/`reqId`.

### 2.3 The gate decision
Single pure function (testable, `sux.decisions`-style):

```ts
type Vendor = "workers-ai" | "openai" | "gemini" | "mistral-ocr";
type Decision = { allow: true; redact: boolean } | { allow: false; reason: string };

function gateEgress(v: Vendor, cls: Sensitivity, consent: ConsentGrant | null): Decision
```

- `workers-ai` (first-party primary) → allow all classes except `secret` (redact `secret`-tainted).
- third-party (`openai`/`gemini`/`mistral-ocr`) + `public`/`internal` → allow (redact defensively).
- third-party + `personal` → allow **iff** a matching non-expired `ConsentGrant` exists; else deny with an actionable reason.
- any vendor + `secret` → deny (must be redacted to a lower class first).

**Default-deny is the invariant** — an unclassified/unknown combination denies. A fuzz test asserts no input yields an un-redacted `personal→third-party` allow without consent.

### 2.4 Consent model
Extend the existing `preferences` fn with a `vendor_consent` scope rather than a new fn.

- Grant storage (KV): `consent:vendor:{login}:{vendor}:{scope}` → `{grantedAt, ttl, scope, note}`. Keyed off `_egress.login` (the only per-connection identity in this stateless transport).
- **Default deny; opt-in; TTL'd; revocable.** Scopes are coarse: `personal:ocr`, `personal:verify`, `personal:synthesis`.
- **Interactive consent via a `run` ask-gate.** When a `personal→third-party` call is attempted without a grant, the durable path can pause on an `ask` gate ("Send this vault content to Gemini for a second opinion? [grant once / grant 24h / deny]"). Inline (non-durable) path just denies with the reason string — never silently proceeds.

### 2.5 Redaction pre-pass (defense in depth)
Before *any* third-party call on `personal`/consented content, run the existing deterministic `redactText` (`redact.ts`, regex — SSN/DOB/account#/email/phone). Applied even with consent. Cheap, no LLM. Note it's imperfect (that's why consent, not redaction, is the primary control).

### 2.6 Egress audit (never the content)
Every third-party call emits a Loki egress-audit line via the existing `_egress.reqId` plumbing: `{reqId, login, vendor, class, consentGrantId|null, bytesOut, redacted:bool, fn}`. **Content is never logged.** This is what makes "zero unconsented personal egress" audit-provable — the success metric in §11.

### 2.7 Enforcement chokepoint: Cloudflare AI Gateway
Use the **dormant `AI_GATEWAY_ID`** (`ai.ts:9`, `registry.ts:633`) as the single physical egress point for all third-party LLM traffic. Routing OpenAI/Gemini through AI Gateway gives one place for logging, caching, rate-limiting, and cost metering, and keeps the gate decision and the network egress co-located. Arming it is part of Phase 0.

---

## 3. Vendor router (evolving `llm()`)

Replace the failover-only `llm()` with a router that selects by `(difficulty × sensitivity × availability × consent)`.

```ts
type LlmMode = "single" | "verify" | "offload";
type Difficulty = "trivial" | "standard" | "hard";
interface LlmOpts {
  maxTokens?: number;
  task?: string;            // already exists
  difficulty?: Difficulty;  // per call-site tag
  mode?: LlmMode;           // single (default) | verify | offload
  sensitivity?: Sensitivity;// from provenance; router calls gateEgress()
}
llm(env, system, user, opts?): Promise<LlmResult>
```

**Model tiers:**
- `tiny` — `llama-3.2-3b` (current default). All classes, first-party, cheap. `trivial`/`standard` personal work stays here.
- `strong-firstparty` — a larger Workers-AI model for `hard` `personal` synthesis that must **not** leave first-party (recall/advise/oracle-answer).
- `thirdparty-strong` — OpenAI / Gemini. Only reachable for `public`/`internal`, or `personal` **with consent**, and only for `verify`/`offload` modes.

**Difficulty tagging:** the 21 call sites already pass a `task` string; add a `difficulty` per site (e.g. `_mail_triage.ts:302` spam verdict = `trivial`; `recall.ts:620` = `hard`). Routing policy is a config table, not hardcoded per site — one place to tune.

Backward-compat: `mode:"single"`, `difficulty:"standard"`, no consent → byte-identical to today's Workers-AI→OpenAI failover.

---

## 4. Cross-vendor verify / adversarial

### 4.1 Runtime `verify:true`
Opt-in flag on high-stakes synthesis fns (`oracle` answer/`ask`, `recall`, `advise`, `_answer`). Runs the same prompt through the decorrelated vendor (gated + redacted), then **compares by claim, not by string**:
- Extract atomic claims from both answers (cheap structured pass), check for direct contradiction on facts/numbers/citations.
- **Agree** → return, optionally note "cross-checked". **Contradict** → attach a caveat + flag for human; never silently pick a winner.
- Both verdicts cached (namespaced key, like `::summarize`). Cost/latency paid only when the caller opts in.

### 4.2 Dev/CI adversarial review stage
New stage (in `security-review.yml` or a sibling reusable workflow): Claude's findings → a second vendor prompted to **refute** each, structured verdict via the existing `--json-schema` path.
- **Both flag** → high confidence. **One flags** → triage. **Conflict** → human.
- **Egress note:** private-repo code to a third-party model is itself an egress decision — gate it at the **org level** (a repo/org opt-in secret + flag), not per-PR. Public-code repos can enable freely; private ones require deliberate opt-in.

### 4.3 `security-review` resilience tier
Today `security-review` fails **closed** (`hold` label) when the shared Anthropic subscription pool exhausts (documented jam risk). Add a **second-vendor backstop tier**: when the Anthropic pool is exhausted, degrade to a third-party reviewer, labeling the PR `reviewed-by-fallback-vendor` so humans know the verdict's provenance. Turns an accepted-risk jam into a graceful degrade.

---

## 5. Token-optimization surface changes (no vendor dependency, no egress)

### 5.1 Terse descriptions + `help` (A1)
Split each `Fn.description` into `descShort` (≤1 line, for `tools/list`) and `descLong` (full prose). `tools/list` serves `short`; `sux({verb})` / `/llms.txt` serve `long`.
- Target the 5 heaviest front verbs first — `oracle` (2,975 ch), `ingest` (2,524), `mail` (1,667), `recall` (1,526), `run` (1,438) — ~10k chars / ~2.5k tokens off every cold session.

### 5.2 Default `declutter→summarize` on heavy web fns (A3)
New `heavyOutput` fn flag → `scrape`/`crawl`/`render`/`batch_fetch` default to decluttered+summarized returns, with `raw:true` escape. Cuts the highest-token-volume path in the system.

### 5.3 Structured returns (A4)
Where fns return prose the model parses, emit compact JSON / `pack`-ed TSV. Fewer tokens, less parse ambiguity.

### 5.4 SKILL-prompt compression (A2)
Compress `skill-prompt.ts` (~30 KB, served on `prompts/get`). Pure token win if behavior-preserving.

---

## 6. Prompt consolidation (B3)
Move the 21 inline `*_SYSTEM` constants (across 17 files) into one `prompts/` module with a shared output-format contract and one place asserting injection-fence coverage (`buildMessages`). Enables A/B'ing a format change across all sites and centrally reasoning about token shape.

---

## 7. Concrete interfaces (delta)

```ts
// registry.ts — Fn type additions
sensitivity?: Sensitivity;       // default "internal"
descShort?: string;              // tools/list
heavyOutput?: boolean;           // §5.2

// proxy.ts — EgressContext addition
sensitivity: Sensitivity;        // provenance, max over sources

// new: src/gate.ts (pure, sux.decisions-style)
export function gateEgress(v, cls, consent): Decision

// new: consent (via preferences fn)
type ConsentGrant = { grantedAt: number; ttl: number; scope: string };

// registry.ts — RtEnv additions
GEMINI_API_KEY?: string;         // new third-party lane
AI_GATEWAY_ID: armed (was dormant)
// OPENAI_API_KEY, MISTRAL_API_KEY already present
```

---

## 8. Rollout phases

- **Phase 0 — Gate (prerequisite).** `gateEgress` + provenance + consent + audit; retro-wrap Mistral OCR; arm AI Gateway. Acceptance: health PDF cannot reach Mistral without a logged grant; fuzz proves default-deny.
- **Phase 1 — Token quick wins.** A1 (terse desc), A3 (heavy-output default), B1 (difficulty routing, first-party only). No egress, no vendor dep. Ship first for immediate value.
- **Phase 2 — Runtime verify (B2).** `verify:true` behind the gate.
- **Phase 3 — CI adversarial (C1/C2) + resilience tier (4.3).**
- **Phase 4 — Long-context offload (C3).** Gemini as a retrieval-summarization worker for `issue-build`/`gardener` and huge-PDF `study`/`ingest`, gated.

Each phase is independently shippable and gate-passing; Phase 0 blocks 2–4 but not 1.

---

## 9. Risks & open questions
- **Egress even with consent** — redaction is imperfect; consent scopes must stay coarse and legible.
- **Injection amplification** — a poisoned document can manipulate the second vendor too; a cross-vendor call is not a trust-laundering step. Fence both.
- **Non-determinism** — two vendors = two failure-mode sets; verify must degrade gracefully when the second is unavailable (never block the first-party answer).
- **Disagreement policy** — always escalate to human; never auto-resolve.
- **Private-repo code in CI (§4.2)** — org-level opt-in, not silent.
- **Is Workers-AI truly "first-party"?** It's the host (Cloudflare), not Anthropic/OpenAI. Treated as the trusted primary processor here; revisit if that assumption changes.

## 10. CI gates & testing
- Fuzz `gateEgress` — default-deny, no unconsented `personal→third-party` allow.
- Redaction pre-pass unit tests (known PII shapes).
- Router selection table tests (difficulty×sensitivity→tier).
- Verify-mode contract tests with a stubbed second vendor (agreement + contradiction paths).
- Egress-audit line schema test (asserts content is never present).

## 11. Success metrics
- **Tokens/session** (cold `tools/list` + skill prompts) down measurably (target: −2–3k from A1 alone).
- **Internal LLM $** down via difficulty routing (trivial calls off the wire where possible).
- **Verify catch rate** — cross-vendor disagreements that surfaced a real error.
- **Zero unconsented personal egress** — audit-provable from the Loki egress stream (includes the now-gated OCR path).
