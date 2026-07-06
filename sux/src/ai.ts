import { smartFetch } from "./proxy";
import type { TailscaleEnv } from "./proxy";

export type AiEnv = TailscaleEnv & { AI?: { run: (model: string, inputs: any) => Promise<any> } };

export const MODELS = {
	text: "@cf/meta/llama-3.2-3b-instruct",
	embed: "@cf/baai/bge-base-en-v1.5",
	vision: "@cf/meta/llama-3.2-11b-vision-instruct",
	translate: "@cf/meta/m2m100-1.2b",
} as const;

export function hasAI(env: AiEnv): boolean {
	return typeof env.AI?.run === "function";
}

export async function llm(env: AiEnv, system: string, user: string, maxTokens = 1024): Promise<string> {
	if (!hasAI(env)) throw new Error("Workers AI binding not configured (add \"ai\": { \"binding\": \"AI\" } to wrangler).");
	const r = await env.AI!.run(MODELS.text, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		max_tokens: maxTokens,
	});
	return String(r?.response ?? "").trim();
}

export async function textFromUrlOr(env: TailscaleEnv, text: string, url?: string): Promise<string> {
	if (text) return text;
	if (url && /^https?:\/\//i.test(url)) {
		const html = await (await smartFetch(env, url, {})).text();
		return html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
	return "";
}
