// Public, unauthenticated observability endpoints for the sux engine:
//   GET /metrics  — usage metrics as JSON (?format=prometheus for scraping)
//   GET /logs     — rolling call log with metric fields (JSON; ?tool= / ?limit= )
//   GET /feedback — server-side issue/suggest backlog (JSON; ?type= / ?tool= / ?limit= )
//   GET /llms.txt — the capability map as markdown (CDN-cacheable, no secrets)
// No dashboard UI by design — logging + metrics only. `/health` is intentionally
// NOT handled here: it falls through to the richer browsable page in
// github-handler.ts (residential-egress stats). Returns null when the path isn't
// ours so index.ts can fall through to OAuth.

import { type FeedbackKind, readFeedback } from "./fns/_feedback";
import { maybeDecompress } from "./fns/_gzip";
import { FUNCTIONS } from "./fns/index";
import { renderOverview } from "./fns/_surface";
import { isExpired } from "./fns/_util";
import { readMetrics, sloReport, toPrometheus } from "./metrics";
import type { RtEnv } from "./registry";

const json = (obj: unknown, status = 200): Response =>
	new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Coarse per-IP backpressure for the anonymous routes that hit KV/R2 on every
// request (/metrics, /logs, /feedback, /s/*). The authenticated MCP path is
// gated by MCP_RATE_LIMITER; these are not, so without this an anonymous flood
// would drive real KV read + R2 egress spend with no ceiling. /llms.txt is
// exempt — a pure in-memory render with no per-hit storage cost.
function isMeteredObsPath(pathname: string): boolean {
	return pathname.startsWith("/s/") || pathname === "/metrics" || pathname === "/logs" || pathname === "/feedback";
}

async function obsRateLimited(request: Request, env: RtEnv): Promise<boolean> {
	if (!env.OBS_RATE_LIMITER) return false;
	// Fail OPEN if the limiter throws — an unavailable limiter must never itself
	// become an outage (matches the not-configured branch above).
	try {
		const { success } = await env.OBS_RATE_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") || "anon" });
		return !success;
	} catch (e) {
		console.warn(`obs rate limiter threw, failing open: ${String((e as Error)?.message ?? e)}`);
		return false;
	}
}

export async function handleObservability(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;

	if (isMeteredObsPath(url.pathname) && (await obsRateLimited(request, env))) {
		return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "10" } });
	}

	// Public content handle: GET /s/<uuid> resolves the KV mapping to its R2
	// object and streams it back (the URL `store` returns on put).
	if (url.pathname.startsWith("/s/")) {
		const uuid = url.pathname.slice(3).split("/")[0];
		if (!uuid) return new Response("not found", { status: 404 });
		if (!env.R2) return new Response("R2 not enabled", { status: 503 });
		const raw = await env.OAUTH_KV.get(`store:${uuid}`);
		if (!raw) return new Response("not found", { status: 404 });
		let ref: { key: string; content_type?: string; expiry?: number };
		try {
			ref = JSON.parse(raw);
		} catch {
			return new Response("bad handle", { status: 500 });
		}
		// Expired handle → not-found; best-effort reap any handle KV hasn't evicted.
		if (isExpired(ref)) {
			await env.OAUTH_KV.delete(`store:${uuid}`).catch(() => {});
			return new Response("not found", { status: 404 });
		}
		const obj = await env.R2.get(ref.key);
		if (!obj) return new Response("object missing", { status: 404 });
		// Serve the ORIGINAL bytes: stored text blobs are transparently gzip-framed,
		// but this public URL feeds arbitrary HTTP consumers (browsers, JMAP
		// attachment streaming) that know nothing of our marker — inflate first.
		const body = await maybeDecompress(new Uint8Array(await obj.arrayBuffer()));
		return new Response(body, {
			status: 200,
			headers: {
				"content-type": ref.content_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream",
				"cache-control": "public, max-age=31536000, immutable",
				// Untrusted stored bytes: no MIME sniffing, and sandbox anything renderable.
				"x-content-type-options": "nosniff",
				"content-security-policy": "sandbox",
			},
		});
	}

	// Public capability map — same source as the `sux` root verb (fns/_surface.ts),
	// so the two surfaces can't drift. No secrets; CDN-cacheable for an hour.
	if (url.pathname === "/llms.txt") {
		return new Response(renderOverview(FUNCTIONS), {
			status: 200,
			headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
		});
	}

	if (url.pathname === "/metrics") {
		const m = await readMetrics(env);
		if (url.searchParams.get("format") === "prometheus") {
			return new Response(toPrometheus(m), { status: 200, headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
		}
		// Metrics view excludes the rolling log (see /logs) to stay compact, and
		// adds the SLO/health view (latency percentiles + breaches vs targets)
		// plus derived per-tool rates so hot spots are readable at a glance.
		const { recent, ...summary } = m;
		const r4 = (n: number) => Math.round(n * 10000) / 10000;
		const tools = Object.fromEntries(
			Object.entries(m.tools).map(([name, t]) => {
				// Drop last_error from the public view: raw upstream failure text can carry
				// echoed input / proxy error-body fragments and must not leak to anonymous callers.
				const { last_error, ...pub } = t;
				return [name, { ...pub, error_rate: r4(t.calls ? t.errors / t.calls : 0), hit_rate: r4(t.calls ? t.cache_hits / t.calls : 0), avg_ms: t.calls ? Math.round(t.total_ms / t.calls) : 0 }];
			}),
		);
		return json({ ...summary, tools, slo: sloReport(m) });
	}

	if (url.pathname === "/logs") {
		const m = await readMetrics(env);
		const tool = url.searchParams.get("tool");
		const limit = Math.min(Number(url.searchParams.get("limit")) || 50, m.recent.length);
		let recent = m.recent;
		if (tool) recent = recent.filter((e) => e.tool === tool);
		return json({
			since: m.since,
			total: m.total,
			cache_hits: m.cache_hits,
			errors: m.errors,
			// Explicit allowlist, NOT a spread: only these known-safe fields are emitted so
			// any future LogEntry field (args/headers/secrets) can't silently leak to the
			// unauthenticated view. `err` (raw tool failure text) is deliberately excluded;
			// the boolean `error` flag stays so callers still see which calls failed.
			recent: recent.slice(0, limit).map((e) => ({
				at: new Date(e.at).toISOString(),
				tool: e.tool,
				ms: e.ms,
				cache: e.cache,
				error: e.error,
				...(e.routes ? { routes: e.routes } : {}),
			})),
		});
	}

	if (url.pathname === "/feedback") {
		const t = url.searchParams.get("type");
		const kind: FeedbackKind | undefined = t === "issue" || t === "suggest" ? t : undefined;
		const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
		const items = await readFeedback(env, kind, limit, url.searchParams.get("tool") ?? undefined);
		return json({ count: items.length, items: items.map((e) => ({ ...e, at: new Date(e.at).toISOString() })) });
	}

	return null;
}
