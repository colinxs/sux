import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { ALL_SIEVE_CATEGORIES, matchCoarseCategories } from "./_mail_sieve";
import { type Invocation, JmapError, runBatch } from "./_jmap";
import { errMsg, fromB64, oj, toB64 } from "./_util";

// mail_sieve_backfill — a ONE-TIME pass applying mail_sieve's coarse tags to mail that already
// exists in the mailbox. Sieve only ever evaluates at delivery time; it can't retroactively touch
// anything already sitting in a folder, so this fn is the backfill companion: same rule set
// (matchCoarseCategories, shared with mail_sieve so the two can never drift), applied via a JMAP
// keyword-add (`label:add`), exactly like _mail_triage's own reversible-tag ops. dry_run defaults
// true: report what WOULD be tagged without mutating anything; pass dry_run:false to actually apply
// the labels.
//
// Scale: mail_search caps at 50/page and shapes heavy fields, so this scans the jmap engine directly
// — Email/query (position-paged, oldest-first) + Email/get fetching only ["id","from","subject"] —
// the same shape mail_domain_backfill uses. Each 55s-budgeted call sweeps a bounded page window,
// tags it, and returns a resumable `cursor` + `done` flag; re-calling with the cursor advances the
// sweep, so a large mailbox drains across a handful of invocations. `hasListUnsubscribe` is never
// set here — the engine scan fetches only id/from/subject, not headers — so that one rule never
// fires on backfill, same limitation as the prior mail_search-backed pass.

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
		"One-time backfill: apply mail_sieve's coarse tags (junk / mailing-list / gh,gitlab,vercel,ci / notification) to mail that ALREADY exists in a mailbox — a live Sieve script only tags NEW deliveries, so this fn covers the backlog once. Uses the SAME rule set as mail_sieve (from/subject cues; the List-Unsubscribe-header rule never fires here since the engine scan fetches no headers). Scans the jmap engine directly (Email/query + Email/get, past mail_search's 50-cap), oldest-first. Applies a reversible `label:add` via a JMAP keyword-add, same op class as mail_triage. dry_run:true (default) reports what WOULD be tagged without mutating anything; pass dry_run:false to actually label. Resumable: each 55s-budgeted call sweeps a page window and returns {cursor, done} — re-call with the cursor until done:true to drain a large mailbox.",
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
			dry_run: { type: "boolean", default: true, description: "true (default): report matches only, mutate nothing. false: actually apply the label:add ops." },
			cursor: { type: "string", description: "Opaque cursor from a prior call — resumes the sweep where it left off (must be the same mailbox). Omit to start fresh." },
		},
	},
	run: async (env: RtEnv, a: any) => {
		const categories = Array.isArray(a?.categories) ? a.categories.map(String) : undefined;
		const invalid = (categories ?? []).filter((c: string) => !ALL_SIEVE_CATEGORIES.includes(c as any));
		if (invalid.length) return failWith("bad_input", `unknown categor${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")} (valid: ${ALL_SIEVE_CATEGORIES.join(", ")})`);
		if (!env.FASTMAIL_TOKEN)
			return failWith("not_configured", "Fastmail JMAP not configured — set FASTMAIL_TOKEN to a JMAP-scoped API token (Fastmail → Settings → Privacy & Security → API tokens).");
		const mailbox = a?.mailbox ? String(a.mailbox) : "inbox";
		const max = Math.min(10000, Math.max(1, Math.floor(Number(a?.max) || 2000)));
		const dryRun = a?.dry_run !== false;
		const startedAt = Date.now();

		try {
			const boxResp = await runBatch(env, [["Mailbox/get", { properties: ["id", "name", "role"] }, "m"]], { startedAt });
			const boxes: any[] = resultFor(boxResp.response.methodResponses, "Mailbox/get")?.list ?? [];
			const inMailbox = resolveMailbox(boxes, mailbox);
			if (!inMailbox) return failWith("not_found", `no mailbox matching '${mailbox}' — try a role like inbox/archive or a folder name.`);

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
			const matched: Array<{ id: string; flags: string[] }> = [];
			// Accumulated ACROSS pages, but each entry only grows after that page's write
			// succeeds — see the per-page apply below for why this can't be a plain byFlag Map.
			const appliedByFlag = new Map<string, { count: number; error?: string }>();
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

				// Group THIS page's ids by flag (a message can land in several, e.g. junk+notification).
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
				// the checkpoint — mirrors mail_domain_backfill: a page (≤200 ids/flag) never
				// approaches maxObjectsInSet, and the resume cursor only ever advances past a
				// written page, so a mid-sweep budget stop or resume can't silently skip un-tagged
				// mail the way a single end-of-scan Email/set over the whole window could.
				let pageFailed = false;
				if (!dryRun) {
					for (const [flag, kwIds] of pageByFlag) {
						const lr = await mail!.labelMessages(env, kwIds, flag, true);
						const prev = appliedByFlag.get(flag);
						if (lr.isError) {
							appliedByFlag.set(flag, { count: prev?.count ?? 0, error: lr.content?.[0]?.text ?? "label failed" });
							pageFailed = true;
						} else appliedByFlag.set(flag, { count: (prev?.count ?? 0) + kwIds.length });
					}
				}

				// A failed page's ids stay un-tagged, so don't advance scanned/position past it —
				// mirrors mail_domain_backfill's per-page isolation (see #703). The cursor still
				// points at THIS page's start, so a resume rescans and retries it (label:add is
				// idempotent, so re-applying flags that already succeeded on this page is harmless).
				if (pageFailed) {
					done = false;
					break;
				}

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

			if (dryRun) {
				return ok(
					oj({
						dry_run: true,
						mailbox,
						scanned,
						would_tag: matched.length,
						matches: matched,
						cursor,
						done,
						...(total !== undefined ? { total } : {}),
						note: "Nothing mutated. Pass dry_run:false to apply these label:add ops; re-call with the returned cursor until done:true.",
					}),
				);
			}

			const applied: Array<{ flag: string; count: number; error?: string }> = [...appliedByFlag].map(([flag, v]) => ({ flag, ...v }));
			return ok(oj({ dry_run: false, mailbox, scanned, tagged: matched.length, applied, cursor, done, ...(total !== undefined ? { total } : {}) }));
		} catch (e) {
			if (e instanceof JmapError) return failWith(e.code, e.message);
			return failWith("upstream_error", errMsg(e));
		}
	},
};
