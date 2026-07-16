import { type Fn, ok } from "../registry";
import { oj } from "./_util";
import { isTailscaleConfigured, smartFetch } from "../proxy";
import { macRender } from "../mac-render";

// Live probe of the fetch ladder — the three egress pillars (direct → residential
// scrape → mac render) plus the CF Browser Run binding. Each rung is probed
// independently, guarded, and hard time-bounded so a hung node (the exact failure
// this fn exists to detect) can never hang selftest itself: a probe that throws or
// exceeds the deadline is reported `ok:false`, never propagated. `configured`
// reports which credentials/bindings are present as booleans WITHOUT calling the
// upstreams (no key is spent, no rate limit touched). Never cached — a stale
// "everything up" is worse than no answer for a health probe.

// Tiny, always-up, no-JS target every reachable rung can fetch cheaply.
const PROBE_URL = "https://example.com/";

// Default per-rung deadline. Overridable via `timeout_ms` so a caller (or a test)
// can tighten it; each rung gets its own budget and they all run concurrently, so
// selftest returns within roughly one deadline even if every rung is wedged.
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;

// A single rung's verdict. `ok` = the rung answered; `status` carries the HTTP code
// when we got a response; `skipped` marks a rung we can't probe because it isn't
// configured; `error` explains a down/timed-out rung.
type Rung = { ok: boolean; status?: number; skipped?: boolean; reason?: string; error?: string };

function msg(e: unknown): string {
	return String((e as Error)?.message ?? e);
}

// Run `fn` under an AbortSignal.timeout, racing the work against the signal's abort
// so a probe whose underlying op ignores the signal (or just hangs) still resolves
// by the deadline instead of pinning the tool call open forever. The signal is also
// handed to `fn` so signal-aware ops (fetch) abort their socket too.
async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const signal = AbortSignal.timeout(ms);
	return await Promise.race([
		fn(signal),
		new Promise<never>((_, reject) => {
			signal.addEventListener("abort", () => reject(new Error(`probe timed out after ${ms}ms`)));
		}),
	]);
}

// Rung 1 — the worker's own direct fetch() to the public internet. Bypasses the
// residential ladder entirely; if this is down, nothing else can be.
async function probeDirect(ms: number): Promise<Rung> {
	try {
		return await withTimeout(ms, async (signal) => {
			const r = await fetch(PROBE_URL, { method: "GET", redirect: "manual", signal });
			return { ok: true, status: r.status };
		});
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// Rung 2 — smartFetch through the Tailscale residential proxy (the OpenWRT node).
// Skipped (not down) when the proxy isn't configured, so an unconfigured tailnet
// doesn't read as an outage.
async function probeScrape(env: Parameters<typeof smartFetch>[0], ms: number): Promise<Rung> {
	if (!isTailscaleConfigured(env)) return { ok: false, skipped: true, reason: "residential proxy not configured (TAILSCALE_PROXY_URL/SECRET)" };
	try {
		return await withTimeout(ms, async () => {
			const r = await smartFetch(env, PROBE_URL, {}, "proxy");
			return { ok: true, status: r.status };
		});
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// Active Grafana Loki push probe. Distinct from `configured.grafana` (presence
// only): this actually POSTs one health-check line to the Loki push endpoint and
// reports the HTTP status, so the #226 failure mode — all five Grafana secrets set
// yet zero sux data ever lands in the stack — surfaces here as a 401/403/404
// instead of dying silently in shipToLoki's fire-and-forget ctx.waitUntil (whose
// only trace is a console.warn buried in the Worker's own logs). A 204/200 proves
// the configured URL+user+token reach a writable stack; the line it writes
// (kind="selftest") is itself queryable in Loki as end-to-end proof of landing.
// Skipped, not down, when the Loki secrets are unset.
async function probeGrafana(
	env: { GRAFANA_LOKI_URL?: string; GRAFANA_LOKI_USER?: string; GRAFANA_LOKI_TOKEN?: string },
	ms: number,
): Promise<Rung> {
	const url = env.GRAFANA_LOKI_URL;
	const user = env.GRAFANA_LOKI_USER;
	const token = env.GRAFANA_LOKI_TOKEN;
	if (!url || !user || !token) return { ok: false, skipped: true, reason: "GRAFANA_LOKI_* unset" };
	try {
		return await withTimeout(ms, async (signal) => {
			const body = JSON.stringify({
				streams: [
					{ stream: { service: "sux", kind: "selftest" }, values: [[`${Date.now()}000000`, JSON.stringify({ probe: "selftest" })]] },
				],
			});
			const authorization = `Basic ${btoa(`${user}:${token}`)}`;
			const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization }, body, signal });
			return { ok: r.ok, status: r.status };
		});
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

// Rung 3 — the Mac patchright render node. macRender never throws (returns
// {ok:false,error}), but we still bound it: its own AbortSignal budget can exceed
// our probe deadline. Skipped when MAC_RENDER_URL is unset.
async function probeRenderMac(env: Parameters<typeof macRender>[0], ms: number): Promise<Rung> {
	if (!env.MAC_RENDER_URL) return { ok: false, skipped: true, reason: "MAC_RENDER_URL unset" };
	try {
		return await withTimeout(ms, async () => {
			const r = await macRender(env, { url: PROBE_URL, timeout_ms: Math.min(ms, 5_000) });
			return r.ok ? { ok: true } : { ok: false, error: r.error };
		});
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

export const selftest: Fn = {
	name: "selftest",
	description:
		"Probe the fetch ladder and report which rungs are up. Live health check: fetches a tiny known URL through each egress path — direct (worker fetch), scrape (residential proxy / OpenWRT node), render_mac (Mac patchright node) — and reports whether the BROWSER binding (render_cf) is present. Also actively probes the Grafana Cloud Loki push endpoint (`grafana`): POSTs one health-check line with the configured URL/user/token and reports the HTTP status, so a misconfigured stack (all secrets set yet nothing lands) shows as a 401/403/404 instead of failing silently in the fire-and-forget ship path. Every probe is guarded and hard time-bounded (default 8s each, override with timeout_ms) so a hung node can never hang selftest. Also reports `configured` — which credentials/bindings are present as booleans, WITHOUT calling the upstreams (no key spent, no rate limit touched). Returns JSON { rungs:{direct,scrape,render_mac,render_cf}, grafana, configured }. Never cached.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: [],
		properties: {
			timeout_ms: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS, description: "Per-rung probe deadline in ms (default 8000). Each rung runs concurrently under its own deadline." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const ms = Math.min(Math.max(Number(args?.timeout_ms) || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);

		const [direct, scrape, render_mac, grafana] = await Promise.all([
			probeDirect(ms),
			probeScrape(env, ms),
			probeRenderMac(env, ms),
			probeGrafana(env, ms),
		]);

		// render_cf is binding-presence only: launching a browser to probe it would
		// be far heavier than the other rungs, and its presence is what callers need.
		const render_cf: Rung = env.BROWSER ? { ok: true, reason: "BROWSER binding present" } : { ok: false, skipped: true, reason: "BROWSER binding absent" };

		// Configured = credential/binding presence, computed WITHOUT any upstream call.
		const configured = {
			kagi: Boolean(env.KAGI_API_KEY),
			kroger: Boolean(env.KROGER_CLIENT_ID && env.KROGER_CLIENT_SECRET),
			brave: Boolean(env.BRAVE_API_KEY),
			exa: Boolean(env.EXA_API_KEY),
			tavily: Boolean(env.TAVILY_API_KEY),
			google_maps: Boolean(env.GOOGLE_MAPS_KEY),
			bestbuy: Boolean(env.BESTBUY_API_KEY),
			ebay: Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
			youtube: Boolean(env.YOUTUBE_API_KEY),
			stackexchange: Boolean(env.STACKEXCHANGE_KEY),
			coingecko: Boolean(env.COINGECKO_API_KEY),
			facebook: Boolean(env.FACEBOOK_TOKEN),
			grafana: Boolean(env.GRAFANA_LOKI_URL && env.GRAFANA_LOKI_USER && env.GRAFANA_LOKI_TOKEN),
			proxy: isTailscaleConfigured(env),
			mac_render: Boolean(env.MAC_RENDER_URL && env.MAC_RENDER_SECRET),
			browser: Boolean(env.BROWSER),
		};

		return ok(oj({ rungs: { direct, scrape, render_mac, render_cf }, grafana, configured }));
	},
};
