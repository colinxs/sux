import { type Fn, fail, ok } from "../registry";
import { loadHtml, stripHtml, oj } from "./_util";

/** Split a <tr> fragment into cleaned cell strings. */
function cells(rowHtml: string): string[] {
	return [...rowHtml.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) => stripHtml(m[1]));
}

/** Slice out top-level <table>…</table> blocks, honoring nesting depth so nested tables don't truncate the outer one. */
function topLevelTables(html: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = -1;
	for (const t of html.matchAll(/<(\/?)table\b[^>]*>/gi)) {
		if (t[1] === "/") {
			if (depth > 0 && --depth === 0 && start >= 0) {
				out.push(html.slice(start, t.index + t[0].length));
				start = -1;
			}
		} else {
			if (depth === 0) start = t.index;
			depth++;
		}
	}
	return out;
}

export const tables: Fn = {
	name: "tables",
	description:
		"Extract HTML tables into structured data. format: json (default, rows as objects keyed by the header row) | csv. index: pick a single 0-based table; omit for all.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) — or pass `html`." },
			html: { type: "string", description: "Raw HTML to parse instead of fetching a url." },
			format: { type: "string", enum: ["json", "csv"], default: "json", description: "Output format." },
			index: { type: "integer", description: "0-based index of a single table; omit for all tables." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const loaded = await loadHtml(env, args);
		if ("error" in loaded) return fail(loaded.error);

		const tableHtmls = topLevelTables(loaded.html);
		if (!tableHtmls.length) return ok("(no tables found)");

		const single = args?.index != null;
		const pick = single ? [tableHtmls[Number(args.index)]].filter(Boolean) : tableHtmls;
		if (!pick.length) return fail(`No table at index ${args.index} (found ${tableHtmls.length}).`);

		const parsed = pick.map((t) => {
			const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => cells(m[0])).filter((r) => r.length);
			if (!rows.length) return { headers: [] as string[], rows: [] as string[][] };
			return { headers: rows[0], rows: rows.slice(1) };
		});

		if (args?.format === "csv") {
			const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
			const out = parsed
				.map((p) => [p.headers, ...p.rows].map((r) => r.map(esc).join(",")).join("\n"))
				.join("\n\n");
			return ok(out);
		}

		const asObjects = parsed.map((p) =>
			p.rows.map((r) => Object.fromEntries(p.headers.map((h, i) => [h || `col${i}`, r[i] ?? ""]))),
		);
		return ok(oj(single ? asObjects[0] : asObjects));
	},
};
