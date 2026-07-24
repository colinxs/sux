# Model & tool selection — capability reference

**Status:** living reference. Update by PR; do not re-derive from memory.
**Last updated:** 2026-07-24
**Provenance:** rankings supplied by Colin, not measured here. Treat as a dated snapshot of a fast-moving field — the *shape* of the advice outlives the specific version numbers. The workspace-consequence notes are mine and are verified against this repo.

## Standing context

**Colin holds ChatGPT and Gemini subscriptions in addition to Claude.** So GPT-5.6 and Gemini 3.5 Pro are *available at no marginal cost*, which makes the "use a different family for this job" rows actionable rather than hypothetical. Do not default to Claude for a job the table says Claude loses.

## The two rules that override the tables

1. **For routing, RAG, and OCR the surrounding pipeline matters more than the model.** Chunking, retrieval quality, and the citation contract dominate the model choice. Do not "fix" a bad RAG result by upgrading the model.
2. **For prompt rewriting, the writer model should match the runner model.** A Claude-tuned prompt runs best on Claude, a GPT-tuned one on GPT. See `2026-07-23-tooling-and-language-doctrine.md` and the meta-prompting notes.

## By category

| Category | Ranking (`>` better, `>>` much better) | Best pick |
|---|---|---|
| **Coding / agents** | Claude Fable 5 > Opus 4.8 ≈ GPT-5.6 > DeepSeek V4 Pro >> Gemini 3.5 Pro >> Grok 4.5 >>> Llama 4 | **Fable 5** (80.3% SWE-Bench Pro) |
| **Hard math / science** | GPT-5.6 Sol > Gemini 3.5 Pro ≈ Fable 5 > Grok 4.5 >> Opus 4.8 >>> open | **GPT-5.6 Sol** |
| **Long context** | Llama 4 Scout (10M) > Gemini 3.5 Pro (2M) >>> Claude/GPT (~200K–1M) | **Llama 4 Scout / Gemini** |
| **Writing / prose** | Opus 4.8 > Sonnet 5 > GPT-5.6 >> Gemini 3.5 >>> Grok, open | **Opus 4.8** |
| **Everyday chat** | GPT-5.6 ≈ Sonnet 5 > Gemini 3.5 > Grok 4.5 >> rest | ~parity at top |
| **Cost-efficiency** | DeepSeek V4 Flash > GLM-5.2 > Gemini Flash >> Grok 4.5 >>> flagships | **DeepSeek V4 Flash** |
| **Instruction adherence** | Opus 4.8 ≈ Fable 5 > GPT-5.6 > Gemini 3.5 >> Grok >>> open | **Claude** (most steerable) |
| **Prompt rewriting (meta)** | Opus 4.8 ≈ GPT-5.6 > Fable 5 > Gemini 3.5 >> Grok >>> open | match writer to target |
| → *cheap* prompt rewrite | Haiku 4.5 > Gemini Flash | **Haiku** if target is Claude/agnostic; **Flash** if target is Gemini or high-volume |
| **RAG / grounded cites** | Gemini 3.5 Pro > Opus 4.8 ≈ GPT-5.6 > Sonnet 5 >> Grok >>> open | Claude least-hallucinating; **pipeline matters most** |
| **OCR (LLM)** | Gemini 3.5 > GPT-5.6 > Opus 4.8 >> Grok >>> open VLMs | — |
| **Video gen** | Veo 3.1 ≈ Seedance 2.5 > Kling 3.0 > Runway Gen-4.5 > Luma Ray 3 >>> Sora 2 (retiring) | **Veo 3.1** |
| **Multimodal (omni)** | Gemini 3.5 >>> everything | only unified frontier omni-model |

## Specialized tools that beat general LLMs

| Job | Tools | Pick |
|---|---|---|
| **OCR at scale** | Google Document AI, Azure Document Intelligence, Mistral OCR, dots.ocr | **Mistral OCR** — cheap, simple API |
| **Model routing** | OpenRouter, LiteLLM, RouteLLM, Not Diamond, Martian, Orq.ai | **OpenRouter** (one key, all models); **LiteLLM** for logging + cost caps; **RouteLLM** for auto cost-routing in code; **Not Diamond** for auto best-pick |
| **Prompt optimization** | DSPy (MIPROv2), Anthropic Console improver, OpenAI Playground | **DSPy** for pipelines; **Console improver** for one-offs |
| **RAG orchestration** | LlamaIndex (retrieval), DSPy (pipeline opt) | **LlamaIndex** |
| **Token minimization** | LLMLingua, LongLLMLingua, LLMLingua-2, Selective Context | **LongLLMLingua ≈ LLMLingua** > LLMLingua-2 (faster) > Selective Context |

## What this already implies for this workspace

Verified against the repo, not asserted:

- **The OCR pick is already correct.** `sux/src/fns/_ocr.ts` uses Mistral OCR (`api.mistral.ai/v1/ocr`, `mistral-ocr-latest`) as the single engine, and its header comment records that a former Workers-AI llama-3.2-vision path was deliberately removed. That matches the table's recommendation; no change needed.
- **The routing row is the placement fabric's neighbourhood.** `2026-07-23-placement-fabric-architecture.md` designs a placement selector below a content router. OpenRouter/LiteLLM/RouteLLM are prior art for the *content* half, and LiteLLM's cost-cap + logging is close to what §3's decision ledger wants. Worth reading before building that layer — and note rule 1: the pipeline dominates, so the fabric's value is the pipeline, not the model picks it makes.
- **Token minimization has an open home.** The LLMLingua family belongs against the unfinished output-clamp work (`MAX_OUTPUT_CHARS` 1M → ~40k) rather than being adopted speculatively.
- **`llm()`'s primary path is Workers AI llama-3.2-3b**, with an OpenAI fallback (`ai.ts`). Per the table that is a *cost* choice, not a capability one — appropriate for classification and extraction, not for anything on the coding/math rows. Route accordingly rather than reaching for `llm()` by default.
- **Prompts written here for `llm()` should not be tuned on Claude** (rule 2) — the runner is llama. Prompts for subagents *should* be.

## How to use this

Pick the row, then check rule 1 and rule 2 before acting. When a job spans rows (an agent that also does hard math), split it rather than compromising on one model — that is what the fabric's node/edge split exists to make cheap.
