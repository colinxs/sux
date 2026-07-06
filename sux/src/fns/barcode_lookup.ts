import { type Fn, fail, ok } from "../registry";

export const barcodeLookup: Fn = {
	name: "barcode_lookup",
	description: "Look up a product by barcode (GTIN/UPC/EAN) via Open Food Facts (free). Returns name, brand, categories, quantity, and image. Best for grocery/CPG; general cross-store pricing needs a keyed provider (not wired).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["gtin"],
		properties: { gtin: { type: "string", description: "8–14 digit barcode." } },
	},
	cacheable: true,
	run: async (_env, args) => {
		const gtin = String(args?.gtin ?? "").replace(/\D/g, "");
		if (!/^\d{8,14}$/.test(gtin)) return fail("Provide a numeric 8–14 digit barcode.");
		const resp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${gtin}.json`, {
			headers: { "user-agent": "sux/1.0 (barcode_lookup)" },
		});
		if (!resp.ok) return fail(`Open Food Facts failed: HTTP ${resp.status}`);
		const j = (await resp.json()) as any;
		if (j.status !== 1 || !j.product) return ok(JSON.stringify({ gtin, found: false, note: "not in Open Food Facts (try a keyed provider for non-grocery items)" }));
		const p = j.product;
		return ok(
			JSON.stringify(
				{
					gtin,
					found: true,
					name: p.product_name || null,
					brand: p.brands || null,
					categories: p.categories || null,
					quantity: p.quantity || null,
					image: p.image_url || null,
					nutriscore: p.nutriscore_grade || null,
				},
				null,
				2,
			),
		);
	},
};
