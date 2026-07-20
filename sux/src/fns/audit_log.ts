import { type Fn, failWith, ok } from "../registry";
import { readAuditEntries } from "../audit-log";
import { errMsg, oj } from "./_util";

// The read side of the forensic audit log (#1111) — "what did sux actually send/delete/
// move" over the STAGE_KINDS-gated actions recorded at stage.ts's staged() chokepoint (see
// audit-log.ts for the write side and what's NOT yet covered: the JMAP allow_send/allow_destroy
// raw-conduit path and Dropbox Mode-B's non-staged internal callers). Read-only, newest-first.
export const audit_log: Fn = {
	name: "audit_log",
	surface: "leaf",
	annotations: { readOnlyHint: true, openWorldHint: false },
	description:
		"Read the forensic audit log of side-effecting actions sux has actually committed (mail_send, contact_delete, cal_delete, vault_delete, files_delete_full, kv_delete, dropbox_delete, store_put, todoist_delete, ...) — distinct from ledger.ts's idempotency dedup store. Each entry has kind, at (epoch ms), the preview it was staged/run with, and the mutate() result (often carrying an undo pointer — a message id, a submissionId, a git sha). Params: kind (filter to one STAGE_KINDS kind), since (ISO-8601 date-time floor), limit (default 100, max 500).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			kind: { type: "string", description: "Filter to one STAGE_KINDS kind, e.g. 'mail_send' or 'vault_delete'." },
			since: { type: "string", description: "ISO-8601 date-time floor — only entries at or after this time." },
			limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
		},
	},
	run: async (env, a) => {
		try {
			let since: number | undefined;
			if (a?.since !== undefined && a?.since !== null && a?.since !== "") {
				const t = Date.parse(String(a.since));
				if (!Number.isFinite(t)) return failWith("bad_input", "since must be an ISO-8601 date-time.");
				since = t;
			}
			const limit = Math.max(1, Math.min(500, Number(a?.limit) || 100));
			const entries = await readAuditEntries(env, { kind: a?.kind ? String(a.kind) : undefined, since, limit });
			return ok(oj({ count: entries.length, entries }));
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
