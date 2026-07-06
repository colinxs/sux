import { type Fn, fail, ok } from "../registry";

export const ipGeo: Fn = {
	name: "ip_geo",
	description: "Geolocate an IP address (or hostname). Returns country, region, city, lat/lon, ASN, and org.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["ip"],
		properties: { ip: { type: "string", description: "IPv4/IPv6 address or hostname. Empty resolves the caller." } },
	},
	cacheable: true,
	run: async (_env, args) => {
		const ip = String(args?.ip ?? "").trim();
		const resp = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
		if (!resp.ok) return fail(`ip_geo failed: HTTP ${resp.status}`);
		const j = (await resp.json()) as any;
		if (j.success === false) return fail(`ip_geo: ${j.message ?? "lookup failed"}`);
		return ok(
			JSON.stringify(
				{
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
				},
				null,
				2,
			),
		);
	},
};
