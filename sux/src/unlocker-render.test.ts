import { afterEach, describe, expect, it, vi } from "vitest";

import { unlockerRender } from "./unlocker-render";

const ARMED = { UNLOCKER_API_URL: "https://unlocker.example/req", UNLOCKER_API_KEY: "secret" } as any;

afterEach(() => vi.restoreAllMocks());

describe("unlockerRender", () => {
	it("no-ops fail-closed when unconfigured (never touches the network)", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const r = await unlockerRender({} as any, { url: "https://www.homedepot.com/s/drill" });
		expect(r).toEqual({ ok: false, error: "unlocker not configured" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns the unlocked HTML on a 200", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("<html><body>unlocked</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
		);
		const r = await unlockerRender(ARMED, { url: "https://www.costco.com/CatalogSearch?keyword=x" });
		expect(r).toMatchObject({ ok: true, body: "<html><body>unlocked</body></html>", contentType: "text/html" });
	});

	it("sends the target url with a bearer key", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("<html>ok</html>", { status: 200 }));
		await unlockerRender(ARMED, { url: "https://www.homedepot.com/s/drill" });
		const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(endpoint).toBe("https://unlocker.example/req");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
		expect(JSON.parse(init.body as string)).toEqual({ url: "https://www.homedepot.com/s/drill" });
	});

	it("fails (never throws) on a non-2xx", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 503 }));
		const r = await unlockerRender(ARMED, { url: "https://x" });
		expect(r).toEqual({ ok: false, error: "unlocker failed: HTTP 503" });
	});

	it("fails (never throws) on a transport error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNRESET"));
		const r = await unlockerRender(ARMED, { url: "https://x" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/unlocker failed: ECONNRESET/);
	});
});
