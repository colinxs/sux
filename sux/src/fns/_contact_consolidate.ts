// Duplicate-CONTACT detection — the missing half #965 documents: contact.ts already exposes
// full JMAP ContactCard CRUD, and contact_delete is already a STAGE_KINDS-gated verb, but
// nothing ever looked for duplicate cards (same email/phone, or a fuzzy name match like
// "Colin Powell" vs "C. Powell" vs a stray import-duplicate "Colin Powell (work)"). Unlike
// _consolidate.ts's duplicateKey (a single path-derived string key), a contact card has no one
// field that reliably identifies "the same person" — so this groups by ANY of three
// field-based signals (shared email, shared phone, or a fuzzy name match) via union-find, not
// a single key lookup. Crude but cheap on purpose: every cluster this produces is only ever a
// PROPOSAL a human approves or rejects (contact_consolidate_plan.ts's durable run), never
// auto-applied — so, mirroring _consolidate.ts's duplicateKey, this favors recall over
// precision.
import type { RtEnv } from "../registry";

// A truthy toggle ("0"/"false"/"off"/empty ⇒ off) — mirrors _consolidate.ts/_cross_semantic.ts's
// flagOn, so an explicit CONTACT_CONSOLIDATE_ENABLED=0 stays off rather than arming on mere presence.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The contact-consolidation sweep may run at all. Unset ⇒ the feature is dormant (no-op). */
export const hasContactConsolidate = (env: RtEnv): boolean => flagOn(env.CONTACT_CONSOLIDATE_ENABLED);

/** Trimmed to what dedup detection needs — matches contact_search's shapeContact() reference shape. */
export type ContactRef = { id: string; name?: string; emails?: string[]; phones?: string[]; company?: string };
export type DuplicateContactCluster = { ids: string[] };

const normEmail = (e: string): string => e.trim().toLowerCase();

/** caps.ts's contactsMergeSink tags an already-merged archive by appending this pointer to its
 *  raw name field rather than deleting it — but normName() below strips ALL parenthetical
 *  content before fuzzy-matching, making that tag invisible to the detector and letting the
 *  same archive re-propose forever (#989). Check the RAW name, before normName() strips it. */
const isMergedArchive = (name?: string): boolean => /\(merged into [^)]*\)/.test(name ?? "");

/** Strips a trailing extension suffix (" ext 22", " ext. 22", "x22", "#22") before digit
 *  normalization — otherwise "555-123-4567 ext 22" and "555-123-4567" digit-collapse to
 *  different-length keys and never cluster as the same underlying number (#1013). */
const stripExtension = (p: string): string => p.replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, "");

/** Digits only, US country-code (leading "1" on 11 digits) stripped so "+1 (555) 123-4567" and
 *  "555-123-4567" collapse to the same key. Shorter than 7 digits is too weak a signal (a
 *  stray extension-only number) to treat as a match — left out of the phone index entirely.
 *  Exported so _contact_consolidate_plan.ts's merge step can dedup by the same key it clustered
 *  on (#995), not just an exact-string match that misses format variants. */
export const normPhone = (p: string): string => stripExtension(p).replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

/** Strips a parenthetical tag ("(work)", "(home)", an already-applied "(merged into ...)"
 *  pointer) from a raw display name while preserving case/spacing — for when a raw name is
 *  chosen as a MERGED value (_contact_consolidate_plan.ts, #995), not just for the fuzzy-match
 *  comparison below, where case/punctuation don't matter. */
export const stripNameTags = (name: string): string => name.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();

/** Lowercased, parenthetical tags ("(work)", "(home)") and punctuation stripped, whitespace
 *  collapsed — "Colin Powell (work)" and "colin  powell" both become "colin powell". */
const normName = (name?: string): string =>
	stripNameTags(name ?? "")
		.toLowerCase()
		.replace(/[^a-z\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** Two normalized names are a fuzzy match when they share a last name (the final word) and
 *  either the first word matches exactly or one side is a single-letter initial of the
 *  other's ("colin powell" / "c powell" both match "powell" + c===c). */
function namesMatch(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	const wa = a.split(" ").filter(Boolean);
	const wb = b.split(" ").filter(Boolean);
	if (wa.length < 1 || wb.length < 1) return false;
	if (wa[wa.length - 1] !== wb[wb.length - 1]) return false;
	const [fa, fb] = [wa[0], wb[0]];
	if (fa === fb) return true;
	return (fa.length === 1 || fb.length === 1) && fa[0] === fb[0];
}

// Cross-call accumulation (#993) — contact_search/contact_consolidate_plan's own 100-per-call
// cap means findDuplicateContacts only ever sees ONE page at a time; a duplicate pair split
// across two pages (A in page 1, its match B in page 2) is never proposed no matter how many
// times the whole book gets paged through, since no single call's `contacts` array holds both.
// Persist a lightweight cross-call "seen" index (mirrors _files_semantic.ts's KV_KEY/readBlob/
// writeBlob shape) so each call clusters against every contact scanned so far this sweep, not
// just its own page.
const SEEN_KV_KEY = "sux:contacts:consolidate:seen";
// Bounds the accumulated set against an unbounded address book — the O(n²) name-fuzzing pass
// in findDuplicateContacts would otherwise grow without limit across a many-thousand-contact
// book. Mirrors _files_semantic.ts's INDEX_MAX cap.
const MAX_SEEN = 2000;

async function readSeenContacts(env: RtEnv): Promise<ContactRef[]> {
	const raw = await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.get(SEEN_KV_KEY).catch(() => null);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed?.contacts) ? parsed.contacts.filter((c: unknown): c is ContactRef => typeof (c as { id?: unknown })?.id === "string") : [];
	} catch {
		return [];
	}
}

async function writeSeenContacts(env: RtEnv, contacts: ContactRef[]): Promise<void> {
	try {
		await (env as { OAUTH_KV?: KVNamespace }).OAUTH_KV?.put(SEEN_KV_KEY, JSON.stringify({ contacts }));
	} catch {
		/* best-effort cache write — a failed persist just narrows the next call back to within-page detection */
	}
}

/** Folds one page's contacts into the persisted cross-call seen-index and returns the full
 *  accumulated set to cluster against. `position === 0` starts a FRESH sweep (so a repeat full
 *  scan doesn't keep accumulating a stale prior sweep's contacts forever); later positions merge
 *  onto whatever's already persisted. Capped at MAX_SEEN, keeping the most-recently-seen entries. */
export async function accumulateSeenContacts(env: RtEnv, position: number, page: ContactRef[]): Promise<ContactRef[]> {
	const prior = position === 0 ? [] : await readSeenContacts(env);
	const byId = new Map(prior.map((c) => [c.id, c]));
	for (const c of page) byId.set(c.id, c);
	let merged = [...byId.values()];
	if (merged.length > MAX_SEEN) merged = merged.slice(merged.length - MAX_SEEN);
	await writeSeenContacts(env, merged);
	return merged;
}

/** Union-find over a set of contacts — either a single page, or (via accumulateSeenContacts,
 *  #993) the cross-call accumulated seen-index, MAX_SEEN-capped so the O(n²) name-fuzzing pass
 *  below stays cheap: two contacts land in the same cluster when they share a normalized email,
 *  a normalized phone, or a fuzzy-matching name. Singleton groups (nothing else matched) are
 *  dropped — only real candidate clusters of 2+ come back. */
export function findDuplicateContacts(rawContacts: ContactRef[]): DuplicateContactCluster[] {
	const contacts = rawContacts.filter((c) => !isMergedArchive(c.name));
	const n = contacts.length;
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	};

	const byEmail = new Map<string, number[]>();
	const byPhone = new Map<string, number[]>();
	const names = contacts.map((c) => normName(c.name));
	contacts.forEach((c, i) => {
		for (const e of c.emails ?? []) {
			const k = normEmail(e);
			if (!k) continue;
			const list = byEmail.get(k) ?? [];
			list.push(i);
			byEmail.set(k, list);
		}
		for (const p of c.phones ?? []) {
			const k = normPhone(p);
			if (k.length < 7) continue;
			const list = byPhone.get(k) ?? [];
			list.push(i);
			byPhone.set(k, list);
		}
	});
	for (const idxs of byEmail.values()) for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
	// A key shorter than 10 digits has no area code — two different people can each have a
	// bare local number on file in different area codes and land on the identical key. Only
	// auto-cluster a short key when the names also corroborate the match (#1013); a
	// full 10+-digit key is unambiguous enough to cluster on its own.
	for (const [key, idxs] of byPhone) {
		for (let i = 1; i < idxs.length; i++) {
			if (key.length >= 10 || (names[idxs[0]] && names[idxs[i]] && namesMatch(names[idxs[0]], names[idxs[i]]))) {
				union(idxs[0], idxs[i]);
			}
		}
	}
	for (let i = 0; i < n; i++) {
		if (!names[i]) continue;
		for (let j = i + 1; j < n; j++) {
			if (!names[j]) continue;
			if (namesMatch(names[i], names[j])) union(i, j);
		}
	}

	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		const list = groups.get(r) ?? [];
		list.push(i);
		groups.set(r, list);
	}
	const clusters: DuplicateContactCluster[] = [];
	for (const idxs of groups.values()) {
		if (idxs.length < 2) continue;
		clusters.push({ ids: idxs.map((i) => contacts[i].id) });
	}
	return clusters;
}
