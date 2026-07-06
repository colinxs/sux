import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

function matchSelector(html: string, sel: string): string[] {
	const s = sel.trim();
	const m = s.match(/^([a-z0-9]+)?(?:#([\w-]+))?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:[~|^$*]?=["']?([^"'\]]*)["']?)?\])?$/i);
	if (!m) return [];
	const [, tagRaw, id, classChain, attr, attrVal] = m;
	const tag = tagRaw || "[a-z0-9]+";
	const classes = (classChain.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1));
	const re = new RegExp(`<(${tag})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, "gi");
	const out: string[] = [];
	for (const el of html.matchAll(re)) {
		const attrs = el[2];
		if (id && !new RegExp(`id=["']${id}["']`, "i").test(attrs)) continue;
		if (classes.length) {
			const cls = attrs.match(/class=["']([^"']*)["']/i)?.[1] ?? "";
			const have = new Set(cls.split(/\s+/));
			if (!classes.every((c) => have.has(c))) continue;
		}
		if (attr) {
			const av = attrs.match(new RegExp(`${attr}=["']([^"']*)["']`, "i"));
			if (!av) continue;
			if (attrVal && av[1] !== attrVal) continue;
		}
		out.push(el[0]);
	}
	return out;
}

export const select: Fn = {
	name: "select",
	description:
		"Query HTML with a CSS selector (subset: tag, #id, .class, [attr], [attr=val], and combinations like div.card or a[href]). return: html (default) | text | attr. With return='attr', pass `attr` to pull that attribute from each match.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["selector"],
		properties: {
			url: { type: "string" },
			html: { type: "string" },
			selector: { type: "string", description: "e.g. 'a.button', '#main', 'h2', 'meta[name]'." },
			return: { type: "string", enum: ["html", "text", "attr"], default: "text" },
			attr: { type: "string", description: "Attribute name when return='attr'." },
			limit: { type: "integer", default: 100 },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		let html = String(args?.html ?? "");
		if (!html && args?.url) {
			if (!/^https?:\/\//i.test(String(args.url))) return fail("url must be absolute http(s).");
			html = await (await smartFetch(env, String(args.url), {})).text();
		}
		if (!html) return fail("Provide `html` or `url`.");
		const sel = String(args?.selector ?? "");
		if (!sel) return fail("Provide a `selector`.");

		const els = matchSelector(html, sel).slice(0, Number(args?.limit) || 100);
		if (!els.length) return ok("(no matches)");
		const mode = String(args?.return ?? "text");
		if (mode === "html") return ok(els.join("\n"));
		if (mode === "attr") {
			const attr = String(args?.attr ?? "");
			if (!attr) return fail("return='attr' needs an `attr` name.");
			const vals = els.map((e) => e.match(new RegExp(`${attr}=["']([^"']*)["']`, "i"))?.[1]).filter(Boolean);
			return ok(vals.join("\n") || "(attribute not present on matches)");
		}
		const texts = els.map((e) => e.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim());
		return ok(texts.join("\n"));
	},
};
