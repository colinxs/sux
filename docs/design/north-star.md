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

## Flagship experience — "day 1" (the target everything composes toward)

> "Sux, learn about me — what I know, courses I've taken and the material covered, everything in
> my life. Fill gaps, ask me questions to expand. Initialize my vault with this knowledge. Start
> safe mutations like labeling email. Suggest personal-growth steps aligned with my therapy
> because you read the textbook and synthesized it."

Decomposes into capabilities the plan already builds toward:
1. **Self-model (`onboard`/`profile`)** — fan-out READ across mail/files/vault/calendar/contacts →
   a structured profile (interests, expertise, relationships, projects, goals). recall, but aimed
   inward.
2. **Courses + material** — detect courses (email receipts, files, calendar), fetch syllabi/texts
   (`fetch`/`research`), synthesize what was covered. mail + files + fetch + summarize.
3. **Gap-fill loop** — identify what's missing/unclear, ask HIGH-SIGNAL questions, fold answers in.
   Interactive, not one-shot.
4. **Vault init** — write the synthesis as a structured personal knowledge base (MOCs per domain,
   note per course/topic, a "who I am" root). vault_write/capture/batch + the living-wiki pattern.
5. **Safe mutations** — begin learned email labeling/filing, conservative + smart-guarded, widening
   as the learned-preferences store proves reliable.
6. **Therapy-aligned growth** — read the user's OWN therapy material, synthesize the framework
   (CBT/ACT/IFS/…), suggest steps grounded in it + the profile.

**The part that needs real care (therapy + deepest personal data):** this is the most sensitive
data sux will ever touch, so the zero-trust principle is absolute — READ-ONLY synthesis into the
user's own vault, no egress, untrusted-content fenced, nothing leaves the personal boundary. And
the growth suggestions must be **aligned-with, never a replacement-for**, real therapy: sux
synthesizes + reflects the user's own framework and material; the user and their therapist decide.
Framed as a mirror, not an authority. This is where "do the right thing" is load-bearing.

**Why it's the flagship:** it composes the whole spine — one surface, recall, vault, learned
prefs, smart-guards, the self-improvement loop — into something no single tool does: an AI that
*knows you* and helps you grow, safely. Everything in the plan is scaffolding for this.

## The tension to hold
Every feature must pass: *does this do the right thing, stay zero-trust, and earn its interrupt?*
Proactivity that becomes noise, or a nudge that overrides judgment, fails the north star even if
it's clever. Refinement over accretion.

See `session-knowledge.md` for the hard facts, `design-review-2026-07.md` for round 1.
