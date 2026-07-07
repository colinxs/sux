import { describe, expect, it, vi } from "vitest";

// linkedin delegates the anti-bot fetch to the `render` fn via the registry; mock
// the registry so we can feed it canned page HTML without a real browser render.
const { renderRun } = vi.hoisted(() => ({ renderRun: vi.fn() }));
vi.mock("./index", () => ({ FUNCTIONS: [{ name: "render", run: renderRun }] }));

import { extractCompany, extractPerson, linkedin, parseJsonLd } from "./linkedin";

const personHtml = `<html><head>
<meta property="og:title" content="Ada Lovelace - Analyst at X | LinkedIn"/>
<script type="application/ld+json">${JSON.stringify({
	"@graph": [
		{
			"@type": "Person",
			name: "Ada Lovelace",
			jobTitle: "Analyst",
			address: { addressLocality: "London", addressCountry: "UK" },
			worksFor: [{ name: "X" }, { name: "Y" }],
			alumniOf: [{ name: "Uni" }],
			url: "https://www.linkedin.com/in/ada",
		},
	],
})}</script></head><body></body></html>`;

const companyHtml = `<html><head>
<script type="application/ld+json">${JSON.stringify({ "@type": "Organization", name: "Acme", description: "We make things", url: "https://acme.com", numberOfEmployees: { value: 500 }, address: { addressLocality: "SF", addressCountry: "US" } })}</script>
</head></html>`;

describe("linkedin extractors", () => {
	it("parseJsonLd flattens @graph and multiple blocks", () => {
		const nodes = parseJsonLd(personHtml);
		expect(nodes.some((n) => n["@type"] === "Person")).toBe(true);
	});
	it("extractPerson distills the Person JSON-LD", () => {
		const p = extractPerson(personHtml);
		expect(p).toMatchObject({ name: "Ada Lovelace", headline: "Analyst", location: "London, UK", url: "https://www.linkedin.com/in/ada" });
		expect(p.current).toEqual(["X", "Y"]);
		expect(p.education).toEqual(["Uni"]);
	});
	it("extractPerson falls back to og:title when JSON-LD is absent", () => {
		const p = extractPerson(`<meta property="og:title" content="Grace Hopper - Rear Admiral | LinkedIn"/>`);
		expect(p.name).toBe("Grace Hopper");
		expect(p.headline).toBe("Rear Admiral");
	});
	it("extractCompany distills the Organization JSON-LD", () => {
		expect(extractCompany(companyHtml)).toMatchObject({ name: "Acme", description: "We make things", website: "https://acme.com", employees: 500, location: "SF, US" });
	});
});

describe("linkedin fn", () => {
	it("rejects a non-linkedin url", async () => {
		const r = await linkedin.run({} as any, { url: "https://example.com/in/x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/linkedin\.com/);
	});

	it("scrapes a person via the render mac backend and returns distilled data", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: personHtml }] });
		const r = await linkedin.run({} as any, { url: "https://www.linkedin.com/in/ada" });
		expect(renderRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ url: "https://www.linkedin.com/in/ada", backend: "mac", solve: true }));
		expect(JSON.parse(r.content[0].text).name).toBe("Ada Lovelace");
	});

	it("resolves a company via action=company", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: companyHtml }] });
		const r = await linkedin.run({} as any, { url: "https://www.linkedin.com/company/acme", action: "company" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ name: "Acme", employees: 500 });
	});

	it("surfaces an auth wall when there's no public data", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: "<html><body>Sign in to LinkedIn to view</body></html>" }] });
		const r = await linkedin.run({} as any, { url: "https://www.linkedin.com/in/private" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/auth wall/);
	});

	it("propagates a render error", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: "mac backend not configured" }], isError: true });
		const r = await linkedin.run({} as any, { url: "https://www.linkedin.com/in/ada" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/render/);
	});
});
