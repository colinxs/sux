import { keyedSerialize } from "./keyed-serialize";
import { findFn, type RtEnv, type ToolResult } from "./registry";

// The proposal kernel — the substrate for sux acting on Colin's behalf under the
// "propose → approve → gated-act → learn" model (docs/design/personal-agent-roadmap.md,
// epic #228, W1). A Proposal is the agent's INTENT to do ONE reversible, safe thing;
// it is RECORDED, never auto-run. Colin reviews the queue (the `proposals` fn) and
// approves; approval executes the payload through the real fn registry.
//
// Three locks, all fail-closed (mirroring STAGE_KINDS / AUTO_ACT_OPS):
//   1. propose() REFUSES any payload whose `fn` isn't on PROPOSABLE_FNS — the agent
//      literally cannot queue a send/delete/pay. Widen the surface = add a row.
//   2. propose() REFUSES anything not marked `reversible: true`.
//   3. approve executes WITHOUT `force`, so an irreversible sub-action still hits the
//      target tool's own staged() gate (stages, doesn't fire) — a second lock the
//      allow-list never has to be perfect to hold. Enforced by actually stripping
//      any force/confirm/commit_token-shaped key from `payload.args`, both at
//      propose() time and again right before dispatch — a payload can't smuggle its
//      own bypass in and self-commit on approval (#559).
// Propose-only posture (Colin's choice): nothing here acts until he approves it.

const PREFIX = "sux:proposal:";
const INDEX_KEY = "sux:proposal:index"; // JSON array of live proposal ids (bounded, newest-first)
const DEFAULT_TTL_DAYS = 14;
const MAX_OPEN = 200;

export type ProposalStatus = "proposed" | "rejected" | "snoozed" | "committed" | "failed" | "expired";
export type Stakes = "low" | "med" | "high";

export type Proposal = {
	id: string;
	source: string; // "mail" | "monarch" | "vault" | … — which sense raised it
	kind: string; // "archive_newsletters" | "bill_due" | … — the specific situation
	intent: string; // human-readable one-liner Colin reads to decide
	payload: { fn: string; args: Record<string, unknown> }; // what runs on approval
	reversible: boolean;
	stakes: Stakes;
	advisory?: string[]; // conscience-lint notes, surfaced before approval
	evidence?: unknown; // the ids/rows/notes that triggered it (the "why")
	status: ProposalStatus;
	createdAt: number;
	expiresAt: number;
	snoozedUntil?: number;
	result?: unknown; // the ToolResult payload after a commit/fail
};

// The security boundary: the ONLY leaf fns a proposal may execute on approval. Every
// entry is reversible-first + non-money + non-destructive AT THE ACTION IT'S PROPOSED
// FOR — and even a mis-proposed irreversible action stays caught by lock #3 (no force →
// the target's own staged() gate fires). sux never proposes to move money: `monarch`
// is deliberately absent (it's read-only and its graphql escape refuses mutations).
export const PROPOSABLE_FNS = new Set<string>([
	"mail", // reversible mail actions (label/move/archive/draft); send stays staged (lock #3)
	"calendar", // create/update (reversible); delete stays staged
	"contact", // create/update (reversible); delete stays staged
	"obsidian", // vault append/write/edit — git is the undo
	"ingest", // capture a url/text/note into the vault (additive)
	"todoist", // add/update/complete (reversible); delete stays confirm-gated
]);

const now = (): number => Date.now();
const days = (n: number): number => n * 24 * 60 * 60 * 1000;

// Keys that a target fn's own staged() gate treats as "skip staging, commit now"
// (mail/calendar/contact/todoist's `force`, mail's `commit_token`, todoist's
// `confirm`). A proposal must never carry one — that's the whole point of lock #3 —
// so it's stripped both when a proposal is stored and again right before dispatch.
// This is a hand-maintained allow-list, not derived from the target fns' schemas —
// a future PROPOSABLE_FNS entry (or an existing one) that grows a differently-named
// bypass switch needs a matching addition here, or it silently reopens lock #3.
const UNSAFE_ARG_KEYS = new Set(["force", "confirm", "commit_token"]);

function stripUnsafeArgs(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		if (!UNSAFE_ARG_KEYS.has(k)) out[k] = v;
	}
	return out;
}

// Serializes approveProposal's read-check-run-write per proposal id so two concurrent
// approvals (a double-tap, a retried request) can't both read `status: "proposed"`
// before either write lands and double-execute the payload.
const approveChains = new Map<string, Promise<unknown>>();

async function readIndex(env: RtEnv): Promise<string[]> {
	try {
		const raw = await env.OAUTH_KV?.get(INDEX_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}
async function writeIndex(env: RtEnv, ids: string[]): Promise<void> {
	await env.OAUTH_KV?.put(INDEX_KEY, JSON.stringify(ids.slice(0, MAX_OPEN)));
}

// Thrown by getProposal when the KV read itself fails (transient blip, rate limit, …) —
// distinct from a clean miss (raw === null), which means the key is genuinely gone
// (expired or never existed). listProposals relies on this distinction: only a clean
// miss should prune an id from the index (#889).
export class ProposalReadError extends Error {}

export async function getProposal(env: RtEnv, id: string): Promise<Proposal | null> {
	let raw: string | undefined | null;
	try {
		raw = await env.OAUTH_KV?.get(PREFIX + id);
	} catch (e) {
		throw new ProposalReadError(String((e as Error)?.message ?? e));
	}
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Proposal;
	} catch {
		return null;
	}
}

// approve/reject/snooze all want the same "no proposal '<id>' (expired or unknown)"
// error whether the id is genuinely gone or KV just blipped on this read — unlike
// listProposals, they have no index to mis-prune, so collapsing the distinction here
// is safe and keeps their existing error message.
async function getProposalOrThrow(env: RtEnv, id: string): Promise<Proposal> {
	let p: Proposal | null;
	try {
		p = await getProposal(env, id);
	} catch (e) {
		if (e instanceof ProposalReadError) p = null;
		else throw e;
	}
	if (!p) throw new Error(`no proposal '${id}' (expired or unknown).`);
	return p;
}
async function putProposal(env: RtEnv, p: Proposal): Promise<void> {
	const ttl = Math.max(60, Math.ceil((p.expiresAt - now()) / 1000));
	await env.OAUTH_KV?.put(PREFIX + p.id, JSON.stringify(p), { expirationTtl: ttl });
}

/** Record a proposal. Fail-closed on the two propose-time locks: the `fn` must be on
 *  PROPOSABLE_FNS and the proposal must be `reversible: true`. Returns the stored proposal. */
export async function propose(
	env: RtEnv,
	p: Omit<Proposal, "id" | "status" | "createdAt" | "expiresAt"> & { ttlDays?: number },
): Promise<Proposal> {
	if (!PROPOSABLE_FNS.has(p.payload?.fn)) throw new Error(`proposal refused: fn '${p.payload?.fn}' is not on the proposable allow-list.`);
	if (p.reversible !== true) throw new Error("proposal refused: only reversible actions may be proposed (reversible:true required).");
	const t = now();
	const proposal: Proposal = {
		id: crypto.randomUUID(),
		source: String(p.source),
		kind: String(p.kind),
		intent: String(p.intent),
		payload: { fn: p.payload.fn, args: stripUnsafeArgs(p.payload.args ?? {}) },
		reversible: true,
		stakes: p.stakes ?? "low",
		advisory: p.advisory,
		evidence: p.evidence,
		status: "proposed",
		createdAt: t,
		expiresAt: t + days(p.ttlDays ?? DEFAULT_TTL_DAYS),
	};
	await putProposal(env, proposal);
	await keyedSerialize(approveChains, INDEX_KEY, async () => {
		const idx = await readIndex(env);
		await writeIndex(env, [proposal.id, ...idx.filter((x) => x !== proposal.id)]);
	});
	return proposal;
}

/** The live queue, newest-first: reads the index and hydrates each proposal, dropping
 *  any that KV has already expired out from under the index. Snoozed items are included
 *  but flagged by their status; a caller can filter on `snoozedUntil`. */
export async function listProposals(env: RtEnv, opts: { includeSnoozed?: boolean } = {}): Promise<Proposal[]> {
	const t = now();
	return keyedSerialize(approveChains, INDEX_KEY, async () => {
		const idx = await readIndex(env);
		const out: Proposal[] = [];
		const live: string[] = [];
		for (const id of idx) {
			let p: Proposal | null;
			try {
				p = await getProposal(env, id);
			} catch (e) {
				if (e instanceof ProposalReadError) {
					live.push(id); // transient read failure — keep it in the index, just skip listing it this time
					continue;
				}
				throw e;
			}
			if (!p) continue; // KV-expired (clean miss): fall out of the index
			live.push(id);
			if (p.status === "snoozed" && p.snoozedUntil && p.snoozedUntil > t && !opts.includeSnoozed) continue;
			out.push(p);
		}
		if (live.length !== idx.length) await writeIndex(env, live); // prune expired ids
		return out;
	});
}

/** Execute an allow-listed reversible fn WITHOUT force (lock #3), through the real
 *  registry. Dynamic import of the fn table breaks the fns→registry→fns cycle. */
async function runProposalFn(env: RtEnv, fn: string, args: Record<string, unknown>): Promise<ToolResult> {
	const { FUNCTIONS } = await import("./fns");
	const target = findFn(FUNCTIONS, fn);
	if (!target) throw new Error(`fn '${fn}' is not registered.`);
	return target.run(env, stripUnsafeArgs(args));
}

/** Approve → execute. Re-checks both propose-time locks at commit time (a stored
 *  proposal could in principle predate an allow-list change), runs the payload, and
 *  records the outcome. Irreversible sub-actions still stage (no force) — a `committed`
 *  status whose result is a StageResult means "approved, now needs the tool's own commit". */
export async function approveProposal(env: RtEnv, id: string): Promise<Proposal> {
	return keyedSerialize(approveChains, id, async () => {
		const p = await getProposalOrThrow(env, id);
		if (p.status === "committed") return p; // idempotent
		if (p.status === "rejected") throw new Error(`proposal '${id}' was rejected.`);
		if (!PROPOSABLE_FNS.has(p.payload.fn) || p.reversible !== true) throw new Error(`proposal '${id}' is no longer executable (fn not allow-listed or not reversible).`);
		try {
			const res = await runProposalFn(env, p.payload.fn, p.payload.args);
			const text = res?.content?.[0]?.type === "text" ? res.content[0].text : undefined;
			const updated: Proposal = { ...p, status: res?.isError ? "failed" : "committed", result: text ?? res };
			await putProposal(env, updated);
			if (!res?.isError) {
				// The learning signal (W8) — a fn returning isError never counts as approval
				// (the human said yes, but the action itself failed, so it's not "wanted" data).
				const { recordOutcome } = await import("./fns/_learning");
				await recordOutcome(env, p.kind, "approved");
			}
			return updated;
		} catch (e) {
			const updated: Proposal = { ...p, status: "failed", result: String((e as Error)?.message ?? e) };
			await putProposal(env, updated);
			return updated;
		}
	});
}

/** Reject → the learning signal (W8). Keeps the record (status:rejected) and down-
 *  weights the kind's ranking (see fns/_learning.ts) rather than silently re-proposing
 *  it at the same priority — the kind still gets proposed, just sorted lower. */
export async function rejectProposal(env: RtEnv, id: string): Promise<Proposal> {
	return keyedSerialize(approveChains, id, async () => {
		const p = await getProposalOrThrow(env, id);
		if (p.status === "rejected") return p; // idempotent
		if (p.status === "committed" || p.status === "failed") throw new Error(`proposal '${id}' already ${p.status}; can't reject.`);
		const updated: Proposal = { ...p, status: "rejected" };
		await putProposal(env, updated);
		const { recordOutcome } = await import("./fns/_learning");
		await recordOutcome(env, p.kind, "rejected");
		return updated;
	});
}

/** Snooze → defer. Default 1 day; the item drops out of the default list until then. */
export async function snoozeProposal(env: RtEnv, id: string, untilMs?: number): Promise<Proposal> {
	return keyedSerialize(approveChains, id, async () => {
		const p = await getProposalOrThrow(env, id);
		if (p.status === "snoozed") return p; // idempotent
		if (p.status === "committed" || p.status === "failed" || p.status === "rejected") throw new Error(`proposal '${id}' already ${p.status}; can't snooze.`);
		const snoozedUntil = untilMs ?? now() + days(1);
		const updated: Proposal = { ...p, status: "snoozed", snoozedUntil, expiresAt: Math.max(p.expiresAt, snoozedUntil) };
		await putProposal(env, updated);
		return updated;
	});
}
