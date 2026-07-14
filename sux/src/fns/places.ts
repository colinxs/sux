import { type Fn, fail, failWith, ok } from "../registry";
import { errMsg, oj } from "./_util";

// Google Places API (places.googleapis.com) — local business / point-of-interest
// text search. The key rides the `X-Goog-Api-Key` header; a field mask names the
// exact fields to return. One POST resolves a free-text query to nearby places.

const API = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = "places.displayName,places.formattedAddress,places.rating,places.priceLevel,places.location,places.websiteUri,places.nationalPhoneNumber";


function normPlace(d: any): Record<string, unknown> {
	const loc = d?.location ?? {};
	return {
		name: d?.displayName?.text ?? d?.displayName,
		address: d?.formattedAddress,
		rating: typeof d?.rating === "number" ? d.rating : undefined,
		price_level: d?.priceLevel,
		phone: d?.nationalPhoneNumber,
		website: d?.websiteUri,
		lat: typeof loc?.latitude === "number" ? loc.latitude : undefined,
		lng: typeof loc?.longitude === "number" ? loc.longitude : undefined,
	};
}

export const places: Fn = {
	name: "places",
	description:
		"Google Places API (official, free credit) — local business and point-of-interest search from a free-text `query` " +
		'(e.g. "hardware store near 98133"). Returns name, address, rating, price level, phone, website, and coordinates. ' +
		"Needs GOOGLE_MAPS_KEY (free credit at console.cloud.google.com, Places API). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: 'Free-text place query, e.g. "hardware store near 98133".' },
			max_results: { type: "integer", minimum: 1, maximum: 20, default: 10 },
		},
	},
	cacheable: true,
	ttl: 900,
	run: async (env, args) => {
		if (!env.GOOGLE_MAPS_KEY) return failWith("not_configured", "Google Places not configured (GOOGLE_MAPS_KEY). Free credit at console.cloud.google.com (Places API).");

		const query = String(args?.query ?? "").trim();
		if (!query) return fail("`query` is required.");
		const maxResults = Math.min(20, Math.max(1, Number(args?.max_results) || 10));

		try {
			const resp = await fetch(API, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"X-Goog-Api-Key": env.GOOGLE_MAPS_KEY,
					"X-Goog-FieldMask": FIELD_MASK,
				},
				body: JSON.stringify({ textQuery: query, maxResultCount: maxResults }),
			});
			if (!resp.ok) throw new Error(`Google Places HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
			const j: any = await resp.json();
			const results = (j?.places ?? []).map(normPlace);
			return ok(oj({ provider: "places", query, count: results.length, results }));
		} catch (e) {
			return fail(`places failed: ${errMsg(e)}`);
		}
	},
};
