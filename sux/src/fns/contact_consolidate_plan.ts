import { type Fn, failWith, ok } from "../registry";
import { runVerb } from "./run";
import { contact } from "./contact";
import { hasContactConsolidate, findDuplicateContacts, type ContactRef } from "./_contact_consolidate";
import { errMsg, oj } from "./_util";

// contact_consolidate_plan — the entrypoint for the DURABLE, human-approved address-book
// deduplication #965 documents as missing: searches a page of Fastmail contacts, groups them
// into duplicate CANDIDATE clusters with _contact_consolidate.ts's fuzzy email/phone/name
// matching (no precedent in this repo before now — contact.ts exposed full ContactCard CRUD
// with zero downstream dedup use), then starts a `run` of the `contacts-consolidate-plan` op
// (op-engine/registry.ts), which unions each cluster's emails/phones into the canonical card
// and PAUSES for one human "apply these contact merges?" approval before applying anything.
// Nothing is ever auto-applied, and a merge never contact_deletes a duplicate — mirrors
// vault_consolidate_plan.ts's shape exactly (fetch-then-runVerb; a durable op leaf only sees
// `caps`, not env, so the contact search happens here). Gated behind
// CONTACT_CONSOLIDATE_ENABLED (fail-closed).
const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

export const contact_consolidate_plan: Fn = {
	name: "contact_consolidate_plan",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Durable contact-consolidation-with-approval: searches a page of Fastmail contacts for likely duplicates (shared email, shared phone, or a fuzzy name match — \"Colin Powell\" / \"C. Powell\" / \"Colin Powell (work)\"), then starts a durable run (op:'contacts-consolidate-plan') that proposes a REVERSIBLE union merge per duplicate cluster — the canonical (lexicographically-first id) card is updated with the union of every member's emails/phones, the other members are only TAGGED with a pointer back to it in their name field, never contact_deleted — then PAUSES for one human 'apply these contact merges?' approval before applying anything. Nothing is ever auto-applied. Returns {instanceId}: poll with `run {action:'status', instanceId}`; approve with `run {action:'answer', instanceId, prompt:\"apply these contact merges?\", payload:{approved:true}}`, or veto with {approved:false}. An unanswered gate applies nothing after 24h (fails closed). Needs CONTACT_CONSOLIDATE_ENABLED and a FASTMAIL_TOKEN scoped for contacts. One scan covers at most `max` contacts (default/cap 100 — contact_search's own per-call limit) starting at `position`; the response's `total`/`next_position` tell you whether to page a larger address book with a repeat call.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			max: { type: "integer", minimum: 1, maximum: 100, description: "Max contacts to scan this batch (default 100, contact_search's own per-call cap)." },
			maxClusters: { type: "integer", minimum: 1, maximum: 50, description: "Max duplicate clusters to propose merges for this batch (default 20)." },
			position: { type: "integer", minimum: 0, description: "0-based offset into the address book to start this batch's scan (default 0) — pass the previous call's `next_position` to page a book bigger than `max`." },
		},
	},
	run: async (env, a) => {
		if (!hasContactConsolidate(env)) {
			return failWith("not_configured", "contact_consolidate_plan is disabled — set CONTACT_CONSOLIDATE_ENABLED to arm it. Nothing scanned or merged until it's set.");
		}
		try {
			const max = numClamp(a?.max, 1, 100, 100);
			const maxClusters = numClamp(a?.maxClusters, 1, 50, 20);
			const position = numClamp(a?.position, 0, Number.MAX_SAFE_INTEGER, 0);
			const r = await contact.run(env, { action: "search", limit: max, position });
			if (r.isError) return failWith("upstream_error", `contact search failed: ${r.content?.[0]?.text ?? "unknown error"}`);
			let parsed: { contacts?: Array<{ id?: unknown; name?: unknown; emails?: unknown; phones?: unknown; company?: unknown }>; total?: unknown } = {};
			try {
				parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			} catch {
				/* an unparseable search response reads as an empty page below */
			}
			const contacts: Array<ContactRef & { company?: string }> = (parsed.contacts ?? [])
				.filter((c): c is { id: string; name?: unknown; emails?: unknown; phones?: unknown; company?: unknown } => typeof c?.id === "string")
				.map((c) => ({
					id: c.id,
					name: typeof c.name === "string" ? c.name : undefined,
					emails: Array.isArray(c.emails) ? c.emails.map(String) : [],
					phones: Array.isArray(c.phones) ? c.phones.map(String) : [],
					company: typeof c.company === "string" ? c.company : undefined,
				}));
			const total = Number.isFinite(Number(parsed.total)) ? Number(parsed.total) : position + contacts.length;
			const nextPosition = position + contacts.length < total ? position + contacts.length : undefined;
			const byId = new Map(contacts.map((c) => [c.id, c]));
			const clusters = findDuplicateContacts(contacts).slice(0, maxClusters);
			if (!clusters.length) return ok(oj({ scanned: contacts.length, position, total, next_position: nextPosition, candidates: 0, note: "no duplicate candidates found — nothing to merge" }));
			const input = clusters.map((cl) => ({
				ids: cl.ids,
				names: cl.ids.map((id) => byId.get(id)?.name),
				emails: cl.ids.map((id) => byId.get(id)?.emails ?? []),
				phones: cl.ids.map((id) => byId.get(id)?.phones ?? []),
				companies: cl.ids.map((id) => byId.get(id)?.company),
			}));
			const res = await runVerb({ op: "contacts-consolidate-plan", input, mode: "durable" }, env);
			return ok(
				oj({
					scanned: contacts.length,
					position,
					total,
					next_position: nextPosition,
					candidates: clusters.length,
					...res,
					note: 'durable run started — proposes a union merge per cluster, then pauses for a human \'apply these contact merges?\' approval. Poll with `run {action:\'status\', instanceId}`; approve/reject with `run {action:\'answer\', instanceId, prompt:"apply these contact merges?"}` ({approved:true|false}).',
				}),
			);
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
