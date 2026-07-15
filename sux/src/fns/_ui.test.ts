import { describe, expect, it } from "vitest";
import { escapeHtml, MCP_UI_MIME, uiMeta, uiResourceUri, withUiResource } from "./_ui";

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
});
