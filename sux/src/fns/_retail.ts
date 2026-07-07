// Shared normalization for the retailer fns (kroger now; ace/costco/homedepot/
// walmart next). Keep minimal — just what kroger needs today, shaped to extend
// so every retailer emits one product shape a caller can parse identically.

/** One normalized retail product, common across every retailer fn. */
export type RetailProduct = {
	id: string;
	title: string;
	brand?: string;
	price?: number;
	promo_price?: number;
	currency: string;
	fulfillment?: string[];
	size?: string;
	image?: string;
	url?: string;
	in_stock?: boolean;
	condition?: string;
};

/** THE retail result envelope: the query context plus the normalized products. */
export type RetailResult = {
	retailer: string;
	action: string;
	count: number;
	products: RetailProduct[];
};

/**
 * Coerce a money-ish value — a number, or a "$1.23"/"1.23" string — to a positive
 * number, else undefined. Retailers signal "no price for this store" with 0 (and
 * "no promo" with a 0 promo), so a non-positive value normalizes to undefined.
 */
export function normalizeMoney(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}
