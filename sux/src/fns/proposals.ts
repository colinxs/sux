import { type Fn, failWith, ok } from "../registry";
import { errMsg, oj } from "./_util";
import { approveProposal, getProposal, listProposals, type Proposal, rejectProposal, snoozeProposal } from "../proposals";

// The proposal inbox — Colin's one place to review and act on everything the agent
// wants to do on his behalf (docs/design/personal-agent-roadmap.md, epic #228, W1).
// Read + triage only: `list`/`get` show pending intents; `approve` runs one through
// the fail-closed proposal kernel (allow-listed reversible fns only, no force);
// `reject`/`snooze` are the disposition + learning signals. The agent RECORDS
// proposals via the internal propose() kernel (the agenda loop, W2) — this fn is the
// human side of the loop, so it never creates proposals, only dispositions them.

// A queue proposal projected to the fields Colin reads to decide — never the raw
// payload fn/args unless he asks (get), so the list stays a scannable digest.
const brief = (p: Proposal) => ({
	id: p.id,
	source: p.source,
	kind: p.kind,
	intent: p.intent,
	stakes: p.stakes,
	status: p.status,
	...(p.advisory?.length ? { advisory: p.advisory } : {}),
	...(p.snoozedUntil ? { snoozed_until: new Date(p.snoozedUntil).toISOString() } : {}),
});

export const proposals: Fn = {
	name: "proposals",
	surface: "front",
	cacheable: false,
	description:
		"The agent's proposal inbox — review and act on everything sux wants to do on your behalf. {action}: list (pending proposals, newest-first; add include_snoozed:true to see snoozed ones) | get {id} (full detail incl. the exact fn+args that would run and the evidence behind it) | approve {id} (RUN it through the fail-closed proposal kernel — only allow-listed REVERSIBLE actions, executed without force so any irreversible sub-step still hits the target tool's own stage gate) | reject {id} (decline + record as a learning signal) | snooze {id, until?} (defer; ISO-8601 `until`, default +1 day). Propose-only by design: nothing here ever acted without your approve. The agent RECORDS proposals internally (the agenda loop) — this fn is the human side, so it never creates them.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["list", "get", "approve", "reject", "snooze"] },
			id: { type: "string", description: "Proposal id (get/approve/reject/snooze)." },
			include_snoozed: { type: "boolean", description: "list: also show currently-snoozed proposals." },
			until: { type: "string", description: "snooze: ISO-8601 time to defer until (default +1 day)." },
		},
	},
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	run: async (env, a) => {
		try {
			const action = String(a?.action ?? "");
			if (action === "list") {
				const items = await listProposals(env, { includeSnoozed: a?.include_snoozed === true });
				return ok(oj({ count: items.length, proposals: items.map(brief) }));
			}
			const id = a?.id ? String(a.id) : "";
			if (!id && action !== "list") return failWith("bad_input", `proposals ${action} requires an \`id\`.`);
			if (action === "get") {
				const p = await getProposal(env, id);
				if (!p) return failWith("not_found", `no proposal '${id}' (expired or unknown).`);
				return ok(oj(p)); // full detail: payload fn+args + evidence
			}
			if (action === "approve") {
				const p = await approveProposal(env, id);
				return ok(oj({ id: p.id, status: p.status, intent: p.intent, result: p.result }));
			}
			if (action === "reject") {
				const p = await rejectProposal(env, id);
				return ok(oj({ id: p.id, status: p.status }));
			}
			if (action === "snooze") {
				const until = a?.until ? Date.parse(String(a.until)) : undefined;
				if (a?.until && Number.isNaN(until)) return failWith("bad_input", "snooze `until` must be an ISO-8601 date-time.");
				const p = await snoozeProposal(env, id, until);
				return ok(oj({ id: p.id, status: p.status, snoozed_until: p.snoozedUntil ? new Date(p.snoozedUntil).toISOString() : undefined }));
			}
			return failWith("bad_input", `proposals: unknown action '${action}'.`);
		} catch (e) {
			return failWith("upstream_error", `proposals ${a?.action ?? ""} failed: ${errMsg(e)}`);
		}
	},
};
