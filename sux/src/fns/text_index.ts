import zlib from "node:zlib";
import { type Fn, fail, ok } from "../registry";

// A tiny, dependency-free full-text search index: build an inverted index over
// documents, rank queries with BM25, and (to pair with compress/uncompress) emit
// the index gzip+base64 or read one back transparently. Pure node:zlib + JS.

const Z = zlib as any;
const STOP = new Set("a an and are as at be by for from has he in is it its of on that the to was were will with this or not you your we our".split(" "));

type Doc = { id: string; len: number };
type IndexBlob = { v: 1; n: number; avgdl: number; docs: Doc[]; postings: Record<string, Array<[number, number]>> };

function tokenize(text: string, keepStop: boolean): string[] {
	const toks = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
	return keepStop ? toks : toks.filter((t) => !STOP.has(t));
}

function build(documents: Array<string | { id?: string; text: string }>, keepStop: boolean): IndexBlob {
	const docs: Doc[] = [];
	const postings: Record<string, Array<[number, number]>> = {};
	let total = 0;
	documents.forEach((d, i) => {
		const text = typeof d === "string" ? d : String(d?.text ?? "");
		const id = typeof d === "string" ? String(i) : String(d?.id ?? i);
		const toks = tokenize(text, keepStop);
		const tf: Record<string, number> = {};
		for (const t of toks) tf[t] = (tf[t] ?? 0) + 1;
		for (const [term, f] of Object.entries(tf)) (postings[term] ??= []).push([i, f]);
		docs.push({ id, len: toks.length });
		total += toks.length;
	});
	return { v: 1, n: docs.length, avgdl: docs.length ? total / docs.length : 0, docs, postings };
}

/** Accept an index as an object, a JSON string, or a gzip+base64 blob (uncompress). */
function loadIndex(index: unknown): IndexBlob {
	if (index && typeof index === "object") return index as IndexBlob;
	if (typeof index === "string") {
		const s = index.trim();
		if (s.startsWith("{")) return JSON.parse(s);
		// Otherwise treat as base64-gzipped JSON.
		const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(Z.gunzipSync(bytes)));
	}
	throw new Error("`index` must be the built index (object, JSON, or gzip+base64 string).");
}

function query(idx: IndexBlob, q: string, limit: number, keepStop: boolean) {
	const terms = tokenize(q, keepStop);
	const k1 = 1.5;
	const b = 0.75;
	const scores = new Map<number, number>();
	for (const term of new Set(terms)) {
		const post = idx.postings[term];
		if (!post) continue;
		const df = post.length;
		const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
		for (const [di, tf] of post) {
			const dl = idx.docs[di]?.len ?? 0;
			const denom = tf + k1 * (1 - b + (b * dl) / (idx.avgdl || 1));
			scores.set(di, (scores.get(di) ?? 0) + idf * ((tf * (k1 + 1)) / (denom || 1)));
		}
	}
	return [...scores.entries()]
		.sort((a, b2) => b2[1] - a[1])
		.slice(0, limit)
		.map(([di, score]) => ({ id: idx.docs[di].id, score: Number(score.toFixed(4)) }));
}

export const textIndex: Fn = {
	name: "index",
	description:
		"Build a full-text search index over documents and query it with BM25 ranking. `mode: build` (default) takes `documents` (array of strings or {id,text}) and returns the inverted index; add `compress: true` to return it gzip+base64 (pair with `uncompress`/the compress tool for storage). " +
		"`mode: query` takes `index` (the built index — object, JSON, or a gzip+base64 blob, transparently decompressed) and a `query`, returning the top matching document ids with scores. Pure and dependency-free; index results from search/web_search/shop/local_shop, crawl, etc.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			mode: { type: "string", enum: ["build", "query"], default: "build" },
			documents: { type: "array", description: "build: documents to index (strings or { id, text }).", items: {} },
			index: { description: "query: the index from a prior build (object, JSON string, or gzip+base64)." },
			query: { type: "string", description: "query: the search query." },
			limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
			stopwords: { type: "boolean", description: "Drop common English stop words. Default true.", default: true },
			compress: { type: "boolean", description: "build: return the index gzip+base64 instead of raw JSON.", default: false },
		},
	},
	cacheable: true,
	raw: true,
	run: async (_env, args) => {
		const mode = String(args?.mode ?? "build");
		const keepStop = args?.stopwords === false;

		if (mode === "build") {
			if (!Array.isArray(args?.documents) || args.documents.length === 0) return fail("Provide a non-empty `documents` array.");
			const idx = build(args.documents, keepStop);
			const json = JSON.stringify(idx);
			if (args?.compress === true) {
				const gz = Z.gzipSync(new TextEncoder().encode(json), { level: 9 }) as Uint8Array;
				let bin = "";
				for (const c of gz) bin += String.fromCharCode(c);
				return ok(JSON.stringify({ compressed: true, codec: "gzip", n: idx.n, in_bytes: json.length, out_bytes: gz.length, base64: btoa(bin) }, null, 2));
			}
			return ok(json);
		}

		if (mode === "query") {
			const q = String(args?.query ?? "").trim();
			if (!q) return fail("Provide a `query`.");
			if (args?.index === undefined) return fail("Provide the `index` from a prior build.");
			let idx: IndexBlob;
			try {
				idx = loadIndex(args.index);
			} catch (e) {
				return fail(`Could not read index: ${String((e as Error).message ?? e)}`);
			}
			const hits = query(idx, q, Math.min(100, Math.max(1, Number(args?.limit) || 10)), keepStop);
			return ok(JSON.stringify({ query: q, hits }, null, 2));
		}

		return fail(`Unknown mode '${mode}'. Use build or query.`);
	},
};
