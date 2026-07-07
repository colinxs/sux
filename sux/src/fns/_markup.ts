// Shared HTML <-> Markdown conversion for the directional markdown()/html()
// converters (common subset: headings, links, bold/em, lists, inline code, code
// blocks, blockquotes, paragraphs). Pure. Bidirectionality via composition.

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&#x27;/gi, "'")
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function encodeEntities(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineText(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function inlineToMd(s: string): string {
	return decodeEntities(
		s
			.replace(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${inlineText(txt)}](${href})`)
			.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `**${inlineText(txt)}**`)
			.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `*${inlineText(txt)}*`)
			.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, txt) => `\`${inlineText(txt)}\``)
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+/g, " ")
		.trim();
}

function listItems(html: string, ordered: boolean): string {
	const items: string[] = [];
	const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
	let m: RegExpExecArray | null;
	let n = 1;
	while ((m = re.exec(html))) items.push(`${ordered ? `${n++}.` : "-"} ${inlineToMd(m[1])}`);
	return items.join("\n");
}

export function htmlToMd(html: string): string {
	let s = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "");
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, txt) => `\x00${"#".repeat(Number(lvl))} ${inlineToMd(txt)}\x00`);
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, txt) => {
		const inner = inlineText(txt.replace(/<code\b[^>]*>|<\/code>/gi, ""));
		return `\x00\`\`\`\n${inner}\n\`\`\`\x00`;
	});
	s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, txt) =>
		`\x00${inlineToMd(txt).split("\n").map((l: string) => `> ${l}`.trimEnd()).join("\n")}\x00`,
	);
	s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, txt) => `\x00${listItems(txt, false)}\x00`);
	s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, txt) => `\x00${listItems(txt, true)}\x00`);
	s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, txt) => `\x00${inlineToMd(txt)}\x00`);
	s = inlineToMd(s.replace(/\x00/g, "\n\n"));
	return s
		.split(/\n{2,}/)
		.map((b) => b.trim())
		.filter(Boolean)
		.join("\n\n");
}

function inlineMdToHtml(s: string): string {
	return encodeEntities(s)
		.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
		.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, txt, href) => `<a href="${href}">${txt}</a>`)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_]+)__/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>")
		.replace(/_([^_]+)_/g, "<em>$1</em>");
}

export function mdToHtml(md: string): string {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;
	const flushList = (items: string[], ordered: boolean) => {
		if (!items.length) return;
		const tag = ordered ? "ol" : "ul";
		out.push(`<${tag}>${items.map((t) => `<li>${inlineMdToHtml(t)}</li>`).join("")}</${tag}>`);
	};
	while (i < lines.length) {
		const line = lines[i];
		if (/^\s*$/.test(line)) {
			i++;
			continue;
		}
		if (/^```/.test(line)) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
			i++;
			out.push(`<pre><code>${encodeEntities(body.join("\n"))}</code></pre>`);
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			out.push(`<h${h[1].length}>${inlineMdToHtml(h[2].trim())}</h${h[1].length}>`);
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
			out.push(`<blockquote>${inlineMdToHtml(body.join(" ").trim())}</blockquote>`);
			continue;
		}
		if (/^\s*[-*+]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
			flushList(items, false);
			continue;
		}
		if (/^\s*\d+\.\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
			flushList(items, true);
			continue;
		}
		const para: string[] = [];
		while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) {
			para.push(lines[i++]);
		}
		out.push(`<p>${inlineMdToHtml(para.join(" ").trim())}</p>`);
	}
	return out.join("\n");
}
