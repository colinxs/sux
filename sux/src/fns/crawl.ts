import { type Fn, fail, ok } from "../registry";
import { FANOUT_BUDGET_MS, fetchText, isHttpUrl, oj, pool } from "./_util";
import { type RobotsGroup, isPathAllowed, parseRobots } from "./robots";

// Pages within a frontier level are fetched by a small index-claiming worker
// pool (same pattern as batch_fetch.ts) instead of one await per page. Bodies
// are capped at 512KB — only <title> and hrefs are needed, so streaming past
// that is pure waste.
const CONCURRENCY = 8;
const PAGE_MAX_BYTES = 512 * 1024;

export const crawl: Fn = {
	name: "crawl",
	description: "Breadth-first crawl from a seed URL. Follows same-origin links up to `depth` and `max` pages, returning each URL + its title. same_origin=false allows off-site links (still capped). respect_robots=true honours each host's robots.txt Disallow (for agent *) and reports skipped URLs.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Seed absolute http(s) URL." },
			depth: { type: "integer", default: 1, minimum: 0, maximum: 3 },
			max: { type: "integer", default: 25, minimum: 1, maximum: 100 },
			same_origin: { type: "boolean", default: true },
			respect_robots: { type: "boolean", default: false, description: "Skip URLs disallowed by the target host's robots.txt (user-agent *)." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const seed = String(args?.url ?? "");
		if (!isHttpUrl(seed)) return fail("url must be absolute http(s).");
		// Clamp to the schema bounds and fall back to the defaults on non-numeric
		// input — a NaN depth would disable the depth cap and a NaN max would
		// return (and cache) an empty crawl. isFinite keeps a legitimate depth 0.
		const depthRaw = Number(args?.depth ?? 1);
		const maxDepth = Math.min(3, Math.max(0, Number.isFinite(depthRaw) ? depthRaw : 1));
		const maxRaw = Number(args?.max ?? 25);
		const maxPages = Math.min(100, Math.max(1, Number.isFinite(maxRaw) ? maxRaw : 25));
		const sameOrigin = args?.same_origin !== false;
		const respectRobots = args?.respect_robots === true;
		const origin = new URL(seed).origin;

		// robots.txt is fetched at most once per host for the whole crawl. `null`
		// (fetch failed / >= 400) means "no robots — nothing disallowed". A miss on
		// the map (undefined) triggers the one fetch; an empty [] would look "cached".
		const robotsCache = new Map<string, RobotsGroup[] | null>();
		const skippedByRobots: string[] = [];
		async function robotsAllows(u: string): Promise<boolean> {
			if (!respectRobots) return true;
			const host = new URL(u).origin;
			let groups = robotsCache.get(host);
			if (groups === undefined) {
				try {
					const f = await fetchText(env, `${host}/robots.txt`, { maxBytes: PAGE_MAX_BYTES });
					groups = f.status >= 400 ? null : parseRobots(f.text).groups;
				} catch {
					groups = null; // couldn't reach robots.txt — don't block the crawl
				}
				robotsCache.set(host, groups);
			}
			if (!groups) return true;
			const parsed = new URL(u);
			return isPathAllowed(groups, parsed.pathname + parsed.search);
		}

		const seen = new Set<string>([seed]);
		const results: Array<{ url: string; title: string | null; depth: number }> = [];
		let frontier: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }];

		// Time budget: a large crawl over slow residential fetches can outrun
		// index.ts's FN_DEADLINE_MS, whose withDeadline would then kill the run and
		// return ZERO pages. Instead stop near the budget and return the partials we
		// already have, flagged truncated (mirrors batch.ts / put.ts / _dropbox-full).
		const deadline = Date.now() + FANOUT_BUDGET_MS;
		let truncated = false;

		// The seed is a candidate URL too: honour robots before fetching it.
		if (respectRobots && !(await robotsAllows(seed))) {
			skippedByRobots.push(seed);
			return ok(oj({ seed, pages: 0, results, skipped_by_robots: skippedByRobots }));
		}

		while (frontier.length && results.length < maxPages) {
			// Out of time budget before starting the next level: return what we have.
			if (Date.now() >= deadline) {
				truncated = true;
				break;
			}
			// Only fetch what the remaining budget can index.
			const level = frontier.slice(0, maxPages - results.length);

			// Fetch the level in parallel (shared deadline-raced index-claiming pool);
			// everything else — indexing, link extraction, dedupe — stays sequential in
			// index order so the output is deterministic regardless of completion order.
			// Un-run slots (deadline fired mid-level) come back undefined.
			const fetched = await pool(
				level,
				CONCURRENCY,
				async (item): Promise<{ status: number; html: string } | { error: string }> => {
					try {
						const f = await fetchText(env, item.url, { maxBytes: PAGE_MAX_BYTES });
						return { status: f.status, html: f.text };
					} catch (e) {
						return { error: e instanceof Error ? e.message : String(e) };
					}
				},
				deadline,
			);

			const next: Array<{ url: string; depth: number }> = [];
			for (let i = 0; i < level.length; i++) {
				const { url, depth } = level[i];
				const got = fetched[i];
				// Un-fetched slot: the time budget fired mid-level. Flag and skip — a
				// partial (even seed-only) beats a deadline-killed empty crawl.
				if (got === undefined) {
					truncated = true;
					continue;
				}
				if ("error" in got) {
					// A dead seed is an error, not an empty (cacheable) crawl.
					if (depth === 0) return fail(`seed fetch failed: ${got.error}`);
					continue;
				}
				if (got.status >= 400) {
					if (depth === 0) return fail(`seed fetch returned HTTP ${got.status}.`);
					continue; // skip error pages — don't index them or follow their links
				}
				const html = got.html;
				const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
				results.push({ url, title, depth });
				if (depth >= maxDepth) continue;
				// Stop extracting once the next frontier already fills the budget.
				if (results.length + next.length >= maxPages) continue;
				for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
					if (results.length + next.length >= maxPages) break;
					let abs: string;
					try {
						abs = new URL(m[1], url).href.split("#")[0];
					} catch {
						continue;
					}
					if (!isHttpUrl(abs) || seen.has(abs)) continue;
					if (sameOrigin && new URL(abs).origin !== origin) continue;
					if (respectRobots && !(await robotsAllows(abs))) {
						seen.add(abs); // mark handled so it's reported once, not per inbound link
						skippedByRobots.push(abs);
						continue;
					}
					seen.add(abs);
					next.push({ url: abs, depth: depth + 1 });
				}
			}
			frontier = next;
		}
		const out = ok(oj({ seed, pages: results.length, results, ...(truncated ? { truncated: true, reason: "time" } : {}), ...(respectRobots ? { skipped_by_robots: skippedByRobots } : {}) }));
		// A time-truncated crawl is a partial, not a finished result — freezing it
		// under the default TTL would serve the same incomplete set for up to an
		// hour on re-run (mirrors batch_fetch.ts's noCache-on-truncate via noCacheOn4xx).
		if (truncated) out.noCache = true;
		return out;
	},
};
