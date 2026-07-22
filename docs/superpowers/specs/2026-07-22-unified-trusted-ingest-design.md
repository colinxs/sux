# Unified trusted ingest — read like a person

**Date:** 2026-07-22 · **Issue:** sux#1392 · **Status:** approved design, pre-plan

## North star

Do what the user does when reading anything: **pick trusted things to read, read
skeptically, take meaningful notes.** Trust comes from who chose the material, skepticism
is applied per-segment during distillation, and the stored artifact is notes — a
compression of the substance, never a copy of the noise.

## Problem (sux#1392)

`oracle learn` silently truncates URL fetches at `FETCH_CAP = 40_000` bytes
(`oracle.ts:55`), slices distill input to 24k, and reports success — 8 Project Gutenberg
books ingested as front matter only, each `chunk_count: 1`. Meanwhile `study.ts` already
has paragraph-aligned segmentation (`SEGMENT_CHARS = 18_000`, `MAX_SEGMENTS = 8`) and a
loud-on-oversize byte loader. Two sibling ingest paths with opposite truncation
philosophies; callers route by tool name and get silently corrupted when they guess wrong.

## Design decisions (settled during brainstorm)

1. **One ingest pipeline, not two.** `study` is the surviving surface; `learn` becomes a
   thin wire-compat alias onto it. Size is never again a routing concern.
2. **Trust is a property of the channel, not the tool.** Interactive, user-initiated
   calls → material is whitelisted/owned by default (ranked above model knowledge, cited
   `[whitelisted:topic]`), no ceremony. Autonomous pipelines (Dropbox sweep, watch
   triggers, future `acquire`) ingest through the identical pipeline but are
   provenance-marked with their initiator; their whitelisting follows that pipeline's own
   existing gate. Autonomy can never silently launder content into "user-owned."
3. **Skeptical reading is a quality gate riding the distill pass** (spam-filter
   architecture, near-zero marginal cost — see below).
4. **Noise removal is a universal distill objective**, not source-specific
   pattern-matching: "extract the substance, drop apparatus" (front matter, license
   boilerplate, nav chrome, filler, ad copy). No Gutenberg special case.
5. **Loud failure everywhere.** Silent truncation is the defect class being eliminated.

## Pipeline

```
fetch (loud caps) → segment → distill + denoise + score → quarantine gate → whitelist/provenance → index
```

### Fetch
- Byte ceiling enforced by the streaming reader; exceeding it is a **hard error naming
  the ceiling**, never a clip. `fetchText`'s silent-truncate behavior is removed or made
  to report cap-hit to its caller, which must surface it.
- Receipts carry `bytes_fetched` and `near_cap: true` when within 10% of the ceiling.

### Segment
- `segments()` hoisted out of `study.ts` into a shared helper (hoist-don't-duplicate,
  same as claude-config `_hookutil` precedent). Paragraph-aligned, ~18k chars each.
- `MAX_SEGMENTS` becomes proportional to document size (a ~500k-char book ⇒ ~28
  segments) with a sane absolute ceiling; the final segment never silently sweeps an
  unbounded remainder — if the ceiling truncates coverage, the receipt says so.

### Distill + denoise + score (one model call per segment)
The per-segment distill call's structured output gains:
- `note` — the meaningful notes: substance only, apparatus dropped.
- `quality: 0–1` — substance density of the segment.
- `flags: []` — from a small fixed vocabulary: `promotional`, `incoherent`,
  `unsupported-claim`, `contradicts-established`, `boilerplate`.
Scoring rides the pass that must happen anyway; no second sweep, no verifier fleet.

### Quarantine gate (spam-filter semantics)
- Segments below a static quality threshold are **quarantined: excluded from the served
  KB, kept in storage, itemized in the receipt** with their flags. Never deleted, never
  silently dropped (advisory-skip doctrine, per .github#629).
- `force_include` override re-admits a quarantined segment.
- Empty-after-denoise ⇒ error, never a silent empty chunk.

### Verify (opt-in tier 2 — "even good textbooks can be wrong")
- `verify: true` extracts each kept segment's load-bearing factual claims and checks them
  via `consensus` (evidence-grade literature), `web_search` fallback.
- Contested claims are **annotated, not removed**: `[disputed: …]` in the KB; the answer
  layer cites the dispute.
- Off by default (N external calls per document); intended for medical / technical /
  decision-grade material.

### Receipt (honesty contract)
Every ingest returns: source, `bytes_fetched`, `near_cap`, segment count, per-segment
quality summary, quarantine list with reasons, coverage statement (full / truncated-at-N),
whitelist/provenance label, and (if verify ran) the disputed-claim list. The receipt is
the "what I skipped and why" a careful reader knows implicitly.

## Trust & security invariants

- The `[whitelisted:topic]` rank-boost remains reachable **only** via user-initiated
  ingest or an autonomous pipeline's explicit existing gate — never from content
  properties. (Guarded-distill treatment of untrusted text during processing is
  unchanged; see `ai.ts` whitelist-tag rationale.)
- Quarantine and verify never mutate source material; the pipeline stays reversible.

## Explicitly deferred (YAGNI, revisit on evidence)

- **Learning threshold:** feeding `force_include`/quarantine overrides back into the
  quality threshold (proposals-kernel-style learned weights). Build when override
  frequency shows miscalibration is real.
- **Segmented/ranged multi-part fetch** for sources beyond the hard byte ceiling (>2MB).
- **Auto-verify triggering** by topic detection (e.g. medical) rather than explicit flag.

## Testing

- **Fixture corpus:** the 8 Gutenberg books from the 2026-07-22 feedback session. Assert:
  substance from body chapters (not front matter) present in segments; receipt reports
  full coverage; front-matter/license segments score low or denoise away.
- **Noisy-article case:** a page with few good paragraphs among filler — good paragraphs
  survive, filler quarantines with flags.
- **Loud-failure cases:** oversize source ⇒ named-ceiling error; empty-after-denoise ⇒
  error; `learn` alias behaves byte-identically to `study`.
- **Trust cases:** autonomous-initiator ingest carries provenance and does not
  self-whitelist; interactive ingest does.

## Out of scope

- The `acquire` composite op (sux#1394) — it will *call* this pipeline.
- Blob-integrity bugs (sux#1380, sux#1397) — separate store/retrieve path.
- KB answer-layer ranking changes beyond the disputed-claim annotation.
