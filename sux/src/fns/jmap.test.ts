import { afterEach, describe, expect, it, vi } from "vitest";

import { jmap } from "./jmap";
import { accountIdFor, capForMethod, deriveUsing, detectDestroy, detectSend, type JmapSession, validateCalls } from "./_jmap";

// Map-backed KV stub (env.OAUTH_KV) — the Session blob is the only thing cached.
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A realistic Fastmail Session: maskedemail is advertised on the account's
// accountCapabilities but is NOT a key in primaryAccounts (the D14 trap).
const SESSION: JmapSession = {
	apiUrl: "https://api.fastmail.com/jmap/api/",
	uploadUrl: "https://api.fastmail.com/jmap/upload/{accountId}/",
	downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
	accounts: {
		u123: {
			name: "me@fastmail.com",
			isPersonal: true,
			accountCapabilities: {
				"urn:ietf:params:jmap:core": {},
				"urn:ietf:params:jmap:mail": {},
				"urn:ietf:params:jmap:submission": {},
				"https://www.fastmail.com/dev/maskedemail": {},
			},
		},
	},
	primaryAccounts: {
		"urn:ietf:params:jmap:mail": "u123",
		"urn:ietf:params:jmap:submission": "u123",
	},
	capabilities: {
		"urn:ietf:params:jmap:core": { maxCallsInRequest: 50, maxObjectsInGet: 2, maxObjectsInSet: 500, maxSizeRequest: 10_000_000, maxSizeUpload: 250_000_000 },
		"urn:ietf:params:jmap:mail": {},
		"urn:ietf:params:jmap:submission": {},
		"https://www.fastmail.com/dev/maskedemail": {},
	},
	state: "s1",
};

/** Route the fetch mock by URL. `onApi(body)` builds the JMAP api response from the parsed POST body. */
function installFetch(opts?: { onApi?: (body: any, n: number) => Response; sessionStatus?: number }) {
	const calls = { session: 0, api: 0, upload: 0, download: 0, urls: [] as string[], apiBodies: [] as any[], usings: [] as string[][] };
	const f = vi.fn(async (input: any, init?: any) => {
		const url = String(input?.url ?? input);
		calls.urls.push(url);
		if (url.includes("/jmap/session")) {
			calls.session++;
			return json(SESSION, opts?.sessionStatus ?? 200);
		}
		if (url.includes("/jmap/api")) {
			calls.api++;
			const body = init?.body ? JSON.parse(init.body) : {};
			calls.apiBodies.push(body);
			calls.usings.push(body.using);
			if (opts?.onApi) return opts.onApi(body, calls.api);
			// Default: echo each method call with a trivial list.
			const methodResponses = (body.methodCalls ?? []).map(([m, a, id]: any) => [m, { accountId: a.accountId, list: [] }, id]);
			return json({ methodResponses, sessionState: "s1" });
		}
		if (url.includes("/jmap/upload")) {
			calls.upload++;
			return json({ accountId: "u123", blobId: "B-NEW", type: "text/plain", size: 5 });
		}
		if (url.includes("/jmap/download")) {
			calls.download++;
			return new Response(new Uint8Array([104, 105]).buffer, { status: 200, headers: { "content-type": "application/octet-stream" } });
		}
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls, f };
}

const env = () => ({ FASTMAIL_TOKEN: "tok", OAUTH_KV: kvStub(), R2: undefined }) as any;
const text = (r: any) => r.content[0].text;
const parse = (r: any) => JSON.parse(text(r));

afterEach(() => vi.restoreAllMocks());

describe("_jmap unit helpers", () => {
	it("capForMethod maps method prefixes to capability URNs", () => {
		expect(capForMethod("Email/query")).toBe("urn:ietf:params:jmap:mail");
		expect(capForMethod("EmailSubmission/set")).toBe("urn:ietf:params:jmap:submission");
		expect(capForMethod("MaskedEmail/get")).toBe("https://www.fastmail.com/dev/maskedemail");
		expect(capForMethod("CalendarEvent/get")).toBe("urn:ietf:params:jmap:calendars");
		expect(capForMethod("Frobnicate/wat")).toBeNull();
	});

	it("deriveUsing over-declares mail for EmailSubmission and unions caller using", () => {
		const u = deriveUsing(["EmailSubmission/set"], SESSION, ["custom:urn"]);
		expect(u).toContain("urn:ietf:params:jmap:core");
		expect(u).toContain("urn:ietf:params:jmap:submission");
		expect(u).toContain("urn:ietf:params:jmap:mail"); // over-declared
		expect(u).toContain("custom:urn"); // unioned, never suppressed
	});

	it("accountIdFor resolves MaskedEmail via accountCapabilities (not primaryAccounts)", () => {
		expect(accountIdFor(SESSION, "MaskedEmail/get")).toBe("u123");
		expect(accountIdFor(SESSION, "Email/query")).toBe("u123");
	});

	it("detectSend / detectDestroy classify irreversible ops", () => {
		expect(detectSend([["EmailSubmission/set", { create: { s: {} } }, "c"]])).toBe(true);
		expect(detectSend([["Email/set", { create: { d: {} } }, "c"]])).toBe(false);
		expect(detectDestroy([["Email/set", { destroy: ["e1"] }, "c"]])).toBe(true);
		expect(detectDestroy([["Mailbox/set", { onDestroyRemoveEmails: true }, "c"]])).toBe(true);
		expect(detectDestroy([["Email/set", { update: { e1: {} } }, "c"]])).toBe(false);
	});

	it("validateCalls rejects malformed tuples and duplicate callIds", () => {
		expect(() => validateCalls([["Email/get", {}, "a"], ["Email/get", {}, "a"]])).toThrow(/duplicate callId/);
		expect(() => validateCalls([["Email/get", {}]])).toThrow(/3-tuple/);
		expect(() => validateCalls([])).toThrow(/non-empty/);
	});
});

describe("jmap fn", () => {
	it("returns not_configured without a token", async () => {
		const r = await jmap.run({ OAUTH_KV: kvStub() } as any, { method: "Mailbox/get" });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("[not_configured]");
	});

	it("requires exactly one mode", async () => {
		const e = env();
		expect((await jmap.run(e, {})).isError).toBe(true);
		expect(text(await jmap.run(e, {}))).toContain("exactly one");
		const two = await jmap.run(e, { method: "Mailbox/get", upload: { data: "AA==" } });
		expect(two.isError).toBe(true);
	});

	it("single-call: discovers+caches the Session, injects accountId, derives using, returns methodResponses", async () => {
		const { calls } = installFetch();
		const e = env();
		const r = await jmap.run(e, { method: "Mailbox/get" });
		expect(r.isError).toBeFalsy();
		const out = parse(r);
		expect(out.methodResponses[0][0]).toBe("Mailbox/get");
		// accountId auto-filled from the Session
		expect(calls.apiBodies[0].methodCalls[0][1].accountId).toBe("u123");
		// using derived: core + mail
		expect(calls.usings[0]).toContain("urn:ietf:params:jmap:mail");
		// Session cached in KV, discovered once
		expect(e.OAUTH_KV.map.get("sux:fastmail:session")).toBeTruthy();
		expect(calls.session).toBe(1);
		// A second call reuses the cached Session (no re-discovery).
		await jmap.run(e, { method: "Mailbox/get" });
		expect(calls.session).toBe(1);
	});

	it("MaskedEmail/get: routes accountId + adds the fastmail masked-email capability", async () => {
		const { calls } = installFetch();
		await jmap.run(env(), { method: "MaskedEmail/get" });
		expect(calls.apiBodies[0].methodCalls[0][1].accountId).toBe("u123");
		expect(calls.usings[0]).toContain("https://www.fastmail.com/dev/maskedemail");
	});

	it("rejects a duplicate callId batch", async () => {
		installFetch();
		const r = await jmap.run(env(), { calls: [["Email/get", {}, "a"], ["Mailbox/get", {}, "a"]] });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("[bad_input]");
		expect(text(r)).toContain("duplicate callId");
	});

	it("gates an EmailSubmission/set create behind allow_send", async () => {
		installFetch();
		const batch = { calls: [["EmailSubmission/set", { create: { sub: { emailId: "#d", identityId: "i1" } } }, "s"]] as any };
		const blocked = await jmap.run(env(), batch);
		expect(blocked.isError).toBe(true);
		expect(text(blocked)).toContain("allow_send");
		const allowed = await jmap.run(env(), { ...batch, allow_send: true });
		expect(allowed.isError).toBeFalsy();
	});

	it("gates a destroy behind allow_destroy", async () => {
		installFetch();
		const blocked = await jmap.run(env(), { calls: [["Email/set", { destroy: ["e1"] }, "d"]] as any });
		expect(blocked.isError).toBe(true);
		expect(text(blocked)).toContain("allow_destroy");
		const allowed = await jmap.run(env(), { calls: [["Email/set", { destroy: ["e1"] }, "d"]] as any, allow_destroy: true });
		expect(allowed.isError).toBeFalsy();
	});

	it("refuses a batch over maxCallsInRequest (no auto-split in v1)", async () => {
		installFetch();
		const many = Array.from({ length: 51 }, (_v, i) => ["Mailbox/get", {}, `c${i}`]);
		const r = await jmap.run(env(), { calls: many as any });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("maxCallsInRequest");
	});

	it("self-heals a 401 on the api POST by re-discovering the Session and retrying once", async () => {
		const { calls } = installFetch({
			onApi: (_body, n) => (n === 1 ? json({ error: "unauthorized" }, 401) : json({ methodResponses: [["Mailbox/get", { list: [] }, "c0"]], sessionState: "s1" })),
		});
		const e = env();
		// Pre-seed a cached session so the first api call uses it, 401s, then re-discovers.
		e.OAUTH_KV.map.set("sux:fastmail:session", JSON.stringify(SESSION));
		const r = await jmap.run(e, { method: "Mailbox/get" });
		expect(r.isError).toBeFalsy();
		expect(calls.api).toBe(2); // 401 then retry
		expect(calls.session).toBeGreaterThanOrEqual(1); // re-discovered after the 401
	});

	it("paginate: accumulates ids across pages, dedups, and collapses a hydrated get", async () => {
		let q = 0;
		installFetch({
			onApi: (body) => {
				const [method] = body.methodCalls[0];
				if (method === "Email/query") {
					q++;
					// maxObjectsInGet=2 → pageLimit 2. page1 full (continue), page2 full
					// with a duplicate e2 (dedup), page3 short (stop).
					const page = q === 1 ? { ids: ["e1", "e2"], queryState: "qs1" } : q === 2 ? { ids: ["e2", "e3"], queryState: "qs1" } : { ids: ["e3"], queryState: "qs1" };
					return json({ methodResponses: [["Email/query", page, "q"]], sessionState: "s1" });
				}
				// Email/get hydration chunk → echo the requested ids as objects.
				const ids: string[] = body.methodCalls[0][1].ids ?? [];
				return json({ methodResponses: [["Email/get", { list: ids.map((id) => ({ id, subject: `S ${id}` })) }, "g"]], sessionState: "s1" });
			},
		});
		const r = await jmap.run(env(), {
			paginate: true,
			calls: [
				["Email/query", { filter: { inMailbox: "inbox" } }, "q"],
				["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "subject"] }, "g"],
			] as any,
		});
		expect(r.isError).toBeFalsy();
		const out = parse(r);
		expect(out.ids.sort()).toEqual(["e1", "e2", "e3"]); // deduped union across pages
		expect(out.list).toHaveLength(3); // hydrated + collapsed into one list
		expect(out.partial).toBe(false);
	});

	it("upload: base64 → blobId; refuses an https URL (SSRF)", async () => {
		const { calls } = installFetch();
		const ok = await jmap.run(env(), { upload: { data: "aGVsbG8=", type: "text/plain" } });
		expect(ok.isError).toBeFalsy();
		expect(parse(ok).blobId).toBe("B-NEW");
		expect(calls.upload).toBe(1);
		const ssrf = await jmap.run(env(), { upload: { data: "https://router.internal/secret" } });
		expect(ssrf.isError).toBe(true);
		expect(text(ssrf)).toContain("SSRF");
	});

	it("download: returns inline base64 for a small blob", async () => {
		installFetch();
		const r = await jmap.run(env(), { download: { blobId: "B1", as: "base64" } });
		expect(r.isError).toBeFalsy();
		const out = parse(r);
		expect(out.blobId).toBe("B1");
		expect(out.data).toBe(Buffer.from("hi").toString("base64"));
	});
});

// Regressions for the confirmed adversarial-review findings.
describe("review-fix regressions", () => {
	it("detectDestroy catches a back-referenced #destroy (gate-bypass fix)", () => {
		expect(detectDestroy([["Email/set", { "#destroy": { resultOf: "q", name: "Email/query", path: "/ids" } }, "d"]])).toBe(true);
		expect(detectSend([["EmailSubmission/set", { "#create": { resultOf: "q", name: "x", path: "/y" } }, "s"]])).toBe(true);
	});

	it("gates a query→#destroy bulk-expunge behind allow_destroy", async () => {
		installFetch();
		const batch = { calls: [["Email/query", { filter: {} }, "q"], ["Email/set", { "#destroy": { resultOf: "q", name: "Email/query", path: "/ids" } }, "d"]] as any };
		const blocked = await jmap.run(env(), batch);
		expect(blocked.isError).toBe(true);
		expect(text(blocked)).toContain("allow_destroy");
		expect((await jmap.run(env(), { ...batch, allow_destroy: true })).isError).toBeFalsy();
	});

	it("paginate cursor anchors on the last EMITTED id after a max_results cap (silent-gap fix)", async () => {
		let q = 0;
		installFetch({
			onApi: (body) => {
				if (body.methodCalls[0][0] === "Email/query") {
					q++;
					// pageLimit=2 (maxObjectsInGet). Two full pages overshoot max_results=3.
					const page = q === 1 ? { ids: ["e1", "e2"], queryState: "qs1" } : { ids: ["e3", "e4"], queryState: "qs1" };
					return json({ methodResponses: [["Email/query", page, "q"]], sessionState: "s1" });
				}
				return json({ methodResponses: [["Email/get", { list: [] }, "g"]], sessionState: "s1" });
			},
		});
		const out = parse(await jmap.run(env(), { paginate: true, max_results: 3, calls: [["Email/query", { filter: { inMailbox: "x" } }, "q"]] as any }));
		expect(out.ids).toEqual(["e1", "e2", "e3"]); // capped at 3, not 4
		expect(out.partial).toBe(true);
		const cur = JSON.parse(Buffer.from(out.cursor, "base64").toString());
		expect(cur.anchor).toBe("e3"); // last EMITTED id, not the loop overshoot "e4"
	});

	it("paginate rejects a resumed cursor whose filter changed (filterHash guard)", async () => {
		installFetch({
			onApi: (body) => {
				if (body.methodCalls[0][0] === "Email/query") return json({ methodResponses: [["Email/query", { ids: ["e1", "e2"], queryState: "qs" }, "q"]], sessionState: "s1" });
				return json({ methodResponses: [["Email/get", { list: [] }, "g"]], sessionState: "s1" });
			},
		});
		const first = parse(await jmap.run(env(), { paginate: true, max_results: 2, calls: [["Email/query", { filter: { inMailbox: "a" } }, "q"]] as any }));
		expect(first.cursor).toBeTruthy();
		// Resume the cursor against a DIFFERENT filter → filterHash mismatch → bad_input, never a silent wrong-set.
		const r = await jmap.run(env(), { paginate: true, cursor: first.cursor, calls: [["Email/query", { filter: { inMailbox: "DIFFERENT" } }, "q"]] as any });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("[bad_input]");
	});

	it("paginate resume advances forward — does not deadlock re-fetching the same page", async () => {
		let q = 0;
		installFetch({
			onApi: (body) => {
				if (body.methodCalls[0][0] === "Email/query") {
					q++;
					const pages: Record<number, string[]> = { 1: ["a", "b"], 2: ["c", "d"], 3: ["e", "f"] };
					return json({ methodResponses: [["Email/query", { ids: pages[q] ?? ["g"], queryState: "qs" }, "q"]], sessionState: "s1" });
				}
				return json({ methodResponses: [["Email/get", { list: [] }, "g"]], sessionState: "s1" });
			},
		});
		const first = parse(await jmap.run(env(), { paginate: true, max_results: 3, calls: [["Email/query", { filter: { inMailbox: "x" } }, "q"]] as any }));
		expect(first.ids).toEqual(["a", "b", "c"]);
		expect(first.partial).toBe(true);
		const resume = parse(await jmap.run(env(), { paginate: true, max_results: 3, cursor: first.cursor, calls: [["Email/query", { filter: { inMailbox: "x" } }, "q"]] as any }));
		// Forward progress: resume returns MORE ids and reaches the tail — never the identical set.
		expect(resume.ids.length).toBeGreaterThan(first.ids.length);
		expect(resume.ids).toContain("g");
		expect(resume.ids).not.toEqual(first.ids);
	});

	it("paginate on a short page that overshoots max_results emits a cursor (no silent drop)", async () => {
		const bigSession = { ...SESSION, capabilities: { ...SESSION.capabilities, "urn:ietf:params:jmap:core": { ...(SESSION.capabilities as any)["urn:ietf:params:jmap:core"], maxObjectsInGet: 200 } } };
		global.fetch = vi.fn(async (input: any, init?: any) => {
			const url = String(input?.url ?? input);
			if (url.includes("/jmap/session")) return json(bigSession);
			if (url.includes("/jmap/api")) {
				const body = init?.body ? JSON.parse(init.body) : {};
				if (body.methodCalls[0][0] === "Email/query") return json({ methodResponses: [["Email/query", { ids: ["a", "b", "c", "d", "e"], queryState: "qs" }, "q"]], sessionState: "s1" });
				return json({ methodResponses: [["Email/get", { list: [] }, "g"]], sessionState: "s1" });
			}
			return json({}, 404);
		}) as any;
		// pageLimit=200, one short page of 5 ids, but max_results=2 → must NOT report complete.
		const out = parse(await jmap.run(env(), { paginate: true, max_results: 2, calls: [["Email/query", { filter: {} }, "q"]] as any }));
		expect(out.ids).toEqual(["a", "b"]);
		expect(out.partial).toBe(true); // not falsely complete
		expect(out.cursor).toBeTruthy(); // the tail (c,d,e) stays reachable
	});
});
