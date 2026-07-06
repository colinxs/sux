import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

function htmlToMd(html: string): string {
	let s = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|nav|footer)[\s\S]*?<\/\1>/gi, "");
	s = s
		.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n${"#".repeat(Number(n))} ${t.trim()}\n`)
		.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
		.replace(/<b>([\s\S]*?)<\/b>/gi, "**$1**")
		.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
		.replace(/<i>([\s\S]*?)<\/i>/gi, "*$1*")
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
		.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t) => `\n\`\`\`\n${t.replace(/<[^>]+>/g, "")}\n\`\`\`\n`)
		.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
		.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, "![$1]($2)")
		.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, "![]($1)")
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${t.replace(/<[^>]+>/g, "").trim()}\n`)
		.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t) => `> ${t.replace(/<[^>]+>/g, "").trim()}\n`)
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|ul|ol|tr|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return s;
}

function mdToHtml(md: string): string {
	const lines = md.split(/\r?\n/);
	const out: string[] = [];
	let inList = false;
	for (let line of lines) {
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			if (inList) { out.push("</ul>"); inList = false; }
			out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
			continue;
		}
		const li = line.match(/^\s*[-*]\s+(.*)$/);
		if (li) {
			if (!inList) { out.push("<ul>"); inList = true; }
			out.push(`<li>${inline(li[1])}</li>`);
			continue;
		}
		if (inList) { out.push("</ul>"); inList = false; }
		if (line.trim()) out.push(`<p>${inline(line)}</p>`);
	}
	if (inList) out.push("</ul>");
	return out.join("\n");
	function inline(t: string): string {
		return t
			.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>")
			.replace(/`([^`]+)`/g, "<code>$1</code>");
	}
}

export const htmlMarkdown: Fn = {
	name: "html_markdown",
	description: "Convert between HTML and Markdown. direction: to_md (default; give `html` or `url`) | to_html (give `markdown`). Covers headings, links, images, emphasis, code, lists, blockquotes.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			html: { type: "string" },
			url: { type: "string" },
			markdown: { type: "string" },
			direction: { type: "string", enum: ["to_md", "to_html"], default: "to_md" },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const dir = String(args?.direction ?? "to_md");
		if (dir === "to_html") {
			const md = String(args?.markdown ?? "");
			if (!md) return fail("Provide `markdown` for to_html.");
			return ok(mdToHtml(md));
		}
		let html = String(args?.html ?? "");
		if (!html && args?.url) {
			if (!/^https?:\/\//i.test(String(args.url))) return fail("url must be absolute http(s).");
			html = await (await smartFetch(env, String(args.url), {})).text();
		}
		if (!html) return fail("Provide `html` or `url`.");
		return ok(htmlToMd(html));
	},
};
