import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const protocol: Fn = {
	name: "protocol",
	description:
		"Make an HTTP request through the residential proxy (falls back to direct). Full control over method/headers/body. `as`: text (default) | json | headers. Use for APIs and pages that block datacenter IPs.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
			method: { type: "string", default: "GET" },
			headers: { type: "object", additionalProperties: { type: "string" } },
			body: { type: "string" },
			as: { type: "string", enum: ["text", "json", "headers"], default: "text" },
			max_bytes: { type: "integer", default: 200000, description: "Truncate the body at this many bytes." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(url)) return fail("url must be an absolute http(s) URL.");
		const method = String(args?.method ?? "GET").toUpperCase();
		const headers = args?.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined;
		const body = typeof args?.body === "string" ? args.body : undefined;
		const as = String(args?.as ?? "text");
		const maxBytes = Number(args?.max_bytes) || 200000;

		const resp = await smartFetch(env, url, { method, headers, body });
		const hdrs = Object.fromEntries([...resp.headers]);

		if (as === "headers") {
			return ok(JSON.stringify({ status: resp.status, statusText: resp.statusText, headers: hdrs }, null, 2));
		}

		let text = await resp.text();
		if (text.length > maxBytes) text = `${text.slice(0, maxBytes)}\n… [truncated at ${maxBytes} bytes]`;

		if (as === "json") {
			try {
				return ok(JSON.stringify({ status: resp.status, json: JSON.parse(text) }, null, 2));
			} catch {
				return fail(`Response was not valid JSON (HTTP ${resp.status}). First bytes:\n${text.slice(0, 500)}`);
			}
		}
		return ok(`HTTP ${resp.status} ${resp.statusText} — ${url}\n${JSON.stringify(hdrs)}\n\n${text}`);
	},
};
