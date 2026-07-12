import { retailRender } from "../retail-render";
import { type Fn, fail, ok, type RtEnv } from "../registry";

// WinCo Foods has no online product catalog — this fn is a STORE LOCATOR only.
// wincofoods.com 403s plain/datacenter fetches, so we render through `retailRender`:
// Cloudflare Browser Rendering (residential + stealth) by default, with the mac
// render backend (a residential patched browser) as the dormant fallback when cf
// can't clear a wall. The store directory at /stores is a
// Drupal + AngularJS SPA: the full ~130-store list is rendered client-side into
// `<li id="store-list-item-<locationID>">` cards (there is NO embedded store-JSON
// blob and no per-store lat/lng in the markup), so extraction parses those cards.
// The page shows every store by default — no zip/geo search is required — so `zip`
// and `state` are post-fetch filters. Every card parse is guarded — never throws.

const NO_STORES_MSG = "winco: no stores extracted (layout change or search required).";

type WincoStore = {
	id: string;
	name?: string;
	address?: string;
	city?: string;
	state?: string;
	zip?: string;
	phone?: string;
	lat?: number;
	lng?: number;
	hours?: string;
};

/** Decode the few HTML entities that surface in card text (best-effort). */
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&#38;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.trim();
}

/** First capture group of `re` against `s`, trimmed — or undefined if no match. */
function pick(s: string, re: RegExp): string | undefined {
	const m = s.match(re);
	if (!m || m[1] == null) return undefined;
	const v = decodeEntities(m[1].replace(/\s+/g, " "));
	return v || undefined;
}

/**
 * Parse the rendered store-locator cards. WinCo renders each store as a repeated
 * `<li id="store-list-item-<locationID>">` whose inner `store-details-preview`
 * carries the name/address/city/state/zip/phone in labelled spans (each preceded
 * by an `sr-only` label like "Street"/"City"/"Zip Code"). We split on the list-item
 * marker so each chunk is one card, then lift fields best-effort. No lat/lng is
 * present in the DOM, so those are left undefined. Returns whatever parses.
 */
function fromCards(html: string): WincoStore[] {
	const out: WincoStore[] = [];
	const seen = new Set<string>();
	// Split on the list-item marker; the capture is the numeric locationID, and the
	// following chunk is that card's body up to the next marker.
	const parts = html.split(/<li id="store-list-item-(\d+)"/i);
	// parts[0] is the pre-list preamble; then [id, body, id, body, ...].
	for (let i = 1; i < parts.length; i += 2) {
		const id = parts[i];
		const chunk = parts[i + 1] ?? "";
		try {
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const name = pick(chunk, /class="name">\s*([^<]+?)\s*</i);
			// Street/city/state/zip each sit in a span tagged by its sr-only label.
			const address = pick(chunk, /class="address1"[^>]*>\s*<span class="sr-only">Street<\/span>\s*([^<]+?)\s*</i);
			const city = pick(chunk, /class="city"[^>]*>\s*<span class="sr-only">City<\/span>\s*([^<]+?)\s*</i);
			const state = pick(chunk, /class="state"[^>]*>\s*<span class="sr-only">State<\/span>\s*([^<]+?)\s*</i);
			const zip = pick(chunk, /class="zip"[^>]*>\s*<span class="sr-only">Zip Code<\/span>\s*([^<]+?)\s*</i);
			// Phone: the store-list variant lives in the telephone block — grab the first
			// (NNN) NNN-NNNN after the telephone class marker.
			const phone = pick(chunk, /store-preview__telephone[\s\S]{0,400}?(\(\d{3}\)\s*\d{3}-\d{4})/i);
			// Hours: best-effort — the status span renders a short label like
			// "Open 24 hours" (absent for stores without hours data).
			const hours = pick(chunk, /Store Hours<\/span>[\s\S]{0,300}?<span ng-if="[^"]*isOpen[^"]*"[^>]*>\s*([^<]+?)\s*</i);
			// Assemble a single full-address string from the parts we found.
			const full = [address, [city, state].filter(Boolean).join(", "), zip].filter(Boolean).join(", ").trim();
			out.push({
				id,
				name,
				address: full || undefined,
				city,
				state,
				zip,
				phone,
				hours,
			});
		} catch {
			// One malformed card never aborts the whole parse.
		}
	}
	return out;
}

export const winco: Fn = {
	name: "winco",
	cost: 5,
	description:
		"WinCo Foods store locator via a rendered browser (wincofoods.com 403s plain/datacenter fetches). Renders through Cloudflare Browser Rendering (residential + stealth) by default, falling back to the mac render backend (a residential patched browser) when cf can't clear a wall. " +
		"WinCo has NO online product catalog, so this is locations-only: it renders the /stores directory (a client-side AngularJS list of all ~130 stores) and lifts each store into a normalized shape (id/name/address/city/state/zip/phone/hours). " +
		"`action`: locations. `zip` (5-digit) and `state` (2-letter) are optional post-fetch filters; `limit` caps results (default 25, max 100). Slower than an API.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["locations"], default: "locations", description: "locations (list/find WinCo stores)." },
			zip: { type: "string", description: "5-digit ZIP to filter stores to (optional)." },
			state: { type: "string", description: "2-letter state code to filter stores to (optional)." },
			limit: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "Max stores to return." },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (env: RtEnv, args) => {
		const limit = Math.min(100, Math.max(1, Number(args?.limit) || 25));
		const zip = String(args?.zip ?? "").trim().slice(0, 5);
		const state = String(args?.state ?? "").trim().toUpperCase();

		const r = await retailRender(env, {
			url: "https://www.wincofoods.com/stores",
			// The store list is populated client-side, so wait for the network to settle
			// and give the AngularJS app time to render every card into the DOM.
			wait_until: "networkidle2",
			wait_ms: 10000,
			timeout_ms: 55000,
		});
		if (!r.ok) return fail(`winco: blocked or render failed — ${r.error}`);

		let stores = fromCards(r.body);
		// Apply optional filters: state exact (2-letter), zip by 5-digit prefix (WinCo
		// zips can carry a +4, e.g. "98383-7691").
		if (state) stores = stores.filter((s) => (s.state ?? "").toUpperCase() === state);
		if (zip) stores = stores.filter((s) => (s.zip ?? "").startsWith(zip));
		stores = stores.slice(0, limit);

		if (stores.length === 0) {
			// Distinguish a wall/empty render from a real "no matches / layout change".
			const body = r.body ?? "";
			if (body.length < 1000 || /Access Denied|unusual/i.test(body)) {
				return fail("winco: blocked or empty render (backend may be walled — retry).");
			}
			return fail(NO_STORES_MSG);
		}
		return ok(JSON.stringify({ retailer: "winco", action: "locations", count: stores.length, stores }, null, 2));
	},
};
