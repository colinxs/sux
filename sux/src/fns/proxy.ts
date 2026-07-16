import { type Fn, failWith, ok } from "../registry";
import { smartFetch } from "../proxy";
import { FETCH_BYTES_MAX_BYTES, errMsg, isHttpUrl, noCacheOn4xx, noCacheOnMutation, readBodyBytes, toB64 } from "./_util";

export const proxyFn: Fn = {
	name: "proxy",
	description:
		"Raw HTTP transport through the residential exit (direct fallback). Returns { status, headers, bytes, body }. as='base64' returns binary-safe bytes; as='text' (default) returns UTF-8. The body is STREAMED and capped at max_bytes (default 32MB) — a huge/hostile response is aborted mid-stream, never fully buffered into an OOM. Pin an exit locale by passing an `x-exit-geo` header (e.g. 'us-ca', 'de'; the proxy node interprets it, harmless if unsupported). The low-level primitive under scrape/protocol.",
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
			max_bytes: { type: "number", default: FETCH_BYTES_MAX_BYTES, description: "Max response bytes to read; the stream is aborted (and the call fails) past this cap. Default 32MB." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!isHttpUrl(url)) return failWith("bad_input", "url must be absolute http(s).");
		const maxBytes = Number.isFinite(args?.max_bytes) ? Math.max(0, Number(args.max_bytes)) : FETCH_BYTES_MAX_BYTES;
		const resp = await smartFetch(env, url, {
			method: args?.method,
			headers: args?.headers,
			body: typeof args?.body === "string" ? args.body : undefined,
		});
		// Stream the body and abort at maxBytes so a huge/hostile response is never
		// fully materialized in the isolate — resp.arrayBuffer() here would OOM.
		let buf: Uint8Array;
		try {
			buf = await readBodyBytes(resp, maxBytes);
		} catch (e) {
			return failWith("upstream_error", `Fetch failed: ${errMsg(e)}`);
		}
		const hdrs = Object.fromEntries([...resp.headers]);
		const body = String(args?.as ?? "text") === "base64" ? toB64(buf) : new TextDecoder().decode(buf);
		return noCacheOnMutation(noCacheOn4xx(ok(JSON.stringify({ status: resp.status, statusText: resp.statusText, bytes: buf.length, headers: hdrs, body })), resp.status), args?.method);
	},
};
