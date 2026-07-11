---
title: sux — north star (product vision + design principles)
status: living
audience: Colin + Claude — the anchor every design decision serves
---

# North star

sux is a **personal AI Swiss-army-knife you weave your life through** — a living, breathing
application that does the right thing and *encourages you to do the right thing*, provides
genuine novel utility, and never becomes noise.

## The five principles (in tension — that's the point)

1. **Do the right thing, and nudge me toward it.** Not just execute — judge. Catch the bad
   email before it sends, suggest the better search, surface the filing you'd forget. Agency with
   a conscience.
2. **Zero-trust, personal AI.** Every side-effect is gated; every ingested byte (web/email) is
   untrusted until fenced; least-privilege creds; no ambient authority. Your life flows through
   it, so it earns trust by never assuming any.
3. **Seamless polyglot.** ~95 services behind one self-describing surface; the model reaches
   anything without ceremony. Connections just work; the plumbing is invisible.
4. **High signal, low noise.** Proactive but not chatty. A nudge must be worth the interrupt.
   Feedback rides the quiet channel (suggest/issue chips), not a stream of alerts.
5. **Living & self-improving, within bounds.** The app learns your conventions and improves its
   own code — but only through the CI + review + deploy-safe gates. Bounded self-editing, never
   unfettered.

## Themes → mechanisms (the build backlog this vision implies)

| Your words | The capability |
|---|---|
| "Don't let me send bad emails" | **Pre-send lint**: typo/tone check, recipient sanity (wrong person, reply-all blast), "you mention an attachment but none is attached," sentiment-pause ("you sound heated — hold?"). Extends the smart-guard (stage-by-default + `!`-override). |
| "Tell me where to search" | **Search router**: a query → the right source (web/academic/shop/mail/vault/files) auto-picked or recommended, behind the `search`/`research`/`fetch` front verbs. |
| "Dynamically save knowledge in living vault" + "remember where to save things" | **Auto-capture + learned filing**: distill knowledge into the vault, and a model of *your* folder/tag conventions that gets the destination right (and improves from corrections). |
| "Auto categorize my email" | **Mail classifier** → mailbox/label routing over JMAP, learned from your existing sorting. |
| "Help teach my spam filter" | **Spam feedback loop**: surface likely-spam, one-tap teach → Fastmail's junk learning, batched. |
| "Summarize knowledge" | **recall + proactive digests** (already the read-crown; add cadence). |
| "Recurring design review → stage PRs, auto-deploy safe" | **The self-improvement loop** (below). |
| "Bounded self-editing, self-learning code" | The loop + learned-preferences store (filing, categorization, tone) as durable vault/memory metadata. |
| "Polyglot, seamless, doesn't get in the way" | The one-connector front-door + `fn` escape + normalized output shapes. |

## The self-improvement loop (concrete, buildable now)
Client-side **suggest/issue** verbs already capture feedback. Close the loop:
1. A **recurring design-review action** (cron) runs the review workflow over the branch + the
   accumulated suggest/issue feedback.
2. It **stages PRs** for each finding.
3. **Auto-deploys the SAFE ones** (green + non-security, per the deploy policy); **PRs the risky
   ones** for Colin. Genuine bounded self-editing: the app files its own improvements, ships the
   safe subset, and asks about the rest — exactly the "living application" ask.

## The tension to hold
Every feature must pass: *does this do the right thing, stay zero-trust, and earn its interrupt?*
Proactivity that becomes noise, or a nudge that overrides judgment, fails the north star even if
it's clever. Refinement over accretion.

See `session-knowledge.md` for the hard facts, `design-review-2026-07.md` for round 1.
