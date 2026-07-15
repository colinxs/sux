---
title: Automations layer — build-vs-adopt verdict
status: reference
source: research 2026-07-12 (n8n/Huginn/Windmill/Inngest/Trigger.dev/LangGraph/CF Agents+Workflows)
---

**Verdict: BUILD on sux's own primitives; adopt exactly ONE thing — Cloudflare Workflows — as the
durable-execution substrate. Steal the rule-graph + cursor-watch design; host none of the platforms.**
The standalone platforms (n8n/Huginn/Windmill/Node-RED) are stateful servers (Node/Rust + Postgres,
Docker) that fight a Worker's edge/stateless model. sux already has the triggers (cron, Email Routing,
Dropbox cursor, KV) and actions (fns, vault, mail, files); what it lacks is **durability + a
declarative rule model**, both cheaper to add than to import.

**Adopt: Cloudflare Workflows** — GA, Worker-native durable execution, zero extra infra. Steps
auto-persist + retry; `step.sleep`/`sleepUntil` park for days free; **`waitForEvent`** pauses for a
webhook / mail reply / approval — exactly the "triage → ask me → act" and "file lands → multi-step
ingest that can't half-fail" shapes. Use the **Agents SDK (Durable-Object-per-entity + SQLite)** when
an automation needs long-lived per-mailbox/per-project state; bare Workflows for stateless multi-step.

**3 patterns to steal:**
1. **Durable idempotent steps** — model each automation as replayable steps keyed by a stable id
   (message-id, file-path+rev) so a retry re-runs zero side-effects; `waitForEvent` for approval gates.
2. **Rules-then-LLM filter ladder** — cheap deterministic gate first (sender/regex/label rules stored
   as DATA in KV/vault), escalate only survivors to a Workers-AI classify/summarize. Fast, auditable,
   cheap; rules are editable config, not code.
3. **Cursor-based mailbox/folder watch** — per-source last-seen cursor in KV, dedupe by item id
   (re-delivery = no-op). Prefer PUSH (CF Email Routing → Worker, Dropbox webhook), fall back to
   cron-polled cursor scans. This is the "GitHub-Actions-for-life / Dropbox-folder-auto" trigger core.

**Net design:** a thin sux `automations` fn — declarative trigger→filter→action rules (n8n/Huginn
shape) whose action bodies run as **Cloudflare Workflows**. The mail-triage + self-improve chunks
being built now are v1 (gated, dormant); upgrade their execution onto Workflows for durability later.

Refs: blog.cloudflare.com/workflows-ga-production-ready-durable-execution/ · developers.cloudflare.com/{workflows,agents}/ · inngest.com/docs/learn/how-functions-are-executed
