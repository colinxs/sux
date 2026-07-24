# Prompt-engineering standard

How prompts are written, optimized, cached, and gated in sux. Living reference —
update by PR, don't re-derive from memory.

**Status:** foundation landed (doctrine + typed contract + conformance gate + 3
migrated exemplars). The exhaustive migration, per-prompt eval fixtures, the DSPy
optimize harness, and the all-prompt regression gate are dispatched to the
`SuxOS/.github` pipeline — see [§9](#9-whats-dispatched).

Grounded in Anthropic's
[Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices).
That page is the source for prompt *structure*. It is **not** the optimizer for
every prompt here — see [§2](#2-the-rule-that-dominates-writer-matches-runner).

## 1. Scope

Every prompt the sux worker sends to a model. Three surfaces, different economics:

| Surface | Runner | Where it lives | Cost model |
|---|---|---|---|
| Internal `llm()` call sites (~75, ~28 files) | Workers-AI `llama-3.2-3b` (OpenAI fallback) | `*_SYSTEM` constants / inline strings → migrating into `prompts.ts` | metered API; **no prefix token cache** |
| The MCP tool-list + skill prompts | the CLIENT (Claude Code / connector) | `skill-prompt.ts`, `Fn.description`s served on `tools/list` | the client's Anthropic **prompt cache** pays here |
| CI/pipeline prompts | Claude via `claude-code-action` | `SuxOS/.github` reusable workflows | seat, not per-token; 1h cache available |

The distinction matters because "token pin" (prompt caching) behaves differently on
each — see [§5](#5-token-discipline-token-pin).

## 2. The rule that dominates: writer matches runner

**A prompt tuned by model X runs best on model X.** Each model optimizes for its own
quirks. The final runner decides who may write and optimize the prompt.

Consequence, and it cuts against the obvious move: **the internal `llm()` prompts run
on llama, not Claude.** So Anthropic's best-practices page (and the Console improver)
are the right source for a prompt's *skeleton* — XML fences, explicit output format,
few-shot shape — but the **wrong optimizer** for those specific prompts' wording.
Optimize a llama-targeted prompt against llama (DSPy on the real runner, [§7](#7-how-to-write-or-optimize-a-prompt-here)), never by asking Claude to "make it better."

- Internal `llm()` prompt → runner is **llama** → optimize on llama.
- Subagent / CI / cross-vendor-verify prompt → runner is **Claude/GPT** → the vendor's
  own console/improver is correct.

See `docs/reference/model-and-tool-selection.md` rule 2 and the
`feedback-meta-prompting-optimize-prompts-with-tools` memory.

## 3. The best-practices checklist (structure source)

From the Anthropic page, as a lens to hold every prompt against. Structure is
model-agnostic; apply it to llama and Claude prompts alike.

- **Be clear and direct.** Specific desired output + explicit constraints. If you want
  "above and beyond," say so — don't rely on inference.
- **Add context/motivation.** Explaining *why* a rule exists ("output is read by TTS, so
  no ellipses") outperforms the bare rule.
- **Examples (multishot).** 3–5, wrapped in `<example>`/`<examples>` tags. Relevant,
  diverse (cover edge cases), structured. The single most reliable format-steering lever.
- **XML tags.** Wrap each content type (`<instructions>`, `<context>`, `<input>`) in its
  own tag. sux already does this at the trust boundary — see [§4](#4-the-injection-fence-is-structural).
- **Role / system prompt.** One sentence of role focuses tone and behavior. The `system`
  arg is the trusted channel.
- **Long-context ordering.** Put longform data at the TOP, query/instructions at the
  bottom (up to +30% on multi-doc tasks). Ground answers in quotes first for long docs.
- **Output formatting.** Say what TO do, not what not to do ("write flowing prose"
  beats "no markdown"). Use XML format indicators. Match prompt style to desired output.
- **Structured outputs over prefill.** Prefill on the last assistant turn is removed on
  current Claude models — use Structured Outputs / a tool with an enum for classification,
  or ask for the schema directly. (llama has neither; constrain in the instruction + parse
  defensively — the classifier exemplar replies "exactly one word".)
- **Tool use is explicit.** "Change this function" (acts) beats "can you suggest changes"
  (only suggests). Don't over-prompt: "CRITICAL: you MUST" over-triggers current models —
  plain "Use this tool when…" is enough.
- **Thinking / effort.** `budget_tokens` is gone; use `effort` + adaptive thinking.
  Prefer general "think thoroughly" over hand-written step lists. Ask the model to
  self-check against criteria before finishing.
- **Minimize hallucination / over-engineering.** "Never speculate about code you haven't
  opened"; "only make changes directly requested." Relevant to CI/subagent prompts.

## 4. The injection fence is structural

`ai.ts`'s `buildMessages(system, user, task)` is the one chokepoint every `llm()` call
routes through. It puts the trusted instruction in the `system` role, appends
`guardInstruction(task)`, and wraps the untrusted `user` content between `<<<DATA>>>`
markers (`DATA_OPEN`/`DATA_CLOSE`), defusing any embedded marker with a zero-width space.

Two rules fall out, both enforced by the conformance test ([§6](#6-the-typed-contract)):

1. **A prompt's `system` text must never contain the fence markers** — it would collide
   with the guard and let untrusted content break out.
2. **The untrusted material always goes in `user`, never concatenated into `system`.**
   A cross-vendor call is not a trust-laundering step; fence both providers identically.

## 5. Token discipline ("token pin")

"Pinning tokens" means keeping a cacheable prefix byte-stable so the cache pays off.
It applies to exactly one of our three surfaces:

- **Client-facing (tools/list + skill prompts):** the client (Claude Code) caches the
  `tools` → `system` prefix. Any byte change anywhere in the prefix voids everything
  after it. So: keep the tool list and skill prompt **stable and deterministic** (sorted,
  no timestamps, no per-session IDs), and keep them **short** — the dispatched
  descShort/descLong split (spec §5.1) trims ~2.5k tokens off every cold session. This is
  the surface where "token pin" is real and Anthropic's caching rules
  (`docs/knowledge/llm-models-cost-and-caching.md`) apply.
- **Internal `llm()` (llama):** Workers-AI has **no** Anthropic-style `cache_control`
  prefix cache. Do not add `cache_control` to a llama call — it does nothing. The levers
  here are (a) **AI Gateway response caching** (`aiGatewayOptions`, dormant until
  `AI_GATEWAY_ID` is set — exact-match on the whole request, so a stable system prompt +
  identical input is a free repeat), and (b) **lean prompts** (fewer input tokens per
  call). A prompt under active optimization is `fluid` and doesn't benefit from either;
  a frozen `crystallized` prompt does.

### The lifecycle that reconciles pinning and optimization

Caching wants a frozen prefix; meta-prompting wants iteration. A prompt can't be both at
once, so each `PromptRecord` carries a **state**:

- **`fluid`** — under optimization, wording changes between runs, cache-cold. Cheap
  runner, low stakes.
- **`crystallized`** — passed its eval gate, frozen, eligible to be cache-pinned and to
  route through the AI Gateway response cache.

A prompt moves `fluid → crystallized` only by beating its incumbent on its eval fixtures
([§7](#7-how-to-write-or-optimize-a-prompt-here)). That single flag is what lets caching
and optimization coexist instead of fighting.

## 6. The typed contract

`sux/src/prompts.ts` is the one home for every internal prompt. Each is a `PromptRecord`:

```ts
{
  id,          // stable dotted "<fn>.<role>" — the eval-fixture key and cache namespace
  runner,      // who RUNS it → who may optimize it (writer-matches-runner)
  system,      // trusted instruction; buildMessages() appends the fence guard
  task,        // short label, rides in guardInstruction()
  maxTokens,   // output ceiling → llm()'s maxTokens
  difficulty,  // trivial | standard | hard — routing + optimizer effort
  metric,      // how a rewrite is scored → the fixture's metric (§8)
  state,       // fluid | crystallized (§5)
  evalRef?,    // path to the fixture set (dispatched work wires these)
  note?,       // one-line human description
}
```

The conformance test (`prompts.test.ts`) is the lint gate: unique dotted ids, non-empty
trimmed `system`/`task`, positive `maxTokens`, valid enums, and — the load-bearing one —
**no `system` contains the `<<<DATA>>>`/`<<</DATA>>>` fence markers** ([§4](#4-the-injection-fence-is-structural)).

**Dynamic prompts** (e.g. `oracle.ts`'s `answerSystem(topic, distilled)`) build their
`system` from runtime values. They keep a static `base` record here for the frozen
skeleton and compose the volatile part at the call site; the migration decides this per
prompt. The three landed exemplars are all static.

## 7. How to write or optimize a prompt here

1. **Cold start:** describe the task to the **Anthropic Console prompt generator** (writes
   a full prompt) — but only for a Claude/GPT runner. For llama, draft the skeleton from
   [§3](#3-the-best-practices-checklist-structure-source) and optimize against llama.
2. **Improve an existing prompt:** the **Console prompt improver** for a Claude runner;
   **DSPy (MIPROv2)** against the real runner where there's an eval set — this is the
   correct tool for the llama prompts, because it measures on llama. Build the fixture set
   first if it's missing; a handful of input/expected pairs beats an unmeasured rewrite.
3. **Right-size the rewrite itself:** never Opus. **Haiku 4.5** when the target is
   Claude/agnostic; **Gemini Flash** when the target is Gemini or the volume is high. The
   rewrite is not a peak-reasoning task; prompt quality compounds over thousands of runs,
   so a cheap one-time pass has an outsized return.
4. **Gate it:** the rewrite merges only if it beats the incumbent on the fixtures. On a
   pass, flip `state` to `crystallized`.

## 8. Metric taxonomy (for the eval harness)

A prompt's `metric` picks how a candidate is scored — so we don't hand-invent one per
prompt. The three landed exemplars anchor the three families:

| `metric` | Scored by | Exemplar |
|---|---|---|
| `exact` / `label` | deterministic string / label match (F1 for multi-class) | `mail_triage.spam` — one word, SPAM vs NOT_SPAM |
| `faithfulness` | does the output preserve the source's key facts (claim overlap; LLM-judge on the runner's family) | `oracle.distill` — condensed notes |
| `format` / `judge` | format-conformance + constraint checks (LLM-judge rubric) | `infer_nudge.phrasing` — one sentence, no invented facts, no diagnosis named |

Deterministic metrics first (Cardinal #2: a set/exact predicate beats an LLM judge when
it decides the case). Reserve the judge for genuinely open outputs.

## 9. What's dispatched

The design-bearing foundation is here; the mechanical + infrastructure remainder is filed
to the `SuxOS/.github` build pipeline:

- Migrate the remaining internal `llm()` sites into `prompts.ts` (mechanical sweep,
  conforms to the pattern the 3 exemplars set).
- Per-prompt eval fixtures + metrics ([§8](#8-metric-taxonomy-for-the-eval-harness)).
- A DSPy optimize harness that tunes each prompt against its real runner.
- An all-prompt regression gate: no prompt merges unless it beats the incumbent on its
  fixtures; a pass flips `state` to `crystallized`.
- The `descShort`/`descLong` token cut on the client-facing surface (spec §5.1).
- Arm AI Gateway response caching (`AI_GATEWAY_ID`) and measure the win.

Full design: `docs/design/2026-07-23-cross-vendor-token-optimization-spec.md`.
