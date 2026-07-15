// Vault graph primitives — the pure text layer under vault_backlinks / vault_query / vault_tags
// (workflow §4). Obsidian semantics: wikilinks resolve by basename, tags come from inline #tags
// plus a frontmatter `tags` field, frontmatter is the leading --- YAML block. No I/O here — these
// parse one note's text; vault-mcp scans the git store and maps these over every note.

/** A note path → its Obsidian basename (drop folders + the .md extension), lower-cased for matching. */
export function noteBasename(path: string): string {
	const base = path.split("/").pop() ?? path;
	return base.replace(/\.md$/i, "").toLowerCase();
}

/** All [[wikilink]] targets in a note — alias (`|`), heading (`#`), and block (`^`) refs stripped. */
export function extractWikilinks(content: string): string[] {
	const out: string[] = [];
	for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
		const target = m[1].split("|")[0].split("#")[0].split("^")[0].trim();
		if (target) out.push(target);
	}
	return out;
}

/** Does a wikilink target resolve to a note path? Obsidian matches by basename, or by full relative path. */
export function linkResolvesTo(link: string, targetPath: string): boolean {
	const l = link.toLowerCase().replace(/\.md$/i, "");
	return noteBasename(link) === noteBasename(targetPath) || l === targetPath.toLowerCase().replace(/\.md$/i, "");
}

const stripQuotes = (s: string): string => s.replace(/^["']|["']$/g, "").trim();

/** Parse a leading `---` YAML frontmatter block. Handles `k: v`, inline `[a, b]`, and block lists. */
export function parseFrontmatter(content: string): Record<string, unknown> {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: Record<string, unknown> = {};
	let curKey: string | null = null;
	for (const raw of m[1].split(/\r?\n/)) {
		const item = raw.match(/^\s*-\s+(.*)$/);
		if (item && curKey && Array.isArray(out[curKey])) {
			(out[curKey] as string[]).push(stripQuotes(item[1]));
			continue;
		}
		const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		const [, key, rawVal] = kv;
		const val = rawVal.trim();
		if (val === "") {
			out[key] = []; // a block list may follow
			curKey = key;
			continue;
		}
		curKey = null;
		if (/^\[.*\]$/.test(val)) out[key] = val.slice(1, -1).split(",").map((s) => stripQuotes(s)).filter(Boolean);
		else out[key] = stripQuotes(val);
	}
	return out;
}

/** All tags on a note: the frontmatter `tags` field ∪ inline #tags (code spans/blocks excluded). */
export function extractTags(content: string, fm: Record<string, unknown>): string[] {
	const set = new Set<string>();
	const fmTags = fm.tags ?? fm.tag;
	if (Array.isArray(fmTags)) fmTags.forEach((t) => t && set.add(String(t).replace(/^#/, "")));
	else if (typeof fmTags === "string") fmTags.split(/[,\s]+/).forEach((t) => t && set.add(t.replace(/^#/, "")));
	const body = content
		.replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`]*`/g, "");
	for (const m of body.matchAll(/(?:^|\s)#([A-Za-z][A-Za-z0-9_/-]*)/g)) set.add(m[1]);
	return [...set];
}

/** Does a frontmatter field match a wanted value? Equality, array-membership, or mere presence (no value). */
export function frontmatterMatches(fm: Record<string, unknown>, field: string, value?: unknown): boolean {
	if (!(field in fm)) return false;
	if (value === undefined || value === null || value === "") return true;
	const v = fm[field];
	const want = String(value).toLowerCase();
	if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase() === want);
	return String(v).toLowerCase() === want;
}

// ---------------------------------------------------------------------------
// JsonLogic-lite frontmatter filter + structural PATCH transforms (from the
// obsidian-structured-search work; grafted onto P4's graph layer). Pure text.
// ---------------------------------------------------------------------------
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const eq = (a: unknown, b: unknown): boolean => a === b || String(a) === String(b);
type Frontmatter = Record<string, unknown>;
export type Filter = Record<string, unknown>;

export function evalFilter(fm: Frontmatter, filter: Filter): boolean {
	if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("filter must be a JsonLogic object, e.g. {\"==\":[\"type\",\"project\"]}");
	const keys = Object.keys(filter);
	if (keys.length !== 1) throw new Error(`filter node must have exactly one operator, got: ${keys.join(", ") || "(none)"}`);
	const op = keys[0];
	const arg = filter[op];

	switch (op) {
		case "and":
			return asFilters(op, arg).every((f) => evalFilter(fm, f));
		case "or":
			return asFilters(op, arg).some((f) => evalFilter(fm, f));
		case "not":
			return !evalFilter(fm, arg as Filter);
		case "in": {
			const [field, val] = asPair(op, arg);
			return frontmatterMatches(fm, field, val);
		}
		case "==":
		case "!=":
		case ">":
		case "<":
		case ">=":
		case "<=": {
			const [field, val] = asPair(op, arg);
			return compare(op, fm[field], val);
		}
		default:
			throw new Error(`unknown filter operator '${op}' — use and/or/not, ==, !=, >, <, >=, <=, in`);
	}
}

function asFilters(op: string, arg: unknown): Filter[] {
	if (!Array.isArray(arg)) throw new Error(`'${op}' takes an array of filters`);
	return arg as Filter[];
}

function asPair(op: string, arg: unknown): [string, unknown] {
	if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[0] !== "string") {
		throw new Error(`'${op}' takes [field, value] with a string field name`);
	}
	return [arg[0] as string, arg[1]];
}

function compare(op: string, got: unknown, val: unknown): boolean {
	if (op === "==") return got === undefined ? false : eq(got, val);
	if (op === "!=") return got === undefined ? true : !eq(got, val);
	if (got === undefined) return false; // ordered compare on an absent field never matches
	const gN = Number(got);
	const vN = Number(val);
	const numeric = Number.isFinite(gN) && Number.isFinite(vN) && String(got).trim() !== "" && String(val).trim() !== "";
	const [a, b]: [number | string, number | string] = numeric ? [gN, vN] : [String(got), String(val)];
	switch (op) {
		case ">":
			return a > b;
		case "<":
			return a < b;
		case ">=":
			return a >= b;
		case "<=":
			return a <= b;
	}
	return false;
}

// --- structural PATCH transforms (pure text surgery; read+write lives in the tool) ---
//
// Each returns { content, changed }: changed:false when the target already holds
// the requested text (idempotent — a re-run makes no empty commit). A target that
// isn't found, or is ambiguous, THROWS with a clear message — mirroring
// vault_edit's unique-match discipline so a patch never lands somewhere unintended.

export type PatchResult = { content: string; changed: boolean };
export type PatchMode = "replace" | "append" | "prepend";

const eol = (s: string) => (s.includes("\r\n") ? "\r\n" : "\n");

/** Set/replace a top-level frontmatter key (creating the block if the note has
 * none). Operates ONLY inside the `---` fence, so a `key:` line in the body is
 * never touched. Idempotent: setting the same serialized value changes nothing. */
export function patchFrontmatter(content: string, field: string, value: unknown): PatchResult {
	if (!/^[A-Za-z0-9_.-]+$/.test(field)) throw new Error(`invalid frontmatter field name '${field}'`);
	const nl = eol(content);
	const serialized = `${field}: ${serializeValue(value)}`;
	const m = content.match(FENCE);
	if (!m) {
		return { content: `---${nl}${serialized}${nl}---${nl}${nl}${content}`, changed: true };
	}
	const block = m[1];
	const lines = block.split(/\r?\n/);
	const keyRe = new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s?(.*)$`);
	const idx = lines.findIndex((l) => keyRe.test(l));
	if (idx === -1) {
		lines.push(serialized);
	} else {
		if (lines[idx] === serialized) return { content, changed: false };
		// Drop any block-array `- item` continuation lines the old key owned.
		let end = idx + 1;
		while (end < lines.length && /^\s*-\s+/.test(lines[end])) end++;
		lines.splice(idx, end - idx, serialized);
	}
	// A FUNCTION replacement so `$`-sequences in the values (e.g. `$1`, `$$`, `$&`) are
	// taken literally — a string replacement would expand them (FENCE has a capture group),
	// silently corrupting any value containing `$`.
	const rebuilt = content.replace(FENCE, () => `---${nl}${lines.join(nl)}${nl}---${nl}`);
	return { content: rebuilt, changed: rebuilt !== content };
}

function serializeValue(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((v) => serializeScalar(v)).join(", ")}]`;
	return serializeScalar(value);
}

function serializeScalar(value: unknown): string {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const s = String(value ?? "");
	// Quote only when a bare scalar would reparse wrong (leading/trailing space, or
	// YAML-significant punctuation); keep clean strings/dates unquoted for readability.
	// An embedded newline must always quote too — unquoted it would prematurely
	// close the `---` frontmatter fence (or inject pseudo-frontmatter/body text).
	return /^\s|\s$|\n|[:#\[\]{},&*!|>'"%@`]/.test(s) ? JSON.stringify(s) : s;
}

/** Operate on the section under a `# Heading` (matched by heading text at any
 * level; must be unique). The section runs from just after the heading line to
 * the next heading of the same-or-higher level (or EOF). replace swaps the
 * section body; append adds to its end; prepend inserts right after the heading. */
export function patchHeadingSection(content: string, heading: string, mode: PatchMode, text: string): PatchResult {
	const nl = eol(content);
	const lines = content.split(/\r?\n/);
	const want = heading.replace(/^#+\s*/, "").trim();
	const heads = lines
		.map((l, i) => ({ i, m: l.match(/^(#{1,6})\s+(.*?)\s*$/) }))
		.filter((h) => h.m && h.m[2].trim() === want);
	if (heads.length === 0) throw new Error(`heading not found: '${want}'`);
	if (heads.length > 1) throw new Error(`heading '${want}' matches ${heads.length} times — make it unique`);
	const start = heads[0].i;
	const level = heads[0].m![1].length;
	let end = start + 1;
	while (end < lines.length) {
		const h = lines[end].match(/^(#{1,6})\s+/);
		if (h && h[1].length <= level) break;
		end++;
	}
	// Section body = (start+1 .. end); trim its trailing blank lines for clean edits.
	let bodyEnd = end;
	while (bodyEnd > start + 1 && lines[bodyEnd - 1].trim() === "") bodyEnd--;
	const before = lines.slice(0, start + 1);
	const body = lines.slice(start + 1, bodyEnd);
	const after = lines.slice(end);
	const insert = text.split(/\r?\n/);

	let next: string[];
	if (mode === "replace") next = [...before, ...insert];
	else if (mode === "prepend") next = [...before, ...insert, ...body];
	else next = [...before, ...body, ...insert]; // append
	// Reattach the tail with one blank separator when both sides have content.
	const joined = after.length ? [...next, "", ...after] : next;
	const rebuilt = joined.join(nl);
	return { content: rebuilt, changed: rebuilt !== content };
}

/** Operate on the block anchored by `^blockId` (unique). replace rewrites the
 * anchored line's text (keeping the anchor); append/prepend add a line after/
 * before it. blockId may be given with or without the leading `^`. */
export function patchBlockRef(content: string, blockId: string, mode: PatchMode, text: string): PatchResult {
	const nl = eol(content);
	const id = blockId.replace(/^\^/, "");
	if (!/^[\w-]+$/.test(id)) throw new Error(`invalid block id '${blockId}'`);
	const lines = content.split(/\r?\n/);
	const anchorRe = new RegExp(`\\s\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
	const hits = lines.map((l, i) => ({ i, l })).filter((x) => anchorRe.test(x.l));
	if (hits.length === 0) throw new Error(`block ref not found: '^${id}'`);
	if (hits.length > 1) throw new Error(`block ref '^${id}' matches ${hits.length} times — block ids must be unique`);
	const at = hits[0].i;
	if (mode === "prepend") lines.splice(at, 0, text);
	else if (mode === "append") lines.splice(at + 1, 0, text);
	else lines[at] = `${text} ^${id}`; // replace: keep the anchor
	const rebuilt = lines.join(nl);
	return { content: rebuilt, changed: rebuilt !== content };
}
