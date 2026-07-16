# Pivot validation — the git-markdown core-and-tools pivot (2026-07)

> **Status:** decision record. Validates `docs/proposals/SUX.md` (the pivot).
> **Method:** four independent adversarial reviews (go/no-go, de-risk,
> load-bearing-assumption, red-team), each run blind to the others against the
> real code (`sux/src/fns/obsidian.ts`, `sux/src/vault-mcp.ts`) and the proposal
> corpus. They converged on the same crack — that convergence is the finding.

## Verdict

**GO on the store as the core. NO-GO on the slogan** — "one store, no database,
tools are just markdown + verbs" — **as written.**

The pivot unifies *storage* (one git repo of markdown, `git revert` = undo,
human+agent shared editing) — which is genuinely good and hard to beat. It then
relabels *query, index, and integrity* as "convention" and **hides** that
complexity rather than removing it. The store primitive (`obsidian.ts`) is
production-quality; the framing that everything else disappears is false, and the
code already proves it false.

Adopt the vault as the legible source of truth for *notes*. Do **not** delete the
KV/Todoist stores, and do not treat the pivot as a v1 deletion of everything else.
Treat "one markdown core" as a **direction**, not a slogan.

## The load-bearing assumption (shaky)

> "Every future tool reduces to *markdown convention + a few store verbs* at
> **flat** marginal cost."

This is the entire justification for collapsing onto one store and parking the
rest. It is:

- **TRUE** for `append`/`read`-shaped tools — capture, daily note,
  remember-a-fact. The pivot is right about these; build them freely.
- **COMPOUNDING** the moment a tool needs (a) a structured/range/aggregate query,
  (b) a uniqueness/dedupe/referential-integrity constraint, or (c) a multi-note or
  cross-source transform. **All four of the first roadmap tools are in the
  compounding class:**

| Tool | Why flat-cost breaks |
|---|---|
| Tasks ("overdue p1 #home, by due date") | range/structured query — GitHub code-search is keyword-only + index-lagged; `🔁` recurring-completion is a stateful transform the Obsidian *app* performs, not `edit [ ]→[x]` |
| Email capture | dedupe = a uniqueness constraint → needs a seen-id index; **KV has no compare-and-swap** (`obsidian.ts:55-56`) → double-import race |
| Ask / recall | `knowledge-core.md` §3 is a **6-step** retrieval ladder (MOC → fuzzy → embeddings → link-follow → citation records), not "two store ops and Claude" |
| Agenda / calendar view | a **cross-source join** (vault tasks × calendar connector) — not one store at all |

## The tell is already in the code

Three index/query layers have *already* been smuggled in under "just store ops",
which is direct evidence the abstraction leaks:

1. The `remote` backend (`obsidian.ts:198-343`) exists solely to get Obsidian's
   **DQL / JsonLogic** — a real query engine — plus `/search/simple` and surgical
   `/patch`. But it is **Mac-awake-only**.
2. `readVaultIndexBlob` / `writeVaultIndexBlob` (`obsidian.ts:88-93`,
   `vault-mcp.ts:55-102`) — a HEAD-keyed **derived-scan index**, because per-query
   GitHub scans are too slow. A materialized view with manual invalidation.
3. The **MOC** is a hand-maintained index.

And the always-available path (git backend — mobile / Mac-asleep) has
**`search` effectively dead on a private repo** (`vault-backends.md` §1.2 op-parity
matrix: "code-search dead on private repo"). This was the single most-cited
blocking fact across all four reviews. So the store's query power is *bimodal* and
the rich half is availability-gated — the pivot doc silently assumes the rich half
is always present.

## What the store already gets right (do not re-solve)

- **`edit` has real optimistic concurrency** — `vaultPut` threads the read-time
  sha into the PUT, so a concurrent write 409s instead of clobbering
  (`obsidian.ts:141-155, 470-472`). Better than the KV stores it would replace.
- **`append` re-reads before merging** through `readGitContents`, so a >1MB note
  isn't seen as empty and destroyed (`obsidian.ts:178-184, 439-443`).
- **Non-JSON / proxy-interstitial guard** (`obsidian.ts:25-31`), **path-escape
  guard** (`badVaultPath`, `obsidian.ts:120-126`), and a **`truncated` flag** that
  honestly signals index read-holes instead of a confident undercount.

## Conditions for GO (union of all four reviews)

1. **Query must work on the path you use daily.** Choose explicitly:
   - **(a)** Build a Worker-maintained index — extend `buildVaultIndex` to parse
     `- [ ]` task lines (skipping fenced code blocks; honoring `^t-` ids) into a
     `VaultRecord.tasks[]` field, plus a body excerpt/keyword set. Then "overdue
     today" and grep-quality body search are in-memory filters over one KV blob,
     answerable **cloud-side today** — no code-search, no live Obsidian. *This is
     the single highest-leverage add.* **or**
   - **(b)** Commit to the always-on headless-Obsidian node as real, monitored
     infrastructure — and then stop calling the core "just a git repo."

   Today the cloud path has **neither**. That is the one blocking gap.

2. **Close the two silent-data-loss holes** (both small, both from the code):
   - `write` calls `vaultPut` with **no sha** (`obsidian.ts:455`) → last-write-wins
     clobber with no 409, no signal. Give it an optional `base_sha`.
   - `append` / `edit` surface 409 as a hard fail with **no retry**
     (`obsidian.ts:155, 446`). Add a bounded read-modify-write retry loop (3 tries,
     jittered); `append` is trivially retryable and should self-heal silently.

3. **Reconcile with `knowledge-core.md` explicitly.** That spec is `designed`,
   carries decisions signed 2026-07-08, and is *linked from SUX.md as support* —
   yet the pivot silently narrows it: collapses "both transports first-class" to
   the degraded git-only four verbs, and drops **triage, consolidate, and all
   integrity governance** from its six-verb lifecycle. Either adopt those decisions
   (making the core the *capable* remote backend, not four git verbs) or argue the
   reversal in writing. Do not leave it silently overruled.

4. **State the honest scope in the README.** No types, no structured query,
   single-writer — *and* "here's the parked typed `algebra.md` we resume the day
   that hurts." `algebra.md` is `FINAL` (43 adversarial issues folded in);
   **park ≠ delete** — shelve it behind a documented trigger, don't discard it.

## The reframe that makes the keystone true

The core is not "one markdown store + four verbs." It is:

> **one markdown store + a query/index/integrity layer as a first-class core
> primitive** (structured task/frontmatter index, dedupe/uniqueness helpers, the
> DQL/JsonLogic surface), built **once** — not re-invented per tool.

Build that layer once and tools genuinely *are* cheap on top. Leave it implicit as
"a few store ops" and every tool re-invents it ad hoc, coherence rots, and you get
the opposite of the pivot's justification.

## Sequenced next steps

1. **Settle the keystone with a ~1-day prototype** (cheapest decisive move):
   build recurring/overdue **tasks end-to-end on the git-only backend** at a
   realistic 1k–5k-note vault, and measure — (a) can "overdue as of today" be
   answered correctly and at acceptable latency/cost with only `list/read/search`?
   (b) does `🔁` completion preserve recurrence without the Obsidian app? (c) can
   email-capture dedupe by message-id without a race? Testing on the *git-only*
   path is the whole point — that's the path you're on when mobile. Any "no"
   confirms the index/integrity layer must be scoped into the core before the
   collapse.
2. **Build the task-aware index** (GO condition 1a) — unblocks the flagship
   productivity tool on the always-on floor instead of gating it on the VPC node.
3. **Land the `write` sha + append/edit retry loop** (GO condition 2).
4. **Write the reconciliation + honest-scope README edits** (GO conditions 3, 4).
5. Defer incremental index, cache-freshness escapes, HEAD-CAS — real but they
   self-heal within a recheck window or only bite at higher scale.

## Related

- [[SUX]] — the pivot this validates
- [[knowledge-core]] — the signed spec the pivot silently narrows (condition 3)
- [[vault-backends]] — the op-parity matrix admitting search is dead on private git
- [[algebra]] — the parked typed query layer (condition 4; park ≠ delete)
