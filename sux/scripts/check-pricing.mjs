#!/usr/bin/env node
// Check current API pricing for sux's paid dependencies. Live pricing pages are
// JS/marketing and can't be parsed reliably, so this keeps a maintained manifest
// of last-known prices + the authoritative pricing URL for each provider, and
// verifies each URL is still reachable (flagging ones whose page moved — a signal
// the price may have changed and should be re-checked by hand). Run:
//   npm run check:pricing            (reachability + manifest)
//   npm run check:pricing -- --open  (also print the URLs to open)
import { pathToFileURL } from "node:url";

// last_checked: YYYY-MM (bump when you manually re-verify a price).
export const PRICING = [
	{ dep: "Kagi Search", price: "$12 / 1k searches", note: "Extract $4/1k — snippet-first, cap extract_count", url: "https://help.kagi.com/kagi/api/search.html", last_checked: "2026-07" },
	{ dep: "Kagi Summarizer", price: "~$0.12 / page", note: "vs Workers AI ~$0.0003/page (~300x cheaper)", url: "https://help.kagi.com/kagi/api/summarizer.html", last_checked: "2026-07" },
	{ dep: "CF Browser Rendering", price: "$0.09 / browser-hr", note: "render fn — needs Workers Paid", url: "https://developers.cloudflare.com/browser-rendering/platform/pricing/", last_checked: "2026-07" },
	{ dep: "Workers AI", price: "~$0.011 / 1k neurons", note: "summarize/translate/classify/ocr — very cheap", url: "https://developers.cloudflare.com/workers-ai/platform/pricing/", last_checked: "2026-07" },
	{ dep: "Workers KV", price: "$0.50/M reads, $5/M writes", note: "cache + metrics — compressed payloads (cache-codec)", url: "https://developers.cloudflare.com/workers/platform/pricing/", last_checked: "2026-07" },
	{ dep: "R2", price: "$0.015/GB-mo, no egress fees", note: "store fn (CAS blobs)", url: "https://developers.cloudflare.com/r2/pricing/", last_checked: "2026-07" },
	{ dep: "Facebook Graph API", price: "free (rate-limited)", note: "facebook fn — subject to app review/limits", url: "https://developers.facebook.com/docs/graph-api/overview/rate-limiting/", last_checked: "2026-07" },
];

/** true when a manifest entry hasn't been re-verified within `months`. */
export function isStale(entry, nowYm, months = 6) {
	const [ny, nm] = nowYm.split("-").map(Number);
	const [ey, em] = String(entry.last_checked).split("-").map(Number);
	return (ny - ey) * 12 + (nm - em) > months;
}

async function reachable(url) {
	try {
		const r = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15000) });
		return r.status;
	} catch (e) {
		return `ERR ${e?.name ?? ""}`.trim();
	}
}

async function main() {
	const nowYm = new Date().toISOString().slice(0, 7);
	console.log(`sux API pricing check — ${nowYm}\n`);
	const results = await Promise.all(PRICING.map(async (p) => ({ ...p, status: await reachable(p.url) })));
	for (const p of results) {
		const flags = [p.status === 200 ? "" : `URL ${p.status}`, isStale(p, nowYm) ? "STALE(>6mo)" : ""].filter(Boolean).join(" ");
		console.log(`• ${p.dep.padEnd(24)} ${p.price}${flags ? `   [${flags}]` : ""}`);
		console.log(`    ${p.note}`);
		if (process.argv.includes("--open")) console.log(`    ${p.url}`);
	}
	const attention = results.filter((p) => p.status !== 200 || isStale(p, nowYm));
	console.log(`\n${attention.length} item(s) need attention${attention.length ? ` (re-verify the price + URL): ${attention.map((a) => a.dep).join(", ")}` : ""}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
