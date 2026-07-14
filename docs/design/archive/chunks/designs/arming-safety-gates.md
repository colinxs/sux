---
title: Arming safety gates — mail_triage + self-improve (fail-closed preconditions)
status: reference
source: research 2026-07-12 (lethal-trifecta / CaMeL / OWASP LLM01 / RAIL)
---

The autonomous chunks ship **gated OFF**. Before Colin flips an arm-flag, these must hold.
Every gate is **fail-closed**: any missing precondition ⇒ no autonomous action.

## mail_triage (reads UNTRUSTED email — the lethal trifecta applies)
Frame: an agent is exploitable with all three of {private data, untrusted content, egress}.
Triage has the first two by nature → **eliminate egress** (Meta "Rule of Two").
- [ ] **NO egress tool bound** — no send/reply/forward, no HTTP fetch, no filter/forwarding-rule
      creation (persistent exfiltration), no URL following / remote-content rendering.
      *← sharpest new requirement; verify the built branch grants NONE of these.*
- [ ] Email body is **data, not instructions** — quarantined lane; never concatenated into the
      tool-calling prompt. Classifier returns a **structured enum + confidence**, schema-validated.
- [ ] **Reversible-only allow-list**: label / move / junk-teach. **Delete, send, sharing/permission
      changes HARD-DENIED.**
- [ ] Scoped to the invoking user's own mailbox; per-hour rate cap; full audit log.
- [ ] **Suggest-only for the first N cycles** — log what it *would* do for human audit before any
      live mutation. Confidence threshold enforced (uncertain → suggest, never act).

## self-improve loop (can auto-merge to prod — grade by blast radius)
- [ ] **Lane grading**: only trivially-reversible lanes (docs/deps/test-fixes) auto-merge-eligible.
      Anything touching auth, secrets, bindings, deploy config, or the mail/vault/files namespaces
      is **PR-only**. **Security/permission changes NEVER auto**, regardless of confidence.
- [ ] **Kill-switch + arm-flag live in a binding the loop has NO write credential to** — only a
      human flips it. The loop cannot disable its own kill-switch or raise its own rate cap.
- [ ] **CI is the gate, branch protection is the enforcer**: auto-merge requires green CI +
      branch-protection + (ideally) signed commits; the loop cannot bypass required checks or push
      to `main` directly. (Matches the house "git is undo, CI is gate, review is net" posture.)
- [ ] Rate cap (max N/day) + circuit breaker (auto-halt on CI-failure spike / error-rate
      regression / rollback). One-command rollback; reviewer sees the **real diff**, not a summary.

## Ship-review actions (main loop, when the fleet lands)
1. On the **mail_triage** branch: grep the diff for any send/HTTP/forward/rule-creation capability
   in the triage path — if present, that's a blocker, fix before PR.
2. On the **self-improve** branch: confirm the arm-flag/kill-switch binding is write-isolated from
   the loop and that security/namespace lanes route to PR-only.
3. Fold this checklist into each PR body as the "arming preconditions."

Sources: lethal-trifecta & CaMeL (simonwillison.net), OWASP LLM01 (genai.owasp.org), RAIL/kill-switch (looprails.dev, codebridge.tech).
