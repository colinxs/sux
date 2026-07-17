// Shared scaffolding for position-paged JMAP backfill sweeps (mail_domain_backfill today;
// mail_sieve_backfill migrates onto this once it scans the jmap engine directly — see #678/#685).
// Each consumer owns its own classify+label step; this module owns the parts that don't vary:
// mailbox resolution, the Email/query+Email/get position cursor, and the batch result lookup.
import { JmapError } from "./_jmap";
import { fromB64, toB64 } from "./_util";

/** JMAP EmailAddress[] → the first sender address string. */
export function senderAddress(from: unknown): string | undefined {
	if (!Array.isArray(from)) return undefined;
	for (const x of from) {
		const email = (x as { email?: unknown })?.email;
		if (typeof email === "string" && email) return email;
	}
	return undefined;
}

/** Resolve a mailbox arg (role like "inbox", display name, or raw id) to a mailbox id, or undefined. */
export function resolveMailbox(boxes: any[], mailbox: string): string | undefined {
	const key = mailbox.toLowerCase();
	const byRole = boxes.find((b) => String(b?.role ?? "").toLowerCase() === key);
	if (byRole) return byRole.id;
	const byName = boxes.find((b) => String(b?.name ?? "").toLowerCase() === key);
	if (byName) return byName.id;
	return boxes.some((b) => b?.id === mailbox) ? mailbox : undefined;
}

/** The first methodResponse for `method`; throws JmapError on a method-level JMAP error in the batch. */
export function resultFor(methodResponses: any[], method: string): any {
	for (const mr of methodResponses ?? []) {
		if (mr[0] === method) return mr[1];
		if (mr[0] === "error") throw new JmapError("upstream_error", `JMAP ${method}: ${mr[1]?.type ?? "error"}${mr[1]?.description ? " — " + mr[1].description : ""}`);
	}
	return null;
}

export type Cursor = { v: 1; inMailbox: string; position: number };
export const encodeCursor = (c: Cursor): string => toB64(new TextEncoder().encode(JSON.stringify(c)));
export const decodeCursor = (s: string): Cursor => JSON.parse(new TextDecoder().decode(fromB64(s)));

// One Email/get page pulls up to 200 ids (the engine's per-page cap); a per-call scan bounded by
// `max` keeps scan + write comfortably inside the 55s fn budget. Writes go one Email/set per keyword
// PER PAGE, so a page (≤200 ids/keyword) never approaches maxObjectsInSet and the resume cursor only
// ever advances past a fully-written page (a mid-call budget stop can't skip un-tagged mail).
export const PAGE = 200;
export const BUDGET_MS = 50_000;
