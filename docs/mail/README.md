# Mail — hand-installed Sieve artifacts

Generated Sieve scripts staged for **manual** installation into Fastmail. Per the
standing doctrine (docs/knowledge/product-vision-and-roadmap.md, restated in
docs/design/personal-agent-roadmap.md W9 and docs/proposals/archive/jmap.md D5),
sux **never installs a Sieve script via token** — Sieve/rule JMAP methods are a
gated, lasting-effect capability class, so the floor is generate-and-paste.

## sieve-hc-2026-07-21.sieve

The high-confidence sender-domain labeling script, regenerated from
`tryCompileHighConfidenceSieve()` (`sux/src/fns/_domain_labels.ts`) at commit
`fe6241e` with all categories enabled. It is byte-identical to what the
`mail_sieve_hc` fn returns with default args.

**Verified safety property (re-checked programmatically at generation time):**
after dropping comment lines (`#`-prefixed — the header prose mentions
fileinto/discard, which false-positives a naive grep), the script contains

- `require ["imap4flags", "variables"]` and **15 `addflag` actions** — nothing else;
- **zero** occurrences of `fileinto` / `discard` / `reject` / `ereject` /
  `redirect` / `vacation` / `notify` / `setflag` / `removeflag` / `keep`.

Sieve's implicit keep still delivers every message to the inbox: a false positive
costs a stray IMAP keyword, never a hidden or lost email. Fully reversible.

### Install (≈30 seconds, Fastmail web UI)

1. Fastmail → **Settings → Mail rules** (fastmail.com/settings/rules).
2. Click **Edit custom Sieve code** (bottom of the page).
3. Paste the entire contents of `sieve-hc-2026-07-21.sieve` into the editable
   custom-Sieve section (the editor marks where custom code may go; position
   relative to the UI-generated rules does not matter — every rule here is
   addflag-only, so nothing can shadow or stop other rules).
4. **Save**. Fastmail validates the Sieve on save; it should accept as-is
   (`imap4flags` and `variables` are both supported extensions).

### Deactivate / undo

Open the same editor (**Settings → Mail rules → Edit custom Sieve code**), delete
the pasted block, **Save**. Tags already applied to delivered mail remain as IMAP
keywords and can be bulk-removed with `mail_triage` (reversible label ops) if ever
desired.

### Regenerate

Call the `mail_sieve_hc` fn (or `tryCompileHighConfidenceSieve()` directly) on
current main and re-verify the addflag-only property before replacing this file.
To label mail that predates installation, run `mail_domain_backfill` — it applies
the identical rules to existing mail.
