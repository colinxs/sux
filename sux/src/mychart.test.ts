import { afterEach, describe, expect, it, vi } from "vitest";
import { MYCHART_ORGS, connectedOrgs, handleAppleHealth, handleMychartRoutes, isUnderFhirBase, mintAccessToken, mychartFetch, readGrant, resolveFhirPath, resolveOrg, summarizeMyChart } from "./mychart";
import { handleObservability } from "./observability";

const ORG = "uwmedicine";
const ORG2 = "swedish";
const BASE = MYCHART_ORGS[ORG].fhirBase;
const BASE2 = MYCHART_ORGS[ORG2].fhirBase;
const AUTHZ = `${BASE}/authorize`;
const TOKEN = `${BASE}/token`;
const AUTHZ2 = `${BASE2}/authorize`;
const TOKEN2 = `${BASE2}/token`;

function kvStub() {
	const map = new Map<string, string>();
	return {
		map,
		get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => {
			map.set(k, v);
		}),
		delete: vi.fn(async (k: string) => {
			map.delete(k);
		}),
	};
}

function r2Stub() {
	const map = new Map<string, { body: any; contentType?: string }>();
	return {
		map,
		put: vi.fn(async (key: string, body: any, opts?: any) => {
			map.set(key, { body, contentType: opts?.httpMetadata?.contentType });
		}),
		get: vi.fn(async (key: string) => {
			const o = map.get(key);
			if (!o) return null;
			const bytes = typeof o.body === "string" ? new TextEncoder().encode(o.body) : new Uint8Array(o.body);
			return { size: bytes.length, httpMetadata: { contentType: o.contentType }, arrayBuffer: async () => bytes.buffer, text: async () => new TextDecoder().decode(bytes) };
		}),
		list: vi.fn(async (opts?: { prefix?: string; cursor?: string; limit?: number }) => {
			const prefix = opts?.prefix ?? "";
			const limit = opts?.limit ?? 1000;
			// Mirrors real R2: ascending key order, cursor = a plain page offset here (only this
			// stub needs to understand it).
			const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
			const start = opts?.cursor ? Number(opts.cursor) : 0;
			const page = all.slice(start, start + limit);
			const truncated = start + limit < all.length;
			return { objects: page.map((key) => ({ key, size: 0, uploaded: new Date() })), truncated, cursor: truncated ? String(start + limit) : undefined };
		}),
	};
}

const baseEnv = (over: Record<string, unknown> = {}) => ({ EPIC_CLIENT_ID: "cid", EPIC_CLIENT_SECRET: "csec", OAUTH_KV: kvStub(), R2: r2Stub(), ...over }) as any;

const smartCfgResponse = (authz = AUTHZ, token = TOKEN) => new Response(JSON.stringify({ authorization_endpoint: authz, token_endpoint: token }), { status: 200 });

const fetchRouter =
	(handlers: Record<string, () => Response>) =>
	async (u: any, init?: any): Promise<Response> => {
		const url = String(u);
		for (const [match, handler] of Object.entries(handlers)) {
			if (url.includes(match)) return handler();
		}
		throw new Error(`unexpected fetch ${url} ${init ? JSON.stringify(init.body ?? "") : ""}`);
	};

afterEach(() => vi.restoreAllMocks());

describe("MYCHART_ORGS registry", () => {
	it("seeds the three verified orgs with name + fhirBase", () => {
		expect(Object.keys(MYCHART_ORGS).sort()).toEqual(["bozeman", "swedish", "uwmedicine"]);
		for (const org of Object.values(MYCHART_ORGS)) {
			expect(org.name).toBeTruthy();
			expect(org.fhirBase).toMatch(/^https:\/\//);
		}
	});
});

describe("mychart FHIR base validation", () => {
	it("isUnderFhirBase accepts on-base URLs and rejects origin/path escapes", () => {
		expect(isUnderFhirBase(ORG, `${BASE}/Observation?patient=1`)).toBe(true);
		expect(isUnderFhirBase(ORG, `${BASE}`)).toBe(true);
		expect(isUnderFhirBase(ORG, "https://evil.com/Observation")).toBe(false);
		// prefix that isn't a path-segment boundary must not match
		expect(isUnderFhirBase(ORG, `${BASE}x/Observation`)).toBe(false);
		// an unknown org has no base — always refuses
		expect(isUnderFhirBase("nope", `${BASE}/Observation`)).toBe(false);
	});

	it("isUnderFhirBase keeps orgs isolated — org A's base never validates org B's URL", () => {
		expect(isUnderFhirBase(ORG, `${BASE2}/Observation`)).toBe(false);
		expect(isUnderFhirBase(ORG2, `${BASE}/Observation`)).toBe(false);
	});

	it("resolveFhirPath resolves relative paths and refuses escapes", () => {
		expect(resolveFhirPath(ORG, "Observation?category=laboratory")).toBe(`${BASE}/Observation?category=laboratory`);
		expect(resolveFhirPath(ORG, "https://evil.com/x")).toBeNull();
		expect(resolveFhirPath(ORG, "")).toBeNull();
		expect(resolveFhirPath("nope", "Observation")).toBeNull();
	});
});

describe("resolveOrg — explicit org, or default to the sole connected org", () => {
	it("an explicit known org resolves as-is; an unknown org errors listing valid orgs", async () => {
		const env = baseEnv();
		expect(await resolveOrg(env, ORG)).toEqual({ org: ORG });
		const bad = await resolveOrg(env, "nope");
		expect("error" in bad && bad.error).toMatch(/unknown org 'nope'/);
	});

	it("omitted org defaults to the sole CONNECTED org", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG}`, JSON.stringify({ refresh_token: "rt", patient: "P", issued_at: 1 }));
		expect(await resolveOrg(env, undefined)).toEqual({ org: ORG });
	});

	it("omitted org is ambiguous with zero or 2+ connected orgs", async () => {
		const env = baseEnv();
		expect("error" in (await resolveOrg(env, undefined))).toBe(true);
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG}`, JSON.stringify({ refresh_token: "rt", patient: "P", issued_at: 1 }));
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG2}`, JSON.stringify({ refresh_token: "rt2", patient: "P2", issued_at: 1 }));
		const err = await resolveOrg(env, undefined);
		expect("error" in err).toBe(true);
	});
});

describe("connectedOrgs", () => {
	it("lists only orgs with a stored grant", async () => {
		const env = baseEnv();
		expect(await connectedOrgs(env)).toEqual([]);
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG2}`, JSON.stringify({ refresh_token: "rt", patient: "P", issued_at: 1 }));
		expect(await connectedOrgs(env)).toEqual([ORG2]);
	});
});

describe("mychart OAuth callback (PKCE round-trip)", () => {
	it("exchanges code+verifier, persists the grant under the org from the PKCE state, caches the access token", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put("sux:mychart:pkce:STATE1", JSON.stringify({ verifier: "VERIFIER123", org: ORG, created: Date.now() }));
		const seen: any = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				const url = String(u);
				if (url.includes(".well-known/smart-configuration")) return smartCfgResponse();
				if (url === TOKEN) {
					seen.body = init.body;
					seen.auth = init.headers.Authorization;
					return new Response(JSON.stringify({ access_token: "AT1", refresh_token: "RT1", patient: "PatientA", scope: "patient/*.read", expires_in: 3600 }), { status: 200 });
				}
				throw new Error(`unexpected fetch ${url}`);
			}),
		);
		const resp = await handleMychartRoutes(new URL("https://suxos.net/mychart/callback?code=CODE1&state=STATE1"), new Request("https://suxos.net/mychart/callback?code=CODE1&state=STATE1"), env);
		expect(resp?.status).toBe(200);
		expect(await resp!.text()).toContain("MyChart connected");
		expect(seen.body).toContain("grant_type=authorization_code");
		expect(seen.body).toContain("code_verifier=VERIFIER123");
		expect(seen.auth).toBe(`Basic ${btoa("cid:csec")}`);
		const grant = await readGrant(env, ORG);
		expect(grant).toMatchObject({ refresh_token: "RT1", patient: "PatientA", scope: "patient/*.read" });
		expect(env.OAUTH_KV.map.get(`sux:mychart:token:${ORG}`)).toBe("AT1");
		// one-time state consumed
		expect(env.OAUTH_KV.map.has("sux:mychart:pkce:STATE1")).toBe(false);
	});

	it("serves the reflected `error` param as text/plain (no HTML execution)", async () => {
		const env = baseEnv();
		const xss = "<script>alert(1)</script>";
		const u = `https://suxos.net/mychart/callback?error=${encodeURIComponent(xss)}`;
		const resp = await handleMychartRoutes(new URL(u), new Request(u), env);
		expect(resp?.status).toBe(400);
		expect(resp!.headers.get("content-type")).toMatch(/text\/plain/);
	});

	it("refuses an unknown/expired state (CSRF check)", async () => {
		const env = baseEnv();
		const resp = await handleMychartRoutes(new URL("https://suxos.net/mychart/callback?code=X&state=NOPE"), new Request("https://suxos.net/mychart/callback?code=X&state=NOPE"), env);
		expect(resp?.status).toBe(400);
		expect(await resp!.text()).toMatch(/CSRF/i);
	});

	it("refuses a PKCE state whose stored org is missing/unknown (corrupt state)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put("sux:mychart:pkce:STATE2", JSON.stringify({ verifier: "V", org: "nope", created: Date.now() }));
		const resp = await handleMychartRoutes(new URL("https://suxos.net/mychart/callback?code=X&state=STATE2"), new Request("https://suxos.net/mychart/callback?code=X&state=STATE2"), env);
		expect(resp?.status).toBe(400);
		expect(await resp!.text()).toMatch(/Corrupt PKCE state/i);
	});
});

describe("mychart /connect gate — Bearer-authed, org-validated", () => {
	const req = (u: string, bearer?: string) => new Request(u, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined);

	it("404s when the operator token is unset, 401 on a missing/wrong bearer, 404 on an unknown org, 302 with S256 when correct", async () => {
		const noGate = baseEnv();
		const u = `https://suxos.net/mychart/connect?org=${ORG}`;
		expect((await handleMychartRoutes(new URL(u), req(u), noGate))?.status).toBe(404);

		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		expect((await handleMychartRoutes(new URL(u), req(u), env))?.status).toBe(401); // no bearer
		expect((await handleMychartRoutes(new URL(u), req(u, "wrong"), env))?.status).toBe(401);
		// the raw token in a query string (the OLD gate) must no longer work
		expect((await handleMychartRoutes(new URL(`${u}&token=op-secret`), req(`${u}&token=op-secret`), env))?.status).toBe(401);

		const unknownOrgUrl = "https://suxos.net/mychart/connect?org=nope";
		expect((await handleMychartRoutes(new URL(unknownOrgUrl), req(unknownOrgUrl, "op-secret"), env))?.status).toBe(404);

		vi.stubGlobal("fetch", vi.fn(fetchRouter({ ".well-known/smart-configuration": () => smartCfgResponse() })));
		const resp = await handleMychartRoutes(new URL(u), req(u, "op-secret"), env);
		expect(resp?.status).toBe(302);
		const loc = new URL(resp!.headers.get("location")!);
		expect(loc.origin + loc.pathname).toBe(AUTHZ);
		expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
		expect(loc.searchParams.get("aud")).toBe(BASE);
		expect(loc.searchParams.get("redirect_uri")).toBe("https://suxos.net/mychart/callback");
		const state = loc.searchParams.get("state")!;
		const stored = JSON.parse(env.OAUTH_KV.map.get(`sux:mychart:pkce:${state}`)!);
		expect(stored.org).toBe(ORG);
	});

	it("a smartConfig failure is escaped and served with an explicit text content-type (#360)", async () => {
		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
		const u = `https://suxos.net/mychart/connect?org=${ORG}`;
		const resp = await handleMychartRoutes(new URL(u), req(u, "op-secret"), env);
		expect(resp?.status).toBe(502);
		expect(resp?.headers.get("content-type")).toMatch(/text\/plain/);
		const body = await resp!.text();
		expect(body).not.toContain("<script>"); // any future attacker-influenced message stays HTML-inert
	});
});

describe("mychart token lifecycle (mint / rotate / 401 self-heal), per org", () => {
	it("mints from the refresh grant, caches the access token, persists a ROTATED refresh token — scoped to one org", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG}`, JSON.stringify({ refresh_token: "OLD_RT", patient: "P", issued_at: 1 }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				const url = String(u);
				if (url.includes(".well-known/smart-configuration")) return smartCfgResponse();
				if (url === TOKEN) {
					expect(String(init.body)).toContain("grant_type=refresh_token");
					expect(String(init.body)).toContain("refresh_token=OLD_RT");
					return new Response(JSON.stringify({ access_token: "AT2", refresh_token: "NEW_RT", expires_in: 3600 }), { status: 200 });
				}
				throw new Error(`unexpected ${url}`);
			}),
		);
		const tok = await mintAccessToken(env, ORG);
		expect(tok).toBe("AT2");
		expect(env.OAUTH_KV.map.get(`sux:mychart:token:${ORG}`)).toBe("AT2");
		expect(JSON.parse(env.OAUTH_KV.map.get(`sux:mychart:grant:${ORG}`)!).refresh_token).toBe("NEW_RT");
	});

	it("keeps the old refresh token when the response doesn't rotate it", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG}`, JSON.stringify({ refresh_token: "KEEP_RT", patient: "P", issued_at: 1 }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any) => {
				if (String(u).includes(".well-known/smart-configuration")) return smartCfgResponse();
				return new Response(JSON.stringify({ access_token: "AT3", expires_in: 3600 }), { status: 200 });
			}),
		);
		await mintAccessToken(env, ORG);
		expect(JSON.parse(env.OAUTH_KV.map.get(`sux:mychart:grant:${ORG}`)!).refresh_token).toBe("KEEP_RT");
	});

	it("mychartFetch drops the cached token and re-mints once on a 401", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG}`, JSON.stringify({ refresh_token: "RT", patient: "P", issued_at: 1 }));
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "STALE_AT");
		let minted = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				const url = String(u);
				if (url.includes(".well-known/smart-configuration")) return smartCfgResponse();
				if (url === TOKEN) {
					minted++;
					return new Response(JSON.stringify({ access_token: "FRESH_AT", expires_in: 3600 }), { status: 200 });
				}
				// The FHIR resource: 401 with the stale token, 200 with the fresh one.
				const bearer = init.headers.Authorization;
				if (bearer === "Bearer STALE_AT") return new Response("unauthorized", { status: 401 });
				return new Response(JSON.stringify({ resourceType: "Patient", id: "P" }), { status: 200 });
			}),
		);
		const resp = await mychartFetch(env, ORG, `${BASE}/Patient/P`);
		expect(resp.status).toBe(200);
		expect(minted).toBe(1);
		expect(env.OAUTH_KV.map.get(`sux:mychart:token:${ORG}`)).toBe("FRESH_AT");
	});

	it("keeps two orgs' grants/tokens fully isolated — minting for one never reads or writes the other's", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG}`, JSON.stringify({ refresh_token: "RT_A", patient: "PA", issued_at: 1 }));
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG2}`, JSON.stringify({ refresh_token: "RT_B", patient: "PB", issued_at: 1 }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				const url = String(u);
				if (url.includes(".well-known/smart-configuration")) return url.startsWith(BASE2) ? smartCfgResponse(AUTHZ2, TOKEN2) : smartCfgResponse();
				if (url === TOKEN) {
					expect(String(init.body)).toContain("refresh_token=RT_A");
					return new Response(JSON.stringify({ access_token: "AT_A", expires_in: 3600 }), { status: 200 });
				}
				if (url === TOKEN2) {
					expect(String(init.body)).toContain("refresh_token=RT_B");
					return new Response(JSON.stringify({ access_token: "AT_B", expires_in: 3600 }), { status: 200 });
				}
				throw new Error(`unexpected ${url}`);
			}),
		);
		await mintAccessToken(env, ORG);
		expect(env.OAUTH_KV.map.get(`sux:mychart:token:${ORG}`)).toBe("AT_A");
		expect(env.OAUTH_KV.map.has(`sux:mychart:token:${ORG2}`)).toBe(false);
		await mintAccessToken(env, ORG2);
		expect(env.OAUTH_KV.map.get(`sux:mychart:token:${ORG2}`)).toBe("AT_B");
		expect(env.OAUTH_KV.map.get(`sux:mychart:token:${ORG}`)).toBe("AT_A"); // untouched
	});
});

describe("apple-health ingest", () => {
	const post = (env: any, headers: Record<string, string>, body = '{"data":{"metrics":[]}}') =>
		handleAppleHealth(new URL("https://suxos.net/apple-health"), new Request("https://suxos.net/apple-health", { method: "POST", headers, body }), env);

	it("404s when HEALTH_INGEST_TOKEN is unset (feature off)", async () => {
		const resp = await post(baseEnv(), { authorization: "Bearer x" });
		expect(resp?.status).toBe(404);
	});

	it("401s on a wrong/missing bearer", async () => {
		const env = baseEnv({ HEALTH_INGEST_TOKEN: "secret" });
		expect((await post(env, {}))?.status).toBe(401);
		expect((await post(env, { authorization: "Bearer nope" }))?.status).toBe(401);
	});

	it("accepts a valid POST, writes under phi/, and a re-POST is an idempotent upsert", async () => {
		const env = baseEnv({ HEALTH_INGEST_TOKEN: "secret" });
		const headers = { authorization: "Bearer secret", "x-automation-id": "auto1", "x-period": "2026-07-13" };
		const r1 = await post(env, headers);
		expect(r1?.status).toBe(200);
		const body1 = JSON.parse(await r1!.text());
		expect(body1.ok).toBe(true);
		expect(body1.key.startsWith("phi/apple-health/")).toBe(true);
		expect(env.R2.map.size).toBe(1);
		// Same automation-id + period ⇒ same key ⇒ one object, not two.
		const r2 = await post(env, headers);
		expect(JSON.parse(await r2!.text()).key).toBe(body1.key);
		expect(env.R2.map.size).toBe(1);
	});

	it("rejects a non-POST method", async () => {
		const env = baseEnv({ HEALTH_INGEST_TOKEN: "secret" });
		const resp = await handleAppleHealth(new URL("https://suxos.net/apple-health"), new Request("https://suxos.net/apple-health", { method: "GET" }), env);
		expect(resp?.status).toBe(405);
	});

	it("rejects a multi-byte body whose UTF-16 code-unit length is under MAX_BYTES but whose UTF-8 byte length exceeds it", async () => {
		const env = baseEnv({ HEALTH_INGEST_TOKEN: "secret" });
		// U+66F8 encodes as 3 UTF-8 bytes but 1 UTF-16 code unit, so 3,000,000 of them is
		// well under the 8 MiB cap by body.length (3,000,000) but well over it by actual
		// byte size (9,000,000) — exactly the gap body.length undercounts.
		const oversized = "書".repeat(3_000_000);
		expect(oversized.length).toBeLessThan(8 * 1024 * 1024);
		expect(new TextEncoder().encode(oversized).length).toBeGreaterThan(8 * 1024 * 1024);
		const resp = await post(env, { authorization: "Bearer secret" }, oversized);
		expect(resp?.status).toBe(413);
		expect(env.R2.map.size).toBe(0);
	});
});

describe("PHI gate: /s/ handler refuses phi/ keys", () => {
	it("404s a store handle that resolves to the private phi/ prefix", async () => {
		const kv = kvStub();
		const r2 = r2Stub();
		await r2.put(`phi/mychart/${ORG}/P/Patient/x.json`, '{"resourceType":"Patient"}', { httpMetadata: { contentType: "application/fhir+json" } });
		await kv.put("store:11111111-1111-1111-1111-111111111111", JSON.stringify({ key: `phi/mychart/${ORG}/P/Patient/x.json`, content_type: "application/fhir+json" }));
		const env = { OAUTH_KV: kv, R2: r2 } as any;
		const resp = await handleObservability(new URL("https://suxos.net/s/11111111-1111-1111-1111-111111111111"), new Request("https://suxos.net/s/11111111-1111-1111-1111-111111111111"), env);
		expect(resp?.status).toBe(404);
	});
});

describe("summarizeMyChart — redacted last-pull summary for the agenda detector (W6), multi-org", () => {
	async function seedGrant(env: ReturnType<typeof baseEnv>, org: string, patient: string) {
		await env.OAUTH_KV.put(`sux:mychart:grant:${org}`, JSON.stringify({ refresh_token: "rt", patient, issued_at: Date.now() }));
	}
	async function seedBundle(env: ReturnType<typeof baseEnv>, org: string, patient: string, label: string, stamp: string, resources: any[]) {
		const bundle = { resourceType: "Bundle", entry: resources.map((resource) => ({ resource })) };
		await env.R2.put(`phi/mychart/${org}/${patient}/${label}/${stamp}-p1.json`, JSON.stringify(bundle), { httpMetadata: { contentType: "application/fhir+json" } });
	}

	it("returns null when unconfigured or never connected", async () => {
		expect(await summarizeMyChart({} as any)).toBeNull();
		const env = baseEnv();
		expect(await summarizeMyChart(env)).toBeNull(); // configured, but no grant yet
	});

	it("flags an out-of-range lab/vital observation by direction only, never the value", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "Observation.laboratory", "2026-07-18T00-00-00-000Z", [
			{ resourceType: "Observation", id: "obs1", interpretation: [{ coding: [{ code: "H" }] }], valueQuantity: { value: 999 } },
			{ resourceType: "Observation", id: "obs2", interpretation: [{ coding: [{ code: "N" }] }], valueQuantity: { value: 5 } },
		]);
		const summary = await summarizeMyChart(env);
		expect(summary?.labFlags).toEqual([{ id: "obs1", category: "laboratory", direction: "high" }]);
		expect(JSON.stringify(summary)).not.toContain("999"); // the raw value never leaves latestPulledResources
	});

	it("flags an active MedicationRequest whose validityPeriod ends inside the refill window, skips one far out or inactive", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [
			{ resourceType: "MedicationRequest", id: "med1", status: "active", medicationCodeableConcept: { text: "Atorvastatin" }, dispenseRequest: { validityPeriod: { end: "2026-07-25" } } },
			{ resourceType: "MedicationRequest", id: "med2", status: "active", dispenseRequest: { validityPeriod: { end: "2027-01-01" } } }, // far out
			{ resourceType: "MedicationRequest", id: "med3", status: "stopped", dispenseRequest: { validityPeriod: { end: "2026-07-19" } } }, // inactive
		]);
		const summary = await summarizeMyChart(env, { now: "2026-07-18", refillWindowDays: 14 });
		expect(summary?.refillsDue).toEqual([{ id: "med1", name: "Atorvastatin", dueDate: "2026-07-25" }]);
	});

	it("treats a long-stale validityPeriod as stale data, not a live refill-due signal", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "med1", status: "active", dispenseRequest: { validityPeriod: { end: "2025-01-01" } } }]);
		const summary = await summarizeMyChart(env, { now: "2026-07-18" });
		expect(summary?.refillsDue).toHaveLength(0);
	});

	it("returns bare ids for Condition, and id + generic doc type for DocumentReference — never a diagnosis name", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1", code: { text: "should never appear" } }]);
		await seedBundle(env, ORG, "P1", "DocumentReference", "2026-07-18T00-00-00-000Z", [{ resourceType: "DocumentReference", id: "doc1", type: { text: "After Visit Summary" } }]);
		const summary = await summarizeMyChart(env);
		expect(summary?.newConditions).toEqual([{ id: "cond1" }]);
		expect(summary?.newDocuments).toEqual([{ id: "doc1", docType: "After Visit Summary" }]);
		expect(JSON.stringify(summary)).not.toContain("should never appear");
	});

	it("only reads the most recent pull's stamp per label, ignoring an older one", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "Condition", "2026-07-01T00-00-00-000Z", [{ resourceType: "Condition", id: "old-cond" }]);
		await seedBundle(env, ORG, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "new-cond" }]);
		const summary = await summarizeMyChart(env);
		expect(summary?.newConditions).toEqual([{ id: "new-cond" }]);
	});

	it("paginates past R2's per-call listing cap to find the true latest stamp, not just the oldest page", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		// R2 lists ascending by key — a label that's accumulated >1000 pull-page objects over
		// months would sink an unpaginated list() call to only ever see the OLDEST page.
		for (let i = 0; i < 1005; i++) {
			env.R2.map.set(`phi/mychart/${ORG}/P1/Condition/2020-01-${String(i).padStart(4, "0")}T00-00-00-000Z-p1.json`, { body: JSON.stringify({ resourceType: "Bundle", entry: [] }) });
		}
		await seedBundle(env, ORG, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "true-latest" }]);
		const summary = await summarizeMyChart(env);
		expect(summary?.newConditions).toEqual([{ id: "true-latest" }]);
	});

	it("with one connected org, ids stay bare (no ledger-dedupe migration when a second org later connects)", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1" }]);
		const summary = await summarizeMyChart(env);
		expect(summary?.newConditions).toEqual([{ id: "cond1" }]);
	});

	it("with two connected orgs, merges both and prefixes ids with org so identical FHIR ids across orgs never collide", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P1"); // deliberately the SAME opaque patient id at a different org
		await seedBundle(env, ORG, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1" }]);
		await seedBundle(env, ORG2, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1" }]); // same id, different org
		const summary = await summarizeMyChart(env);
		expect(summary?.newConditions.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: `${ORG2}:cond1` }, { id: `${ORG}:cond1` }]);
	});

	it("a second org's grant with zero pulled resources doesn't re-prefix the first org's already-seen bare ids (#994)", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1" }]);
		// ORG2's OAuth completed (grant exists) but `pull` has never run — no R2 object exists
		// under its phi/mychart/ prefix at all.
		await seedGrant(env, ORG2, "P1");
		const summary = await summarizeMyChart(env);
		expect(summary?.newConditions).toEqual([{ id: "cond1" }]); // still bare, not "uwmedicine:cond1"
	});

	it("opts.org scopes to a single org even when others are connected", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P2");
		await seedBundle(env, ORG, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "only-org-a" }]);
		await seedBundle(env, ORG2, "P2", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "only-org-b" }]);
		const summary = await summarizeMyChart(env, { org: ORG });
		expect(summary?.newConditions).toEqual([{ id: "only-org-a" }]);
	});
});
