---
title: Person-name extraction — design (for #1204)
status: designed — not yet implemented
cluster: entities / ingest
type: design
summary: "entities.ts is pure regex NER (dates/money/emails/URLs/phones/handles) with no person-name capability. #1204's 'contemporaneous-fact extraction on ingest' needs the who-half. This is the approach to build against, not a claim it's built."
tags: [sux, entities, ingest, ai]
updated: 2026-07-22
related: ["[[improvement-backlog]]"]
---

# Person-name extraction — design

Filed against #1222 (audit finding: `entities.ts`'s `entities` fn has zero
person-name NER — every matcher is a hand-written regex over dates, money,
percentages, emails, URLs, phones, @handles, #hashtags. None of those touch
free-text names). This doc is the design #1204 ("W2 contemporaneous-fact
extraction on ingest") should build against; it does not itself implement
extraction.

## Why regex can't do this

Every other `entities.ts` matcher works because the target has a rigid lexical
shape (an ISO date, a `$`-prefixed number, an `@`-prefixed handle). A person
name has no such shape — "Colin", "Dr. Summers", "J.P. Morgan" (person or
company?) are indistinguishable from surrounding prose without world knowledge.
This is a real NER problem, not a pattern-matching gap.

## Approach: constrained LLM extraction, self-verified

Use `ai.ts`'s existing `llm(env, system, user, maxTokens, task)` (Workers-AI
text generation, already threaded through `aiGatewayOptions`/`guardInstruction`/
`wrapUntrusted` — no new binding needed) to extract `{person, action, date,
quote_span}` tuples:

1. **Prompt** the model to return ONLY a JSON array of tuples, each with:
   `person` (the name as written), `action` (short verb phrase, e.g. "called"),
   `date` (ISO if resolvable, else the as-written text), `quote_span` (the
   exact substring of the source text the tuple was drawn from — verbatim, not
   paraphrased).
2. **Parse** the model's text response as JSON (same pattern as `_mail_triage.ts`'s
   `JSON.parse(r.content?.[0]?.text ?? "{}")`-style call sites — wrap in
   try/catch, treat malformed JSON as zero facts rather than throwing).
3. **Self-verify each tuple before trusting it**: confirm `quote_span` is a
   literal substring of the source text (`text.includes(quote_span)`). A tuple
   whose quote span doesn't appear verbatim is a hallucination — drop it, don't
   silently keep it. This is the cheapest and highest-value check: it catches
   the model inventing people/dates that were never in the source.
4. Feed dates found this way back through `entities.ts`'s own date matchers
   where possible (prefer the regex-extracted canonical ISO form over the
   model's date field when both identify the same span) — don't let the LLM
   re-derive what the deterministic matcher already gets right.

## Ambiguity → Inbox, never silent

Per #1204's own requirement: a tuple with an unresolved `person` (a bare first
name matching multiple known people, or no match in any people/ profile) or an
unresolved `date` must not silently attach to a profile. Route it to the Inbox
for human disambiguation instead of guessing — evidence-grade provenance
(legal/medical record quality, per #1204) means a wrong auto-link is worse than
an unresolved one sitting in review.

## What NOT to do

- Don't add person-name matching to `entities.ts`'s regex table — there is no
  regex that distinguishes "Colin met Dave" from "Boston met Chicago" reliably
  enough for evidence-grade provenance.
- Don't skip the quote-span verification step to save a call — it's the one
  check that keeps this fact-extraction pipeline from fabricating "contemporaneous
  facts" that never happened in the source, which is the actual risk #1204 flags.
- Don't build this as a new top-level fn parallel to `entities` — it belongs
  behind #1204's ingest hook, consuming `entities`' existing regex output
  (dates especially) rather than re-deriving it.

## Non-goals (v1)

- No cross-document identity resolution ("is this Colin the same Colin as in
  that other note") — that's `_life_wiki.ts`/`onboard`'s people-profile
  matching, a separate existing capability to call into, not reimplement here.
- No structured-output/JSON-mode binding — Workers-AI's `llm()` here returns
  free text; constrain via prompt + parse + verify, the same pattern already
  used at every other `JSON.parse(llm(...))` call site in this repo (e.g.
  `_infer_nudge.ts`, `_onboard.ts`, `oracle.ts`, `advise.ts`, `voice.ts`,
  `recall.ts`, `_briefing.ts`, `summarize.ts`).
