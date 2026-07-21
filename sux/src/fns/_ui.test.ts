import { describe, expect, it } from "vitest";
import { clientDeclaredUiSupport, escapeHtml, MCP_UI_EXTENSION, MCP_UI_MIME, recordClientUiSupport, uiMeta, uiResourceUri, withUiResource } from "./_ui";

function fakeKv() {
	const store = new Map<string, string>();
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } as any;
}

describe("_ui (MCP Apps shared plumbing)", () => {
	it("builds a ui:// resource uri under the sux server namespace", () => {
		expect(uiResourceUri("product-search-dashboard")).toBe("ui://sux/product-search-dashboard");
	});

	it("uses the ratified MCP Apps HTML profile MIME type", () => {
		expect(MCP_UI_MIME).toBe("text/html;profile=mcp-app");
	});

	it("builds tool-definition _meta with the nested ui.resourceUri form", () => {
		expect(uiMeta("foo")).toEqual({ ui: { resourceUri: "ui://sux/foo" } });
	});

	it("appends an embedded resource content block without disturbing existing content", () => {
		const base = { content: [{ type: "text" as const, text: "hello" }] };
		const out = withUiResource(base, "foo", "<html>hi</html>");
		expect(out.content).toHaveLength(2);
		expect(out.content[0]).toEqual({ type: "text", text: "hello" });
		expect(out.content[1]).toEqual({
			type: "resource",
			resource: { uri: "ui://sux/foo", mimeType: MCP_UI_MIME, text: "<html>hi</html>" },
		});
		// Original result object is untouched (a new object/array is returned).
		expect(base.content).toHaveLength(1);
	});

	it("escapes HTML-significant characters", () => {
		expect(escapeHtml(`<script>alert("x")</script> & 'quote'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;");
	});

	it("escapes non-string input via String() coercion", () => {
		expect(escapeHtml(null)).toBe("");
		expect(escapeHtml(42)).toBe("42");
	});

	describe("client-capability negotiation (#1143)", () => {
		it("defaults to attach (true) when nothing was ever recorded for this login", async () => {
			const kv = fakeKv();
			const env = { OAUTH_KV: kv, _egress: { ctx: { waitUntil() {} }, reqId: "r", login: "alice" } } as any;
			expect(await clientDeclaredUiSupport(env)).toBe(true);
		});

		it("defaults to attach (true) when there's no login on the request", async () => {
			const kv = fakeKv();
			const env = { OAUTH_KV: kv } as any;
			expect(await clientDeclaredUiSupport(env)).toBe(true);
		});

		it("records a declared extension and reads it back as supported", async () => {
			const kv = fakeKv();
			await recordClientUiSupport({ OAUTH_KV: kv }, "alice", { extensions: { [MCP_UI_EXTENSION]: {} } });
			const env = { OAUTH_KV: kv, _egress: { ctx: { waitUntil() {} }, reqId: "r", login: "alice" } } as any;
			expect(await clientDeclaredUiSupport(env)).toBe(true);
		});

		it("suppresses attachment once a client explicitly initializes WITHOUT the UI extension", async () => {
			const kv = fakeKv();
			await recordClientUiSupport({ OAUTH_KV: kv }, "bob", { extensions: {} });
			const env = { OAUTH_KV: kv, _egress: { ctx: { waitUntil() {} }, reqId: "r", login: "bob" } } as any;
			expect(await clientDeclaredUiSupport(env)).toBe(false);
		});

		it("recordClientUiSupport is a no-op (never throws) with no login", async () => {
			const kv = fakeKv();
			await expect(recordClientUiSupport({ OAUTH_KV: kv }, undefined, { extensions: { [MCP_UI_EXTENSION]: {} } })).resolves.toBeUndefined();
			expect(kv.store.size).toBe(0);
		});
	});
});
