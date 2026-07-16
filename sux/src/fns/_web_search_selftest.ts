// Periodic markup-drift probe for web_search's scraped engines (#545, following on
// from #537: a scraper whose parser stops matching returns [] instead of throwing,
// which is indistinguishable from a genuine no-results query until someone notices
// results look thin). Runs a known-good query through each auto-probed engine on
// the daily cron and reports 0-hit engines as a soft failure, so drift surfaces via
// the cron heartbeat (see cron-heartbeat.ts) instead of waiting for a live merge.

import { type RtEnv } from "../registry";
import { webSearch } from "./web_search";
import { errMsg } from "./_util";

// Guaranteed to have results and cheap to parse — a 0-hit response is unambiguous
// drift, never a query that legitimately has no answer.
export const SEARCH_PROBE_QUERY = "site:wikipedia.org test";

// `google` scrapes through the mac render backend and is deliberately opt-in/
// never-picked-automatically elsewhere in web_search.ts (see its `run` description);
// an unattended daily probe shouldn't be the first thing to invoke that heavy path.
// `ddg` and `kagi_session` are the cheap, no-extra-infra scraped engines.
export const AUTO_SCRAPED_ENGINES = ["ddg", "kagi_session"] as const;

export type WebSearchSelftestDeps = { runEngine: typeof webSearch.run };

export function defaultDeps(): WebSearchSelftestDeps {
	return { runEngine: webSearch.run };
}

export type EngineProbe = { engine: string; ok: boolean; skipped?: boolean; error?: string };

/** Probe a single scraped engine with the known-good query. `kagi_session` is
 * skipped (not failed) when KAGI_SESSION isn't configured — an unconfigured
 * engine isn't drift. */
async function probeEngine(env: RtEnv, engine: string, deps: WebSearchSelftestDeps): Promise<EngineProbe> {
	if (engine === "kagi_session" && !(env as any).KAGI_SESSION) return { engine, ok: false, skipped: true };
	try {
		const res = await deps.runEngine(env, { query: SEARCH_PROBE_QUERY, engine, limit: 3 });
		if (res.isError) return { engine, ok: false, error: res.content?.[0]?.text ?? "no results" };
		return { engine, ok: true };
	} catch (e) {
		return { engine, ok: false, error: errMsg(e) };
	}
}

/** Cron sub-job report: `error` (read by cron-heartbeat's subJobError) is set only
 * when a NON-skipped engine came back with 0 hits — that's the markup-drift signal
 * worth alerting on, not an engine that was never configured. */
export async function runWebSearchSelftest(env: RtEnv, deps: WebSearchSelftestDeps = defaultDeps()): Promise<{ probes: EngineProbe[]; error?: string }> {
	const probes = await Promise.all(AUTO_SCRAPED_ENGINES.map((engine) => probeEngine(env, engine, deps)));
	const drifted = probes.filter((p) => !p.ok && !p.skipped).map((p) => p.engine);
	if (drifted.length) return { probes, error: `scraped engine(s) returned 0 hits for a known-good query — possible markup drift: ${drifted.join(", ")}` };
	return { probes };
}
