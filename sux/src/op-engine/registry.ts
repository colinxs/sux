import { op, pipe, map, reconcile, ask, sink, aimd, fixed, unzip, extract, summarize, type Caps, type Op } from "@suxos/lib";
import { classifyForLabelPlan, compactLabelPlan, type LabelPlanItem } from "./_mail_triage_plan.js";
import { proposeMerge, compactMergePlan, type DuplicateClusterInput, type MergePlanItem } from "./_vault_consolidate_plan.js";
import { proposeContactMerge, compactContactMergePlan, type ContactClusterInput, type ContactMergePlanItem } from "./_contact_consolidate_plan.js";
import { proposeMychartOutreach, compactMychartOutreachPlan, type MychartConflictInput, type MychartOutreachPlanItem } from "./_mychart_reconcile_plan.js";
import { proposeFileDuplicate, compactFileDuplicatePlan, type FileClusterInput, type FileDuplicatePlanItem } from "./_files_consolidate_plan.js";
import type { TriageMsg } from "../fns/_mail_triage.js";

// THE op registry — named op trees that the `run` front-verb and the OpWorkflow
// dispatch by id. Each entry is a FACTORY that builds a FRESH tree per invocation,
// not a shared module constant. That matters for two reasons:
//   • Control state is per-run. An op's `map` limiter (`aimd`) carries mutable
//     inflight/backpressure state; a module-level singleton would leak one run's
//     congestion window into the next. Minting the tree per call gives every run a
//     clean limiter.
//   • Replay stays deterministic. The factory is a pure function of no inputs — it
//     reads no clock/random/I-O — so it yields an identical tree SHAPE every call.
//     Durable step names derive from each node's positional path (see durable.ts),
//     never from limiter state, so a fresh tree per replay lines up with the memoized
//     steps exactly. (Building once and sharing would be the bug, not the safety.)
//
// `echo` is the minimal tracer op — a single pure leaf, so the inline path is
// end-to-end testable with no R2/AI/Workflows bindings. `assimilate-pdfs` is the
// real walking-skeleton vertical: unzip a PDF archive, extract each PDF to markdown
// under a bounded fan-out, reconcile into one master, pause for human review, then
// summarize and fan the result out to both the R2 and vault sinks.
//
// `mail-triage-plan` is the first REAL personal-data flow on the durable runtime: input is a
// page of TriageMsg already fetched by the `mail_triage_plan` fn (listing needs mail/JMAP
// access a leaf can't reach — a leaf only sees `caps`, which exposes store/llm/clock/sinks,
// not env — so the fetch happens in the calling fn and the op tree starts from its output).
// Each message is classified with _mail_triage's EXISTING rules into a proposed reversible
// `label:add` (never archive/unarchive/undelete/draft-reply — see _mail_triage_plan.ts), the
// human is asked once to approve the WHOLE batch, and only on approval does the `mail-labels`
// sink (caps.ts) apply them. onTimeout:'fail' — an unanswered gate applies nothing.
//
// `vault-consolidate-plan` is the action-half `consolidate` (fns/_consolidate.ts) documents
// about itself as missing: input is a batch of duplicate-candidate clusters (path + content
// each side) already fetched by the `vault_consolidate_plan` fn — same reason as mail-triage-
// plan's fetch-in-the-calling-fn shape (a leaf only sees `caps`, not env). Each cluster is
// proposed as one faithful-union merge (`proposeMerge` — content-addressed via `caps.store`,
// reusing suxlib's op/reconcile.ts dedup, NOT a tree-level `reconcile` node, since a Handle
// carries no room for the cluster's target-path metadata past the merge), the human approves
// the WHOLE batch once, and only on approval does the `vault-notes` sink (caps.ts) apply them
// — a `write` of the merged content to the canonical note plus an `append` pointer on the
// duplicate, never a delete. onTimeout:'fail' — an unanswered gate applies nothing.
//
// `cross-semantic-plan` (#785) is a lighter, append-only sibling of vault-consolidate-plan:
// input is a batch of already-computed {vaultPath, domain, key, label, score} cross-domain
// matches (fns/_cross_semantic.ts's crossDomainLinks, ranked from the vault/mail/files semantic
// indices by `vault_cross_link_plan`) — no `caps` needed to compute those (pure cosine ranking
// over already-embedded chunks), so unlike propose/classify above there's no leaf here, just the
// gate and the sink. The human approves the WHOLE batch once, and only on approval does the
// `related-links` sink (caps.ts) apply them — an `append`-only "Related" block per matched vault
// note, never a `write`/`delete` (so, unlike vault-consolidate-plan, this can never touch a
// note's own content). onTimeout:'fail' — an unanswered gate applies nothing.
//
// `contacts-consolidate-plan` (#965) is vault-consolidate-plan's sibling for the address book:
// input is a batch of duplicate-candidate contact clusters (id + name/emails/phones/company
// each side) already fetched by `contact_consolidate_plan` and grouped by
// _contact_consolidate.ts's fuzzy email/phone/name matching — same reason as the other plan
// ops' fetch-in-the-calling-fn shape (a leaf only sees `caps`, not env). Each cluster is
// proposed as one field-union merge (`proposeContactMerge` — a plain set union over already-
// structured emails/phones, no `caps.store`/reconcile needed, unlike vault-consolidate-plan's
// unstructured note bodies), the human approves the WHOLE batch once, and only on approval does
// the `contacts-merge` sink (caps.ts) apply them via `contact_update` — never a `contact_delete`,
// so a wrong merge judgment stays reversible. onTimeout:'fail' — an unanswered gate applies nothing.
//
// `mychart-reconcile-plan` (#1008) is the LLM-drafted half of #1005's cross-org reconciliation
// that issue's own sketch deferred: input is a batch of already-detected MyChartConflicts
// (mychart.ts's crossOrgMedicationAllergyConflicts) fetched by `mychart_reconcile_plan` — same
// fetch-in-the-calling-fn shape as the other plan ops (a leaf only sees `caps`, not env). Each
// conflict is drafted into a plain-English discrepancy summary + a templated outreach message
// (`proposeMychartOutreach`, using caps.llm.summarize to condense — never invent — the plain
// facts), the human approves the WHOLE batch once, and only on approval does the
// `mychart-outreach` sink (caps.ts) write the approved drafts as vault notes for the human to
// read and send by hand — this NEVER reaches mail's send path (no mail_send/mail_draft call
// anywhere in this op or its sink), since an LLM-drafted clinical message needs a human's own
// eyes and hands on the actual send, not just an approval click. onTimeout:'fail' — an
// unanswered gate drafts nothing.
//
// `files-consolidate-plan` (#1015) is vault-consolidate-plan's sibling for Dropbox: input is a
// batch of duplicate-candidate file clusters (paths only) already clustered by
// `files_consolidate_plan` from files_semantic's EXISTING embeddings (_files_consolidate.ts's
// cosine union-find) — same fetch-in-the-calling-fn shape as the other plan ops (a leaf only
// sees `caps`, not env), except there isn't even a fetch here since the index is already
// built. Each cluster is proposed as one relocation (`proposeFileDuplicate` — a plain path
// transform, no `caps` needed, unlike vault-consolidate-plan's content-merging propose), the
// human approves the WHOLE batch once, and only on approval does the `files-duplicates` sink
// (caps.ts) apply them via the existing Mode-B `moveFull` primitive — never a files_delete, so
// a wrong duplicate judgment is always undoable by moving the file back. onTimeout:'fail' — an
// unanswered gate archives nothing.
export const registry: Record<string, () => Op> = {
	echo: () => op("echo", async (x: unknown) => x, { kind: "pure" }),
	"assimilate-pdfs": () =>
		pipe(
			op("unzip", unzip, { kind: "effect" }),
			map(op("extract", extract, { kind: "effect", heavy: true }), { concurrency: aimd({ start: 4 }) }),
			reconcile({ mode: "faithful-union" }),
			ask("review master?", { timeout: "24 hour", onTimeout: "proceed" }),
			op("summarize", summarize, { kind: "effect" }),
			sink.fanout("r2", "vault"),
		),
	"mail-triage-plan": () =>
		pipe(
			map(op("classify", async (m: TriageMsg) => classifyForLabelPlan(m), { kind: "pure" }), { concurrency: fixed(8) }),
			op("compact", async (items: Array<LabelPlanItem | null>) => compactLabelPlan(items), { kind: "pure" }),
			ask("apply these label changes?", { timeout: "24 hour", onTimeout: "fail" }),
			sink("mail-labels"),
		),
	"vault-consolidate-plan": () =>
		pipe(
			map(op("propose", async (c: DuplicateClusterInput, caps: Caps) => proposeMerge(c, caps), { kind: "effect" }), { concurrency: fixed(8) }),
			op("compact", async (items: Array<MergePlanItem | null>) => compactMergePlan(items), { kind: "pure" }),
			ask("apply these note merges?", { timeout: "24 hour", onTimeout: "fail" }),
			sink("vault-notes"),
		),
	"cross-semantic-plan": () =>
		pipe(
			ask("add these related links?", { timeout: "24 hour", onTimeout: "fail" }),
			sink("related-links"),
		),
	"contacts-consolidate-plan": () =>
		pipe(
			map(op("propose", async (c: ContactClusterInput) => proposeContactMerge(c), { kind: "pure" }), { concurrency: fixed(8) }),
			op("compact", async (items: Array<ContactMergePlanItem | null>) => compactContactMergePlan(items), { kind: "pure" }),
			ask("apply these contact merges?", { timeout: "24 hour", onTimeout: "fail" }),
			sink("contacts-merge"),
		),
	"mychart-reconcile-plan": () =>
		pipe(
			map(op("propose", async (c: MychartConflictInput, caps: Caps) => proposeMychartOutreach(c, caps), { kind: "effect" }), { concurrency: fixed(4) }),
			op("compact", async (items: Array<MychartOutreachPlanItem | null>) => compactMychartOutreachPlan(items), { kind: "pure" }),
			ask("draft this outreach message?", { timeout: "24 hour", onTimeout: "fail" }),
			sink("mychart-outreach"),
		),
	"files-consolidate-plan": () =>
		pipe(
			map(op("propose", async (c: FileClusterInput) => proposeFileDuplicate(c), { kind: "pure" }), { concurrency: fixed(8) }),
			op("compact", async (items: Array<FileDuplicatePlanItem | null>) => compactFileDuplicatePlan(items), { kind: "pure" }),
			ask("archive these duplicate files?", { timeout: "24 hour", onTimeout: "fail" }),
			sink("files-duplicates"),
		),
};
