import { afterEach, describe, expect, it, vi } from "vitest";

import { parseUwDirectory, people_finder } from "./people_finder";

// The uw source POSTs the search form to directory.uw.edu; stub global fetch to
// feed canned directory HTML without a real request.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// linkedin/facebook/web_search are invoked through the FUNCTIONS registry; mock it
// so each returns a canned result (facebook fails, to exercise error isolation).
const { linkedinRun, facebookRun, webRun } = vi.hoisted(() => ({ linkedinRun: vi.fn(), facebookRun: vi.fn(), webRun: vi.fn() }));
vi.mock("./index", () => ({
	FUNCTIONS: [
		{ name: "linkedin", run: linkedinRun },
		{ name: "facebook", run: facebookRun },
		{ name: "web_search", run: webRun },
	],
}));

// Two person-cards for the same person (length=full) — to exercise dedupe and
// multiple appointments.
const UW_HTML = `
<div class="results-summary"><a href="#">2 matches</a></div>
<div class="person-card">
  <h4 class="person-name">Arden Hellmann</h4>
  <ul class="no-style-list"><li>Professor Emeritus, Political Science</li><li>Adjunct Professor, Jackson School</li></ul>
  <ul class="dir-listing no-style-list">
    <li>Email: ardenh@uw.edu</li>
    <li>Phone: +1 206 284-3027, +1 206 543-4904</li>
    <li class="person-box-number">Box 354900</li>
  </ul>
</div>
<div class="person-card">
  <h4 class="person-name">Arden Hellmann</h4>
  <ul class="no-style-list"><li>Research Scientist, Chemistry</li></ul>
  <ul class="dir-listing no-style-list">
    <li>Email: ardenh@uw.edu</li>
  </ul>
</div>`;

const LINKEDIN_JSON = JSON.stringify({
	name: "Arden Hellmann",
	headline: "Professor",
	current: ["University of Washington"],
	url: "https://www.linkedin.com/in/arden",
	location: "Seattle, WA",
});

const WEB_TEXT = `1. Arden Hellmann — LinkedIn
   https://www.linkedin.com/in/arden
   Public profile

2. Arden Hellmann (@arden) / Twitter
   https://twitter.com/arden
   Tweets`;

function setMocks() {
	fetchMock.mockResolvedValue(new Response(UW_HTML, { status: 200 }));
	linkedinRun.mockResolvedValue({ content: [{ text: LINKEDIN_JSON }] });
	webRun.mockResolvedValue({ content: [{ text: WEB_TEXT }] });
	facebookRun.mockResolvedValue({ content: [{ text: "Facebook not configured (FACEBOOK_TOKEN)." }], isError: true });
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("parseUwDirectory", () => {
	it("parses public fields out of length=full person-cards", () => {
		const people = parseUwDirectory(UW_HTML);
		expect(people).toHaveLength(2);
		expect(people[0].name).toBe("Arden Hellmann");
		expect(people[0].emails).toEqual(["ardenh@uw.edu"]);
		expect(people[0].phones).toEqual(["+1 206 284-3027", "+1 206 543-4904"]);
		expect(people[0].addresses).toEqual(["Box 354900"]);
		expect(people[0].work[0]).toEqual({ title: "Professor Emeritus", org: "Political Science" });
		expect(people[0].work[1]).toEqual({ title: "Adjunct Professor", org: "Jackson School" });
		expect(people[1].work[0]).toEqual({ title: "Research Scientist", org: "Chemistry" });
	});
});

describe("people_finder fn", () => {
	it("rejects a missing name", async () => {
		const r = await people_finder.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/name/);
	});

	it("merges public data across all sources, isolates the failing one, and dedupes", async () => {
		setMocks();
		const r = await people_finder.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { name: "Arden Hellmann" });
		expect(r.isError).toBeFalsy();
		const p = JSON.parse(r.content[0].text);

		// uw contributed email/phone/box/title+dept — deduped across the two cards.
		expect(p.emails).toEqual(["ardenh@uw.edu"]);
		expect(p.phones).toEqual(["+1 206 284-3027", "+1 206 543-4904"]);
		expect(p.addresses).toEqual(["Box 354900"]);

		// work carries source tags from both uw and linkedin.
		const uwWork = p.work.filter((w: any) => w.source === "uw");
		const liWork = p.work.filter((w: any) => w.source === "linkedin");
		expect(uwWork).toContainEqual({ title: "Professor Emeritus", org: "Political Science", source: "uw" });
		expect(liWork).toContainEqual({ title: "Professor", org: "University of Washington", source: "linkedin" });

		// profiles come from linkedin + web, deduped by URL (the linkedin URL appears
		// in both the linkedin and web results but lands once).
		const urls = p.profiles.map((x: any) => x.url);
		expect(urls.filter((u: string) => u === "https://www.linkedin.com/in/arden")).toHaveLength(1);
		expect(p.profiles).toContainEqual({ network: "twitter", url: "https://twitter.com/arden" });

		// succeeded sources vs isolated failure.
		expect(p.sources.sort()).toEqual(["linkedin", "uw", "web"]);
		expect(p.errors).toHaveLength(1);
		expect(p.errors[0].source).toBe("facebook");
		expect(p.errors[0].error).toMatch(/Facebook/);

		expect(p.name).toBe("Arden Hellmann");
	});

	it("respects a sources subset — only the named sources run", async () => {
		setMocks();
		const r = await people_finder.run({} as any, { name: "Arden Hellmann", sources: ["web"] });
		const p = JSON.parse(r.content[0].text);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(linkedinRun).not.toHaveBeenCalled();
		expect(facebookRun).not.toHaveBeenCalled();
		expect(webRun).toHaveBeenCalledTimes(1);
		expect(p.sources).toEqual(["web"]);
	});

	it("opts the uw source in when org names 'uw' even under a narrowed sources list", async () => {
		setMocks();
		await people_finder.run({} as any, { name: "Arden Hellmann", sources: ["web"], org: "uw" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(webRun).toHaveBeenCalledTimes(1);
		expect(linkedinRun).not.toHaveBeenCalled();
	});
});
