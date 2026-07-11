import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { obsidian } from "./obsidian";
import { errMsg } from "./_util";

// citation — turn a scholarly result into a durable, exportable reference. Three
// actions over one normalized entry shape (vault-backends.md Part 3):
//   format  — PURE: entries[] → BibTeX + CSL-JSON (no vault; the testable core).
//   capture — write a `type: citation` note to References/<citekey>.md in the vault
//             (via the obsidian fn, git backend → every write a revertible commit).
//   export  — walk References/*.md, parse the frontmatter, emit a combined .bib string.
// Handle-first: PDFs live as a `pdf:` dropbox handle in the note, never inlined here.

const REF_DIR = "References";
const STOPWORDS = new Set(["a", "an", "the", "on", "of", "in", "for", "and", "to", "with"]);

type Author = { family: string; given?: string };
type Entry = {
	key?: string;
	type?: string; // article | book | inproceedings | misc
	title: string;
	authors?: Array<string | Author>;
	year?: number | string;
	doi?: string;
	url?: string;
	container?: string; // journal / book / proceedings title
	publisher?: string;
	volume?: string;
	pages?: string;
	pdf?: string; // a dropbox handle, kept in the note, not the bib
};

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Normalize one author to {family, given}. Accepts "Family, Given", "Given Family", or the object. */
function normAuthor(a: string | Author): Author {
	if (typeof a === "object" && a) return { family: String(a.family ?? "").trim(), given: a.given ? String(a.given).trim() : undefined };
	const s = String(a).trim();
	if (s.includes(",")) {
		const [family, given] = s.split(",", 2).map((x) => x.trim());
		return { family, given: given || undefined };
	}
	const parts = s.split(/\s+/);
	if (parts.length === 1) return { family: parts[0] };
	return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(" ") };
}

const authorLabel = (a: Author): string => (a.given ? `${a.family}, ${a.given}` : a.family);

/** Deterministic citekey: <firstAuthorFamily><year><firstSignificantTitleWord>, all alnum-lowercased. */
function citeKey(e: Entry): string {
	const authors = (e.authors ?? []).map(normAuthor);
	const fam = authors[0]?.family ? alnum(authors[0].family) : "anon";
	const yr = e.year ? String(e.year).replace(/\D/g, "") : "";
	const word = (e.title || "").split(/\s+/).map((w) => alnum(w)).find((w) => w && !STOPWORDS.has(w)) ?? "";
	return `${fam}${yr}${word}` || "ref";
}

/** BibTeX for one entry. Values are brace-wrapped; a stray brace in a value is stripped (BibTeX-unsafe). */
function toBibtex(e: Entry): string {
	const key = e.key || citeKey(e);
	const type = e.type || (e.container ? "article" : "misc");
	const authors = (e.authors ?? []).map(normAuthor).map(authorLabel).join(" and ");
	const field = (k: string, v: unknown): string | null => {
		const s = v === undefined || v === null ? "" : String(v).replace(/[{}]/g, "").trim();
		return s ? `  ${k} = {${s}}` : null;
	};
	const containerKey = type === "book" ? "publisher" : type === "inproceedings" ? "booktitle" : "journal";
	const lines = [field("title", e.title), field("author", authors), field("year", e.year), field(containerKey, e.container ?? (type === "book" ? e.publisher : undefined)), field("volume", e.volume), field("pages", e.pages), field("publisher", type === "book" ? undefined : e.publisher), field("doi", e.doi), field("url", e.url)].filter(Boolean);
	return `@${type}{${key},\n${lines.join(",\n")}\n}`;
}

/** CSL-JSON for one entry. */
function toCsl(e: Entry): Record<string, unknown> {
	const authors = (e.authors ?? []).map(normAuthor).map((a) => ({ family: a.family, ...(a.given ? { given: a.given } : {}) }));
	const yr = e.year ? Number(String(e.year).replace(/\D/g, "")) : undefined;
	const typeMap: Record<string, string> = { article: "article-journal", book: "book", inproceedings: "paper-conference", misc: "document" };
	return {
		id: e.key || citeKey(e),
		type: typeMap[e.type || (e.container ? "article" : "misc")] ?? "document",
		title: e.title,
		...(authors.length ? { author: authors } : {}),
		...(yr ? { issued: { "date-parts": [[yr]] } } : {}),
		...(e.container ? { "container-title": e.container } : {}),
		...(e.publisher ? { publisher: e.publisher } : {}),
		...(e.volume ? { volume: String(e.volume) } : {}),
		...(e.pages ? { page: String(e.pages) } : {}),
		...(e.doi ? { DOI: e.doi } : {}),
		...(e.url ? { URL: e.url } : {}),
	};
}

/** The `type: citation` note: YAML frontmatter (machine-readable) + a human body. */
function citationNote(e: Entry, key: string): string {
	const authors = (e.authors ?? []).map(normAuthor).map(authorLabel);
	const fm = [
		"---",
		"type: citation",
		`citekey: ${key}`,
		`title: ${JSON.stringify(e.title)}`,
		authors.length ? `authors: [${authors.map((a) => JSON.stringify(a)).join(", ")}]` : null,
		e.year ? `year: ${String(e.year).replace(/\D/g, "")}` : null,
		e.container ? `container: ${JSON.stringify(e.container)}` : null,
		e.publisher ? `publisher: ${JSON.stringify(e.publisher)}` : null,
		e.volume ? `volume: ${JSON.stringify(String(e.volume))}` : null,
		e.pages ? `pages: ${JSON.stringify(String(e.pages))}` : null,
		e.type ? `entry_type: ${e.type}` : null,
		e.doi ? `doi: ${JSON.stringify(e.doi)}` : null,
		e.url ? `url: ${JSON.stringify(e.url)}` : null,
		e.pdf ? `pdf: ${JSON.stringify(e.pdf)}` : null,
		"---",
	].filter(Boolean);
	return `${fm.join("\n")}\n\n# ${e.title}\n\n${authors.join(", ")}${e.year ? ` (${String(e.year).replace(/\D/g, "")})` : ""}${e.container ? `. *${e.container}*` : ""}.\n${e.doi ? `\nDOI: ${e.doi}` : ""}${e.url ? `\n${e.url}` : ""}${e.pdf ? `\n\nPDF: \`${e.pdf}\`` : ""}\n`;
}

/** Parse the small frontmatter subset citation notes write, back into an Entry. */
function parseFrontmatter(md: string): Entry | null {
	const m = /^---\n([\s\S]*?)\n---/.exec(md);
	if (!m) return null;
	const fm: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
		if (kv) fm[kv[1]] = kv[2].trim();
	}
	if (fm.type !== "citation") return null;
	const unq = (v?: string): string | undefined => {
		if (!v) return undefined;
		try {
			return typeof JSON.parse(v) === "string" ? JSON.parse(v) : v;
		} catch {
			return v;
		}
	};
	// A malformed authors line must not throw and drop an otherwise-valid citation from export.
	let authors: string[] | undefined;
	try {
		authors = fm.authors ? (JSON.parse(fm.authors) as string[]) : undefined;
	} catch {
		authors = undefined;
	}
	return { key: fm.citekey, type: fm.entry_type, title: unq(fm.title) ?? "", authors, year: fm.year, container: unq(fm.container), publisher: unq(fm.publisher), volume: unq(fm.volume), pages: unq(fm.pages), doi: unq(fm.doi), url: unq(fm.url), pdf: unq(fm.pdf) };
}

async function obs(env: RtEnv, args: Record<string, unknown>): Promise<any> {
	const r = await obsidian.run(env, { backend: "git", ...args });
	const text = r.content?.[0]?.text ?? "";
	if (r.isError) throw new Error(text);
	try {
		return JSON.parse(text);
	} catch {
		return { text };
	}
}

/** citation needs a vault backend (git or remote) to capture/export. */
const hasVault = (env: RtEnv): boolean => Boolean(env.OBSIDIAN_VAULT_REPO || env.OBSIDIAN_REMOTE_URL);

/** Read one References/ note, returning its parsed citation entry or null if absent/non-citation. */
async function readCitation(env: RtEnv, key: string): Promise<Entry | null> {
	try {
		const note = await obs(env, { action: "read", path: `${REF_DIR}/${key}.md` });
		return parseFrontmatter(String(note?.content ?? note?.text ?? ""));
	} catch {
		return null; // not found (or unreadable) → the slot is free
	}
}

/** Find a non-colliding citekey: reuse the slot for the SAME paper (idempotent re-capture), else suffix a/b/c… */
async function freeCiteKey(env: RtEnv, base: string, entry: Entry): Promise<string> {
	for (let i = 0; i < 26; i++) {
		const k = i === 0 ? base : `${base}${String.fromCharCode(96 + i)}`;
		const existing = await readCitation(env, k);
		if (!existing) return k; // free slot
		// Same work → reuse (overwrite): match on DOI, else on title when neither has a DOI.
		const same = entry.doi ? existing.doi === entry.doi : !existing.doi && existing.title === entry.title;
		if (same) return k;
	}
	return `${base}${entry.doi ? entry.doi.replace(/\W+/g, "") : entry.year ?? ""}z`; // pathological fallback, still deterministic
}

const asEntries = (a: any): Entry[] => (Array.isArray(a?.entries) ? a.entries : a?.title ? [a] : []);

export const citation: Fn = {
	name: "citation",
	cost: 1,
	cacheable: false,
	description:
		"Reference management over a vault References/ folder. action: format (entries[] → BibTeX + CSL-JSON, PURE, no vault) | capture (write a type:citation note to References/<citekey>.md from title/authors/year/doi/url/container/pdf, returns the citekey + BibTeX) | export (walk References/*.md and emit a combined .bib; pass `write:true` to save it to References/library.bib). " +
		"An entry: {title, authors:[\"Family, Given\"|{family,given}], year, type:article|book|inproceedings, doi?, url?, container?, publisher?, volume?, pages?, pdf?(a dropbox handle)}. capture/export use the obsidian fn (git backend) so every write is a revertible commit; needs OBSIDIAN_VAULT_REPO (+ GITHUB_TOKEN for writes).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["format", "capture", "export"] },
			entries: { type: "array", items: { type: "object" }, description: "format: the entries to render." },
			write: { type: "boolean", description: "export: also write the .bib to References/library.bib." },
			// A single inline entry's fields (capture, or format of one entry):
			title: { type: "string" },
			authors: { type: "array", items: {} },
			year: { type: ["string", "integer"] },
			type: { type: "string", enum: ["article", "book", "inproceedings", "misc"] },
			doi: { type: "string" },
			url: { type: "string" },
			container: { type: "string" },
			publisher: { type: "string" },
			volume: { type: ["string", "integer"] },
			pages: { type: "string" },
			pdf: { type: "string", description: "A dropbox handle, kept in the note (never inlined)." },
			key: { type: "string", description: "Override the derived citekey." },
		},
	},
	run: async (env: RtEnv, a: any) => {
		const action = String(a?.action ?? "");
		try {
			if (action === "format") {
				const entries = asEntries(a);
				if (!entries.length) return failWith("bad_input", "citation format needs `entries` (or a single entry's fields).");
				// Disambiguate colliding citekeys within the batch (a/b/c…) so the .bib has no duplicate keys.
				const seen = new Map<string, number>();
				const keyed = entries.map((e) => {
					const base = e.key || citeKey(e);
					const n = seen.get(base) ?? 0;
					seen.set(base, n + 1);
					return { ...e, key: n === 0 ? base : `${base}${String.fromCharCode(96 + n)}` };
				});
				return ok(JSON.stringify({ bibtex: keyed.map(toBibtex).join("\n\n"), csl: keyed.map(toCsl) }, null, 2));
			}
			if (action === "capture") {
				if (!hasVault(env)) return failWith("not_configured", "citation capture needs a vault — set OBSIDIAN_VAULT_REPO (+ GITHUB_TOKEN for writes) or the remote backend.");
				if (!a?.title) return failWith("bad_input", "citation capture requires a `title`.");
				const entry = a as Entry;
				// Never clobber a DIFFERENT paper that hashed to the same key — reuse the slot only for the same work.
				const key = await freeCiteKey(env, entry.key || citeKey(entry), entry);
				const path = `${REF_DIR}/${key}.md`;
				await obs(env, { action: "write", path, content: citationNote(entry, key) });
				return ok(JSON.stringify({ ok: true, citekey: key, path, bibtex: toBibtex({ ...entry, key }) }, null, 2));
			}
			if (action === "export") {
				if (!hasVault(env)) return failWith("not_configured", "citation export needs a vault — set OBSIDIAN_VAULT_REPO or the remote backend.");
				const listing = await obs(env, { action: "list", path: REF_DIR });
				// list returns REPO-relative paths (they include any OBSIDIAN_VAULT_DIR prefix); obsidian read re-applies
				// the dir, so strip it here or every read 404s and export silently yields an empty bibliography.
				const dir = String((env as { OBSIDIAN_VAULT_DIR?: string }).OBSIDIAN_VAULT_DIR ?? "").replace(/^\/+|\/+$/g, "");
				const files: string[] = (listing?.files ?? listing?.notes ?? listing?.entries ?? []).map((f: any) => (typeof f === "string" ? f : f?.path)).filter((p: string) => p && p.endsWith(".md"));
				const entries: Entry[] = [];
				for (const raw of files) {
					const p = dir && raw.startsWith(`${dir}/`) ? raw.slice(dir.length + 1) : raw;
					try {
						const note = await obs(env, { action: "read", path: p });
						const e = parseFrontmatter(String(note?.content ?? note?.text ?? ""));
						if (e) entries.push(e);
					} catch {
						/* skip an unreadable/non-citation note */
					}
				}
				const bibtex = entries.map(toBibtex).join("\n\n");
				if (a?.write === true && bibtex) await obs(env, { action: "write", path: `${REF_DIR}/library.bib`, content: `${bibtex}\n` });
				return ok(JSON.stringify({ count: entries.length, bibtex, ...(a?.write === true ? { written: `${REF_DIR}/library.bib` } : {}) }, null, 2));
			}
			return failWith("bad_input", `citation: unknown action '${action}'.`);
		} catch (e) {
			return failWith("upstream_error", `citation ${action} failed: ${errMsg(e)}`);
		}
	},
};
