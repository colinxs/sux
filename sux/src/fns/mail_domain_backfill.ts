import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { labelsFor } from "./_domain_labels";
import { type Invocation, JmapError, runBatch } from "./_jmap";
import { BUDGET_MS, type Cursor, PAGE, decodeCursor, encodeCursor, resolveMailbox, resultFor, senderAddress } from "./_jmap_backfill";
import { errMsg, oj } from "./_util";

// mail_domain_backfill — the historical companion to the mail_sieve_hc / _domain_labels Sieve.
// A live Sieve script only ever tags NEW deliveries; it can never retroactively touch mail already
// sitting in a folder. This fn sweeps an EXISTING mailbox and applies the SAME high-confidence
// sender-domain labels (finance/shopping/travel/…, hierarchical edu+uw+dept, gov/mil) via the exact
// `labelsFor` rules the generator emits — one shared source (_domain_labels.ts), so old-mail and
// new-mail labeling can never drift. Same reversible-tag op class as mail_sieve_backfill /
// mail_triage: a JMAP keyword-add (`label:add`), never a move/delete, so a false positive costs a
// stray keyword and nothing hides. dry_run:true (default) reports what WOULD be tagged and mutates
// nothing; dry_run:false applies the labels.
//
// Scale: mail_search caps at 50/page and shapes heavy fields, so this scans the jmap engine directly
// — Email/query (position-paged, oldest-first) + Email/get fetching only ["id","from"]. Each 55s-
// budgeted call sweeps a bounded page window, tags it, and returns a resumable `cursor` + `done`
// flag; re-calling with the cursor advances the sweep, so the whole ~53k inbox drains across a
// handful of invocations. Oldest-first paging is stable against new arrivals (they append at the
// tail and are caught by the live Sieve anyway).

export const mail_domain_backfill: Fn = {
	name: "mail_domain_backfill",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		"Backfill high-confidence sender-domain labels onto mail that ALREADY exists in a mailbox — the historical companion to mail_sieve_hc (a live Sieve only tags NEW deliveries; this covers the backlog). Applies the SAME rules the generator emits, from the shared _domain_labels source (so old-mail and new-mail labeling can't drift): brand groups (finance, shopping, travel, shipping, dev, tech, social, news, health — first-party domains only, ESP/relay infra excluded), HIERARCHICAL education (edu + uw + dept, e.g. cs.uw.edu → edu,uw,cs), and gov/mil. Scans the jmap engine directly (Email/query + Email/get, past mail_search's 50-cap), oldest-first. Applies a reversible `label:add` (JMAP keyword-add — never a move/delete). dry_run:true (default) reports per-keyword counts and mutates NOTHING; dry_run:false applies them. Resumable: each 55s-budgeted call sweeps a page window and returns {cursor, done} — re-call with the cursor until done:true to drain a large inbox.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			mailbox: { type: "string", description: "Mailbox role (inbox/archive/sent/drafts/trash/junk) or display name to scan (default inbox)." },
			dry_run: { type: "boolean", default: true, description: "true (default): report per-keyword counts, mutate nothing. false: apply the reversible keyword-adds." },
			max: { type: "integer", minimum: 1, maximum: 10000, description: "Max messages to scan THIS call (default 2000). The sweep is resumable — re-call with the returned cursor until done:true." },
			cursor: { type: "string", description: "Opaque cursor from a prior call — resumes the sweep where it left off (must be the same mailbox). Omit to start fresh." },
		},
	},
	run: async (env: RtEnv, a: any) => {
		if (!env.FASTMAIL_TOKEN)
			return failWith("not_configured", "Fastmail JMAP not configured — set FASTMAIL_TOKEN to a JMAP-scoped API token (Fastmail → Settings → Privacy & Security → API tokens).");
		const mailbox = a?.mailbox ? String(a.mailbox) : "inbox";
		const max = Math.min(10000, Math.max(1, Math.floor(Number(a?.max) || 2000)));
		const dryRun = a?.dry_run !== false;
		const startedAt = Date.now();

		try {
			// Resolve the mailbox to an id (JMAP filters on inMailbox by id, not role/name).
			const boxResp = await runBatch(env, [["Mailbox/get", { properties: ["id", "name", "role"] }, "m"]], { startedAt });
			const boxes: any[] = resultFor(boxResp.response.methodResponses, "Mailbox/get")?.list ?? [];
			const inMailbox = resolveMailbox(boxes, mailbox);
			if (!inMailbox) return failWith("not_found", `no mailbox matching '${mailbox}' — try a role like inbox/archive or a folder name.`);

			// Resume position from the cursor (fresh sweeps start at 0). A cursor for a different
			// mailbox is a misuse — fail loud rather than silently re-scan from the wrong offset.
			let position = 0;
			if (a?.cursor) {
				let c: Cursor;
				try {
					c = decodeCursor(String(a.cursor));
				} catch {
					return failWith("bad_input", "invalid cursor — omit it to start a fresh sweep.");
				}
				if (c?.inMailbox !== inMailbox) return failWith("bad_input", "cursor is for a different mailbox — omit it, or pass the mailbox it was issued for.");
				position = Math.max(0, Math.floor(Number(c.position) || 0));
			}

			const mail = dryRun ? null : await import("../mail-mcp");
			const filter = { inMailbox };
			const per_keyword: Record<string, number> = {};
			const errors: Array<{ keyword: string; error: string }> = [];
			let scanned = 0;
			let tagged = 0;
			let total: number | undefined;
			let done = false;

			while (scanned < max) {
				if (Date.now() - startedAt > BUDGET_MS) break; // clean stop at a page boundary; cursor at `position`
				const limit = Math.min(PAGE, max - scanned);
				const batch: Invocation[] = [
					["Email/query", { filter, sort: [{ property: "receivedAt", isAscending: true }], position, limit, calculateTotal: total === undefined }, "q"],
					["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "from"] }, "g"],
				];
				const { response } = await runBatch(env, batch, { startedAt });
				const query = resultFor(response.methodResponses, "Email/query");
				const get = resultFor(response.methodResponses, "Email/get");
				const ids: string[] = Array.isArray(query?.ids) ? query.ids.map(String) : [];
				if (total === undefined && Number.isFinite(Number(query?.total))) total = Number(query.total);

				const fromById = new Map<string, unknown>();
				for (const e of Array.isArray(get?.list) ? get.list : []) fromById.set(String(e?.id), e?.from);

				// Group THIS page's ids by keyword (a message can land in several groups, e.g. edu+uw+cs).
				const pageByKeyword = new Map<string, string[]>();
				for (const id of ids) {
					const addr = senderAddress(fromById.get(id));
					const flags = addr ? labelsFor(addr) : [];
					if (!flags.length) continue;
					tagged++;
					for (const f of flags) {
						const arr = pageByKeyword.get(f);
						if (arr) arr.push(id);
						else pageByKeyword.set(f, [id]);
					}
				}

				// Apply (or, in dry-run, just tally) this page before advancing the checkpoint.
				let pageFailed = false;
				for (const [keyword, kwIds] of pageByKeyword) {
					if (dryRun) {
						per_keyword[keyword] = (per_keyword[keyword] ?? 0) + kwIds.length;
						continue;
					}
					const lr = await mail!.labelMessages(env, kwIds, keyword, true);
					if (lr.isError) {
						errors.push({ keyword, error: lr.content?.[0]?.text ?? "label failed" });
						pageFailed = true;
					} else per_keyword[keyword] = (per_keyword[keyword] ?? 0) + kwIds.length;
				}
				// A label-write failure means this page is only partially applied — don't
				// advance the resume cursor past it, or a re-call with the returned cursor
				// would permanently skip the un-tagged ids. Stop here so the next call
				// re-scans and retries this same page (label:add is idempotent, so
				// re-applying the keywords that already succeeded is harmless).
				if (pageFailed) break;

				scanned += ids.length;
				position += ids.length;
				if (ids.length < limit) {
					done = true;
					break;
				}
				if (total !== undefined && position >= total) {
					done = true;
					break;
				}
			}

			const cursor = done ? null : encodeCursor({ v: 1, inMailbox, position });
			return ok(
				oj({
					dry_run: dryRun,
					mailbox,
					scanned,
					tagged,
					per_keyword,
					cursor,
					done,
					...(total !== undefined ? { total } : {}),
					...(errors.length ? { errors } : {}),
					...(dryRun
						? { note: "Nothing mutated. Pass dry_run:false to apply these reversible keyword-adds; re-call with the returned cursor until done:true." }
						: {}),
				}),
			);
		} catch (e) {
			if (e instanceof JmapError) return failWith(e.code, e.message);
			return failWith("upstream_error", errMsg(e));
		}
	},
};
