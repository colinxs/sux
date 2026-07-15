import type { Hit } from "./web_search";
import type { SearchScope } from "./web_search";
import { kagiSession, parseKagiMarkdown, withOperators } from "./web_search";
import { kagiTool } from "../kagi";
import type { Route } from "../proxy";
import { type Fn, fail, ok } from "../registry";
import type { RtEnv, ToolResult } from "../registry";
import { deliverBytes, fromB64, inlineB64, loadBytes, putBlob, toB64 } from "./_util";

export type Kind = "pdf" | "document" | "ebook" | "code" | "docs" | "artifact" | "reference" | "any";

const KIND_VALUES: readonly Kind[] = ["pdf", "document", "ebook", "code", "docs", "artifact", "reference", "any"];

export type Strategy = { kind: Kind; query: string };

export function isUrlInput(input: string): boolean {
	return /^https?:\/\//i.test(input.trim());
}

const FILE_CLAUSE_RE = /file\(\s*(\w+)\s*,\s*([^)]+)\)/gi;

// Each strategy fans into up to 2 free operator calls + up to 2 metered lens
// calls (KIND_PLANS) — an unbounded number of file() clauses is an unbounded
// Kagi-call fan-out per request, bypassing the per-request cost the rate
// limiter expects (security review finding). Keep this in sync with
// rate-limit.ts's requestCost("get", ...), which prices against the same cap.
export const MAX_GET_STRATEGIES = 5;

export function parseStrategies(input: string, kindArg?: string): Strategy[] {
	const clauses: Strategy[] = [];
	FILE_CLAUSE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FILE_CLAUSE_RE.exec(input)) && clauses.length < MAX_GET_STRATEGIES) {
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

async function normalizeBytes(env: RtEnv, bytes: Uint8Array, contentType: string, convertToPdf: boolean, deliver: "inline" | "url" | undefined): Promise<{ result: ToolResult; converted: boolean }> {
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

export async function fetchAndNormalize(env: RtEnv, url: string, convertToPdf: boolean, deliver: "inline" | "url" | undefined): Promise<{ result: ToolResult; converted: boolean }> {
	const { bytes, contentType } = await loadBytes(env, { url });
	return normalizeBytes(env, bytes, contentType ?? "", convertToPdf, deliver);
}

async function loadBytesFromUrl(env: RtEnv, url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
	const { bytes, contentType } = await loadBytes(env, { url });
	return { bytes, contentType: contentType ?? "application/octet-stream" };
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

export async function storeResult(env: RtEnv, bytes: Uint8Array, contentType: string, store: "vault" | "dropbox" | "r2", summarize: boolean): Promise<{ where: string; ref: string }> {
	const blobRef = await putBlob(env, bytes, contentType);
	if (store === "r2") return { where: "r2", ref: blobRef.url };

	const ingestFn = await findFn("ingest");
	const r = await ingestFn.run(env, { url: blobRef.url, blobs: store === "dropbox" ? "dropbox" : "auto", summarize, tags: ["get"] });
	if (r?.isError) throw new Error(r.content?.[0]?.text ?? "ingest failed");
	return { where: store, ref: r.content?.[0]?.text ?? blobRef.url };
}

export const get: Fn = {
	name: "get",
	cost: 5,
	description:
		"Universal 'get me a file'. `input` is either an absolute http(s) URL (URL mode) or a search query (query mode), optionally using file(kind, subquery) clauses to run several typed searches at once, e.g. file(pdf, textbook) file(code, react hooks). " +
		"Query mode fans out over Kagi: free session-scrape operator strategies (filetype:/site: — needs KAGI_SESSION) plus <=2 bounded metered lens strategies per kind (needs KAGI_API_KEY) — see `kind`. Hits are deduped into unique editions (same title+filetype mirrored across hosts collapses to one; a different filetype or a genuinely different title stays separate), the top edition is downloaded and normalized, and every unique edition is returned so a caller can re-pick. " +
		"URL mode turns the page into a durable artifact: `as:'pdf'` (default) renders it to PDF; `as:'archive'` prefers a Wayback snapshot, falling back to a live scrape. " +
		"Normalize: a PDF result is always compressed (object streams + stripped metadata). `convert:'pdf'` additionally converts html/plain-text results to PDF before compressing — docx/epub and other binary formats have no converter today and are returned as-is (`converted:false` in the result either way that happens). " +
		"`store` delegates to `ingest` (vault/dropbox/r2 blob routing); `summarize` (vault store only) adds an AI summary via the existing `summarize` fn's cost-conscious path. " +
		"`download:false` (query mode only) returns just the ranked editions, skipping the fetch/normalize/store steps entirely.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["input"],
		properties: {
			input: { type: "string", description: "An absolute http(s) URL, or a search query (optionally with file(kind, subquery) clauses)." },
			kind: { type: "string", enum: ["pdf", "document", "ebook", "code", "docs", "artifact", "reference", "any"], default: "any", description: "Query mode: which lens/operator strategies to run. Ignored when input contains file(kind, ...) clauses (each clause carries its own kind)." },
			as: { type: "string", enum: ["pdf", "archive"], default: "pdf", description: "URL mode: pdf render or web-archive capture." },
			convert: { type: "string", enum: ["pdf", "none"], default: "none", description: "Convert an html/text acquisition to PDF before compressing. No-op for other formats." },
			download: { type: "boolean", default: true, description: "Query mode: false returns only the ranked editions, skipping fetch/normalize/store." },
			store: { type: "string", enum: ["vault", "dropbox", "r2", "none"], default: "none", description: "Delegate to ingest's blob routing (vault/dropbox) or the raw content-addressed store (r2)." },
			summarize: { type: "boolean", default: false, description: "Vault store only: add an AI summary via the summarize fn." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Query mode: cap on merged/deduped editions." },
			include_domains: { type: "array", items: { type: "string" }, description: "Query mode: extra domains added to every operator strategy." },
			deliver: { type: "string", enum: ["inline", "url"], description: "base64 inline (default for small files) or a content-addressed /s/<uuid> URL." },
			proxy: { type: "boolean", default: false, description: "Route Kagi operator-strategy queries through the residential proxy." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const input = String(args?.input ?? "").trim();
		if (!input) return fail("input is required — a URL or a search query.");
		const deliver = args?.deliver === "url" ? "url" : args?.deliver === "inline" ? "inline" : undefined;
		const convertToPdf = args?.convert === "pdf";
		const route = args?.proxy === true ? "proxy" : "auto";

		try {
			if (isUrlInput(input)) {
				const as = args?.as === "archive" ? "archive" : "pdf";
				const { bytes, contentType } = await acquireFromUrl(env, input, as);
				if (!bytes.length) return fail(`Fetched 0 bytes from ${input} — the source is empty or the fetch was blocked; nothing to return.`);
				const { result: normalized, converted } = await normalizeBytes(env, bytes, contentType, convertToPdf, deliver);
				const out: Record<string, unknown> = { file: JSON.parse(normalized.content?.[0]?.text ?? "{}"), converted };
				if (args?.store && args.store !== "none") out.stored = await storeResult(env, bytes, contentType, args.store, args?.summarize === true);
				return ok(JSON.stringify(out));
			}

			const strategies = parseStrategies(input, typeof args?.kind === "string" ? args.kind : undefined);
			const extraDomains = Array.isArray(args?.include_domains) ? args.include_domains.map(String) : [];
			const hits = await runStrategies(env, strategies, extraDomains, route);
			const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
			const editions = dedupeEditions(hits).slice(0, limit);
			if (!editions.length) return fail(`No files found for "${input}".`);

			if (args?.download === false) return ok(JSON.stringify({ editions, picked: null }));

			const top = editions[0];
			const { bytes, contentType } = await loadBytesFromUrl(env, top.url);
			if (!bytes.length) return fail(`Downloaded 0 bytes from the top edition (${top.url}) — it's empty or the fetch was blocked. Retry, or use download:false to pick another edition.`);
			const { result: normalized, converted } = await normalizeBytes(env, bytes, contentType, convertToPdf, deliver);
			const out: Record<string, unknown> = { file: JSON.parse(normalized.content?.[0]?.text ?? "{}"), editions, picked: 0, converted };
			if (args?.store && args.store !== "none") out.stored = await storeResult(env, bytes, contentType, args.store, args?.summarize === true);
			return ok(JSON.stringify(out));
		} catch (e) {
			return fail(`get failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
