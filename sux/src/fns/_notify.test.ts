import { afterEach, describe, expect, it, vi } from "vitest";
import { hasNotify, notify } from "./_notify";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
	fetchMock.mockReset();
});

describe("hasNotify — env-gated", () => {
	it("false when NTFY_URL is unset", () => {
		expect(hasNotify({} as any)).toBe(false);
	});
	it("true once NTFY_URL is set", () => {
		expect(hasNotify({ NTFY_URL: "https://ntfy.sh/colin-sux" } as any)).toBe(true);
	});
});

describe("notify — fail-open, KISS single POST", () => {
	it("is a silent no-op (never calls fetch) when NTFY_URL is unset", async () => {
		const sent = await notify({} as any, "agenda", "title", "body");
		expect(sent).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("POSTs the body with Title/Priority headers to NTFY_URL, topic folded into the title", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		const env = { NTFY_URL: "https://ntfy.sh/colin-sux" } as any;
		const sent = await notify(env, "agenda", "3 things need you today", "See the digest.", "high");
		expect(sent).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://ntfy.sh/colin-sux");
		expect(init.method).toBe("POST");
		expect(init.headers.Title).toBe("[agenda] 3 things need you today");
		expect(init.headers.Priority).toBe("high");
		expect(init.headers.Authorization).toBeUndefined();
		expect(init.body).toBe("See the digest.");
	});

	it("adds a Bearer Authorization header when NTFY_TOKEN is set", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		const env = { NTFY_URL: "https://ntfy.sh/colin-sux", NTFY_TOKEN: "tok123" } as any;
		await notify(env, "agenda", "t", "b");
		expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok123");
	});

	it("defaults priority to 'default'", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		const env = { NTFY_URL: "https://ntfy.sh/colin-sux" } as any;
		await notify(env, "agenda", "t", "b");
		expect(fetchMock.mock.calls[0][1].headers.Priority).toBe("default");
	});

	it("strips embedded CR/LF from the title so caller text can't inject a header", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		const env = { NTFY_URL: "https://ntfy.sh/colin-sux" } as any;
		await notify(env, "agenda", "evil\r\nX-Injected: yes", "b");
		const title = fetchMock.mock.calls[0][1].headers.Title as string;
		expect(title).not.toMatch(/[\r\n]/);
		expect(title).toContain("evil");
	});

	it("resolves false (never throws) on a non-ok response", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
		const env = { NTFY_URL: "https://ntfy.sh/colin-sux" } as any;
		expect(await notify(env, "agenda", "t", "b")).toBe(false);
	});

	it("resolves false (never throws) on a network error", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		const env = { NTFY_URL: "https://ntfy.sh/colin-sux" } as any;
		expect(await notify(env, "agenda", "t", "b")).toBe(false);
	});
});
