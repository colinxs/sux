import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

function minifyJson(s: string): string { return JSON.stringify(JSON.parse(s)); }
function minifyCss(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*([{}:;,>])\s*/g, "$1").replace(/;}/g, "}").replace(/\s+/g, " ").trim();
}
function minifyJs(s: string): string {

	return s
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
}
function minifyHtml(s: string): string {
	return s.replace(/<!--(?!\[)[\s\S]*?-->/g, "").replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();
}

function detect(s: string): string {
	const t = s.trimStart();
	if (t.startsWith("{") || t.startsWith("[")) return "json";
	if (/^<!doctype|^<html|^<[a-z]+[\s>]/i.test(t)) return "html";
	if (/[{][^}]*:[^}]*[;}]/.test(t) && !/function|=>|var |let |const /.test(t)) return "css";
	return "js";
}

export const optimize: Fn = {
	name: "optimize",
	description: "Losslessly minify text assets (F1 Tier A). type: json | css | js | html (auto-detected if omitted). Give `data` or a `url`. Returns { type, in_bytes, out_bytes, saved_pct, data }. Binary lossless (png/jpeg/pdf) is a separate WASM path.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			data: { type: "string" },
			url: { type: "string" },
			type: { type: "string", enum: ["json", "css", "js", "html"] },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		let data = String(args?.data ?? "");
		if (!data && args?.url) {
			if (!/^https?:\/\//i.test(String(args.url))) return fail("url must be absolute http(s).");
			data = await (await smartFetch(env, String(args.url), {})).text();
		}
		if (!data) return fail("Provide `data` or `url`.");
		const type = String(args?.type ?? detect(data));
		let out: string;
		try {
			out = type === "json" ? minifyJson(data) : type === "css" ? minifyCss(data) : type === "html" ? minifyHtml(data) : minifyJs(data);
		} catch (e) {
			return fail(`optimize (${type}) failed: ${String((e as Error).message ?? e)}`);
		}
		const inB = enc(data), outB = enc(out);
		const saved = inB ? Number((((inB - outB) / inB) * 100).toFixed(1)) : 0;
		return ok(JSON.stringify({ type, in_bytes: inB, out_bytes: outB, saved_pct: saved, data: out }));
		function enc(s: string) { return new TextEncoder().encode(s).length; }
	},
};
