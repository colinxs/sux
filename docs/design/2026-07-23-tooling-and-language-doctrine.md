# Tooling and language doctrine — stop losing turns to shell glue

**Date:** 2026-07-23
**Status:** proposed
**Supersedes:** nothing. The twelve-agent research that was meant to answer this was lost with its
workflow transcript (see `2026-07-23-placement-fabric-architecture.md` §12). This is written instead
from **direct evidence collected in one working session** — which turns out to be the better source,
because the failures are observed rather than surveyed.

## The question

> "we need better tooling than jq + bash which always fucks you up. look at typescript libs/functions,
> nushell, portable go/rust. also which languages in general are you best at developing in due to
> combinations (innate, skills, mcps, lsp, language design features (like rustc guarantees/verbosity),
> portability (go musl static for example), overhead, ease of change, etc)"

## The evidence

Seven failures in a single session, all in glue code, none in application code:

| # | What was written | What happened | Loud? |
|---|---|---|---|
| 1 | `set -- $spec` to split `"repo num"` | zsh does **not** word-split an unquoted expansion; `$2` was empty, four `gh` calls died | loud |
| 2 | `grep -rn … --include=*.ts` | zsh `nomatch`: the glob matched nothing in cwd and **aborted the whole command** | loud |
| 3 | `awk '$4 ~ /\.md$/ {t+=$4}'` over `git ls-tree -l` | wrong field indices — size is `$4`, path is `$5`. Printed `md files: 0`, `total: ` and **exit 0** | **silent** |
| 4 | `cd repo && …` then a follow-up call | the harness resets cwd between calls; the follow-up ran in the wrong repo | **silent** |
| 5 | `jq 'select(.type=="started")' \| wc -l` | counted **lines of pretty-printed JSON**, not records: reported 1722 agents instead of 22 | **silent** |
| 6 | `jq 'select(.label==…)'` | the records had keys `{type,key,agentId}` — no `label`. Returned empty | **silent** |
| 7 | `beforeEach(() => mock.mockClear())` | `mockClear()` returns the mock; a function returned from `beforeEach` is a **teardown callback**, so vitest invoked `smartFetch()` with no args | loud |

**Four of seven were silent.** That is the whole problem. A loud failure costs one turn. A silent one
costs a wrong conclusion reported as fact — #5 was stated to the user before being caught.

## The actual predictor (not "bash is bad")

The failures do not cluster by language. They cluster by **whether the boundary carries a schema.**

- `jq`, `awk`, and shell word-splitting all consume **untyped text** and, on a mismatched assumption,
  emit a **plausible scalar** instead of an error. `0`, `""`, and `1722` are all valid outputs.
- The two loud failures (#1, #2) were loud only because zsh happens to abort — not because anything
  understood the data.
- #7 is the same shape in a typed language: an **implicitly returned value** reinterpreted by a
  framework contract. TypeScript did not catch it because `Mock` is a legal return type for a
  `beforeEach` callback.

> **The rule:** every field access across an untyped boundary is an unverified assumption. `jq` makes
> those assumptions cheap to write and impossible to see.

This also refines the standing "deterministic beats LLM" rule. Deterministic is necessary but not
sufficient — `jq '.label'` is perfectly deterministic and was perfectly wrong. **Deterministic *and
schema-checked*** is the property worth having.

## Recommendations

### 1. Ranked by where the work lives

| Context | Use | Why |
|---|---|---|
| Anything inside sux/suxlib | **TypeScript** | Already the codebase; `tsc` + LSP + vitest catch field-name errors *at author time*. Highest leverage per keystroke of anything here. |
| Interactive/ad-hoc data shaping | **Nushell** | Already Colin's shell. Pipelines carry **structured values**, so `where type == started \| length` cannot become a line count — failure #5 is unrepresentable. |
| Standalone repo scripts | **Python 3, stdlib only** | Precedent exists (`vault-lint.py`); no build step, no deps, runs on any runner. Chosen for this session's vault fix for exactly that reason. |
| Ships to router/box | **Go**, static musl | The one case where a single dependency-free binary on a constrained target justifies leaving the above. |
| Rust | **only** where its guarantees are the point | Its verbosity and build overhead are a real cost; do not pay it for glue. |

### 2. Concrete replacements for the failures above

- **Never** `jq … | wc -l`. Count *inside* the tool: `jq 'length'`, or `jq -r '.type' | grep -c '^started$'`.
- **Never** guess a JSON schema. `jq -r 'keys' | head -1` (or `columns` in nu) **first** — #6 cost a
  silent empty result for want of one call.
- **Never** field-index a `git`/`ls` line format from memory. Use a porcelain/`-z`/`--format` flag that
  names its fields, or read one line first.
- **Always** quote a glob that may not match, in any command this harness runs (#2).
- **Always** prefix an out-of-repo command with its own `cd` — never rely on a previous call's (#4).
- **Prefer** `--json` + `--jq` on `gh` over parsing its human output; it is the same schema-at-the-
  boundary argument, and `gh` will tell you when a field does not exist.

### 3. Where the strengths actually come from

Answering the "innate / skills / MCP / LSP / language design" part directly, in honest order:

1. **Tooling around the language beats the language.** TypeScript here is strong not because of the
   type system in the abstract but because `tsc --noEmit`, the LSP, and 3719 existing tests make a
   wrong guess *fail before it runs*. Python is strong here for the opposite reason — zero setup.
2. **Verbosity is a feature at author time and a tax at edit time.** Rust's guarantees are real; for
   code that changes weekly, the edit tax dominates. Reserve it.
3. **Portability is a deployment property, not a development one.** Go's static musl binary matters
   for owl-tegu, and nowhere else in this fabric.
4. **The weakest link is not a language at all** — it is one-off glue written inline with no test, no
   type, and no second reader. Every failure in the table is that.

## The single highest-value change

Not a rewrite. **Move field access behind a schema, and count inside the tool that owns the data.**
Everything in the table follows from violating one of those two.

## Follow-up

The distilled rules (quote globs, per-call `cd`, never `jq | wc -l`, inspect keys before filtering)
belong folded into the existing shell-gotchas section of the operator `CLAUDE.md` rather than kept
here — that file is what actually gets read at session start. This doc is the derivation; that is the
enforcement.
