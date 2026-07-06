import { type Fn, fail, ok } from "../registry";

type Geo = {
	ip?: string;
	country?: string;
	country_code?: string;
	region?: string;
	city?: string;
	latitude?: number;
	longitude?: number;
	asn?: number | string;
	org?: string;
	timezone?: string;
};

// ipwho.is — primary. Rate-limited (HTTP 429) under load.
async function viaIpwho(ip: string): Promise<Geo | null> {
	const resp = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
	if (!resp.ok) return null;
	const j = (await resp.json()) as any;
	if (j.success === false) return null;
	return {
		ip: j.ip,
		country: j.country,
		country_code: j.country_code,
		region: j.region,
		city: j.city,
		latitude: j.latitude,
		longitude: j.longitude,
		asn: j.connection?.asn,
		org: j.connection?.org ?? j.connection?.isp,
		timezone: j.timezone?.id,
	};
}

// ip-api.com — fallback. Free tier is HTTP-only; empty path resolves the caller.
async function viaIpApi(ip: string): Promise<Geo | null> {
	const fields = "status,message,query,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as";
	const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`);
	if (!resp.ok) return null;
	const j = (await resp.json()) as any;
	if (j.status !== "success") return null;
	const asnMatch = /^AS(\d+)/.exec(String(j.as ?? ""));
	return {
		ip: j.query,
		country: j.country,
		country_code: j.countryCode,
		region: j.regionName,
		city: j.city,
		latitude: j.lat,
		longitude: j.lon,
		asn: asnMatch ? Number(asnMatch[1]) : undefined,
		org: j.org || j.isp,
		timezone: j.timezone,
	};
}

export const ipGeo: Fn = {
	name: "ip_geo",
	description:
		"Geolocate an IP address (or hostname). Returns country, region, city, lat/lon, ASN, and org. " +
		"An empty `ip` resolves the Worker's own egress IP (not the caller's). Tries ipwho.is, falls back to ip-api.com.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["ip"],
		properties: { ip: { type: "string", description: "IPv4/IPv6 address or hostname. Empty resolves the Worker's egress IP, not the caller." } },
	},
	cacheable: true,
	run: async (_env, args) => {
		const ip = String(args?.ip ?? "").trim();
		let geo: Geo | null = null;
		try {
			geo = await viaIpwho(ip);
		} catch {
			geo = null;
		}
		if (!geo) {
			try {
				geo = await viaIpApi(ip);
			} catch {
				geo = null;
			}
		}
		if (!geo) return fail("ip_geo failed: both providers (ipwho.is, ip-api.com) errored or rate-limited. Try again shortly.");
		return ok(JSON.stringify(geo, null, 2));
	},
};
