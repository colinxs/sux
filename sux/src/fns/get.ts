import type { Hit } from "./web_search";
import type { SearchScope } from "./web_search";

export type Kind = "pdf" | "document" | "ebook" | "code" | "docs" | "artifact" | "reference" | "any";

const KIND_VALUES: readonly Kind[] = ["pdf", "document", "ebook", "code", "docs", "artifact", "reference", "any"];

export type Strategy = { kind: Kind; query: string };

export function isUrlInput(input: string): boolean {
	return /^https?:\/\//i.test(input.trim());
}

const FILE_CLAUSE_RE = /file\(\s*(\w+)\s*,\s*([^)]+)\)/gi;

export function parseStrategies(input: string, kindArg?: string): Strategy[] {
	const clauses: Strategy[] = [];
	FILE_CLAUSE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FILE_CLAUSE_RE.exec(input))) {
		const kind = m[1].toLowerCase();
		if ((KIND_VALUES as readonly string[]).includes(kind)) clauses.push({ kind: kind as Kind, query: m[2].trim() });
	}
	if (clauses.length) return clauses;
	const kind = KIND_VALUES.includes(kindArg as Kind) ? (kindArg as Kind) : "any";
	return [{ kind, query: input.trim() }];
}

// Verified 2026-07-15 against the account's kagi.com/settings/lenses (edit-link
// hrefs). Built-ins (pdfs/usenetArchive/academic) share IDs across every Kagi
// account; the custom lenses (documentHosts..wikisNotes) are unique to this one
// and require "Share Lens Link" enabled or Kagi silently ignores the lens_id.
export const LENSES = {
	pdfs: "3",
	usenetArchive: "5648",
	academic: "2",
	documentHosts: "31362",
	codeSearch: "31363",
	techDocs: "31364",
	artifacts: "31365",
	wikisNotes: "31366",
} as const;

export type KindPlan = { operatorScopes: SearchScope[]; lensIds: string[] };

// Each kind maps to <=2 lens ids so metered spend is bounded regardless of how
// wide the operator fan-out is (operatorScopes run over the free KAGI_SESSION
// path; lensIds are the only calls that cost KAGI_API_KEY spend).
export const KIND_PLANS: Record<Kind, KindPlan> = {
	pdf: { operatorScopes: [{ file_type: "pdf" }], lensIds: [LENSES.pdfs] },
	document: { operatorScopes: [{ file_type: "pdf" }, { file_type: "docx" }], lensIds: [LENSES.documentHosts, LENSES.pdfs] },
	ebook: { operatorScopes: [{ file_type: "epub" }, { include_domains: ["archive.org"] }], lensIds: [LENSES.usenetArchive, LENSES.documentHosts] },
	code: { operatorScopes: [], lensIds: [LENSES.codeSearch] },
	docs: { operatorScopes: [], lensIds: [LENSES.techDocs] },
	artifact: { operatorScopes: [], lensIds: [LENSES.artifacts] },
	reference: { operatorScopes: [], lensIds: [LENSES.wikisNotes] },
	any: { operatorScopes: [{ file_type: "pdf" }, { include_domains: ["archive.org"] }], lensIds: [LENSES.pdfs, LENSES.usenetArchive] },
};

export type Edition = { title: string; url: string; host: string; filetype: string; rank: number };

function normalizeTitle(t: string): string {
	return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function guessFiletype(url: string): string {
	const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
	return m ? m[1].toLowerCase() : "";
}

// Dedup key is title+filetype WITHOUT host — same document mirrored across
// hosts must collapse to one edition (host only differs by mirror, not by
// content), while a different filetype (epub vs pdf) or a title that names a
// distinct edition/format stays a separate entry.
export function dedupeEditions(hits: Hit[]): Edition[] {
	const seen = new Map<string, Edition>();
	let rank = 0;
	for (const h of hits) {
		if (!h?.url) continue;
		let host: string;
		try {
			host = new URL(h.url).hostname;
		} catch {
			continue;
		}
		const filetype = guessFiletype(h.url);
		const key = `${normalizeTitle(h.title)}::${filetype}`;
		if (!seen.has(key)) {
			rank++;
			seen.set(key, { title: h.title, url: h.url, host, filetype, rank });
		}
	}
	return [...seen.values()];
}
