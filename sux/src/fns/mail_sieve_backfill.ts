import { type Fn, failWith, ok } from "../registry";
import { ALL_SIEVE_CATEGORIES, matchCoarseCategories } from "./_mail_sieve";
import { errMsg, oj } from "./_util";

// mail_sieve_backfill — a ONE-TIME pass applying mail_sieve's coarse tags to mail that already
// exists in the mailbox. Sieve only ever evaluates at delivery time; it can't retroactively touch
// anything already sitting in a folder, so this fn is the backfill companion: same rule set
// (matchCoarseCategories, shared with mail_sieve so the two can never drift), applied via the
// existing mail_search + labelMessages verbs — a `label:add`, exactly like _mail_triage's own
// reversible-tag ops. dry_run defaults true: report what WOULD be tagged without mutating
// anything; pass dry_run:false to actually apply the labels.
export const mail_sieve_backfill: Fn = {
	name: "mail_sieve_backfill",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		"One-time backfill: apply mail_sieve's coarse tags (junk / mailing-list / gh,gitlab,vercel,ci / notification) to mail that ALREADY exists in a mailbox — a live Sieve script only tags NEW deliveries, so this fn covers the backlog once. Uses the SAME rule set as mail_sieve (from/subject cues; the List-Unsubscribe-header rule never fires here since mail_search previews carry no headers). Applies a reversible `label:add` via the existing mail verbs, same op class as mail_triage. dry_run:true (default) reports what WOULD be tagged without mutating anything; pass dry_run:false to actually label.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			mailbox: { type: "string", description: "Mailbox role to scan (default inbox)." },
			max: { type: "integer", minimum: 1, maximum: 500, description: "Max messages to scan (default 100)." },
			categories: {
				type: "array",
				items: { type: "string", enum: [...ALL_SIEVE_CATEGORIES] },
				description: `Which rule categories to apply (default: all). One of ${ALL_SIEVE_CATEGORIES.join(", ")}.`,
			},
			dry_run: { type: "boolean", default: true, description: "true (default): report matches only, mutate nothing. false: actually apply the label:add ops." },
		},
	},
	run: async (env, a) => {
		const categories = Array.isArray(a?.categories) ? a.categories.map(String) : undefined;
		const invalid = (categories ?? []).filter((c: string) => !ALL_SIEVE_CATEGORIES.includes(c as any));
		if (invalid.length) return failWith("bad_input", `unknown categor${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")} (valid: ${ALL_SIEVE_CATEGORIES.join(", ")})`);
		const mailbox = a?.mailbox ? String(a.mailbox) : "inbox";
		const max = Math.min(500, Math.max(1, Math.floor(Number(a?.max) || 100)));
		const dryRun = a?.dry_run !== false;

		try {
			const mail = await import("../mail-mcp");
			const searchTool = mail.MAIL_TOOLS.find((t) => t.name === "mail_search");
			if (!searchTool) return failWith("upstream_error", "mail_search tool not found");
			const r = await searchTool.run(env, { mailbox, limit: max });
			if (r.isError) return failWith("upstream_error", r.content?.[0]?.text ?? "mail_search failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			const msgs: Array<{ id: string; from?: string; subject?: string }> = (parsed.emails ?? []).map((e: any) => ({ id: String(e?.id ?? ""), from: e?.from, subject: e?.subject }));

			const matched: Array<{ id: string; flags: string[] }> = [];
			for (const m of msgs) {
				if (!m.id) continue;
				const flags = matchCoarseCategories({ from: m.from, subject: m.subject }, categories);
				if (flags.length) matched.push({ id: m.id, flags });
			}

			if (dryRun) {
				return ok(oj({ dry_run: true, mailbox, scanned: msgs.length, would_tag: matched.length, matches: matched, note: "Nothing mutated. Pass dry_run:false to apply these label:add ops." }));
			}

			// Group ids by flag so each label needs one Email/set call instead of one per message.
			const byFlag = new Map<string, string[]>();
			for (const m of matched) for (const f of m.flags) byFlag.set(f, [...(byFlag.get(f) ?? []), m.id]);
			const applied: Array<{ flag: string; count: number; error?: string }> = [];
			for (const [flag, ids] of byFlag) {
				const lr = await mail.labelMessages(env, ids, flag, true);
				if (lr.isError) applied.push({ flag, count: 0, error: lr.content?.[0]?.text ?? "label failed" });
				else applied.push({ flag, count: ids.length });
			}
			return ok(oj({ dry_run: false, mailbox, scanned: msgs.length, tagged: matched.length, applied }));
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
