import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMacRenderBreaker, macRender } from "./mac-render";
import { hmacHex } from "./proxy";

// macRender is the HMAC-signed client for the Mac patchright render node — the
// residential egress path six retailer fns (amazon/lowes/walmart/homedepot/ace/
// winco) depend on. Those fns all MOCK it, so its own signing + error handling is
// otherwise unexercised. The node authenticates every request by re-computing the
// SAME HMAC, so a signing regression silently 401s the entire mac backend; these
// pin the wire contract (sig over `${ts}\n${body}`, on the query string AND the
// mirrored headers) and the never-throw error envelope.

const ENV = { MAC_RENDER_URL: "https://mac.example.ts.net", MAC_RENDER_SECRET: "s3cr3t" } as any;
const macJson = (obj: unknown, status = 200) =>
	new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

describe("macRender", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch") as any;
		__resetMacRenderBreaker();
	});
	afterEach(() => {
		fetchSpy.mockRestore();
		__resetMacRenderBreaker();
	});

	it("returns ok:false and never fetches when the backend is unconfigured", async () => {
		expect(await macRender({} as any, { url: "https://x" })).toEqual({ ok: false, error: expect.stringMatching(/not configured/i) });
		expect(await macRender({ MAC_RENDER_URL: "https://x" } as any, { url: "https://x" })).toMatchObject({ ok: false });
		expect(await macRender({ MAC_RENDER_SECRET: "s" } as any, { url: "https://x" })).toMatchObject({ ok: false });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("propagates a node-side solver_error onto the ok result (a CapSolver breakage must not vanish)", async () => {
		fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html>wall</html>", solver_error: "capsolver 429" }));
		const r = await macRender(ENV, { url: "https://walmart.com" });
		expect(r).toMatchObject({ ok: true, body: "<html>wall</html>", solverError: "capsolver 429" });
	});

	it("omits solverError when the node reports none (happy path unchanged)", async () => {
		fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html>ok</html>" }));
		const r = await macRender(ENV, { url: "https://homedepot.com" });
		expect(r.ok && "solverError" in r).toBe(false);
	});

	it("POSTs an HMAC-signed html payload — sig is HMAC-SHA256(secret, `${ts}\\n${body}`), on the query string and mirrored headers", async () => {
		fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html>ok</html>" }));

		const r = await macRender(ENV, { url: "https://homedepot.com/p/1" });
		expect(r).toMatchObject({ ok: true, contentType: "text/html", body: "<html>ok</html>" });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const u = new URL(endpoint);
		expect(u.origin + u.pathname).toBe("https://mac.example.ts.net/render");
		expect(init.method).toBe("POST");

		// Payload defaults `as:"html"` and passes the caller's spec through verbatim.
		const body = init.body as string;
		expect(JSON.parse(body)).toEqual({ as: "html", url: "https://homedepot.com/p/1" });

		// The signature genuinely verifies against the exact wire body (using the real
		// hmacHex, not a stub) — the same computation the node runs to authenticate.
		const ts = u.searchParams.get("ts")!;
		const sig = u.searchParams.get("sig")!;
		expect(ts).toMatch(/^\d+$/);
		expect(sig).toBe(await hmacHex("s3cr3t", `${ts}\n${body}`));

		// Mirrored in headers for hosts that DON'T drop custom POST headers.
		const headers = init.headers as Record<string, string>;
		expect(headers["x-timestamp"]).toBe(ts);
		expect(headers["x-signature"]).toBe(sig);
	});

	it("normalizes Puppeteer wait_until (networkidle0/2) → Playwright's networkidle for the mac service", async () => {
		// The mac node is Playwright; page.goto rejects networkidle0/2 (Puppeteer's names)
		// with a 502 — the real cause of 'mac render broken'. Normalize on the wire.
		for (const [sent, wire] of [
			["networkidle0", "networkidle"],
			["networkidle2", "networkidle"],
			["domcontentloaded", "domcontentloaded"],
		] as const) {
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html>ok</html>" }));
			await macRender(ENV, { url: "https://x.com", wait_until: sent });
			const b = JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string);
			expect(b.wait_until).toBe(wire);
		}
	});

	it("lets the spec override `as` and passes extra knobs (solve, wait_ms) into the signed body", async () => {
		fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/plain", body: "text" }));

		await macRender(ENV, { url: "https://walmart.com", as: "text", solve: true, wait_ms: 6000 });

		const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = init.body as string;
		expect(JSON.parse(body)).toMatchObject({ as: "text", url: "https://walmart.com", solve: true, wait_ms: 6000 });
		// The override is inside the signed body, so the signature still covers it exactly.
		const u = new URL(endpoint);
		expect(u.searchParams.get("sig")).toBe(await hmacHex("s3cr3t", `${u.searchParams.get("ts")}\n${body}`));
	});

	it("carries a base64 screenshot envelope through (bodyEncoding preserved)", async () => {
		fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "image/png", bodyEncoding: "base64", body: "iVBOR" }));
		const r = await macRender(ENV, { url: "https://homedepot.com", as: "screenshot" });
		expect(r).toEqual({ ok: true, contentType: "image/png", body: "iVBOR", bodyEncoding: "base64" });
	});

	it("maps a node-side {error} envelope to ok:false even on HTTP 200", async () => {
		fetchSpy.mockResolvedValueOnce(macJson({ error: "challenge unsolved" }));
		expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: expect.stringMatching(/challenge unsolved/) });
	});

	it("maps a non-2xx response to ok:false with the HTTP status", async () => {
		fetchSpy.mockResolvedValueOnce(macJson({}, 502));
		expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: expect.stringMatching(/HTTP 502/) });
	});

	it("maps an unreadable (non-JSON) body to ok:false without throwing", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("not json", { status: 200, headers: { "content-type": "text/html" } }));
		expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: expect.stringMatching(/unreadable/i) });
	});

	it("maps a transport throw to ok:false (never propagates)", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("tunnel down"));
		expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: expect.stringMatching(/tunnel down/) });
	});

	it("defaults content_type to text/html and body to '' when the node omits them", async () => {
		fetchSpy.mockResolvedValueOnce(macJson({ status: 200 }));
		expect(await macRender(ENV, { url: "https://x" })).toMatchObject({ ok: true, contentType: "text/html", body: "" });
	});

	// Circuit breaker: a down/hung node makes every call wait out the full timeout.
	// After N consecutive transport failures the breaker OPENS and short-circuits
	// instantly (no fetch), then half-opens after the cooldown to probe recovery.
	describe("circuit breaker", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("fast-fails the next call WITHOUT fetching after 5 consecutive failures, then recovers after the cooldown", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);

			// Five straight transport failures trip the breaker. Each one DOES fetch.
			fetchSpy.mockRejectedValue(new Error("tunnel down"));
			for (let i = 0; i < 5; i++) {
				expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: expect.stringMatching(/tunnel down/) });
			}
			expect(fetchSpy).toHaveBeenCalledTimes(5);

			// Circuit now OPEN: the next call is fast-failed with circuit-open and never
			// reaches fetch — no full-timeout wait.
			fetchSpy.mockClear();
			expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: "mac render backend circuit-open" });
			expect(fetchSpy).not.toHaveBeenCalled();

			// Still open just before the cooldown elapses.
			vi.setSystemTime(29_999);
			expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: "mac render backend circuit-open" });
			expect(fetchSpy).not.toHaveBeenCalled();

			// After the cooldown the breaker is half-open: the probe call reaches the
			// node again, and a healthy Response closes the circuit for good.
			vi.setSystemTime(30_001);
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html>back</html>" }));
			expect(await macRender(ENV, { url: "https://x" })).toMatchObject({ ok: true, body: "<html>back</html>" });
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			// Recovered: the failure count reset, so subsequent calls flow normally.
			fetchSpy.mockResolvedValueOnce(macJson({ status: 200, content_type: "text/html", body: "<html>ok</html>" }));
			expect(await macRender(ENV, { url: "https://x" })).toMatchObject({ ok: true, body: "<html>ok</html>" });
		});

		it("half-open probe that fails re-opens the circuit for another cooldown", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			fetchSpy.mockRejectedValue(new Error("tunnel down"));
			for (let i = 0; i < 5; i++) await macRender(ENV, { url: "https://x" });

			// Cooldown elapses → half-open → probe still fails → re-open.
			vi.setSystemTime(30_001);
			expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: expect.stringMatching(/tunnel down/) });

			fetchSpy.mockClear();
			expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: "mac render backend circuit-open" });
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("does not trip on a node that keeps ANSWERING — any Response resets the failure count", async () => {
			// Node-side {error} envelopes mean the node is alive (just a hard page), so
			// they must never open the circuit against unrelated URLs.
			fetchSpy.mockImplementation(async () => macJson({ error: "challenge unsolved" }));
			for (let i = 0; i < 8; i++) {
				expect(await macRender(ENV, { url: "https://x" })).toEqual({ ok: false, error: expect.stringMatching(/challenge unsolved/) });
			}
			// Still closed: the 9th call fetches rather than fast-failing.
			expect(fetchSpy).toHaveBeenCalledTimes(8);
		});
	});
});
