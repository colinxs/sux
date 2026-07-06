import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

function checkDigitValid(code: string): boolean {
	if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
	const digits = code.split("").map(Number);
	const check = digits.pop()!;
	let sum = 0;

	for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
	return (10 - (sum % 10)) % 10 === check;
}

export const gtin: Fn = {
	name: "gtin",
	description: "Find product barcodes (GTIN/UPC/EAN, 8–14 digits) in a page's JSON-LD, microdata, and meta tags, validating each check digit. Pass a url or raw html. Returns the valid GTINs found.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: { url: { type: "string" }, html: { type: "string" } },
	},
	cacheable: true,
	run: async (env, args) => {
		let html = String(args?.html ?? "");
		if (!html && args?.url) {
			if (!/^https?:\/\//i.test(String(args.url))) return fail("url must be absolute http(s).");
			html = await (await smartFetch(env, String(args.url), {})).text();
		}
		if (!html) return fail("Provide `html` or `url`.");

		const candidates = new Set<string>();
		for (const m of html.matchAll(/"gtin(?:8|12|13|14)?"\s*:\s*"?(\d{8,14})"?/gi)) candidates.add(m[1]);
		for (const m of html.matchAll(/itemprop=["']gtin\d*["'][^>]*content=["'](\d{8,14})["']/gi)) candidates.add(m[1]);
		for (const m of html.matchAll(/\b(\d{12,14})\b/g)) candidates.add(m[1]);

		const valid = [...candidates].filter(checkDigitValid);
		if (!valid.length) return ok("(no valid GTIN found)");
		return ok(JSON.stringify({ gtins: [...new Set(valid)] }, null, 2));
	},
};
