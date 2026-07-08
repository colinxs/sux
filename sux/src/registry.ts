import type { BrowserWorker } from "@cloudflare/puppeteer";
import type { TailscaleEnv } from "./proxy";

export type AiBinding = {
	run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
};

export type ImagesBinding = {
	input: (data: ReadableStream | ArrayBuffer | Uint8Array) => {
		transform: (opts: Record<string, unknown>) => any;
		output: (opts: Record<string, unknown>) => Promise<{ response: () => Response }>;
	};
};

export type R2Bucket = {
	put: (key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => Promise<unknown>;
	get: (key: string) => Promise<null | { size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;
	head: (key: string) => Promise<null | { size: number; uploaded?: Date; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>;
	delete: (key: string) => Promise<void>;
	list: (opts?: { prefix?: string; limit?: number; cursor?: string }) => Promise<{ objects: Array<{ key: string; size: number; uploaded?: Date }>; truncated?: boolean; cursor?: string }>;
};

export type RtEnv = Env &
	TailscaleEnv & {
		KAGI_API_KEY: string;
		ALLOWED_GITHUB_LOGIN: string;
		DEBUG_MCP?: string;

		NCBI_API_KEY?: string;

		S2_API_KEY?: string;

		STACKEXCHANGE_KEY?: string;
		R2?: R2Bucket;

		BRAVE_API_KEY?: string;
		BING_API_KEY?: string;

		// Facebook Graph API access token (facebook fn). (linkedin fn now scrapes via
		// the render mac backend — Proxycurl shut down July 2025 — so it needs no key.)
		FACEBOOK_TOKEN?: string;
		// Git-backed Obsidian vault (obsidian fn): 'owner/repo', branch, optional subfolder.
		OBSIDIAN_VAULT_REPO?: string;
		OBSIDIAN_VAULT_BRANCH?: string;
		OBSIDIAN_VAULT_DIR?: string;
		// Remote Obsidian backend: the Funnel'd Local REST API URL + its bearer key.
		OBSIDIAN_REMOTE_URL?: string;
		OBSIDIAN_REMOTE_KEY?: string;

		EXA_API_KEY?: string;

		KROGER_CLIENT_ID?: string;
		KROGER_CLIENT_SECRET?: string;

		BESTBUY_API_KEY?: string;

		EBAY_CLIENT_ID?: string;
		EBAY_CLIENT_SECRET?: string;


		TAVILY_API_KEY?: string;


		GOOGLE_MAPS_KEY?: string;


		YOUTUBE_API_KEY?: string;
		AI?: AiBinding;
		IMAGES?: ImagesBinding;

		BROWSER?: BrowserWorker;

		MAC_RENDER_URL?: string;
		MAC_RENDER_SECRET?: string;

		// Grafana Cloud Loki push (observability). All three required to ship logs;
		// absent → sux emits metrics locally only. See sux/src/grafana.ts.
		GRAFANA_LOKI_URL?: string;
		GRAFANA_LOKI_USER?: string;
		GRAFANA_LOKI_TOKEN?: string;

		MCP_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
	};

/**
 * Machine-readable failure taxonomy. A small fixed set so callers and Grafana can
 * group failures by cause instead of parsing free-text. Every code maps to a
 * distinct operator/caller action:
 *   not_configured — a required key/binding is absent (fix config)
 *   blocked        — upstream refused us (bot wall / challenge / access denied)
 *   timeout        — upstream/render did not respond in time
 *   rate_limited   — upstream throttled us (429 / quota)
 *   not_found      — the requested resource does not exist
 *   upstream_error — upstream errored, no more precise attribution
 *   bad_input      — the caller's args are invalid (bad url, missing field, SSRF target)
 *   layout_change  — we fetched fine but the page/response shape no longer parses
 */
export const FAIL_CODES = ["not_configured", "blocked", "timeout", "rate_limited", "not_found", "upstream_error", "bad_input", "layout_change"] as const;
export type FailCode = (typeof FAIL_CODES)[number];

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; noCache?: boolean; errorCode?: FailCode };
export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * A fail() carrying a machine-readable code from FAIL_CODES. The code is prefixed
 * to the human text as `[code]` — so it flows into the Grafana `err` field (index.ts
 * derives `err` from the first text part) and stays visible to callers — AND is
 * attached as a structured `errorCode` on the ToolResult for typed consumers. The
 * human message is preserved verbatim after the prefix. Never used on a success path.
 */
export const failWith = (code: FailCode, text: string): ToolResult => ({ content: [{ type: "text", text: `[${code}] ${text}` }], isError: true, errorCode: code });

export type Fn = {
	name: string;
	description: string;
	inputSchema: unknown;

	cacheable?: boolean;

	cost?: number;

	ttl?: number;

	raw?: boolean;
	run: (env: RtEnv, args: any) => Promise<ToolResult>;
};

export function toolList(fns: Fn[]): Array<{ name: string; description: string; inputSchema: unknown }> {
	return fns.map((f) => ({ name: f.name, description: f.description, inputSchema: f.inputSchema }));
}

export function findFn(fns: Fn[], name: string): Fn | undefined {
	return fns.find((f) => f.name === name);
}
