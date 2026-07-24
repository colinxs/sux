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
	return {
		map,
		put: vi.fn(async (k: string, b: any) => void map.set(k, b)),
		get: vi.fn(async (k: string) => (map.has(k) ? { text: async () => String(map.get(k)) } : null)),
		list: vi.fn(async (opts?: { prefix?: string; limit?: number }) => ({
			objects: [...map.keys()]
				.filter((k) => k.startsWith(opts?.prefix ?? ""))
				.sort()
				.slice(0, opts?.limit ?? 1000)
				.map((key) => ({ key, size: 1 })),
			truncated: false,
		})),
	};
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

	it("pull starts a durable run and returns {instanceId} immediately — never blocks in-request on the FHIR sync (#1178)", async () => {
		const env = connectedEnv();
		const created: any[] = [];
		env.OP_WORKFLOW = { create: vi.fn(async (opts: any) => (created.push(opts), { id: "instance-1" })) };
		const out = parse(await mychart.run(env, { op: "pull", types: ["DocumentReference"] })); // org defaulted (sole connected)
		expect(out.org).toBe(ORG);
		expect(out.patient).toBe("PatientA");
		expect(out.instanceId).toBe("instance-1");
		expect(created).toHaveLength(1);
		expect(created[0].params).toMatchObject({ opId: "mychart-pull", input: { org: ORG, patient: "PatientA", types: ["DocumentReference"] } });
		// nothing was fetched or written synchronously — the actual FHIR pagination only
		// happens once the durable Workflow instance itself runs (see mychart.test.ts's
		// pullType coverage for that logic).
		expect(env.R2.map.size).toBe(0);
	});

	it("pull without the OP_WORKFLOW binding is not_configured, not a silent inline fallback", async () => {
		const env = connectedEnv();
		const r = await mychart.run(env, { op: "pull" });
		expect(r.errorCode).toBe("not_configured");
	});

	it("pull on an org with no grant is not_configured, and doesn't touch another connected org's data", async () => {
		const env = connectedEnv();
		env.OP_WORKFLOW = { create: vi.fn() };
		const r = await mychart.run(env, { op: "pull", org: ORG2 });
		expect(r.errorCode).toBe("not_configured");
		expect(env.OP_WORKFLOW.create).not.toHaveBeenCalled();
		expect(env.R2.map.size).toBe(0);
	});
});

describe("mychart op=notes — the export path for stored clinical notes (#1462)", () => {
	const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
	const storeNote = async (env: any, id: string, html: string) =>
		env.R2.put(`phi/mychart/${ORG}/PatientA/Binary/${id}.json`, JSON.stringify({ resourceType: "Binary", contentType: "text/html", data: b64(html) }));

	it("exports a stored note's actual text to the caller — before #1462 the bodies were write-only and nothing could read them back", async () => {
		const env = connectedEnv();
		await storeNote(env, "b1", "<p>Assessment: post-op knee, healing well.</p>");
		await storeNote(env, "b2", "<p>Follow-up in six weeks.</p>");
		await env.R2.put(
			`phi/mychart/${ORG}/PatientA/DocumentReference/STAMP-p1.json`,
			JSON.stringify({
				resourceType: "Bundle",
				entry: [{ resource: { resourceType: "DocumentReference", id: "d1", description: "Ortho Note", content: [{ attachment: { url: `${BASE}/Binary/b1` } }] } }],
			}),
		);
		const out = parse(await mychart.run(env, { op: "notes", text: true }));
		expect(out.org).toBe(ORG);
		expect(out.total).toBe(2);
		expect(out.notes.map((n: any) => n.text)).toEqual(["Assessment: post-op knee, healing well.", "Follow-up in six weeks."]);
		expect(out.notes[0].title).toBe("Ortho Note");
	});

	it("indexes without bodies by default, and says so rather than looking like an empty chart", async () => {
		const env = connectedEnv();
		await storeNote(env, "b1", "<p>body</p>");
		const out = parse(await mychart.run(env, { op: "notes" }));
		expect(out.total).toBe(1);
		expect(out.notes[0]).toMatchObject({ id: "b1", text: "" });
		expect(out.note).toMatch(/text:true/);
	});

	it("reads one note by id, and 404s an id that was never pulled without echoing it raw", async () => {
		const env = connectedEnv();
		await storeNote(env, "b1", "<p>single</p>");
		expect(parse(await mychart.run(env, { op: "notes", id: "b1" })).text).toBe("single");
		const missing = await mychart.run(env, { op: "notes", id: "<script>x</script>" });
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).not.toMatch(/<script>/);
	});

	it("an empty bucket reports total:0 with a pointer at pull — never a silent empty list", async () => {
		const out = parse(await mychart.run(connectedEnv(), { op: "notes", text: true }));
		expect(out).toMatchObject({ total: 0, notes: [] });
		expect(out.note).toMatch(/op=pull/);
	});
});
