// Pure vault-graph helpers: frontmatter parsing, a JsonLogic-lite filter DSL over
// frontmatter fields, and structural PATCH transforms (frontmatter key / heading
// section / block-ref). Everything here is a pure text/value function — NO I/O,
// no env, no fetch — so it unit-tests without a vault and runs identically on the
// git backend (read → transform → commit) or a live backend. The I/O that scans
// notes and commits patches lives in vault-mcp.ts; this file is the evaluator.
//
// Why git-backend, not live-backend, coupled: JsonLogic-lite is pure evaluation
// over a note's already-parsed frontmatter (knowledge-core.md §2 separates it from
// Dataview DQL's live-only query engine), and structural PATCH is the same
// read+text-surgery+write pattern vault_edit already uses — neither needs the
// live Obsidian REST verb. True full-text / fuzzy / DQL search stays gated on the
// live vpc backend (vault-backends.md §1.2), and is deliberately NOT here.

// --- frontmatter parsing (YAML-lite, flat — the shape this vault actually uses) ---

export type Frontmatter = Record<string, unknown>;

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a note into its frontmatter block (parsed) and the body after it. A note
 * with no leading `---` fence yields an empty fm and the whole content as body. */
export function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
	const m = content.match(FENCE);
	if (!m) return { fm: {}, body: content };
	return { fm: parseYamlLite(m[1]), body: content.slice(m[0].length) };
}

// Enough YAML for Obsidian frontmatter: flat `key: value` scalars, inline arrays
// `[a, b]`, and block arrays (`key:` then `- item` lines). Anything fancier
// (nested maps, multi-line scalars) is kept as its raw string — never guessed at.
function parseYamlLite(block: string): Frontmatter {
	const fm: Frontmatter = {};
	const lines = block.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const kv = line.match(/^([A-Za-z0-9_.-]+):\s?(.*)$/);
		if (!kv) continue;
		const key = kv[1];
		const rest = kv[2];
		if (rest.trim() === "") {
			// A bare `key:` may head a block array of `- item` lines; else it's empty.
			const items: unknown[] = [];
			while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
				items.push(coerceScalar(lines[++i].replace(/^\s*-\s+/, "")));
			}
			fm[key] = items.length ? items : "";
		} else {
			fm[key] = coerceValue(rest);
		}
	}
	return fm;
}

function coerceValue(raw: string): unknown {
	const t = raw.trim();
	if (t.startsWith("[") && t.endsWith("]")) {
		const inner = t.slice(1, -1).trim();
		return inner === "" ? [] : inner.split(",").map((s) => coerceScalar(s.trim()));
	}
	return coerceScalar(t);
}

function coerceScalar(raw: string): unknown {
	const t = raw.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
	if (t === "true") return true;
	if (t === "false") return false;
	if (t === "null" || t === "") return t === "null" ? null : "";
	// Keep dates/ids/versions (2026-07-09, 1.2.3) as strings; only a clean number is a number.
	if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
	return t;
}

// --- simple field/value match (the back-compat vault_query form) ---

/** Match one frontmatter field: value omitted → presence; array field →
 * membership; scalar field → equality. String-coerced so `year: 2017` matches
 * both `2017` and "2017" (models pass frontmatter values as strings). */
export function frontmatterMatches(fm: Frontmatter, field: string, value?: unknown): boolean {
	const got = fm[field];
	if (value === undefined) return got !== undefined;
	if (Array.isArray(got)) return got.some((x) => eq(x, value));
	return eq(got, value);
}

const eq = (a: unknown, b: unknown): boolean => a === b || String(a) === String(b);

// --- JsonLogic-lite filter DSL over frontmatter ---
//
// Shape (the LEFT operand of every comparator is a frontmatter FIELD NAME, the
// RIGHT is a literal — the shorthand knowledge-core.md §2 calls "JsonLogic for
// type=project AND status=active"):
//   {and:[...]} {or:[...]} {not:<filter>}
//   {"==":[field,val]} {"!=":[field,val]}
//   {">":[field,val]} {"<":...} {">=":...} {"<=":...}   numeric else lexical (ISO dates order)
//   {"in":[field,val]}   array-membership, same semantics as frontmatterMatches
//
// Missing-field rule: a present-value comparator on an absent field is false
// (so `>=` never matches a note lacking the field); `!=` on an absent field is
// TRUE (a note with no `status` is not `status == done`).

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
	const rebuilt = content.replace(FENCE, `---${nl}${lines.join(nl)}${nl}---${nl}`);
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
	return /^\s|\s$|[:#\[\]{},&*!|>'"%@`]/.test(s) ? JSON.stringify(s) : s;
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
