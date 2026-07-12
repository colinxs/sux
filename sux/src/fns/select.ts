import { type Fn, fail, ok } from "../registry";
import { loadHtml, oj } from "./_util";

/** Escape regex metacharacters so a user-supplied attribute name can't inject
 * regex syntax (or throw) when interpolated into an attribute-matching pattern. */
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Simple = {
	tag: string | null;
	id: string | null;
	classes: string[];
	attr: string | null;
	attrVal: string | null;
};

/** Parse one compound selector like `a.btn#x[href="/y"]` (no combinators). */
function parseSimple(sel: string): Simple | null {
	const m = sel.match(/^([a-z0-9]+|\*)?((?:[.#][\w-]+)*)(?:\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/i);
	if (!m) return null;
	const [, tagRaw, chain = "", attr, attrVal] = m;
	const tag = !tagRaw || tagRaw === "*" ? null : tagRaw.toLowerCase();
	const id = (chain.match(/#([\w-]+)/) ?? [])[1] ?? null;
	const classes = (chain.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1));
	if (!tag && !id && !classes.length && !attr) return null;
	return { tag, id, classes, attr: attr ?? null, attrVal: attrVal ?? null };
}

/** Does an element (its full outer HTML) satisfy a single simple selector? */
function elementMatches(el: string, s: Simple): boolean {
	const open = el.match(/^<[a-z0-9]+\b([^>]*)>/i);
	if (!open) return false;
	const attrs = open[1];
	if (s.id && !new RegExp(`\\bid=["']${s.id}["']`, "i").test(attrs)) return false;
	if (s.classes.length) {
		const cls = attrs.match(/\bclass=["']([^"']*)["']/i)?.[1] ?? "";
		const have = new Set(cls.split(/\s+/).filter(Boolean));
		if (!s.classes.every((c) => have.has(c))) return false;
	}
	if (s.attr) {
		const av = attrs.match(new RegExp(`\\b${escapeRegex(s.attr)}=["']([^"']*)["']`, "i"));
		if (!av) return false;
		if (s.attrVal !== null && av[1] !== s.attrVal) return false;
	}
	return true;
}

/** The content between an element's own open and close tags (its innerHTML). */
function innerHtml(el: string): string {
	const open = el.match(/^<[a-z0-9]+\b[^>]*>/i);
	if (!open) return "";
	const close = el.match(/<\/[a-z0-9]+\s*>$/i);
	return el.slice(open[0].length, close ? el.length - close[0].length : el.length);
}

/** All top-level elements whose tag matches `tag` (or any tag), returning outer HTML. */
function findByTag(html: string, tag: string | null): string[] {
	const t = tag ?? "[a-z0-9]+";
	const re = new RegExp(`<(${t})\\b([^>]*?)(\\/?)>`, "gi");
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		const name = m[1];
		const selfClose = m[3] === "/" || /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(name);
		if (selfClose) {
			out.push(m[0]);
			continue;
		}
		// Walk forward to the matching close tag, accounting for nesting of the same tag.
		const openRe = new RegExp(`<${name}\\b[^>]*?(?<!/)>|<\\/${name}\\s*>`, "gi");
		openRe.lastIndex = m.index;
		let depth = 0;
		let end = -1;
		let om: RegExpExecArray | null;
		while ((om = openRe.exec(html))) {
			if (om[0].startsWith("</")) {
				if (--depth === 0) {
					end = om.index + om[0].length;
					break;
				}
			} else {
				depth++;
			}
		}
		if (end === -1) end = html.length;
		out.push(html.slice(m.index, end));
	}
	return out;
}

/** Split a selector list on commas that sit outside `[...]` and quotes, so a
 * comma inside an attribute value (e.g. `meta[content="a,b"]`) stays intact. */
function splitSelectorList(selector: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < selector.length; i++) {
		const ch = selector[i];
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "[") {
			depth++;
		} else if (ch === "]") {
			if (depth > 0) depth--;
		} else if (ch === "," && depth === 0) {
			out.push(selector.slice(start, i));
			start = i + 1;
		}
	}
	out.push(selector.slice(start));
	return out.map((g) => g.trim()).filter(Boolean);
}

/** Evaluate one comma-free selector (space-separated descendant steps). A
 * pathological input (e.g. a 100k-char "tag" that overflows the regex engine)
 * can't match any real element, so degrade to no matches rather than throwing. */
function selectOne(html: string, selector: string): string[] {
	try {
		return selectOneUnsafe(html, selector);
	} catch {
		return [];
	}
}

function selectOneUnsafe(html: string, selector: string): string[] {
	const steps = selector.trim().split(/\s+/).map(parseSimple);
	if (steps.some((s) => s === null)) return [];
	let scopes = [html];
	let results: string[] = [];
	steps.forEach((step, i) => {
		const next: string[] = [];
		for (const scope of scopes) {
			for (const el of findByTag(scope, (step as Simple).tag)) {
				if (elementMatches(el, step as Simple)) next.push(el);
			}
		}
		results = next;
		scopes = next.map(innerHtml); // descend into matched elements' contents (not the elements themselves)
	});
	return results;
}

export const select: Fn = {
	name: "select",
	description:
		"Query HTML with a CSS selector and return matches. Provide `html` or `url`, plus a required `selector`. Supported subset (pragmatic pure matcher, no browser): tag, .class, #id, [attr], [attr=val], compounds (div.card, a[href]), comma lists (h1, h2), and simple descendant combinators (space, e.g. 'div.post a'). NOT supported: >, +, ~, :pseudo, nth-child. By default returns each match's text; pass `attr` to return that attribute's value instead. Returns a JSON array (capped at `limit`, default 50).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["selector"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to fetch (used if `html` is absent)." },
			html: { type: "string", description: "Raw HTML to query." },
			selector: { type: "string", description: "e.g. 'a.button', '#main h2', 'meta[name]', 'h1, h2'." },
			attr: { type: "string", description: "Return this attribute's value from each match instead of its text." },
			limit: { type: "integer", default: 50, minimum: 1, maximum: 1000, description: "Max matches to return." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const selector = String(args?.selector ?? "").trim();
		if (!selector) return fail("Provide a `selector`.");

		const loaded = await loadHtml(env, args);
		if ("error" in loaded) return fail(loaded.error);
		const html = loaded.html;

		const limit = Math.min(Number(args?.limit) || 50, 1000);
		const attr = args?.attr != null ? String(args.attr) : null;

		// Comma list = union of each group's matches, de-duplicated by outer HTML.
		const groups = splitSelectorList(selector);
		const seen = new Set<string>();
		const els: string[] = [];
		for (const g of groups) {
			for (const el of selectOne(html, g)) {
				if (!seen.has(el)) {
					seen.add(el);
					els.push(el);
				}
			}
		}
		if (!els.length) return ok("[]");

		const out: string[] = [];
		for (const el of els) {
			if (attr) {
				const open = el.match(/^<[a-z0-9]+\b([^>]*)>/i);
				// A junk `attr` (e.g. a 100k-char string) can overflow the regex
				// engine — treat it as no match instead of letting it throw.
				let v: string | undefined;
				try {
					v = open?.[1].match(new RegExp(`\\b${escapeRegex(attr)}=["']([^"']*)["']`, "i"))?.[1];
				} catch {
					v = undefined;
				}
				if (v != null) out.push(v);
			} else {
				out.push(el.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim());
			}
			if (out.length >= limit) break;
		}
		return ok(oj(out));
	},
};
