import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { ALL_SIEVE_CATEGORIES, matchCoarseCategories } from "./_mail_sieve";
import { type Invocation, JmapError, runBatch } from "./_jmap";
import { errMsg, fromB64, oj, toB64 } from "./_util";

// mail_sieve_backfill — a ONE-TIME pass applying mail_sieve's coarse tags to mail that already
// exists in the mailbox. Sieve only ever evaluates at delivery time; it can't retroactively touch
// anything already sitting in a folder, so this fn is the backfill companion: same rule set
// (matchCoarseCategories, shared with mail_sieve so the two can never drift). Fastmail does NOT
// render a custom IMAP keyword as a visible Label — a Label is a real Mailbox — so this applies a
// REAL, VISIBLE mailbox move instead of the invisible `keywords/*` patch the old version used (the
// exact bug that made an addflag-based sieve look like it "did nothing"; #1196). Every category
// `_mail_sieve.ts` defines today (junk/spam/mailing-list/service-notification/notification) is
// noise-only — none of them is a "keep visible in Inbox" exception — so every match gets a
// skip-inbox move: added to a dedicated per-flag mailbox AND removed from the scanned mailbox, via
// one JMAP `Email/set` patch-path update per page (`mailboxIds/<from>: null`, `mailboxIds/<to>:
// true` per matched flag — additive across flags, so a message matching e.g. both junk and
// notification lands visibly in BOTH folders, same as the old multi-keyword behavior, just visible
// now). dry_run defaults true: report what WOULD move without mutating anything; pass
// dry_run:false to actually apply the moves. Fully reversible — `mail_move` back, or drag it back
// in the Fastmail UI; nothing here ever discards/deletes.
//
// Scale: mail_search caps at 50/page and shapes heavy fields, so this scans the jmap engine directly
// — Email/query (position-paged, oldest-first) + Email/get fetching only ["id","from","subject"] —
// the same shape mail_domain_backfill uses. Each 55s-budgeted call sweeps a bounded page window,
// moves it, and returns a resumable `cursor` + `done` flag; re-calling with the cursor advances the
// sweep, so a large mailbox drains across a handful of invocations. `hasListUnsubscribe` is never
// set here — the engine scan fetches only id/from/subject, not headers — so that one rule never
// fires on backfill, same limitation as the prior mail_search-backed pass.
//
// Pagination + mutation: `Email/query`'s `position` indexes into the LIVE `{inMailbox}`-filtered
// result set. Moving a matched message OUT of that mailbox removes it from the set the very next
// page fetches from — advancing `position` by the FULL page size (as if nothing moved) would skip
// every message that used to sit right after the ones just moved. Advance `position` only by the
// count that's STILL in `inMailbox` after this page (`ids.length - movedThisPage`); moved messages
// vanish from the live set for free, so the next query naturally continues where this one left off.
// `total` (captured once, before any moves) goes stale under mutation, so the `position >= total`
// fast-path is skipped once we're actually applying moves — `ids.length < limit` alone (a genuinely
// short page from the live set) remains the correct, always-valid end-of-sweep signal.

/** JMAP EmailAddress[] → the first sender address string (what matchCoarseCategories keys off). */
function senderAddress(from: unknown): string | undefined {
	if (!Array.isArray(from)) return undefined;
	for (const x of from) {
		const email = (x as { email?: unknown })?.email;
		if (typeof email === "string" && email) return email;
	}
	return undefined;
}

/** Resolve a mailbox arg (role like "inbox", display name, or raw id) to a mailbox id, or undefined. */
function resolveMailbox(boxes: any[], mailbox: string): string | undefined {
	const key = mailbox.toLowerCase();
	const byRole = boxes.find((b) => String(b?.role ?? "").toLowerCase() === key);
	if (byRole) return byRole.id;
	const byName = boxes.find((b) => String(b?.name ?? "").toLowerCase() === key);
	if (byName) return byName.id;
	return boxes.some((b) => b?.id === mailbox) ? mailbox : undefined;
}

/** Resolve a mailbox nested directly under `parentId` by name — PARENT-scoped, unlike
 *  resolveMailbox above, so a same-named TOP-LEVEL mailbox (e.g. Fastmail's own system "Junk")
 *  can never satisfy a lookup meant for a target nested under Inbox (#1236). */
function resolveChildMailbox(boxes: any[], parentId: string, name: string): string | undefined {
	const key = name.toLowerCase();
	const found = boxes.find((b) => String(b?.parentId ?? "") === parentId && String(b?.name ?? "").toLowerCase() === key);
	return found?.id ? String(found.id) : undefined;
}

// The flags matchCoarseCategories/_mail_sieve.ts's rule set can produce — junk/spam/mailing-list/
// notification, plus the four per-service tags gh/gitlab/vercel/ci (from SERVICE_SENDERS there).
// Not exported by _mail_sieve.ts (allRules() is private to that file), so this list is kept in
// sync by hand — it must match every `flags: [...]` entry in that file's allRules(). Used both as
// the default per-flag mailbox name (see mailboxNameForFlag) and to validate the `mailboxes`
// override input's keys, the same way `categories` above is validated against ALL_SIEVE_CATEGORIES.
const ALL_SIEVE_FLAGS = ["junk", "spam", "mailing-list", "notification", "gh", "gitlab", "vercel", "ci"] as const;

// The visible Fastmail folder each coarse-tag flag moves into, NESTED under the account's real
// Inbox mailbox (parentId = Inbox's own id) — this mirrors what a traditional Sieve script's
// `fileinto "INBOX.<label>"` actually creates/targets over IMAP (JMAP has no dotted-name
// hierarchy; that convention surfaces here as a Mailbox object whose `parentId` points at Inbox),
// which is what Colin's real, hand-pasted Sieve script files NEW mail into. Backfilled mail and
// sieve-filed mail have to land in the SAME folder for "backfill" to mean anything (#1236) — the
// prior default was a flat, top-level `${flag} (sux)` name. The "(sux)" suffix existed so a bare
// name like "Junk" could never collide with — and get wrongly resolved onto — Fastmail's own
// top-level system "Junk" mailbox and its spam trainer/retention policy. Nesting under Inbox
// removes that need entirely: every lookup here is PARENT-scoped (see resolveChildMailbox), so a
// same-named top-level system mailbox can never satisfy it, and the default name can just be the
// bare flag string. `mailboxes` (fn input) lets an operator override individual flags to whatever
// folder name their own installed Sieve script actually uses — sux can't discover a hand-pasted
// script's contents to derive this automatically.
function mailboxNameForFlag(flag: string, overrides?: Record<string, string>): string {
	return overrides?.[flag] ?? flag;
}

/** The first methodResponse for `method`; throws JmapError on a method-level JMAP error in the batch. */
function resultFor(methodResponses: any[], method: string): any {
	for (const mr of methodResponses ?? []) {
		if (mr[0] === method) return mr[1];
		if (mr[0] === "error") throw new JmapError("upstream_error", `JMAP ${method}: ${mr[1]?.type ?? "error"}${mr[1]?.description ? " — " + mr[1].description : ""}`);
	}
	return null;
}

type Cursor = { v: 1; inMailbox: string; position: number };
const encodeCursor = (c: Cursor): string => toB64(new TextEncoder().encode(JSON.stringify(c)));
const decodeCursor = (s: string): Cursor => JSON.parse(new TextDecoder().decode(fromB64(s)));

// Mirrors mail_domain_backfill's paging/budget constants — see that fn's comment for the rationale
// (a page never approaches maxObjectsInSet; the resume cursor only advances past a written page).
const PAGE = 200;
const BUDGET_MS = 50_000;

export const mail_sieve_backfill: Fn = {
	name: "mail_sieve_backfill",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		`One-time backfill: apply mail_sieve's coarse categories (junk / spam / mailing-list / gh,gitlab,vercel,ci / notification) to mail that ALREADY exists in a mailbox — a live Sieve script only tags NEW deliveries, so this fn covers the backlog once. Uses the SAME rule set as mail_sieve (from/subject cues; the List-Unsubscribe-header rule never fires here since the engine scan fetches no headers). Scans the jmap engine directly (Email/query + Email/get, past mail_search's 50-cap), oldest-first. Applies a REAL, VISIBLE mailbox move (skip-inbox — Fastmail doesn't render IMAP keywords as Labels, so a keyword-based tag is invisible) into a per-flag folder NESTED under the account's real Inbox mailbox — mirrors what a traditional Sieve script's 'fileinto "INBOX.<label>"' actually creates over IMAP, which is what a hand-installed Sieve script files new mail into, so backfilled mail lands in the SAME folder new mail does. Named the bare flag by default (${ALL_SIEVE_FLAGS.join(", ")}); pass 'mailboxes' to point individual flags at whatever folder name YOUR OWN installed Sieve script actually uses (sux can't discover a hand-pasted script's contents). Target folders auto-create on first use; a message matching multiple categories lands in all of them. Fully reversible (mail_move it back). dry_run:true (default) reports what WOULD move without mutating anything; pass dry_run:false to actually move. Resumable: each 55s-budgeted call sweeps a page window and returns {cursor, done} — re-call with the cursor until done:true to drain a large mailbox.`,
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			mailbox: { type: "string", description: "Mailbox role to scan (default inbox)." },
			max: { type: "integer", minimum: 1, maximum: 10000, description: "Max messages to scan THIS call (default 2000). The sweep is resumable — re-call with the returned cursor until done:true." },
			categories: {
				type: "array",
				items: { type: "string", enum: [...ALL_SIEVE_CATEGORIES] },
				description: `Which rule categories to apply (default: all). One of ${ALL_SIEVE_CATEGORIES.join(", ")}.`,
			},
				dry_run: { type: "boolean", default: true, description: "true (default): report matches only, mutate nothing. false: actually apply the mailbox moves." },
			cursor: { type: "string", description: "Opaque cursor from a prior call — resumes the sweep where it left off (must be the same mailbox). Omit to start fresh." },
			mailboxes: {
				type: "object",
				additionalProperties: { type: "string" },
				description: `Optional override map from a sieve flag (one of ${ALL_SIEVE_FLAGS.join(", ")}) to the exact target mailbox NAME to file that flag's mail into instead of the bare flag — still created/resolved nested under the account's Inbox mailbox. Use this to match whatever folder name your OWN hand-installed Sieve script actually files new mail into (sux can't discover a hand-pasted script's contents to derive this automatically); omit to use the bare flag name for every category.`,
			},
		},
	},
	run: async (env: RtEnv, a: any) => {
		const categories = Array.isArray(a?.categories) ? a.categories.map(String) : undefined;
		const invalid = (categories ?? []).filter((c: string) => !ALL_SIEVE_CATEGORIES.includes(c as any));
		if (invalid.length) return failWith("bad_input", `unknown categor${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")} (valid: ${ALL_SIEVE_CATEGORIES.join(", ")})`);
		let mailboxOverrides: Record<string, string> | undefined;
		if (a?.mailboxes !== undefined) {
			if (typeof a.mailboxes !== "object" || a.mailboxes === null || Array.isArray(a.mailboxes))
				return failWith("bad_input", "mailboxes must be an object mapping a sieve flag to a target mailbox name.");
			const entries = Object.entries(a.mailboxes as Record<string, unknown>);
			const badFlags = entries.filter(([k]) => !(ALL_SIEVE_FLAGS as readonly string[]).includes(k)).map(([k]) => k);
			if (badFlags.length) return failWith("bad_input", `unknown mailboxes flag${badFlags.length === 1 ? "" : "s"}: ${badFlags.join(", ")} (valid: ${ALL_SIEVE_FLAGS.join(", ")})`);
			const badValues = entries.filter(([, v]) => typeof v !== "string" || !v.trim()).map(([k]) => k);
			if (badValues.length) return failWith("bad_input", `mailboxes values must be non-empty strings (flags: ${badValues.join(", ")})`);
			mailboxOverrides = Object.fromEntries(entries as Array<[string, string]>);
		}
		if (!env.FASTMAIL_TOKEN)
			return failWith("not_configured", "Fastmail JMAP not configured — set FASTMAIL_TOKEN to a JMAP-scoped API token (Fastmail → Settings → Privacy & Security → API tokens).");
		const mailbox = a?.mailbox ? String(a.mailbox) : "inbox";
		const max = Math.min(10000, Math.max(1, Math.floor(Number(a?.max) || 2000)));
		const dryRun = a?.dry_run !== false;
		const startedAt = Date.now();

		try {
			const boxResp = await runBatch(env, [["Mailbox/get", { properties: ["id", "name", "role", "parentId"] }, "m"]], { startedAt });
			const boxes: any[] = resultFor(boxResp.response.methodResponses, "Mailbox/get")?.list ?? [];
			const inMailbox = resolveMailbox(boxes, mailbox);
			if (!inMailbox) return failWith("not_found", `no mailbox matching '${mailbox}' — try a role like inbox/archive or a folder name.`);
			// The Sieve nesting target is always the account's REAL Inbox, independent of `mailbox`
			// (the scan target) above — those are conceptually different: this fn might be scanning
			// Archive while every target folder still nests under Inbox, same as the installed Sieve.
			const inboxBox = boxes.find((b) => String(b?.role ?? "").toLowerCase() === "inbox");
			const inboxId: string | undefined = inboxBox?.id ? String(inboxBox.id) : undefined;

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
			const matched: Array<{ id: string; flags: string[] }> = [];
			// Accumulated ACROSS pages, but each entry only grows after that page's write
			// succeeds — see the per-page apply below for why this can't be a plain byFlag Map.
			const appliedByFlag = new Map<string, { count: number; error?: string }>();
			// Target mailbox ids, resolved (and created if missing) lazily on first use — once per
			// flag per run, never per message/page. `boxes` grows in place as new folders get
			// created so a later resolveChildMailbox() in this same run sees them too.
			const targetIdByFlag = new Map<string, string>();
			async function ensureTargetMailbox(flag: string): Promise<string> {
				const cached = targetIdByFlag.get(flag);
				if (cached) return cached;
				if (!inboxId) throw new Error("could not resolve the account's Inbox mailbox (no mailbox with role=inbox) — needed to nest target mailboxes under it.");
				const name = mailboxNameForFlag(flag, mailboxOverrides);
				let id = resolveChildMailbox(boxes, inboxId, name);
				if (!id) {
					const { response: createResp } = await runBatch(env, [["Mailbox/set", { create: { m: { name, parentId: inboxId } } }, "c"]], { startedAt });
					const setR = resultFor(createResp.methodResponses, "Mailbox/set");
					const created = setR?.created?.m;
					if (!created?.id) throw new Error(`could not create mailbox '${name}': ${JSON.stringify(setR?.notCreated ?? {})}`);
					id = String(created.id);
					boxes.push({ id, name, role: null, parentId: inboxId });
				}
				targetIdByFlag.set(flag, id);
				return id;
			}
			let scanned = 0;
			let total: number | undefined;
			let done = false;

			while (scanned < max) {
				if (Date.now() - startedAt > BUDGET_MS) break; // clean stop at a page boundary; cursor at `position`
				const limit = Math.min(PAGE, max - scanned);
				const batch: Invocation[] = [
					["Email/query", { filter, sort: [{ property: "receivedAt", isAscending: true }], position, limit, calculateTotal: total === undefined }, "q"],
					["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "from", "subject"] }, "g"],
				];
				const { response } = await runBatch(env, batch, { startedAt });
				const query = resultFor(response.methodResponses, "Email/query");
				const get = resultFor(response.methodResponses, "Email/get");
				const ids: string[] = Array.isArray(query?.ids) ? query.ids.map(String) : [];
				if (total === undefined && Number.isFinite(Number(query?.total))) total = Number(query.total);

				const byId = new Map<string, { from?: unknown; subject?: unknown }>();
				for (const e of Array.isArray(get?.list) ? get.list : []) byId.set(String(e?.id), e);

				// Group THIS page's ids by flag (a message can land in several, e.g. junk+notification —
				// each flag it matches becomes one more mailbox it's ADDED to below, on top of the one
				// `mailboxIds/<inMailbox>: null` removal).
				const pageByFlag = new Map<string, string[]>();
				for (const id of ids) {
					const e = byId.get(id);
					const flags = matchCoarseCategories({ from: senderAddress(e?.from), subject: e?.subject ? String(e.subject) : undefined }, categories);
					if (!flags.length) continue;
					matched.push({ id, flags });
					for (const f of flags) {
						const arr = pageByFlag.get(f);
						if (arr) arr.push(id);
						else pageByFlag.set(f, [id]);
					}
				}

				// Apply (or, in dry-run, just tally via `matched` above) this page before advancing
				// the checkpoint — mirrors mail_domain_backfill: a page (≤200 ids) never approaches
				// maxObjectsInSet, and the resume cursor only ever advances past a written page, so a
				// mid-sweep budget stop or resume can't silently skip un-moved mail the way a single
				// end-of-scan Email/set over the whole window could. ONE Email/set update per page
				// (not one per flag) — a message matching several flags gets every target mailbox
				// added in the SAME patch, so a later flag's write can never clobber an earlier one's
				// (a per-flag REPLACE would have left only the last-processed flag's folder).
				let pageFailed = false;
				let movedThisPage = 0;
				if (!dryRun && pageByFlag.size) {
					const update: Record<string, Record<string, unknown>> = {};
					for (const [flag, flagIds] of pageByFlag) {
						const targetId = await ensureTargetMailbox(flag);
						for (const id of flagIds) {
							const patch = update[id] ?? { [`mailboxIds/${inMailbox}`]: null };
							patch[`mailboxIds/${targetId}`] = true;
							update[id] = patch;
						}
					}
					const { response: setResp } = await runBatch(env, [["Email/set", { update }, "s"]], { startedAt });
					const setR = resultFor(setResp.methodResponses, "Email/set");
					const updatedIds = new Set(Object.keys(setR?.updated ?? {}));
					const notUpdated = setR?.notUpdated ?? {};
					movedThisPage = updatedIds.size;
					for (const [flag, flagIds] of pageByFlag) {
						const prev = appliedByFlag.get(flag);
						const okCount = flagIds.filter((id) => updatedIds.has(id)).length;
						const failCount = flagIds.length - okCount;
						if (failCount) pageFailed = true;
						appliedByFlag.set(flag, {
							count: (prev?.count ?? 0) + okCount,
							...(failCount ? { error: `${failCount} failed on this page: ${JSON.stringify(notUpdated).slice(0, 200)}` } : prev?.error ? { error: prev.error } : {}),
						});
					}
				}

				// A failed page's ids stay un-moved, so don't advance scanned/position past it —
				// mirrors mail_domain_backfill's per-page isolation (see #703). The cursor still
				// points at THIS page's start, so a resume rescans and retries it (the mailboxIds
				// patch is idempotent, so re-applying a move that already succeeded is harmless).
				if (pageFailed) {
					done = false;
					break;
				}

				scanned += ids.length;
				// Moved messages disappear from the LIVE {inMailbox} set the next Email/query sees —
				// only advance `position` past the ones still sitting in `inMailbox` (see header note).
				position += ids.length - movedThisPage;
				if (ids.length < limit) {
					done = true;
					break;
				}
				// `total` was captured once, before any moves — stale the instant a move happens, so
				// this fast-path only fires when nothing has been (or ever will be, this call) moved.
				if (!movedThisPage && total !== undefined && position >= total) {
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
						would_move: matched.length,
						matches: matched,
						cursor,
						done,
						...(total !== undefined ? { total } : {}),
						note: "Nothing mutated. Pass dry_run:false to apply these mailbox moves; re-call with the returned cursor until done:true.",
					}),
				);
			}

			const applied: Array<{ flag: string; mailbox: string; count: number; error?: string }> = [...appliedByFlag].map(([flag, v]) => ({ flag, mailbox: mailboxNameForFlag(flag, mailboxOverrides), ...v }));
			return ok(oj({ dry_run: false, mailbox, scanned, moved: matched.length, applied, cursor, done, ...(total !== undefined ? { total } : {}) }));
		} catch (e) {
			if (e instanceof JmapError) return failWith(e.code, e.message);
			return failWith("upstream_error", errMsg(e));
		}
	},
};
