import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_BINARIES_PER_TYPE,
	MYCHART_ORGS,
	NOTE_EXPORT_CHAR_BUDGET,
	buildPullPlan,
	connectedOrgs,
	crossOrgAllergyGaps,
	crossOrgMedicationAllergyConflicts,
	decodeStoredBinary,
	gatherMedicalTimelineEvents,
	handleAppleHealth,
	handleMychartRoutes,
	isUnderFhirBase,
	listStoredNotes,
	mintAccessToken,
	mychartFetch,
	pullType,
	readGrant,
	readStoredNote,
	reconcilePull,
	resolveFhirPath,
	resolveOrg,
	rtfToText,
	storedBinaryIds,
	substancesOverlap,
	summarizeMyChart,
	throttledPullType,
} from "./mychart";
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
			// Real byte length, not a 0 placeholder — pullType's resume skip set filters on
			// `size > 0` so a zero-length body written from a 200 gets re-fetched, and a stub
			// reporting 0 for everything makes that filter untestable (it would look like it
			// skips nothing).
			const sizeOf = (k: string) => {
				const o = map.get(k)!;
				return typeof o.body === "string" ? new TextEncoder().encode(o.body).length : new Uint8Array(o.body).length;
			};
			return { objects: page.map((key) => ({ key, size: sizeOf(key), uploaded: new Date() })), truncated, cursor: truncated ? String(start + limit) : undefined };
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
	it("seeds the registered orgs with name + fhirBase", () => {
		expect(Object.keys(MYCHART_ORGS).sort()).toEqual(["bozeman", "evergreen", "swedish", "uwmedicine"]);
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

	it("uses a per-org EPIC_CLIENT_SECRET_<ORG> for the token endpoint's Basic auth header when one is set", async () => {
		const env = baseEnv({ EPIC_CLIENT_SECRET_UWMEDICINE: "org-secret" });
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG}`, JSON.stringify({ refresh_token: "RT", patient: "P", issued_at: 1 }));
		let seenAuth = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				const url = String(u);
				if (url.includes(".well-known/smart-configuration")) return smartCfgResponse();
				if (url === TOKEN) {
					seenAuth = init.headers.Authorization;
					return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
				}
				throw new Error(`unexpected ${url}`);
			}),
		);
		await mintAccessToken(env, ORG);
		expect(seenAuth).toBe(`Basic ${btoa("cid:org-secret")}`);
	});

	it("falls back to the global EPIC_CLIENT_SECRET when no per-org secret is set for that org", async () => {
		const env = baseEnv(); // baseEnv only ever sets the global EPIC_CLIENT_SECRET ("csec")
		await env.OAUTH_KV.put(`sux:mychart:grant:${ORG2}`, JSON.stringify({ refresh_token: "RT", patient: "P", issued_at: 1 }));
		let seenAuth = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				const url = String(u);
				if (url.includes(".well-known/smart-configuration")) return smartCfgResponse(AUTHZ2, TOKEN2);
				if (url === TOKEN2) {
					seenAuth = init.headers.Authorization;
					return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
				}
				throw new Error(`unexpected ${url}`);
			}),
		);
		await mintAccessToken(env, ORG2);
		expect(seenAuth).toBe(`Basic ${btoa("cid:csec")}`);
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

describe("buildPullPlan / pullType / reconcilePull — the durable `mychart-pull` op's leaves (#1178)", () => {
	it("buildPullPlan carries org/patient/stamp onto every resourcePlan item", () => {
		const items = buildPullPlan({ org: ORG, patient: "P1", types: ["DocumentReference"] }, "STAMP");
		expect(items).toEqual([{ type: "DocumentReference", label: "DocumentReference", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" }]);
	});

	it("pullType pages a searchset, resolves DocumentReference→Binary, writes raw FHIR under org-scoped phi/ — same key shape the old synchronous pull() wrote", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		const page1 = {
			resourceType: "Bundle",
			link: [{ relation: "next", url: `${BASE}/DocumentReference?patient=P1&page=2` }],
			entry: [{ resource: { resourceType: "DocumentReference", id: "d1", content: [{ attachment: { url: `${BASE}/Binary/b1` } }] } }],
		};
		const page2 = { resourceType: "Bundle", entry: [{ resource: { resourceType: "DocumentReference", id: "d2", content: [] } }] };
		vi.stubGlobal(
			"fetch",
			fetchRouter({
				"/Binary/b1": () => new Response(JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "aGk=" }), { status: 200 }),
				"page=2": () => new Response(JSON.stringify(page2), { status: 200 }),
				"/DocumentReference": () => new Response(JSON.stringify(page1), { status: 200 }),
			}),
		);
		const item = { type: "DocumentReference", label: "DocumentReference", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" };
		const result = await pullType(env, item);
		expect(result).toEqual({ org: ORG, patient: "P1", label: "DocumentReference", count: 2, pages: 2, binaries: 1, keys: 3, status: "ok", binariesSeen: 1 });
		const keys = [...env.R2.map.keys()];
		expect(keys.every((k: string) => k.startsWith(`phi/mychart/${ORG}/P1/`))).toBe(true);
		expect(keys.some((k: string) => k.includes("/Binary/b1.json"))).toBe(true);
	});

	it("pullType throws on a 429/5xx so the durable step retries — never silently drops the type the way the old pull() did", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
		const item = { type: "Condition", label: "Condition", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" };
		await expect(pullType(env, item)).rejects.toThrow(/429/);
	});

	it("pullType reports a 404 as status:'unsupported', never an error — some orgs don't support every USCDI type", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
		const item = { type: "Goal", label: "Goal", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" };
		const result = await pullType(env, item);
		expect(result.status).toBe("unsupported");
		expect(result.count).toBe(0);
	});

	it("pullType caps the DocumentReference→Binary fan-out at MAX_BINARIES_PER_TYPE and flips status to 'truncated' — never an unbounded per-attachment fan-out", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		const overCap = MAX_BINARIES_PER_TYPE + 5;
		const page = {
			resourceType: "Bundle",
			entry: Array.from({ length: overCap }, (_, i) => ({ resource: { resourceType: "DocumentReference", id: `d${i}`, content: [{ attachment: { url: `${BASE}/Binary/b${i}` } }] } })),
		};
		vi.stubGlobal(
			"fetch",
			fetchRouter({
				"/Binary/": () => new Response(JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "aGk=" }), { status: 200 }),
				"/DocumentReference": () => new Response(JSON.stringify(page), { status: 200 }),
			}),
		);
		const item = { type: "DocumentReference", label: "DocumentReference", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" };
		const result = await pullType(env, item);
		expect(result.binaries).toBe(MAX_BINARIES_PER_TYPE);
		expect(result.status).toBe("truncated");
		expect(result.count).toBe(overCap);
		expect([...env.R2.map.keys()].filter((k: string) => k.includes("/Binary/")).length).toBe(MAX_BINARIES_PER_TYPE);
	});

	it("pullType RESUMES past the binary cap — the cap bounds NEW fetches, so repeated pulls advance instead of refetching the same chunk forever (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		// Everything the previous pull already landed.
		for (let i = 0; i < MAX_BINARIES_PER_TYPE; i++) {
			await env.R2.put(`phi/mychart/${ORG}/P1/Binary/b${i}.json`, JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "aGk=" }), {});
		}
		const attachments = MAX_BINARIES_PER_TYPE + 5;
		const page = {
			resourceType: "Bundle",
			entry: Array.from({ length: attachments }, (_, i) => ({ resource: { resourceType: "DocumentReference", id: `d${i}`, content: [{ attachment: { url: `${BASE}/Binary/b${i}` } }] } })),
		};
		vi.stubGlobal(
			"fetch",
			fetchRouter({
				"/Binary/": () => new Response(JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "aGk=" }), { status: 200 }),
				"/DocumentReference": () => new Response(JSON.stringify(page), { status: 200 }),
			}),
		);
		const result = await pullType(env, { type: "DocumentReference", label: "DocumentReference", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(result.binaries).toBe(5);
		expect(result.binariesSkipped).toBe(MAX_BINARIES_PER_TYPE);
		expect(result.binariesSeen).toBe(attachments);
		expect(result.status).toBe("ok");
		for (let i = MAX_BINARIES_PER_TYPE; i < attachments; i++) expect(env.R2.map.has(`phi/mychart/${ORG}/P1/Binary/b${i}.json`)).toBe(true);
	});

	it("pullType's resume skip set re-fetches a ZERO-length stored body — the unstamped key self-heals it today and a naive skip set would freeze it forever (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		await env.R2.put(`phi/mychart/${ORG}/P1/Binary/b1.json`, "", {});
		const page = { resourceType: "Bundle", entry: [{ resource: { resourceType: "DocumentReference", id: "d1", content: [{ attachment: { url: `${BASE}/Binary/b1` } }] } }] };
		vi.stubGlobal(
			"fetch",
			fetchRouter({
				"/Binary/": () => new Response(JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "aGk=" }), { status: 200 }),
				"/DocumentReference": () => new Response(JSON.stringify(page), { status: 200 }),
			}),
		);
		const result = await pullType(env, { type: "DocumentReference", label: "DocumentReference", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(result.binaries).toBe(1);
		expect(result.binariesSkipped).toBeUndefined();
		expect(String(env.R2.map.get(`phi/mychart/${ORG}/P1/Binary/b1.json`).body)).toContain("Binary");
	});

	it("pullType honors refetchBinaries — the escape hatch for a note Epic amended under the same id (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		await env.R2.put(`phi/mychart/${ORG}/P1/Binary/b1.json`, JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "b2xk" }), {});
		const page = { resourceType: "Bundle", entry: [{ resource: { resourceType: "DocumentReference", id: "d1", content: [{ attachment: { url: `${BASE}/Binary/b1` } }] } }] };
		vi.stubGlobal(
			"fetch",
			fetchRouter({
				"/Binary/": () => new Response(JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "bmV3" }), { status: 200 }),
				"/DocumentReference": () => new Response(JSON.stringify(page), { status: 200 }),
			}),
		);
		const base = { type: "DocumentReference", label: "DocumentReference", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" };
		expect((await pullType(env, base)).binariesSkipped).toBe(1);
		const forced = await pullType(env, { ...base, refetchBinaries: true });
		expect(forced.binaries).toBe(1);
		expect(forced.binariesSkipped).toBeUndefined();
		expect(String(env.R2.map.get(`phi/mychart/${ORG}/P1/Binary/b1.json`).body)).toContain("bmV3");
	});

	it("pullType fetches an absolute attachment URL VERBATIM — rebuilding `${base}/Binary/${id}` would change the request and 4xx into a silent per-note drop (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		const attUrl = `${BASE}/SomePath/Binary/b1`;
		const page = { resourceType: "Bundle", entry: [{ resource: { resourceType: "DocumentReference", id: "d1", content: [{ attachment: { url: attUrl } }] } }] };
		const seenUrls: string[] = [];
		vi.stubGlobal("fetch", async (u: any) => {
			seenUrls.push(String(u));
			if (String(u).includes("/Binary/")) return new Response(JSON.stringify({ resourceType: "Binary", contentType: "text/plain", data: "aGk=" }), { status: 200 });
			return new Response(JSON.stringify(page), { status: 200 });
		});
		await pullType(env, { type: "DocumentReference", label: "DocumentReference", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(seenUrls).toContain(attUrl);
	});

	it("pullType counts a failed Binary fetch and an unresolvable attachment instead of dropping both silently (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		const page = {
			resourceType: "Bundle",
			entry: [
				{ resource: { resourceType: "DocumentReference", id: "d1", content: [{ attachment: { url: `${BASE}/Binary/b1` } }] } },
				{ resource: { resourceType: "DocumentReference", id: "d2", content: [{ attachment: { url: `${BASE}/DocumentReference/$binary?id=zz` } }] } },
			],
		};
		vi.stubGlobal(
			"fetch",
			fetchRouter({
				"/Binary/b1": () => new Response("", { status: 403 }),
				"/DocumentReference": () => new Response(JSON.stringify(page), { status: 200 }),
			}),
		);
		const result = await pullType(env, { type: "DocumentReference", label: "DocumentReference", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(result.binariesFailed).toBe(1);
		expect(result.binariesUnresolvable).toBe(1);
		expect(result.status).toBe("truncated");
		expect(reconcilePull([result]).errors!.DocumentReference).toMatch(/Binary fetch/);
	});

	it("buildPullPlan carries refetchBinaries onto every item, and omits it when unset", () => {
		expect(buildPullPlan({ org: ORG, patient: "P1", types: ["DocumentReference"], refetchBinaries: true }, "S")[0].refetchBinaries).toBe(true);
		expect(buildPullPlan({ org: ORG, patient: "P1", types: ["DocumentReference"] }, "S")[0]).not.toHaveProperty("refetchBinaries");
	});

	it("pullType flags count < Bundle.total as truncated — !next alone is not proof of completeness (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		const page = { resourceType: "Bundle", total: 250, entry: Array.from({ length: 100 }, (_, i) => ({ resource: { resourceType: "Condition", id: `c${i}` } })) };
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })));
		const result = await pullType(env, { type: "Condition", label: "Condition", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(result.status).toBe("truncated");
		expect(result.reason).toMatch(/total/);
	});

	it("pullType counts MATCH entries only — Epic's trailing OperationOutcome is what pinned six types at exactly 101 (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		const page = {
			resourceType: "Bundle",
			entry: [
				...Array.from({ length: 100 }, (_, i) => ({ search: { mode: "match" }, resource: { resourceType: "Condition", id: `c${i}` } })),
				{ search: { mode: "outcome" }, resource: { resourceType: "OperationOutcome", issue: [{ severity: "warning", code: "informational" }] } },
			],
		};
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })));
		const result = await pullType(env, { type: "Condition", label: "Condition", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(result.count).toBe(100);
		expect(result.status).toBe("ok");
		// The outcome entry must still be on disk — it is Epic's only disclosure of suppressed sub-types.
		expect(String(env.R2.map.get(`phi/mychart/${ORG}/P1/Condition/STAMP-p1.json`).body)).toContain("OperationOutcome");
	});

	it("pullType reports a MID-pagination 404 as truncated, not 'unsupported' — a broken continuation is not an unsupported type (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		const page1 = { resourceType: "Bundle", link: [{ relation: "next", url: `${BASE}/Condition?patient=P1&page=2` }], entry: [{ resource: { resourceType: "Condition", id: "c1" } }] };
		vi.stubGlobal("fetch", fetchRouter({ "page=2": () => new Response("", { status: 404 }), "/Condition": () => new Response(JSON.stringify(page1), { status: 200 }) }));
		const result = await pullType(env, { type: "Condition", label: "Condition", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(result.status).toBe("truncated");
		expect(reconcilePull([result]).errors).toHaveProperty("Condition");
	});

	it("pullType carries a 4xx's specific reason all the way into reconcilePull's errors — CarePlan's arm, previously a generic literal (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));
		const result = await pullType(env, { type: "CarePlan", label: "CarePlan", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(reconcilePull([result]).errors!.CarePlan).toMatch(/HTTP 400/);
	});

	it("pullType flags a REFUSED next link as truncated instead of silently reporting ok — and never echoes the URL into `reason` (#1365)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put(`sux:mychart:token:${ORG}`, "AT");
		const page1 = { resourceType: "Bundle", link: [{ relation: "next", url: "https://evil.example/FHIR/R4/Condition?patient=SECRETID" }], entry: [{ resource: { resourceType: "Condition", id: "c1" } }] };
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(page1), { status: 200 })));
		const result = await pullType(env, { type: "Condition", label: "Condition", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" });
		expect(result.status).toBe("truncated");
		expect(result.reason).not.toMatch(/SECRETID|evil\.example/);
	});

	it("reconcilePull treats a status it has never seen as incomplete, not clean — the default arm is the point (#1365)", () => {
		const rogue = { org: ORG, patient: "P1", label: "Future", count: 3, pages: 1, binaries: 0, keys: 1, status: "surprise" as any };
		const out = reconcilePull([rogue]);
		expect(out.truncated).toBe(true);
		expect(out.errors!.Future).toMatch(/unclassified/);
	});

	it("reconcilePull still waves through an unsupported type that landed zero pages", () => {
		const out = reconcilePull([{ org: ORG, patient: "P1", label: "Goal", count: 0, pages: 0, binaries: 0, keys: 0, status: "unsupported" as const }]);
		expect(out.truncated).toBeUndefined();
		expect(out.errors).toBeUndefined();
	});

	it("throttledPullType degrades a retry-exhausted type to status:'throttled', and reconcilePull surfaces it in `errors` — one bad type never sinks the pull", () => {
		const item = { type: "Condition", label: "Condition", query: "patient=P1&_count=100", org: ORG, patient: "P1", stamp: "STAMP" };
		const throttled = throttledPullType(item);
		expect(throttled).toEqual({ org: ORG, patient: "P1", label: "Condition", count: 0, pages: 0, binaries: 0, keys: 0, status: "throttled" });
		const out = reconcilePull([{ org: ORG, patient: "P1", label: "Patient", count: 1, pages: 1, binaries: 0, keys: 1, status: "ok" as const }, throttled]);
		expect(out.truncated).toBe(true);
		expect(out.errors).toHaveProperty("Condition");
		expect(out.errors!.Condition).toMatch(/throttled/);
		expect(out.counts.Patient).toBe(1);
	});

	it("reconcilePull merges per-type results into counts, and surfaces a truncated type in `errors` — never silently reports a partial sync as clean", () => {
		const results = [
			{ org: ORG, patient: "P1", label: "Condition", count: 3, pages: 1, binaries: 0, keys: 1, status: "ok" as const },
			{ org: ORG, patient: "P1", label: "Goal", count: 0, pages: 0, binaries: 0, keys: 0, status: "unsupported" as const },
			{ org: ORG, patient: "P1", label: "Observation.laboratory", count: 50, pages: 50, binaries: 0, keys: 50, status: "truncated" as const },
		];
		const out = reconcilePull(results);
		expect(out).toMatchObject({ org: ORG, patient: "P1", counts: { Condition: 3, Goal: 0, "Observation.laboratory": 50 }, truncated: true });
		expect(out.errors).toHaveProperty("Observation.laboratory");
		expect(out.errors).not.toHaveProperty("Goal");
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

describe("gatherMedicalTimelineEvents — FHIR → medical_timeline_plan mapper (#1220)", () => {
	async function seedGrant(env: ReturnType<typeof baseEnv>, org: string, patient: string) {
		await env.OAUTH_KV.put(`sux:mychart:grant:${org}`, JSON.stringify({ refresh_token: "rt", patient, issued_at: Date.now() }));
	}
	async function seedBundle(env: ReturnType<typeof baseEnv>, org: string, patient: string, label: string, stamp: string, resources: any[]) {
		const bundle = { resourceType: "Bundle", entry: resources.map((resource) => ({ resource })) };
		await env.R2.put(`phi/mychart/${org}/${patient}/${label}/${stamp}-p1.json`, JSON.stringify(bundle), { httpMetadata: { contentType: "application/fhir+json" } });
	}

	it("returns [] when unconfigured, not connected, or never pulled", async () => {
		expect(await gatherMedicalTimelineEvents({} as any)).toEqual([]);
		const env = baseEnv();
		expect(await gatherMedicalTimelineEvents(env)).toEqual([]); // configured, but no grant yet
		await seedGrant(env, ORG, "P1");
		expect(await gatherMedicalTimelineEvents(env)).toEqual([]); // grant exists, never pulled
	});

	it("maps Encounter/MedicationRequest/DiagnosticReport to appointment/medication/result, citing an opaque mychart:{org}:{type}/{id}", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "Encounter", "2026-07-18T00-00-00-000Z", [{ resourceType: "Encounter", id: "enc1", period: { start: "2026-06-01T10:00:00Z" }, type: [{ text: "Office Visit" }] }]);
		await seedBundle(env, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "med1", authoredOn: "2026-05-15", medicationCodeableConcept: { text: "Atorvastatin" } }]);
		await seedBundle(env, ORG, "P1", "DiagnosticReport", "2026-07-18T00-00-00-000Z", [{ resourceType: "DiagnosticReport", id: "rep1", effectiveDateTime: "2026-04-20", category: [{ text: "Laboratory" }], conclusion: "should never appear" }]);

		const events = await gatherMedicalTimelineEvents(env);
		const json = JSON.stringify(events);
		expect(json).not.toContain("should never appear"); // conclusion/diagnosis text never leaves the mapper

		expect(events.sort((a, b) => a.date.localeCompare(b.date))).toEqual([
			{ date: "2026-04-20", kind: "result", title: "Laboratory report", source: `mychart:${ORG}:DiagnosticReport/rep1` },
			{ date: "2026-05-15", kind: "medication", title: "Atorvastatin", source: `mychart:${ORG}:MedicationRequest/med1` },
			{ date: "2026-06-01", kind: "appointment", title: "Office Visit", source: `mychart:${ORG}:Encounter/enc1` },
		]);
	});

	it("drops a resource with no usable date instead of throwing", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "Encounter", "2026-07-18T00-00-00-000Z", [{ resourceType: "Encounter", id: "enc-nodate" }]);
		expect(await gatherMedicalTimelineEvents(env)).toEqual([]);
	});

	it("opts.org scopes to a single org even when others are connected", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P2");
		await seedBundle(env, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "only-a", authoredOn: "2026-01-01", medicationCodeableConcept: { text: "A" } }]);
		await seedBundle(env, ORG2, "P2", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "only-b", authoredOn: "2026-01-01", medicationCodeableConcept: { text: "B" } }]);
		const events = await gatherMedicalTimelineEvents(env, { org: ORG });
		expect(events).toEqual([{ date: "2026-01-01", kind: "medication", title: "A", source: `mychart:${ORG}:MedicationRequest/only-a` }]);
	});

	it("fans across every connected org when opts.org is omitted", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P2");
		await seedBundle(env, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "m-a", authoredOn: "2026-01-01", medicationCodeableConcept: { text: "A" } }]);
		await seedBundle(env, ORG2, "P2", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "m-b", authoredOn: "2026-01-02", medicationCodeableConcept: { text: "B" } }]);
		const events = await gatherMedicalTimelineEvents(env);
		expect(events.map((e) => e.source).sort()).toEqual([`mychart:${ORG2}:MedicationRequest/m-b`, `mychart:${ORG}:MedicationRequest/m-a`].sort());
	});
});

describe("substancesOverlap — conservative, non-diagnostic text match (#1005)", () => {
	it("matches on a shared significant word or a substring containment", () => {
		expect(substancesOverlap("Penicillin V Potassium", "Penicillin")).toBe(true);
		expect(substancesOverlap("Amoxicillin 500mg oral capsule", "amoxicillin")).toBe(true);
		expect(substancesOverlap("Ibuprofen", "Acetaminophen")).toBe(false);
	});

	it("ignores generic pharma filler words so unrelated substances never share only a stopword", () => {
		expect(substancesOverlap("Aspirin 81mg oral tablet", "Penicillin oral suspension")).toBe(false);
	});

	it("ignores generic ingredient/salt/class words too (#1012)", () => {
		expect(substancesOverlap("Vitamin D3", "Vitamin B12 injection")).toBe(false);
		expect(substancesOverlap("Diclofenac Sodium", "Sodium Bicarbonate")).toBe(false);
	});

	it("is false-safe on empty/missing input", () => {
		expect(substancesOverlap("", "Penicillin")).toBe(false);
		expect(substancesOverlap("Penicillin", "")).toBe(false);
	});

	it("ignores bare numeric dosage tokens so unrelated substances never share only a dose (#1031)", () => {
		expect(substancesOverlap("Calcium Carbonate 1000 MG Oral Tablet", "Vitamin D3 1000 UNT Tablet")).toBe(false);
		expect(substancesOverlap("Metformin 500 MG Tablet", "Naproxen 500 MG Tablet")).toBe(false);
	});

	it("ignores a fused dose+unit token like \"500mg\" so unrelated substances never share only a dose (#1038)", () => {
		expect(substancesOverlap("Ibuprofen 500mg tablet", "Tylenol 500mg tablet")).toBe(false);
		expect(substancesOverlap("Aspirin 81mg tablet", "Warfarin 81mg tablet")).toBe(false);
	});
});

describe("crossOrgMedicationAllergyConflicts — cross-org continuity check (#1005)", () => {
	async function seedGrant(env: ReturnType<typeof baseEnv>, org: string, patient: string) {
		await env.OAUTH_KV.put(`sux:mychart:grant:${org}`, JSON.stringify({ refresh_token: "rt", patient, issued_at: Date.now() }));
	}
	async function seedBundle(env: ReturnType<typeof baseEnv>, org: string, patient: string, label: string, stamp: string, resources: any[]) {
		const bundle = { resourceType: "Bundle", entry: resources.map((resource) => ({ resource })) };
		await env.R2.put(`phi/mychart/${org}/${patient}/${label}/${stamp}-p1.json`, JSON.stringify(bundle), { httpMetadata: { contentType: "application/fhir+json" } });
	}

	it("returns [] when unconfigured, or fewer than 2 connected/pulled orgs", async () => {
		expect(await crossOrgMedicationAllergyConflicts({} as any)).toEqual([]);
		const oneOrg = baseEnv();
		await seedGrant(oneOrg, ORG, "P1");
		await seedBundle(oneOrg, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "med1", status: "active", medicationCodeableConcept: { text: "Penicillin V" } }]);
		expect(await crossOrgMedicationAllergyConflicts(oneOrg)).toEqual([]);
	});

	it("flags an active medication at one org overlapping an allergy at ANOTHER connected org", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P1");
		await seedBundle(env, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "med1", status: "active", medicationCodeableConcept: { text: "Penicillin V" } }]);
		await seedBundle(env, ORG2, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" } }]);
		const conflicts = await crossOrgMedicationAllergyConflicts(env);
		expect(conflicts).toEqual([{ medOrg: ORG, medId: "med1", medName: "Penicillin V", allergyOrg: ORG2, allergyId: "al1", allergySubstance: "Penicillin" }]);
	});

	it("never flags a same-org medication/allergy pair — only the cross-org blind spot", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P1");
		await seedBundle(env, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "med1", status: "active", medicationCodeableConcept: { text: "Penicillin V" } }]);
		await seedBundle(env, ORG, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" } }]);
		// ORG2 connected but contributes nothing overlapping — proves this isn't just "any 2 orgs".
		await seedBundle(env, ORG2, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1" }]);
		expect(await crossOrgMedicationAllergyConflicts(env)).toEqual([]);
	});

	it("skips an inactive medication and an org that's connected but never pulled", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "MedicationRequest", "2026-07-18T00-00-00-000Z", [{ resourceType: "MedicationRequest", id: "med1", status: "stopped", medicationCodeableConcept: { text: "Penicillin V" } }]);
		await seedGrant(env, ORG2, "P1"); // grant exists, but pull() has never run
		expect(await crossOrgMedicationAllergyConflicts(env)).toEqual([]);
	});
});

describe("crossOrgAllergyGaps — one-sided allergy continuity gap (#1009)", () => {
	async function seedGrant(env: ReturnType<typeof baseEnv>, org: string, patient: string) {
		await env.OAUTH_KV.put(`sux:mychart:grant:${org}`, JSON.stringify({ refresh_token: "rt", patient, issued_at: Date.now() }));
	}
	async function seedBundle(env: ReturnType<typeof baseEnv>, org: string, patient: string, label: string, stamp: string, resources: any[]) {
		const bundle = { resourceType: "Bundle", entry: resources.map((resource) => ({ resource })) };
		await env.R2.put(`phi/mychart/${org}/${patient}/${label}/${stamp}-p1.json`, JSON.stringify(bundle), { httpMetadata: { contentType: "application/fhir+json" } });
	}

	it("returns [] when unconfigured, or fewer than 2 connected/pulled orgs", async () => {
		expect(await crossOrgAllergyGaps({} as any)).toEqual([]);
		const oneOrg = baseEnv();
		await seedGrant(oneOrg, ORG, "P1");
		await seedBundle(oneOrg, ORG, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" } }]);
		expect(await crossOrgAllergyGaps(oneOrg)).toEqual([]);
	});

	it("flags an allergy on file at one org with NO matching record at another connected org", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P1");
		await seedBundle(env, ORG, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" } }]);
		await seedBundle(env, ORG2, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1" }]);
		// ORG2 confirmed-empty for AllergyIntolerance specifically (a real pull of that label, zero results) —
		// distinct from never having pulled the label at all (#1044).
		await seedBundle(env, ORG2, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", []);
		expect(await crossOrgAllergyGaps(env)).toEqual([{ org: ORG, allergyId: "al1", allergySubstance: "Penicillin", missingOrg: ORG2 }]);
	});

	it("does NOT flag a gap when the other org never pulled AllergyIntolerance at all (#1044)", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P1");
		await seedBundle(env, ORG, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" } }]);
		await seedBundle(env, ORG2, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1" }]); // ORG2 pulled Condition only — AllergyIntolerance was never asked for
		expect(await crossOrgAllergyGaps(env)).toEqual([]);
	});

	it("does not flag an allergy that both orgs already have on file", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P1");
		await seedBundle(env, ORG, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" } }]);
		await seedBundle(env, ORG2, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al2", code: { text: "Penicillin V Potassium" } }]);
		expect(await crossOrgAllergyGaps(env)).toEqual([]);
	});

	it("skips an org that's connected but never pulled", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedBundle(env, ORG, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" } }]);
		await seedGrant(env, ORG2, "P1"); // grant exists, but pull() has never run
		expect(await crossOrgAllergyGaps(env)).toEqual([]);
	});

	it("does not flag a resolved/refuted allergy as a gap (#1011)", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P1");
		await seedBundle(env, ORG, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [
			{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" }, clinicalStatus: { coding: [{ code: "resolved" }] } },
		]);
		await seedBundle(env, ORG2, "P1", "Condition", "2026-07-18T00-00-00-000Z", [{ resourceType: "Condition", id: "cond1" }]);
		expect(await crossOrgAllergyGaps(env)).toEqual([]);
	});

	it("does not flag a gap when the OTHER org's matching record is inactive/resolved (#1057)", async () => {
		const env = baseEnv();
		await seedGrant(env, ORG, "P1");
		await seedGrant(env, ORG2, "P1");
		await seedBundle(env, ORG, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [{ resourceType: "AllergyIntolerance", id: "al1", code: { text: "Penicillin" } }]);
		// ORG2 has a matching record, just marked resolved/entered-in-error — still "has a record of
		// it at all", so this must NOT read as "org B has no record" the way an empty list would.
		await seedBundle(env, ORG2, "P1", "AllergyIntolerance", "2026-07-18T00-00-00-000Z", [
			{ resourceType: "AllergyIntolerance", id: "al2", code: { text: "Penicillin" }, clinicalStatus: { coding: [{ code: "resolved" }] } },
		]);
		expect(await crossOrgAllergyGaps(env)).toEqual([]);
	});
});

describe("stored-note reader — the read half of pull's Binary writes (#1462)", () => {
	const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
	const binaryResource = (contentType: string, body: string) => JSON.stringify({ resourceType: "Binary", contentType, data: b64(body) });
	const noteEnv = async (bodies: Record<string, string>, docs?: any[]) => {
		const env = baseEnv();
		for (const [id, html] of Object.entries(bodies)) {
			await env.R2.put(`phi/mychart/${ORG}/P1/Binary/${id}.json`, binaryResource("text/html", html), { httpMetadata: { contentType: "application/fhir+json" } });
		}
		if (docs) {
			await env.R2.put(`phi/mychart/${ORG}/P1/DocumentReference/STAMP-p1.json`, JSON.stringify({ resourceType: "Bundle", entry: docs.map((resource) => ({ resource })) }), {
				httpMetadata: { contentType: "application/fhir+json" },
			});
		}
		return env;
	};

	it("decodeStoredBinary turns Epic's base64 Binary resource into readable text — a reader returning the raw stored object would hand back base64", () => {
		const stored = binaryResource("text/html", "<html><body><p>Chief complaint:</p><p>knee&nbsp;pain &amp; swelling</p></body></html>");
		const out = decodeStoredBinary(stored);
		expect(out.binary).toBe(false);
		expect(out.contentType).toBe("text/html");
		expect(out.text).toBe("Chief complaint:\nknee pain & swelling");
		expect(out.text).not.toMatch(/PGh0bWw|base64/);
	});

	it("decodeStoredBinary reassembles multi-byte UTF-8 — atob alone yields one char per byte and mojibakes every accented name", () => {
		expect(decodeStoredBinary(binaryResource("text/plain", "Müller — 38°C")).text).toBe("Müller — 38°C");
	});

	it("decodeStoredBinary flags a non-textual attachment instead of dumping base64 as 'text'", () => {
		const out = decodeStoredBinary(binaryResource("application/pdf", "%PDF-1.7 binary junk"));
		expect(out).toMatchObject({ binary: true, text: "", contentType: "application/pdf" });
		expect(out.bytes).toBeGreaterThan(0);
	});

	it("decodeStoredBinary falls through to the stored body when the server ignored Accept and returned the document itself", () => {
		expect(decodeStoredBinary("Plain discharge summary.").text).toBe("Plain discharge summary.");
		expect(decodeStoredBinary("<div>Wrapped <b>note</b></div>").text).toBe("Wrapped note");
	});

	it("rtfToText strips control words and unescapes hex escapes", () => {
		expect(rtfToText(String.raw`{\rtf1\ansi{\*\generator Epic}\b Assessment:\b0\par Stable\'2e}`)).toBe("Assessment:\nStable.");
	});

	it("listStoredNotes returns every stored Binary with its id and decoded body — an empty result on a populated bucket is the #1462 bug", async () => {
		const env = await noteEnv({ b1: "<p>note one</p>", b2: "<p>note two</p>", b3: "<p>note three</p>" });
		const out = await listStoredNotes(env, ORG, "P1", { text: true });
		expect(out.total).toBe(3);
		expect(out.notes.map((n) => n.id)).toEqual(["b1", "b2", "b3"]);
		expect(out.notes.map((n) => n.text)).toEqual(["note one", "note two", "note three"]);
		expect(out.nextCursor).toBeUndefined();
	});

	it("listStoredNotes joins each Binary back to the DocumentReference that referenced it", async () => {
		const env = await noteEnv({ b1: "<p>body</p>" }, [
			{
				resourceType: "DocumentReference",
				id: "d1",
				date: "2026-03-04T10:00:00Z",
				description: "Progress Note",
				type: { text: "Progress Notes" },
				author: [{ display: "Dr. Ada Lovelace" }],
				content: [{ attachment: { url: `${BASE}/Binary/b1` } }],
			},
		]);
		expect((await listStoredNotes(env, ORG, "P1", { text: true })).notes[0]).toMatchObject({
			id: "b1",
			docId: "d1",
			date: "2026-03-04T10:00:00Z",
			title: "Progress Note",
			type: "Progress Notes",
			author: "Dr. Ada Lovelace",
			text: "body",
		});
	});

	it("listStoredNotes without `text` is an index — ids and metadata, no bodies", async () => {
		const env = await noteEnv({ b1: "<p>secret body</p>" });
		const out = await listStoredNotes(env, ORG, "P1");
		expect(out.notes[0].text).toBe("");
		expect(out.notes[0].bytes).toBeGreaterThan(0);
	});

	it("listStoredNotes pages a text export by character budget and resumes from nextCursor — a whole chart never lands in one response", async () => {
		const big = "x".repeat(NOTE_EXPORT_CHAR_BUDGET);
		const env = await noteEnv({ b1: big, b2: big, b3: "<p>tail</p>" });
		const first = await listStoredNotes(env, ORG, "P1", { text: true });
		expect(first.notes.map((n) => n.id)).toEqual(["b1"]);
		expect(first.nextCursor).toBe("1");
		const second = await listStoredNotes(env, ORG, "P1", { text: true, cursor: first.nextCursor });
		expect(second.notes.map((n) => n.id)).toEqual(["b2"]);
		const third = await listStoredNotes(env, ORG, "P1", { text: true, cursor: second.nextCursor });
		expect(third.notes.map((n) => n.id)).toEqual(["b3"]);
		expect(third.nextCursor).toBeUndefined();
	});

	it("storedBinaryIds walks past R2's 1000-object page — a single unpaginated list() would silently hide every note after the first page", async () => {
		const env = baseEnv();
		for (let i = 0; i < 1001; i++) await env.R2.put(`phi/mychart/${ORG}/P1/Binary/b${String(i).padStart(4, "0")}.json`, binaryResource("text/plain", "n"), {});
		expect((await storedBinaryIds(env, ORG, "P1")).length).toBe(1001);
	});

	it("readStoredNote returns one note in full, and null for an id that was never pulled", async () => {
		const env = await noteEnv({ b1: "<p>full body</p>" });
		expect((await readStoredNote(env, ORG, "P1", "b1"))?.text).toBe("full body");
		expect(await readStoredNote(env, ORG, "P1", "nope")).toBeNull();
	});
});
