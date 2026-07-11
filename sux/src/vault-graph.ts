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
export function frontmatterMatches(fm: Record<string, unknown>, field: string, value?: string): boolean {
	if (!(field in fm)) return false;
	if (value === undefined || value === null || value === "") return true;
	const v = fm[field];
	const want = String(value).toLowerCase();
	if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase() === want);
	return String(v).toLowerCase() === want;
}
