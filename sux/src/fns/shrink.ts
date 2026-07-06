import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

const estTokens = (s: string) => Math.ceil(s.length / 4);

function shrinkText(input: string, aggressive: boolean): string {
	let t = input;

	if (/<[a-z!][\s\S]*>/i.test(t) && /<\/?(div|p|span|a|table|body|html|script|head)\b/i.test(t)) {
		t = t
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&");
	}
	t = t
		.split(/\r?\n/)
		.map((l) => l.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (aggressive) {

		const seen = new Set<string>();
		t = t
			.split("\n")
			.filter((l) => {
				const k = l.trim();
				if (!k) return true;
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			})
			.join("\n");
	}
	return t;
}

export const shrink: Fn = {
	name: "shrink",
	description:
		"Reduce size. kind='token' (default): shrink the LLM token count of text (strip markup, collapse whitespace, dedupe lines) and report the delta — source may be text or an http(s) url. strategy='aggressive' also drops duplicate lines. target: hard cap on output tokens (truncates). kind='pdf'|'image': byte-size reduction (needs WASM — coming).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["source"],
		properties: {
			source: { type: "string", description: "Text, or an absolute http(s) url (kind=token)." },
			kind: { type: "string", enum: ["token", "pdf", "image"], default: "token" },
			strategy: { type: "string", enum: ["safe", "aggressive"], default: "safe" },
			target: { type: "integer", description: "Max output tokens (token kind only); truncates if exceeded." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const kind = String(args?.kind ?? "token");
		if (kind !== "token") return fail(`shrink kind='${kind}' needs WASM/Browser Run — not wired yet. Use kind='token' for text.`);

		let text = String(args?.source ?? "");
		if (!text) return fail("Provide `source`.");
		if (/^https?:\/\//i.test(text)) {
			try {
				text = await (await smartFetch(env, text, {})).text();
			} catch (e) {
				return fail(`Fetch failed: ${String((e as Error).message ?? e)}`);
			}
		}

		const inTok = estTokens(text);
		let out = shrinkText(text, args?.strategy === "aggressive");

		const target = Number(args?.target) || 0;
		let truncated = false;
		if (target > 0 && estTokens(out) > target) {
			out = out.slice(0, target * 4);
			truncated = true;
		}
		const outTok = estTokens(out);
		const saved = inTok ? Number((((inTok - outTok) / inTok) * 100).toFixed(1)) : 0;
		return ok(JSON.stringify({ in_tokens: inTok, out_tokens: outTok, saved_pct: saved, truncated, text: out }));
	},
};
