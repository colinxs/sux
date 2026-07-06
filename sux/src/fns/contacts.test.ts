import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(
		async () =>
			new Response(
				`<html><body>Reach us at Sales@Example.com or call (415) 555-2671.</body></html>`,
				{ status: 200 },
			),
	),
}));

import { contacts } from "./contacts";

describe("contacts", () => {
	it("pulls emails and phones from plain text, deduped and lowercased", async () => {
		const text = "Email JOHN@foo.com or john@foo.com, phone +1 202 555 0134 and +442071838750.";
		const r = await contacts.run({} as any, { text });
		const out = JSON.parse(r.content[0].text);
		expect(out.emails).toEqual(["john@foo.com"]);
		expect(out.phones).toContain("+1 202 555 0134");
		expect(out.phones).toContain("+442071838750");
	});

	it("strips html before scanning and normalizes email case", async () => {
		const html = `<div>Contact: <b>Info@Site.io</b> tel <span>212.555.0100</span></div>`;
		const r = await contacts.run({} as any, { html });
		const out = JSON.parse(r.content[0].text);
		expect(out.emails).toEqual(["info@site.io"]);
		expect(out.phones).toContain("212.555.0100");
	});

	it("fetches a url via the proxy and scans it", async () => {
		const r = await contacts.run({} as any, { url: "https://example.com" });
		const out = JSON.parse(r.content[0].text);
		expect(out.emails).toEqual(["sales@example.com"]);
		expect(out.phones).toContain("(415) 555-2671");
	});

	it("extracts social profiles from hrefs and skips non-profile paths", async () => {
		const html = `<a href="https://twitter.com/jane_dev">tw</a>
			<a href="https://github.com/janedev">gh</a>
			<a href="https://www.linkedin.com/in/jane-doe">li</a>
			<a href="https://github.com/features">not a profile</a>
			<a href="https://x.com/home">nav</a>`;
		const out = JSON.parse((await contacts.run({} as any, { html })).content[0].text);
		expect(out.socials.twitter).toContain("jane_dev");
		expect(out.socials.github).toContain("janedev");
		expect(out.socials.linkedin).toContain("jane-doe");
		expect(out.socials.github).not.toContain("features");
		expect(out.socials.twitter ?? []).not.toContain("home");
	});

	it("returns an empty socials object when there are none", async () => {
		const out = JSON.parse((await contacts.run({} as any, { text: "just an email a@b.com" })).content[0].text);
		expect(out.socials).toEqual({});
	});

	it("errors when nothing is provided", async () => {
		const r = await contacts.run({} as any, {});
		expect(r.isError).toBe(true);
	});
});
