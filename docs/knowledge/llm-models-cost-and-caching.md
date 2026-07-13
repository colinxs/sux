# LLM models, pricing & caching cheat-sheet (2026)

Durable reference so we stop re-looking this up. Prices are $/MTok (million tokens) unless noted. Sources cited inline; primaries are `platform.claude.com`, `openai.com`.

## Anthropic models

| Model | ID | Context | In / Out $/Mtok | sux ladder use |
|---|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M | $10 / $50 | **crux** — hardest reasoning, long-horizon agentic work, `ultra(x)` |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5 / $25 | **verify/design** — architecture, adversarial review, hard bugs |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $3 / $15 (intro $2/$10 thru 2026-08-31) | **build** — main implementation workhorse |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1 / $5 | **ground/mechanical** — grounding reads, scaffolding, bulk fan-out |

Source: `platform.claude.com/docs/en/pricing`, `platform.claude.com/docs/en/about-claude/models/overview` (Anthropic Claude API skill, cached 2026-06-24).

Notes:
- Opus/Sonnet/Fable all support adaptive thinking (`thinking:{type:"adaptive"}`) and `output_config.effort` (`low`→`max`); `budget_tokens` is removed/400s on all current-gen models — use effort instead.
- Fable 5 requires 30-day data retention (not available under ZDR); always-on thinking; no assistant prefill.
- These match the effort/model ladder in `effort-model-orchestration` memory: haiku=ground, sonnet=build, opus=verify+design, fable=crux.

## OpenAI (comparison / offload)

| Model | Rough $/Mtok in / out | Notes |
|---|---|---|
| GPT-5 (flagship) | ~$5–10 in / ~$15–30 out (tier-dependent) | check `openai.com/api/pricing` for current numbers — shifts more often than Anthropic's |
| GPT-5 mini | ~$0.25–1 in / ~$1–4 out | mid-tier offload |
| GPT-5 nano | ~$0.05–0.15 in / ~$0.30–0.60 out | cheapest tier, mechanical/classification work |

**Subscription seat ≠ API billing.** ChatGPT Plus/Pro is a separate product from the OpenAI API — paying for ChatGPT does not grant API credits and vice versa. Key lever: **use the subscription seat, not the API, when possible**:
- **Codex** (OpenAI's coding agent) runs on the ChatGPT **Plus/Pro seat** — no separate API billing for that usage.
- **Claude Code** runs on the Anthropic **Pro/Max seat** — same pattern, avoids per-token API billing for interactive coding sessions.
- Only fall through to metered API billing (either provider) for programmatic/headless/bot use where there's no seat to lean on (e.g. sux's own Worker calling the Claude API directly).

## Prompt caching

**Anthropic** (`shared/prompt-caching.md` in the claude-api skill):
- Cache **write**: 1.25× base price (5-min TTL) or 2× (1-hour TTL).
- Cache **read**: 0.1× base price.
- Break-even: 5-min TTL pays off at 2 requests; 1-hour TTL needs ≥3 requests (write cost is higher).
- It's a **prefix match** — any byte change anywhere in the prefix invalidates everything after it. Render order: `tools` → `system` → `messages`. Keep stable content (frozen system prompt, deterministic tool list) first; put volatile content (timestamps, per-request IDs) after the last breakpoint.
- Min cacheable prefix ~1024–4096 tokens depending on model (Opus/Haiku 4.5 need 4096; Fable 5/Sonnet 4.6 need 2048; older Sonnet 1024).
- Verify with `usage.cache_read_input_tokens` — zero across repeats means a silent invalidator (unsorted JSON, `datetime.now()` in system prompt, varying tool set).
- Max 4 breakpoints per request.

**claude-code-action (GitHub Action):** `ENABLE_PROMPT_CACHING_1H` env var opts into 1-hour TTL; prompt caching itself is **on by default** in the action.

**OpenAI:** automatic (no explicit cache_control needed) — repeated prefixes across requests are cached server-side; reads run at roughly **0.25×** (a.k.a. "cached input" discount, varies by model — check current pricing page). No write premium like Anthropic's.

## Batch API

- **Anthropic Message Batches**: −50% on both input and output tokens, async, results within ≤24h (usually much faster). Good for non-interactive bulk jobs — sux bot sweeps, bulk classification/labeling, non-blocking backfills.
- **OpenAI Batch API**: same shape, −50% off standard pricing, 24h completion window.
- Rule of thumb: **stack caching + batch** for recurring non-interactive workloads — e.g. a nightly mail-labeling sweep with a stable system prompt gets both the batch 50% off and cache reads on the repeated prefix.

## Free tiers worth using (mechanical offload)

| Provider | Free tier (rough) | When to use |
|---|---|---|
| **Cerebras** | ~1M tokens/day free (Llama/Qwen models on their inference chips) | ultra-fast mechanical batch inference, extraction/classification at volume |
| **Groq** | Free tier w/ rate limits (varies by model) | very-low-latency small-model inference (Llama, Gemma) |
| **Gemini Flash** (free tier via AI Studio) | Free quota, rate-limited (RPM/RPD caps) | quick grounding/classification calls, prototyping |
| **OpenRouter free models** | Several `:free` suffixed models, rate-limited, no cost | trying a model before committing, low-stakes fan-out |
| **DeepSeek** | Not free but very cheap (~$0.28/Mtok in, ~$0.42/Mtok out for V3-class, exact numbers shift) | budget mechanical/bulk work when free tiers are exhausted |

These are best for **ground/mechanical** tier work analogous to Haiku — high volume, low individual-call value, latency-tolerant. Not for anything touching personal-data namespaces (vault/mail/files) without the same trust review as the primary model.

## Cost levers table

| Lever | Discount | When to use |
|---|---|---|
| Prompt caching (Anthropic) | writes 1.25×/2×, reads 0.1× | stable system prompt / tool list reused across ≥2–3 calls in short succession |
| Prompt caching (OpenAI) | reads ~0.25× | automatic — just keep prefixes stable, no code change needed |
| Batch API (either provider) | −50% | non-interactive, latency-tolerant, ≤24h turnaround jobs |
| Batch + caching stacked | −50% and cache reads on top | recurring scheduled jobs with a shared system prompt (best combo) |
| Subscription seat vs API | seat cost is flat/sunk, API is metered | interactive coding sessions — Claude Code (Pro/Max) / Codex (Plus/Pro) instead of raw API billing |
| Model tier down (Opus→Sonnet→Haiku) | ~1.7–5× cheaper per tier step | match model to task difficulty — don't verify with Haiku or ground with Opus |
| Free-tier offload (Cerebras/Groq/Gemini Flash/OpenRouter) | 100% free within quota | bulk mechanical work below cost/quality bar that needs Anthropic-grade judgment |
| Effort parameter (`low`→`max`) | indirectly — fewer/shorter thinking tokens | tune per task; `high` is usually the sweet spot, `low` for subagents/simple tasks |

## sux guidance

- **Model selection follows the existing ladder** (`effort-model-orchestration` memory): Haiku for grounding/mechanical/bulk fan-out subagents, Sonnet for main build work, Opus for verify/design/adversarial review, Fable only for genuine crux problems or explicit `ultra(x)` triggers.
- **Cache the sux system prompts.** Any fn/route with a stable system prompt (recall, mail classification, vault ingest) should have a `cache_control` breakpoint on the frozen instruction block — mail sweeps run repeatedly with the same prompt shape, this is free money left on the table if unset.
- **Batch the sweeps.** Scheduled/cron-style jobs (mail label sweeps, bulk vault reindex, nightly digest generation) are prime Batch API candidates — async, non-interactive, tolerate the ≤24h window, and stack with caching.
- **claude-code-action**: confirm `ENABLE_PROMPT_CACHING_1H` is set for any bot/CI workflow that reuses a large system prompt across many PR-review or fix-round invocations — 1h TTL beats 5min for workflows with gaps between runs (e.g. `/code-review ultra` multi-round loops).
- **Don't reach for OpenAI/free-tier models for anything touching personal-data namespaces** (vault/mail/files) — those stay on Anthropic per the existing trust model; free-tier/offload models are for genuinely disposable mechanical work only (e.g. scraping cleanup, generic text transforms with no PII).
- **Prefer the Claude Code seat over API billing** for interactive dev sessions (this is already how sux work happens) — the Worker's own runtime calls (recall, mail classify, etc.) are necessarily metered API calls since there's no seat to lean on there.
