import { afterEach, describe, expect, it, vi } from "vitest";
import { ipGeo } from "./ip_geo";

afterEach(() => vi.unstubAllGlobals());

const okResp = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ipwhoBody = {
	success: true,
	ip: "8.8.8.8",
	country: "United States",
	country_code: "US",
	region: "California",
	city: "Mountain View",
	latitude: 37.4,
	longitude: -122.07,
	connection: { asn: 15169, org: "Google LLC" },
	timezone: { id: "America/Los_Angeles" },
};

const ipApiBody = {
	status: "success",
	query: "8.8.8.8",
	country: "United States",
	countryCode: "US",
	regionName: "California",
	city: "Mountain View",
	lat: 37.4,
	lon: -122.07,
	timezone: "America/Los_Angeles",
	isp: "Google LLC",
	org: "Google Public DNS",
	as: "AS15169 Google LLC",
};

describe("ip_geo", () => {
	it("returns a flattened geolocation record from the primary provider", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => okResp(ipwhoBody)));
		const r = await ipGeo.run({} as any, { ip: "8.8.8.8" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.ip).toBe("8.8.8.8");
		expect(j.city).toBe("Mountain View");
		expect(j.asn).toBe(15169);
		expect(j.org).toBe("Google LLC");
		expect(j.timezone).toBe("America/Los_Angeles");
	});

	it("falls back to ip-api.com when the primary is rate-limited (429)", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => new Response("rate limited", { status: 429 }))
			.mockImplementationOnce(async () => okResp(ipApiBody));
		vi.stubGlobal("fetch", fetchMock);
		const r = await ipGeo.run({} as any, { ip: "8.8.8.8" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.city).toBe("Mountain View");
		expect(j.asn).toBe(15169);
		expect(j.org).toBe("Google Public DNS");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("falls back when the primary reports an unsuccessful lookup", async () => {
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(async () => okResp({ success: false, message: "quota" }))
			.mockImplementationOnce(async () => okResp(ipApiBody));
		vi.stubGlobal("fetch", fetchMock);
		const r = await ipGeo.run({} as any, { ip: "8.8.8.8" });
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text).city).toBe("Mountain View");
	});

	it("fails only when both providers error", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
		const r = await ipGeo.run({} as any, { ip: "1.1.1.1" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/both providers/);
	});
});
