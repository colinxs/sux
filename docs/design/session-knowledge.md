---
title: sux — compressed session knowledge + blind-spot retrospective
status: living
audience: Colin + future Claude sessions (load this when context is thin)
---

# Compressed knowledge & blind-spots (2026-07-11)

Written because a very long session accumulated hard-won facts that are expensive to
re-derive. This is the "what I'd tell my next self" doc.

## Meta blind-spot (the one that recurred)
**I theorize and act before reproducing against ground truth.** Nearly every real fix this
session came from a LIVE check, not from my reasoning. Corrective principles, in priority order:

1. **Reproduce with the EXACT failing input before hypothesizing.** The Mac-render 502: I burned
   time on "stale 3-day browser" then "stale launchd path" theories. The cause was visible only
   when I replayed the Worker's *exact* payload — `wait_until:"networkidle0"` (Puppeteer) hitting
   a Playwright service that only accepts `networkidle`. A signed local render with the real
   payload found it in one shot.
2. **Never mutate a working production service to test a theory.** I ran `launchctl kickstart -k`
   on the *healthy* render service and took it down — the loaded job still cached the old
   `~/Claude/sux-mcp` path (repo had moved to `~/Code/sux-mcp`). Inspect the loaded definition
   BEFORE restarting. (Fix was `launchctl bootout`+`bootstrap` to reload from the corrected plist.)
3. **Verify upstream API object models + capability grants LIVE, not from assumption.** Two live
   surprises: Fastmail contacts are **RFC 9610 `ContactCard` (JSCard)**, not the legacy `Contact`
   object (`Contact/query`→"Unknown object"); and Fastmail **API tokens cannot grant
   `vacationresponse`/`quota`** (HTTP-rejected even with a Mail RW token).
4. **A method→capability mapping needs BOTH `capForMethod` AND `deriveUsing`.** I added Quota to
   one, not the other; the test mock ignored the `using` array so it passed green, but the live
   server rejected "using item not specified." **Mocks that ignore a wire dimension hide real bugs**
   — test the actual wire contract for anything protocol-level.
5. **Base parallel work off the CURRENT tip, and confirm worktree isolation.** My first fan-out
   built off `main` while the big integration (#34) was unmerged → #39 rebuilt P4's vault graph
   (duplicate), and one design agent's `git checkout -B` LEAKED into the main working tree
   (switched my branch). Merge big work first, or base off it; keep agents strictly in worktrees.
6. Minor: `git add a b badpath` is atomic — one bad pathspec no-ops the whole add. `op` "no
   account" in the interactive shell = desktop-integration not vending to that shell, not a
   missing account.

## Hard facts (don't re-derive)

### Render / bot-detection
- Mac render service = `sux/mac-render/render_server.py` (Playwright/patchright + CapSolver ext),
  launchd `com.sux.render` (plist at `~/Library/LaunchAgents/`, runs `run.sh` → port **8790**),
  Tailscale **Funnel default URL → 127.0.0.1:8790**. Reload after edits:
  `launchctl bootout gui/$(id -u)/com.sux.render && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sux.render.plist`.
- `render_server.py` returns **502 on any `do_render` exception** (`:151`); auth is HMAC of
  `ts\n<body>` on the query string; **no ts-freshness check → captured signed requests are
  replayable** (a real gap; the safe fix is a ±300s window).
- **wait_until vocabulary differs**: cf/Puppeteer = `networkidle0|2`; mac/Playwright = `networkidle`.
  Normalize on the wire (now done in `mac-render.ts`).
- **Per-site bot protection** (drives cf-vs-mac): amazon = **AWS WAF** → cf-residential PASSES
  (proven live, so Amazon is now **cf-first**); walmart = **PerimeterX press-and-hold** → mac only
  (cf structurally can't); homedepot/lowes/costco = **Akamai**; ace = captcha; ebay/kroger/winco =
  real API (no render). Strategy: cf-residential Tier-1 for most; keep mac only for PerimeterX;
  consider retiring mac (home-laptop fragility + public-Funnel SSRF exposure) — validate via the
  live bot-detection matrix before deciding.
- **Residential proxy is fast, not a bottleneck**: home link 15.8ms latency, **308 Mbps down /
  204 Mbps up**. Cloud→residential round-trip: light page ~0.1s, Amazon ~16s (render-bound, not
  proxy-bound). `TAILSCALE_PROXY_URL` is a separate proxy node.

### Fastmail / JMAP
- Contacts = `ContactCard/*` (JSCard: `name.full|components`, `emails`/`phones` as hash-keyed maps
  → `.address`/`.number`, `organizations`). vacation/quota NOT on API tokens. Account `ua5f1401b`.
- `capForMethod` + `deriveUsing` must agree per method (regression test added).
- CalDAV: JMAP has no calendars capability on Fastmail → CalDAV (`FASTMAIL_CALDAV_USER` +
  `FASTMAIL_APP_PASSWORD`). `parseICal` was a flat last-write-wins parser (corrupts non-UTC/aliased
  events + VALARM overwrites) — being replaced with a component-stack tokenizer.

### Ops
- `main` auto-deploys to prod on push (`.github/workflows/deploy.yml`). Merge = release. Guardrails
  are git-undo + CI + `/code-review ultra`. 1Password SSH signer auto-locks → `git -c
  commit.gpgsign=false`; push via `git -c credential.helper='!gh auth git-credential'`.
- Living-wiki pre-commit hook regenerates `docs/wiki/*` + `llms.txt` and can clobber a prior
  `git add` — stage right before commit.

## Current program (2026-07-11, mid-flight)
- **Deployed** (`e99ed58d`): P0–P5 integration, reconciled ultra-sweep/files_transform/amazon
  cf-fallback/vault_patch, contacts(ContactCard), the render wait_until/cf-first/deadline fix.
- **Direction (locked with Colin):** ONE connector (`/mcp`), retire mail/vault/files connectors;
  full front-door (~12 verbs: shop/search/fetch/research/media + mail_/vault_/files_/cal_/contact_
  + recall + `fn` escape hatch); leaves hidden behind front verbs + `fn`; a **`sux` root verb** that
  self-describes the surface (mobile-safe, since skills don't sync to mobile); smart-guards
  (stage-by-default + `!`-override + sentiment-pause + typo-catch) generalized across ALL
  irreversible/outward acts; cf-first render; maximally deployed except genuine security risk.
- **Running:** ultra-flow `sux-ultra-stage-a` — 5 file-disjoint build clusters (infra-resilience,
  render-unify+HMAC-freshness, registry-surface+`sux`-verb, mail-caldav, files-vault) each
  adversarial/fuzz-verified → PRs; + live bot-detection matrix + design-review round 2.
- **Held from auto-deploy (security):** (1) remote-exec shell — NOT building it (RCE surface);
  Mac debugging stays manual / at most allowlisted file-ops, PR-only. (2) Tailnet-only render
  migration (Funnel→Serve + `MAC_RENDER_URL` change) — PR-only (deploy risk); only the safe
  HMAC-ts-freshness ships now. (3) No secret rotation/exposure, unattended.
