import { afterEach, describe, expect, it, vi } from "vitest";
import { mychart } from "./mychart";

const BASE = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";
const TOKEN = "https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token";
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
		EPIC_FHIR_BASE: BASE,
		OAUTH_KV: kvStub({ "sux:mychart:grant": JSON.stringify({ refresh_token: "RT", patient: "PatientA", scope: "patient/*.read", issued_at: Date.now() - 5000 }), "sux:mychart:token": "AT" }),
		R2: r2Stub(),
	}) as any;

afterEach(() => vi.restoreAllMocks());

describe("mychart fn", () => {
	it("status reports not-configured/not-connected without ever returning token material", async () => {
		const out = parse(await mychart.run({} as any, { op: "status" }));
		expect(out).toMatchObject({ configured: false, connected: false });
		const env = connectedEnv();
		const s = parse(await mychart.run(env, { op: "status" }));
		expect(s).toMatchObject({ configured: true, connected: true, patient: "PatientA", fhirBase: BASE, scopes: "patient/*.read" });
		expect(typeof s.refreshTokenAgeSeconds).toBe("number");
		// no refresh/access token value leaks
		expect(JSON.stringify(s)).not.toContain("RT");
		expect(JSON.stringify(s)).not.toContain("AT");
	});

	it("is not_configured for op=get/pull/connect when EPIC_* absent", async () => {
		const r = await mychart.run({} as any, { op: "pull" });
		expect(r.errorCode).toBe("not_configured");
		expect(r.content[0].text).toContain("[not_configured]");
	});

	it("connect returns the operator URL with the token when SUX_CRON_TOKEN is set", async () => {
		const env = connectedEnv();
		env.SUX_CRON_TOKEN = "op";
		const out = parse(await mychart.run(env, { op: "connect" }));
		expect(out.connect_url).toBe("https://suxos.net/mychart/connect?token=op");
	});

	it("get refuses a path that escapes the FHIR base (never fetches)", async () => {
		const env = connectedEnv();
		const spy = vi.fn();
		vi.stubGlobal("fetch", spy);
		const r = await mychart.run(env, { op: "get", path: "https://evil.com/Observation" });
		expect(r.errorCode).toBe("bad_input");
		expect(spy).not.toHaveBeenCalled();
	});

	it("get passes a validated FHIR query through and returns the raw body", async () => {
		const env = connectedEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: any) => {
			expect(String(u)).toBe(`${BASE}/Observation?category=vital-signs`);
			return new Response(JSON.stringify({ resourceType: "Bundle", total: 0 }), { status: 200 });
		}));
		const r = await mychart.run(env, { op: "get", path: "Observation?category=vital-signs" });
		expect(r.isError).toBeFalsy();
		expect(parse(r)).toMatchObject({ resourceType: "Bundle" });
	});

	it("pull pages a searchset, resolves DocumentReference→Binary, writes raw FHIR to phi/, returns counts only", async () => {
		const env = connectedEnv();
		const page1 = {
			resourceType: "Bundle",
			link: [{ relation: "next", url: `${BASE}/DocumentReference?patient=PatientA&page=2` }],
			entry: [{ resource: { resourceType: "DocumentReference", id: "d1", content: [{ attachment: { url: `${BASE}/Binary/b1` } }] } }],
		};
		const page2 = { resourceType: "Bundle", entry: [{ resource: { resourceType: "DocumentReference", id: "d2", content: [] } }] };
		vi.stubGlobal("fetch", vi.fn(async (u: any) => {
			const url = String(u);
			if (url.includes(".well-known/smart-configuration")) return smartCfg();
			if (url === TOKEN) return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
			if (url.includes("/Binary/b1")) return new Response(JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "aGk=" }), { status: 200 });
			if (url.includes("/DocumentReference") && url.includes("page=2")) return new Response(JSON.stringify(page2), { status: 200 });
			if (url.includes("/DocumentReference")) return new Response(JSON.stringify(page1), { status: 200 });
			// every other USCDI type returns an empty searchset
			return new Response(JSON.stringify({ resourceType: "Bundle", entry: [] }), { status: 200 });
		}));
		const out = parse(await mychart.run(env, { op: "pull", types: ["DocumentReference"] }));
		expect(out.patient).toBe("PatientA");
		expect(out.counts.DocumentReference).toBe(2); // d1 (page1) + d2 (page2)
		expect(out.binaries).toBe(1);
		expect(out.pages).toBe(2);
		// raw FHIR landed under the private phi/ prefix, and the Binary was resolved+stored
		const keys = [...env.R2.map.keys()];
		expect(keys.every((k) => k.startsWith("phi/"))).toBe(true);
		expect(keys.some((k) => k.includes("/Binary/b1.json"))).toBe(true);
		// counts only — no resource values in the summary
		expect(JSON.stringify(out)).not.toContain("resourceType");
	});
});
