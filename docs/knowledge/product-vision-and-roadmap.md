# Product vision & roadmap

The durable vision/strategy behind sux (captured from Claude memory so the repo is canonical).
Complements `docs/design/north-star.md` (fuller spec) — this is the compressed through-line.

## North star
sux is a **zero-trust personal-AI Swiss-army-knife**: a Cloudflare Worker MCP server (~95 fns) +
personal-data namespaces (vault / mail / files) behind one `/mcp` front door. Principles:
**do-the-right-thing + nudge**, **high-signal** (no noise), **bounded self-improving**. It's the
"remember when I forget" and "do the tedious thing safely" layer over Colin's whole digital life.

## The generalized assistant (the real goal)
A **learn → research → advise** personal assistant, generalized (not a pile of one-off skills):
- **3-tier knowledge acquisition cascade**: (1) **learn-life** from Colin's OWNED material →
  (2) **research-gaps** on the open web when owned knowledge is thin → (3) **flag-to-upload** when
  neither suffices (ask Colin for the source).
- **Weighting: owned > model > web.** Colin's own documents/notes/mail outrank the model's priors,
  which outrank random web. Colin is disabled → **assistive-tech / accessibility** framing applies
  (the assistant is a capability multiplier, and owned-knowledge distillation is copyright-clean:
  distill/index OWNED material, never reproduce third-party copyrighted text).
- **`learn` is the atom.** Apps (DBT coaching, health tracking, etc.) are later layers built on top
  of learn→recall→advise, not the foundation.

## The digital-life spine (live)
Four namespaces + recall, all live:
- **sux** — the edge toolbelt (search/scrape/transform/research/compute).
- **vault** — Obsidian notes (capture + knowledge graph).
- **mail** — Fastmail/JMAP.
- **files** — Dropbox; **Mode B whole-Dropbox READ is live** (secretless PKCE); Mode B write gated
  on the vault-mirror guard.
- **recall** — cross-store synthesis ("what do I know about X?") over all of the above + web.

## Mail automation (the near-term app)
Home: Fastmail-primary (colinxs.com = Fastmail; everything else consumer; no Workspace/M365 tenant).
Spine: **post-delivery** JMAP push + `Email/set` + a poll+sweep backstop (labels are guaranteed by
the sweep even if the push listener lags). Classifier ladder: in-boundary **rules → kNN →
generative classifier**. Directional-autonomy safe (label/unarchive/undelete/draft; never
delete/send — see working-agreement). Sieve verdicts as the floor (generate-and-paste; no dynamic
filter write via token). A persistent IMAP-IDLE listener, if built, belongs on a **cheap
fixed-price VPS** (Hetzner/Oracle-free) as a *dumb listener*, not an orchestrator — latency
optimization, never a correctness dependency.

## Design verdict (2026-07) — right-size, don't over-build
"**Right-size → Check → Light-up two loops.**" Explicitly **do NOT** build the heavy
event-framework (Workflows engine / email-event bus / VPC-JMAP / rule-DSL). Assert autonomy
invariants **in-band** (in the fns), not as new infrastructure. The one real build worth doing was
**recall-routing**; most of the rest was kill-or-defer. KISS wins (see the engineering taste in
`working-agreement.md`). Fuller detail: `docs/design/design-review-2026-07.md`.
