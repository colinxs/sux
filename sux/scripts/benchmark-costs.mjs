#!/usr/bin/env node
// Benchmark tool latency from the live /metrics and suggest rate-limit cost
// weights (Fn.cost). Heuristic: higher avg latency ≈ heavier/pricier work → a
// higher weight, so a burst of expensive calls drains the per-user budget faster.
// Paid-upstream tools floor at 2. Prints current (parsed from the fn files) vs
// suggested and stars the ones to bump. Run: npm run bench:costs
//   SUX_BASE=https://suxos.net (override the target)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FNS = join(HERE, "..", "src", "fns");
const BASE = process.env.SUX_BASE || "https://suxos.net";

// Tools that hit a paid upstream (Kagi/SerpAPI/Proxycurl/Browser-Rendering/AI) —
// floor their weight above free deterministic transforms regardless of latency.
export const PAID = new Set([
	"render", "search", "web_search", "shop", "summarize", "translate", "classify", "ocr",
	"facebook", "linkedin", "people", "kroger", "bestbuy", "ebay", "arxiv", "pubmed", "openalex",
]);

/** Suggested cost weight from avg latency (ms) and whether the tool is paid. */
export function suggestCost(avgMs, paid) {
	let c = paid ? 2 : 1;
	if (avgMs >= 3000) c = Math.max(c, 5);
	else if (avgMs >= 1500) c = Math.max(c, 3);
	else if (avgMs >= 500) c = Math.max(c, 2);
	return c;
}

/** Parse the declared Fn.cost from each fn file (default 1). */
export function currentCosts(dir = FNS) {
	const costs = {};
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f.startsWith("_") || f === "index.ts") continue;
		const src = readFileSync(join(dir, f), "utf8");
		const name = src.match(/name:\s*"([^"]+)"/)?.[1];
		if (name) costs[name] = Number(src.match(/\bcost:\s*(\d+)/)?.[1] ?? 1);
	}
	return costs;
}

async function main() {
	const current = currentCosts();
	let metrics;
	try {
		metrics = await (await fetch(`${BASE}/metrics`)).json();
	} catch (e) {
		console.error(`Failed to fetch ${BASE}/metrics: ${e?.message ?? e}`);
		process.exit(1);
	}
	const rows = Object.entries(metrics.tools ?? {}).map(([name, t]) => {
		const avg = t.avg_ms ?? 0;
		const suggested = suggestCost(avg, PAID.has(name));
		const cur = current[name] ?? 1;
		return { name, calls: t.calls ?? 0, avg_ms: avg, current: cur, suggested, change: suggested !== cur };
	});
	rows.sort((a, b) => b.avg_ms - a.avg_ms);
	console.log(`sux cost benchmark — ${BASE}\n`);
	console.log("tool                 calls   avg_ms  cur -> sug");
	for (const r of rows) console.log(`${r.name.padEnd(20)} ${String(r.calls).padStart(5)} ${String(r.avg_ms).padStart(7)}   ${r.current}  -> ${r.suggested}${r.change ? "  *" : ""}`);
	const changes = rows.filter((r) => r.change);
	console.log(`\n${changes.length} weight change(s) suggested${changes.length ? `: ${changes.map((c) => `${c.name} ${c.current}->${c.suggested}`).join(", ")}` : ""}.`);
	if (changes.length) console.log("Update `cost:` in the starred fn files and redeploy.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
