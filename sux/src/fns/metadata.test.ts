import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({ smartFetch: vi.fn() }));

import { metadata } from "./metadata";

const HTML = `<html><head>
	<title>Page Title</title>
	<meta name="description" content="A short description.">
	<meta name="keywords" content="a, b, c">
	<meta name="author" content="Jane">
	<meta property="og:title" content="OG Title">
	<meta name="twitter:card" content="summary">
	<link rel="canonical" href="/canonical-path">
	<link rel="shortcut icon" href="/fav.png">
</head><body>hi</body></html>`;

describe("metadata", () => {
	it("extracts a flat object of found fields and resolves relative urls", async () => {
		const r = await metadata.run({} as any, { html: HTML, url: "https://example.com/page" });
		const out = JSON.parse(r.content[0].text);
		expect(out.title).toBe("Page Title");
		expect(out.description).toBe("A short description.");
		expect(out.keywords).toBe("a, b, c");
		expect(out.author).toBe("Jane");
		expect(out["og:title"]).toBe("OG Title");
		expect(out["twitter:card"]).toBe("summary");
		expect(out.canonical).toBe("https://example.com/canonical-path");
		expect(out.favicon).toBe("https://example.com/fav.png");
	});

	it("defaults favicon to /favicon.ico when none declared", async () => {
		const r = await metadata.run({} as any, { html: "<head><title>T</title></head>", url: "https://x.com/a/b" });
		const out = JSON.parse(r.content[0].text);
		expect(out.favicon).toBe("https://x.com/favicon.ico");
	});

	it("errors without html or url", async () => {
		const r = await metadata.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("keeps a malformed canonical href instead of crashing", async () => {
		const html = `<head><title>T</title><link rel="canonical" href="http://[bad"></head>`;
		const r = await metadata.run({} as any, { html, url: "https://example.com/page" });
		expect(r.isError).toBeUndefined();
		const out = JSON.parse(r.content[0].text);
		expect(out.title).toBe("T");
		expect(out.canonical).toBe("http://[bad");
	});

	it("does not crash when url is not an absolute base and refs are relative", async () => {
		const html = `<head><title>T</title><link rel="canonical" href="/x"><link rel="icon" href="/f.png"></head>`;
		const r = await metadata.run({} as any, { html, url: "example.com" });
		expect(r.isError).toBeUndefined();
		const out = JSON.parse(r.content[0].text);
		expect(out.title).toBe("T");
		expect(out.canonical).toBe("/x");
		expect(out.favicon).toBe("/f.png");
	});
});
