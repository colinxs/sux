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
// new-mail labeling can never drift.
//
// VISIBLE labels, not invisible keywords (#1196). A Fastmail "Label" is a real Mailbox, not an IMAP
// keyword — a `keywords/*` patch (the model this fn used before) never renders in Fastmail's UI, so
// the labels looked like they "did nothing." This fn instead applies a REAL mailbox-membership add
// (the same visible-labeling mechanism mail_sieve_backfill uses): one JMAP `Email/set` patch per
// page adding `mailboxIds/<label>: true` per matched flag, into a per-label folder NESTED under the
// account's real Inbox mailbox (mirrors what a Sieve's `fileinto "INBOX.<label>"` creates over IMAP).
// Target folders auto-create on first use. `showAsLabel` is NOT set here — it isn't a JMAP-settable
// Mailbox property on Fastmail (a Mailbox/get for it returns invalidArguments); whether a folder
// renders as a sidebar "folder" or an inline "label" tag is a per-mailbox toggle in Fastmail's own
// settings. Either way the message is now VISIBLE under that category, which is the point.
//
// KEEP-IN-PLACE, never a move. Unlike mail_sieve_backfill (which files NOISE — junk/spam — with a
// skip-inbox move), these are CONTENT categories you keep reading in the inbox, so this only ADDS a
// label mailbox and NEVER removes the scanned mailbox. Same TAG-NEVER-HIDE invariant the Sieve
// carries (addflag only): a false positive costs a stray label, never a message vanishing. Fully
// reversible — drop the label mailbox membership (mail_move / drag in the UI); nothing here is a
// move-with-removal, a fileinto-with-discard, or a delete. The Email/set patch this fn builds only
// ever contains additive `mailboxIds/<target>: true` keys — asserted structurally below.
//
// IDEMPOTENT. Email/get fetches each message's current `mailboxIds`, so a message already sitting in
// a label's folder is skipped — re-running the sweep (or resuming after a partial apply) never
// double-counts or re-patches it. In dry_run the target folders are RESOLVED but never CREATED, so
// the preview counts already-unlabeled matches only, with zero mutation.
//
// dry_run:true (default) reports what WOULD be labeled and mutates nothing; dry_run:false applies it.
//
// Scale: mail_search caps at 50/page and shapes heavy fields, so this scans the jmap engine directly
// — Email/query (position-paged, oldest-first) + Email/get fetching only ["id","from","mailboxIds"].
// Each 55s-budgeted call sweeps a bounded page window, labels it, and returns a resumable `cursor` +
// `done` flag; re-calling with the cursor advances the sweep, so the whole ~14.5k inbox drains
// across a handful of invocations. Oldest-first paging is stable against new arrivals (they append at
// the tail and are caught by the live Sieve anyway). Because a label ADD keeps the message in the
// scanned mailbox (no move), the live result set never shrinks mid-sweep, so `position` advances by
// the full page size — no move-aware cursor arithmetic (contrast mail_sieve_backfill, which must
// subtract the messages its skip-inbox move removed from the set).

/** Resolve a mailbox nested directly under `parentId` by name — PARENT-scoped, so a same-named
 *  TOP-LEVEL mailbox (e.g. one of Fastmail's own system folders) can never satisfy a lookup meant
 *  for a target nested under Inbox (#1236). Mirrors mail_sieve_backfill's helper of the same name. */
function resolveChildMailbox(boxes: any[], parentId: string, name: string): string | undefined {
	const key = name.toLowerCase();
	const found = boxes.find((b) => String(b?.parentId ?? "") === parentId && String(b?.name ?? "").toLowerCase() === key);
	return found?.id ? String(found.id) : undefined;
}

export const mail_domain_backfill: Fn = {
	name: "mail_domain_backfill",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	description:
		"Backfill high-confidence sender-domain labels onto mail that ALREADY exists in a mailbox — the historical companion to mail_sieve_hc (a live Sieve only tags NEW deliveries; this covers the backlog). Applies the SAME rules the generator emits, from the shared _domain_labels source (so old-mail and new-mail labeling can't drift): brand groups (finance, shopping, travel, shipping, dev, tech, social, news, health — first-party domains only, ESP/relay infra excluded), HIERARCHICAL education (edu + uw + dept, e.g. cs.uw.edu → edu,uw,cs), and gov/mil. Scans the jmap engine directly (Email/query + Email/get, past mail_search's 50-cap), oldest-first. Applies a REAL, VISIBLE Fastmail label — a Label is a Mailbox, so this ADDS the message to a per-label folder nested under the account's Inbox (Fastmail doesn't render IMAP keywords as Labels; the old keyword-add was invisible, #1196). KEEP-IN-PLACE: the message stays in the inbox (these are content categories, not noise to evict — never a move/delete). Idempotent (a message already carrying a label is skipped) and fully reversible (drop the label membership). dry_run:true (default) reports per-label counts and mutates NOTHING (target folders are resolved, never created); dry_run:false applies them. Resumable: each 55s-budgeted call sweeps a page window and returns {cursor, done} — re-call with the cursor until done:true to drain a large inbox.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			mailbox: { type: "string", description: "Mailbox role (inbox/archive/sent/drafts/trash/junk) or display name to scan (default inbox)." },
			dry_run: { type: "boolean", default: true, description: "true (default): report per-label counts, mutate nothing (target folders resolved, never created). false: apply the reversible, keep-in-place label adds." },
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
			// Resolve the scan mailbox to an id (JMAP filters on inMailbox by id, not role/name), and the
			// account's real Inbox id — every label folder nests under it, independent of the scan target
			// (this fn might be sweeping Archive while the labels still nest under Inbox, same as the
			// installed Sieve's `fileinto "INBOX.<label>"`).
			const boxResp = await runBatch(env, [["Mailbox/get", { properties: ["id", "name", "role", "parentId"] }, "m"]], { startedAt });
			const boxes: any[] = resultFor(boxResp.response.methodResponses, "Mailbox/get")?.list ?? [];
			const inMailbox = resolveMailbox(boxes, mailbox);
			if (!inMailbox) return failWith("not_found", `no mailbox matching '${mailbox}' — try a role like inbox/archive or a folder name.`);
			const inboxBox = boxes.find((b) => String(b?.role ?? "").toLowerCase() === "inbox");
			const inboxId: string | undefined = inboxBox?.id ? String(inboxBox.id) : undefined;

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

			const filter = { inMailbox };
			const per_keyword: Record<string, number> = {};
			const appliedByFlag = new Map<string, { count: number; error?: string }>();
			// Target label-folder ids, resolved (and created if missing, on apply) lazily on first use —
			// once per flag per run. `boxes` grows in place as new folders get created so a later
			// resolveChildMailbox() in this same run sees them too.
			const targetIdByFlag = new Map<string, string>();
			/** The flag's label-folder id if it ALREADY exists (never creates) — for the idempotent
			 *  already-labeled skip and the dry-run resolve-don't-create rule. undefined until it exists. */
			function knownTargetId(flag: string): string | undefined {
				const cached = targetIdByFlag.get(flag);
				if (cached) return cached;
				if (!inboxId) return undefined;
				const id = resolveChildMailbox(boxes, inboxId, flag);
				if (id) targetIdByFlag.set(flag, id);
				return id;
			}
			/** Resolve-or-create the flag's label folder (apply path only). */
			async function ensureTargetMailbox(flag: string): Promise<string> {
				const cached = knownTargetId(flag);
				if (cached) return cached;
				if (!inboxId) throw new Error("could not resolve the account's Inbox mailbox (no mailbox with role=inbox) — needed to nest label folders under it.");
				const { response: createResp } = await runBatch(env, [["Mailbox/set", { create: { m: { name: flag, parentId: inboxId } } }, "c"]], { startedAt });
				const setR = resultFor(createResp.methodResponses, "Mailbox/set");
				const created = setR?.created?.m;
				if (!created?.id) throw new Error(`could not create label folder '${flag}': ${JSON.stringify(setR?.notCreated ?? {})}`);
				const id = String(created.id);
				boxes.push({ id, name: flag, role: null, parentId: inboxId });
				targetIdByFlag.set(flag, id);
				return id;
			}

			let scanned = 0;
			let tagged = 0;
			let total: number | undefined;
			let done = false;

			while (scanned < max) {
				if (Date.now() - startedAt > BUDGET_MS) break; // clean stop at a page boundary; cursor at `position`
				const limit = Math.min(PAGE, max - scanned);
				const batch: Invocation[] = [
					["Email/query", { filter, sort: [{ property: "receivedAt", isAscending: true }], position, limit, calculateTotal: total === undefined }, "q"],
					["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "from", "mailboxIds"] }, "g"],
				];
				const { response } = await runBatch(env, batch, { startedAt });
				const query = resultFor(response.methodResponses, "Email/query");
				const get = resultFor(response.methodResponses, "Email/get");
				const ids: string[] = Array.isArray(query?.ids) ? query.ids.map(String) : [];
				if (total === undefined && Number.isFinite(Number(query?.total))) total = Number(query.total);

				const byId = new Map<string, { from?: unknown; mailboxIds?: Record<string, unknown> }>();
				for (const e of Array.isArray(get?.list) ? get.list : []) byId.set(String(e?.id), e);

				// Group THIS page's ids by the labels they NEED — a message can need several (edu+uw+cs),
				// minus any it already carries (idempotent skip via its current mailboxIds).
				const pageByFlag = new Map<string, string[]>();
				for (const id of ids) {
					const e = byId.get(id);
					const flags = labelsFor(senderAddress(e?.from) ?? "");
					if (!flags.length) continue;
					const mids = (e?.mailboxIds ?? {}) as Record<string, unknown>;
					const need = flags.filter((f) => {
						const tid = knownTargetId(f);
						return !(tid && mids[tid]); // keep the flag only if the message isn't already in its folder
					});
					if (!need.length) continue;
					tagged++;
					for (const f of need) {
						const arr = pageByFlag.get(f);
						if (arr) arr.push(id);
						else pageByFlag.set(f, [id]);
					}
				}

				// Apply (or, in dry-run, just tally) this page before advancing the checkpoint — a page
				// (≤200 ids) never approaches maxObjectsInSet, and the resume cursor only advances past a
				// fully-written page, so a mid-sweep budget stop can't skip un-labeled mail. ONE Email/set
				// update per page: a message needing several labels gets every target folder added in the
				// SAME patch, and the patch is ADDITIVE-ONLY (`mailboxIds/<target>: true`) — never a
				// removal, never a keyword, never a destroy — so it's reversible by construction and can
				// never evict the message from the scanned mailbox.
				let pageFailed = false;
				if (dryRun) {
					for (const [flag, flagIds] of pageByFlag) per_keyword[flag] = (per_keyword[flag] ?? 0) + flagIds.length;
				} else if (pageByFlag.size) {
					const update: Record<string, Record<string, true>> = {};
					for (const [flag, flagIds] of pageByFlag) {
						const targetId = await ensureTargetMailbox(flag);
						for (const id of flagIds) {
							const patch = update[id] ?? {};
							patch[`mailboxIds/${targetId}`] = true;
							update[id] = patch;
						}
					}
					const { response: setResp } = await runBatch(env, [["Email/set", { update }, "s"]], { startedAt });
					const setR = resultFor(setResp.methodResponses, "Email/set");
					const updatedIds = new Set(Object.keys(setR?.updated ?? {}));
					const notUpdated = setR?.notUpdated ?? {};
					for (const [flag, flagIds] of pageByFlag) {
						const okCount = flagIds.filter((id) => updatedIds.has(id)).length;
						const failCount = flagIds.length - okCount;
						if (failCount) pageFailed = true;
						const prev = appliedByFlag.get(flag);
						appliedByFlag.set(flag, {
							count: (prev?.count ?? 0) + okCount,
							...(failCount ? { error: `${failCount} failed on this page: ${JSON.stringify(notUpdated).slice(0, 200)}` } : prev?.error ? { error: prev.error } : {}),
						});
						per_keyword[flag] = (per_keyword[flag] ?? 0) + okCount;
					}
				}

				// A failed page's ids stay un-labeled, so don't advance scanned/position past it — a
				// resume rescans and retries it (the mailboxIds add is idempotent, and already-labeled
				// ids are skipped, so re-applying is harmless).
				if (pageFailed) {
					done = false;
					break;
				}

				scanned += ids.length;
				position += ids.length; // keep-in-place: nothing leaves the set, so advance by the full page
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

			if (dryRun) {
				return ok(
					oj({
						dry_run: true,
						mailbox,
						scanned,
						would_label: tagged,
						per_keyword,
						cursor,
						done,
						...(total !== undefined ? { total } : {}),
						note: "Nothing mutated (target folders were resolved, never created). Pass dry_run:false to apply these reversible, keep-in-place label adds; re-call with the returned cursor until done:true.",
					}),
				);
			}

			const applied: Array<{ flag: string; count: number; error?: string }> = [...appliedByFlag].map(([flag, v]) => ({ flag, ...v }));
			const errors = applied.filter((x) => x.error).map((x) => ({ keyword: x.flag, error: x.error! }));
			return ok(
				oj({
					dry_run: false,
					mailbox,
					scanned,
					labeled: tagged,
					per_keyword,
					applied,
					cursor,
					done,
					...(total !== undefined ? { total } : {}),
					...(errors.length ? { errors } : {}),
				}),
			);
		} catch (e) {
			if (e instanceof JmapError) return failWith(e.code, e.message);
			return failWith("upstream_error", errMsg(e));
		}
	},
};
