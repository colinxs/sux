import type { Hit } from "./web_search";
import type { SearchScope } from "./web_search";
import { kagiSession, parseKagiMarkdown, withOperators } from "./web_search";
import { kagiTool } from "../kagi";
import type { Route } from "../proxy";
import type { RtEnv, ToolResult } from "../registry";
import { deliverBytes, fromB64, inlineB64, loadBytes, toB64 } from "./_util";

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

export async function runStrategies(env: any, strategies: Strategy[], extraDomains: string[], route: Route): Promise<Hit[]> {
	if (!env?.KAGI_SESSION && !env?.KAGI_API_KEY) throw new Error("Neither KAGI_SESSION nor KAGI_API_KEY is configured — get needs at least one to search.");

	const calls: Promise<Hit[]>[] = [];
	for (const { kind, query } of strategies) {
		const plan = KIND_PLANS[kind];
		if (env?.KAGI_SESSION) {
			for (const scope of plan.operatorScopes) {
				const merged: SearchScope = { ...scope, include_domains: [...(scope.include_domains ?? []), ...extraDomains] };
				calls.push(kagiSession(env, withOperators(query, merged), 10, route).catch(() => [] as Hit[]));
			}
		}
		if (env?.KAGI_API_KEY) {
			for (const lens_id of plan.lensIds) {
				calls.push(
					kagiTool(env, "kagi_search_fetch", { query, limit: 10, lens_id }, route)
						.then((r) => parseKagiMarkdown(r?.content?.[0]?.text ?? "", 10))
						.catch(() => [] as Hit[]),
				);
			}
		}
	}
	const results = await Promise.all(calls);
	return results.flat();
}

async function findFn(name: string): Promise<{ run: (env: any, args: any) => Promise<ToolResult> }> {
	const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Array<{ name: string; run: (env: any, args: any) => Promise<ToolResult> }> };
	const fn = FUNCTIONS.find((f) => f.name === name);
	if (!fn) throw new Error(`the \`${name}\` fn is not available`);
	return fn;
}

const isPdfMagic = (b: Uint8Array): boolean => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

export async function fetchAndNormalize(env: RtEnv, url: string, convertToPdf: boolean, deliver: "inline" | "url" | undefined): Promise<{ result: ToolResult; converted: boolean }> {
	const { bytes, contentType } = await loadBytes(env, { url });
	const ct = contentType ?? "";
	const asArg = deliver === "url" ? "url" : "base64";

	if (isPdfMagic(bytes)) {
		const pdfFn = await findFn("pdf");
		return { result: await pdfFn.run(env, { data: toB64(bytes), compress: true, as: asArg }), converted: false };
	}

	const convertibleKind = /html/i.test(ct) ? "html" : /^text\//i.test(ct) ? "text" : null;
	if (convertToPdf && convertibleKind) {
		const pdfFn = await findFn("pdf");
		return { result: await pdfFn.run(env, { data: toB64(bytes), kind: convertibleKind, compress: true, as: asArg }), converted: true };
	}

	// No converter for this content — deliver the fetched bytes as-is, respecting `deliver`.
	const mime = ct || "application/octet-stream";
	return { result: await deliverBytes(env, bytes, mime, deliver === "url" ? "url" : undefined, () => inlineB64(bytes, mime)), converted: false };
}

export async function acquireFromUrl(env: RtEnv, url: string, as: "pdf" | "archive"): Promise<{ bytes: Uint8Array; contentType: string }> {
	if (as === "pdf") {
		const renderFn = await findFn("render");
		const r = await renderFn.run(env, { url, as: "pdf", delivery: "base64" });
		if (r?.isError) throw new Error(r.content?.[0]?.text ?? "render failed");
		const parsed = JSON.parse(r.content?.[0]?.text ?? "{}") as { mime?: string; base64?: string };
		if (!parsed.base64) throw new Error("render did not return pdf bytes");
		return { bytes: fromB64(parsed.base64), contentType: parsed.mime ?? "application/pdf" };
	}

	const waybackFn = await findFn("wayback");
	const w = await waybackFn.run(env, { url, mode: "snapshot" });
	if (!w?.isError) {
		const snap = JSON.parse(w.content?.[0]?.text ?? "{}") as { available?: boolean; raw_url?: string };
		if (snap.available && snap.raw_url) {
			const { bytes, contentType } = await loadBytes(env, { url: snap.raw_url });
			return { bytes, contentType: contentType ?? "text/html" };
		}
	}

	const scrapeFn = await findFn("scrape");
	const s = await scrapeFn.run(env, { url });
	if (s?.isError) throw new Error(s.content?.[0]?.text ?? "scrape failed");
	const html = s.content?.[0]?.text ?? "";
	return { bytes: new TextEncoder().encode(html), contentType: "text/html" };
}
