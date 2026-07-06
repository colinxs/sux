import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

function cells(rowHtml: string): string[] {
	return [...rowHtml.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) =>
		m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim(),
	);
}

export const tables: Fn = {
	name: "tables",
	description: "Extract HTML tables into structured data. format: json (default, array of row objects keyed by header) | csv. index: pick a single table (0-based); omit for all.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch — or pass `html`." },
			html: { type: "string" },
			format: { type: "string", enum: ["json", "csv"], default: "json" },
			index: { type: "integer", description: "0-based table index; omit for all tables." },
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

		const tableHtmls = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
		if (!tableHtmls.length) return ok("(no tables found)");
		const pick = args?.index != null ? [tableHtmls[Number(args.index)]].filter(Boolean) : tableHtmls;
		if (!pick.length) return fail(`No table at index ${args?.index} (found ${tableHtmls.length}).`);

		const parsed = pick.map((t) => {
			const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => cells(m[0]));
			const nonEmpty = rows.filter((r) => r.length);
			if (!nonEmpty.length) return { headers: [], rows: [] };
			const headers = nonEmpty[0];
			const dataRows = nonEmpty.slice(1);
			return { headers, rows: dataRows };
		});

		if (args?.format === "csv") {
			const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
			const out = parsed
				.map((p) => [p.headers, ...p.rows].map((r) => r.map(esc).join(",")).join("\n"))
				.join("\n\n");
			return ok(out);
		}
		const out = parsed.map((p) => p.rows.map((r) => Object.fromEntries(p.headers.map((h, i) => [h || `col${i}`, r[i] ?? ""]))));
		return ok(JSON.stringify(args?.index != null ? out[0] : out, null, 2));
	},
};
