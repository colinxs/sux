import { type Fn, failWith, ok } from "../registry";
import { smartFetch } from "../proxy";
import { isHttpUrl, noCacheOn4xx, toB64 } from "./_util";

export const proxyFn: Fn = {
	name: "proxy",
	description:
		"Raw HTTP transport through the residential exit (direct fallback). Returns { status, headers, bytes, body }. as='base64' returns binary-safe bytes; as='text' (default) returns UTF-8. The low-level primitive under scrape/protocol.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
			method: { type: "string", default: "GET" },
			headers: { type: "object", additionalProperties: { type: "string" } },
			body: { type: "string" },
			as: { type: "string", enum: ["text", "base64"], default: "text" },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!isHttpUrl(url)) return failWith("bad_input", "url must be absolute http(s).");
		const resp = await smartFetch(env, url, {
			method: args?.method,
			headers: args?.headers,
			body: typeof args?.body === "string" ? args.body : undefined,
		});
		const buf = new Uint8Array(await resp.arrayBuffer());
		const hdrs = Object.fromEntries([...resp.headers]);
		let body: string;
		if (String(args?.as ?? "text") === "base64") {
			body = toB64(buf);
		} else {
			body = new TextDecoder().decode(buf);
		}
		return noCacheOn4xx(ok(JSON.stringify({ status: resp.status, statusText: resp.statusText, bytes: buf.length, headers: hdrs, body })), resp.status);
	},
};
