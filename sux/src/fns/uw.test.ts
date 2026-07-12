import { afterEach, describe, expect, it, vi } from "vitest";
import { uw } from "./uw";

// Fixtures mirror the real directory.uw.edu length=full response (captured live
// 2026-07-12): a `.person-card` per hit, a vCard form carrying the base64
// person_href, and the RCW footer. Trimmed to the load-bearing structure.
const COOKIE = "edu.uw.directory.session=a6158426-8bcb-471e-bc64-ea7ad21f1f13; Path=/; HttpOnly";

const CARD_LAZOWSKA = `
<!-- Begin Person Card -->
<div class="person-card">
    <h4 class="person-name">Ed Lazowska</h4>
    <ul class="no-style-list">
            <li>Professor Emeritus, Paul G. Allen School of Computer Science &amp; Engineering</li>
    </ul>
    <ul class="dir-listing no-style-list">
            <li>
                    Email: lazowska@uw.edu
            </li>
                <li>Phone: +1 206 543-1695, +1 206 543-4755</li>
                <li>Fax: +1 206 543-2969</li>
            <li class="person-box-number">Box 352350</li>
    </ul>
    <form method="POST" action="/person/vcard">
        <input type="hidden" name="person_href" value="L2lkZW50aXR5L3YyL3BlcnNvbi82QTQzODhDRTZBN0QxMUQ1QTRBRTAwMDRBQzQ5NEZGRS9mdWxsLmpzb24=">
    </form>
</div>
<!-- End Person Card -->`;

const CARD_NO_DEPT = `
<!-- Begin Person Card -->
<div class="person-card">
    <h4 class="person-name">Jane Q Public</h4>
    <ul class="no-style-list">
            <li>Information School</li>
    </ul>
    <ul class="dir-listing no-style-list">
            <li>Email: janeqp@uw.edu</li>
    </ul>
</div>
<!-- End Person Card -->`;

const fullPage = (cards: string) =>
	`<html><body><div class="results-summary">1 faculty/staff</div>${cards}<div class="footerblock"><p>Pursuant to RCW 42.56</p></div></body></html>`;

const NO_MATCH = `<html><body><div class="results-summary">No match</div><div class="contentcell"></div></body></html>`;
const STUDENT_GATED = `<html><body><a id="sign-in" href="/saml/login">Sign in for student search</a><div class="results-summary">No match</div></body></html>`;

// Two-phase mock: GET primes the cookie, POST returns the search page.
function mockDirectory(searchHtml: string, opts: { cookie?: string | null } = {}) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?: any) => {
		if ((init?.method ?? "GET") === "GET") {
			const headers = new Headers();
			if (opts.cookie !== null) headers.set("set-cookie", opts.cookie ?? COOKIE);
			return new Response("<html>form</html>", { status: 200, headers });
		}
		return new Response(searchHtml, { status: 200 });
	});
}

afterEach(() => vi.restoreAllMocks());

describe("uw", () => {
	it("parses a faculty/staff person-card into a normalized record", async () => {
		mockDirectory(fullPage(CARD_LAZOWSKA));
		const r = await uw.run({} as any, { query: "Ed Lazowska" });
		expect(r.isError).toBeUndefined();
		const out = JSON.parse(r.content[0].text);
		expect(out.method).toBe("name");
		expect(out.count).toBe(1);
		const p = out.results[0];
		expect(p.displayName).toBe("Ed Lazowska");
		expect(p.email).toBe("lazowska@uw.edu");
		expect(p.netid).toBe("lazowska");
		expect(p.title).toBe("Professor Emeritus");
		expect(p.department).toBe("Paul G. Allen School of Computer Science & Engineering");
		expect(p.phone).toBe("+1 206 543-1695, +1 206 543-4755");
		expect(p.fax).toBe("+1 206 543-2969");
		expect(p.boxNumber).toBe("352350");
		expect(p.category).toBe("faculty/staff");
		expect(p.regid).toBe("6A4388CE6A7D11D5A4AE0004AC494FFE");
	});

	it("routes an @-address to the email method and posts length=full", async () => {
		const spy = mockDirectory(fullPage(CARD_LAZOWSKA));
		const r = await uw.run({} as any, { query: "lazowska@uw.edu" });
		expect(JSON.parse(r.content[0].text).method).toBe("email");
		const post = spy.mock.calls.find((c) => (c[1] as any)?.method === "POST")!;
		const body = String((post[1] as any).body);
		expect(body).toContain("method=email");
		expect(body).toContain("length=full");
		expect(body).toContain("population=employees");
		expect(body).toContain("query=lazowska%40uw.edu");
		// The POST must carry the session cookie the GET minted.
		expect((post[1] as any).headers.Cookie).toContain("edu.uw.directory.session=");
	});

	it("expands a bare NetID to {netid}@uw.edu for the email method", async () => {
		const spy = mockDirectory(fullPage(CARD_LAZOWSKA));
		await uw.run({} as any, { query: "lazowska", method: "email" });
		const post = spy.mock.calls.find((c) => (c[1] as any)?.method === "POST")!;
		expect(String((post[1] as any).body)).toContain("query=lazowska%40uw.edu");
	});

	it("maps method=box to the box_number field", async () => {
		const spy = mockDirectory(fullPage(CARD_LAZOWSKA));
		await uw.run({} as any, { query: "352350", method: "box" });
		const post = spy.mock.calls.find((c) => (c[1] as any)?.method === "POST")!;
		expect(String((post[1] as any).body)).toContain("method=box_number");
	});

	it("treats a single-field appointment as the department (no title)", async () => {
		mockDirectory(fullPage(CARD_NO_DEPT));
		const r = await uw.run({} as any, { query: "Jane Public" });
		const p = JSON.parse(r.content[0].text).results[0];
		expect(p.title).toBeNull();
		expect(p.department).toBe("Information School");
	});

	it("caps results at the limit and flags truncation", async () => {
		mockDirectory(fullPage(CARD_LAZOWSKA.repeat(5)));
		const r = await uw.run({} as any, { query: "Smith", limit: 2 });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(2);
		expect(out.truncated).toBe(true);
		expect(out.total_matches).toBe(5);
	});

	it("returns an empty, non-error result on no match", async () => {
		mockDirectory(NO_MATCH);
		const r = await uw.run({} as any, { query: "zzzznotarealname" });
		expect(r.isError).toBeUndefined();
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(0);
		expect(out.results).toEqual([]);
	});

	it("returns a sign-in-required note for a student request (never defeats the gate)", async () => {
		mockDirectory(STUDENT_GATED);
		const r = await uw.run({} as any, { query: "John Smith", students: true });
		expect(r.isError).toBeUndefined();
		const out = JSON.parse(r.content[0].text);
		expect(out.sign_in_required).toBe(true);
		expect(out.results).toBeUndefined();
	});

	it("errors on a missing query", async () => {
		const r = await uw.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/query/i);
	});

	it("fails clearly when the session cookie is absent (layout change)", async () => {
		mockDirectory(fullPage(CARD_LAZOWSKA), { cookie: null });
		const r = await uw.run({} as any, { query: "Ed Lazowska" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("layout_change");
	});

	it("enriches with the PWS tier when the UW_PWS_CERT binding is set", async () => {
		mockDirectory(fullPage(CARD_LAZOWSKA));
		const certFetch = vi.fn(async (_url: string, _init?: any) => new Response(JSON.stringify({ RegID: "6A4388CE...", DisplayName: "Edward D Lazowska" }), { status: 200 }));
		const r = await uw.run({ UW_PWS_CERT: { fetch: certFetch } } as any, { query: "Ed Lazowska" });
		const p = JSON.parse(r.content[0].text).results[0];
		expect(certFetch).toHaveBeenCalledOnce();
		expect(String(certFetch.mock.calls[0][0])).toContain("/identity/v2/person/6A4388CE6A7D11D5A4AE0004AC494FFE/full.json");
		expect(p.pws.DisplayName).toBe("Edward D Lazowska");
	});

	it("stays scrape-only (no error) when the PWS cert is absent", async () => {
		mockDirectory(fullPage(CARD_LAZOWSKA));
		const r = await uw.run({} as any, { query: "Ed Lazowska" });
		const p = JSON.parse(r.content[0].text).results[0];
		expect(p.pws).toBeUndefined();
	});
});
