import { afterEach, describe, expect, it, vi } from "vitest";
import { MYCHART_ORGS } from "../mychart";
import { mychart } from "./mychart";

const ORG = "uwmedicine";
const ORG2 = "swedish";
const BASE = MYCHART_ORGS[ORG].fhirBase;
const TOKEN = `${BASE}/token`;
const parse = (r: any) => JSON.parse(r.content[0].text);

function kvStub(seed: Record<string, string> = {}) {
	const map = new Map<string, string>(Object.entries(seed));
	return {
		map,
		get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void map.set(k, v)),
		delete: vi.fn(async (k: string) => void map.delete(k)),
	};
}
function r2Stub() {
	const map = new Map<string, any>();
	return { map, put: vi.fn(async (k: string, b: any) => void map.set(k, b)) };
}

const smartCfg = () => new Response(JSON.stringify({ authorization_endpoint: `${BASE}/authorize`, token_endpoint: TOKEN }), { status: 200 });

const connectedEnv = () =>
	({
		EPIC_CLIENT_ID: "cid",
		EPIC_CLIENT_SECRET: "csec",
		OAUTH_KV: kvStub({
			[`sux:mychart:grant:${ORG}`]: JSON.stringify({ refresh_token: "RT", patient: "PatientA", scope: "patient/*.read", issued_at: Date.now() - 5000 }),
			[`sux:mychart:token:${ORG}`]: "AT",
		}),
		R2: r2Stub(),
	}) as any;

afterEach(() => vi.restoreAllMocks());

describe("mychart fn", () => {
	it("status reports not-configured/not-connected without ever returning token material, across every registry org", async () => {
		const out = parse(await mychart.run({} as any, { op: "status" }));
		expect(out.configured).toBe(false);
		expect(out.orgs.every((o: any) => o.connected === false)).toBe(true);
		const env = connectedEnv();
		const s = parse(await mychart.run(env, { op: "status" }));
		expect(s.configured).toBe(true);
		const row = s.orgs.find((o: any) => o.org === ORG);
		expect(row).toMatchObject({ connected: true, patient: "PatientA", fhirBase: BASE, scopes: "patient/*.read" });
		expect(typeof row.refreshTokenAgeSeconds).toBe("number");
		const other = s.orgs.find((o: any) => o.org === ORG2);
		expect(other.connected).toBe(false);
		// no refresh/access token value leaks
		expect(JSON.stringify(s)).not.toContain("RT");
		expect(JSON.stringify(s)).not.toContain('"AT"');
	});

	it("is not_configured for op=get/pull/connect when EPIC_* absent", async () => {
		const r = await mychart.run({} as any, { op: "pull", org: ORG });
		expect(r.errorCode).toBe("not_configured");
		expect(r.content[0].text).toContain("[not_configured]");
	});

	it("connect requires org when ambiguous (0 or 2+ connected), defaults when exactly one is connected", async () => {
		const env = connectedEnv();
		env.SUX_CRON_TOKEN = "operator-secret-xyz";
		const out = parse(await mychart.run(env, { op: "connect" })); // defaults to the sole connected org
		expect(out.org).toBe(ORG);
		expect(out.connect_url).toBe(`https://suxos.net/mychart/connect?org=${ORG}`);
		// no SUX_CRON_TOKEN VALUE leak — the note references the header by name, not by value
		expect(JSON.stringify(out)).not.toContain("operator-secret-xyz");

		const unconnected = { EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec", OAUTH_KV: kvStub(), R2: r2Stub(), SUX_CRON_TOKEN: "operator-secret-xyz" } as any;
		const ambiguous = await mychart.run(unconnected, { op: "connect" });
		expect(ambiguous.errorCode).toBe("bad_input");
	});

	it("connect with an explicit org returns that org's URL regardless of what's connected", async () => {
		const env = connectedEnv();
		env.SUX_CRON_TOKEN = "operator-secret-xyz";
		const out = parse(await mychart.run(env, { op: "connect", org: ORG2 }));
		expect(out.org).toBe(ORG2);
		expect(out.connect_url).toBe(`https://suxos.net/mychart/connect?org=${ORG2}`);
	});

	it("connect with an unknown org is bad_input", async () => {
		const env = connectedEnv();
		const r = await mychart.run(env, { op: "connect", org: "nope" });
		expect(r.errorCode).toBe("bad_input");
	});

	it("get refuses a path that escapes the FHIR base (never fetches)", async () => {
		const env = connectedEnv();
		const spy = vi.fn();
		vi.stubGlobal("fetch", spy);
		const r = await mychart.run(env, { op: "get", org: ORG, path: "https://evil.com/Observation" });
		expect(r.errorCode).toBe("bad_input");
		expect(spy).not.toHaveBeenCalled();
	});

	it("get's escaped-FHIR-base error strips the query string — never leaks patient identifiers into the error surface (#360)", async () => {
		const env = connectedEnv();
		vi.stubGlobal("fetch", vi.fn());
		const r = await mychart.run(env, { op: "get", org: ORG, path: "https://evil.com/Patient?given=Jane&family=Doe&birthdate=1990-01-01" });
		expect(r.errorCode).toBe("bad_input");
		expect(r.content[0].text).not.toContain("Jane");
		expect(r.content[0].text).not.toContain("Doe");
		expect(r.content[0].text).not.toContain("1990-01-01");
	});

	it("get passes a validated FHIR query through and returns the raw body, defaulting org when unambiguous", async () => {
		const env = connectedEnv();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any) => {
				expect(String(u)).toBe(`${BASE}/Observation?category=vital-signs`);
				return new Response(JSON.stringify({ resourceType: "Bundle", total: 0 }), { status: 200 });
			}),
		);
		const r = await mychart.run(env, { op: "get", path: "Observation?category=vital-signs" });
		expect(r.isError).toBeFalsy();
		expect(parse(r)).toMatchObject({ resourceType: "Bundle" });
	});

	it("get on an org with no grant is not_configured", async () => {
		const env = connectedEnv();
		const r = await mychart.run(env, { op: "get", org: ORG2, path: "Observation" });
		expect(r.errorCode).toBe("not_configured");
	});

	it("pull pages a searchset, resolves DocumentReference→Binary, writes raw FHIR to org-scoped phi/, returns counts + org only", async () => {
		const env = connectedEnv();
		const page1 = {
			resourceType: "Bundle",
			link: [{ relation: "next", url: `${BASE}/DocumentReference?patient=PatientA&page=2` }],
			entry: [{ resource: { resourceType: "DocumentReference", id: "d1", content: [{ attachment: { url: `${BASE}/Binary/b1` } }] } }],
		};
		const page2 = { resourceType: "Bundle", entry: [{ resource: { resourceType: "DocumentReference", id: "d2", content: [] } }] };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any) => {
				const url = String(u);
				if (url.includes(".well-known/smart-configuration")) return smartCfg();
				if (url === TOKEN) return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
				if (url.includes("/Binary/b1")) return new Response(JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "aGk=" }), { status: 200 });
				if (url.includes("/DocumentReference") && url.includes("page=2")) return new Response(JSON.stringify(page2), { status: 200 });
				if (url.includes("/DocumentReference")) return new Response(JSON.stringify(page1), { status: 200 });
				// every other USCDI type returns an empty searchset
				return new Response(JSON.stringify({ resourceType: "Bundle", entry: [] }), { status: 200 });
			}),
		);
		const out = parse(await mychart.run(env, { op: "pull", types: ["DocumentReference"] })); // org defaulted (sole connected)
		expect(out.org).toBe(ORG);
		expect(out.patient).toBe("PatientA");
		expect(out.counts.DocumentReference).toBe(2); // d1 (page1) + d2 (page2)
		expect(out.binaries).toBe(1);
		expect(out.pages).toBe(2);
		// raw FHIR landed under the private, org-scoped phi/ prefix, and the Binary was resolved+stored
		const keys = [...env.R2.map.keys()];
		expect(keys.every((k) => k.startsWith(`phi/mychart/${ORG}/`))).toBe(true);
		expect(keys.some((k) => k.includes("/Binary/b1.json"))).toBe(true);
		// counts only — no resource values in the summary
		expect(JSON.stringify(out)).not.toContain("resourceType");
	});

	it("pull on an org with no grant is not_configured, and doesn't touch another connected org's data", async () => {
		const env = connectedEnv();
		const r = await mychart.run(env, { op: "pull", org: ORG2 });
		expect(r.errorCode).toBe("not_configured");
		expect(env.R2.map.size).toBe(0);
	});
});
