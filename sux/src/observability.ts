// Public, unauthenticated observability endpoints for the sux engine:
//   GET /metrics  — usage metrics as JSON (?format=prometheus for scraping)
//   GET /logs     — rolling call log with metric fields (JSON; ?tool= / ?limit= )
//   GET /feedback — server-side issue/suggest backlog (JSON; ?type= / ?limit= )
// No dashboard UI by design — logging + metrics only. `/health` is intentionally
// NOT handled here: it falls through to the richer browsable page in
// github-handler.ts (residential-egress stats). Returns null when the path isn't
// ours so index.ts can fall through to OAuth.

import { type FeedbackKind, readFeedback } from "./fns/_feedback";
import { readMetrics, sloReport, toPrometheus } from "./metrics";
import type { RtEnv } from "./registry";

const json = (obj: unknown, status = 200): Response =>
	new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleObservability(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;

	// Public content handle: GET /s/<uuid> resolves the KV mapping to its R2
	// object and streams it back (the URL `store` returns on put).
	if (url.pathname.startsWith("/s/")) {
		const uuid = url.pathname.slice(3).split("/")[0];
		if (!uuid) return new Response("not found", { status: 404 });
		if (!env.R2) return new Response("R2 not enabled", { status: 503 });
		const raw = await env.OAUTH_KV.get(`store:${uuid}`);
		if (!raw) return new Response("not found", { status: 404 });
		let ref: { key: string; content_type?: string };
		try {
			ref = JSON.parse(raw);
		} catch {
			return new Response("bad handle", { status: 500 });
		}
		const obj = await env.R2.get(ref.key);
		if (!obj) return new Response("object missing", { status: 404 });
		return new Response(await obj.arrayBuffer(), {
			status: 200,
			headers: { "content-type": ref.content_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" },
		});
	}

	if (url.pathname === "/metrics") {
		const m = await readMetrics(env);
		if (url.searchParams.get("format") === "prometheus") {
			return new Response(toPrometheus(m), { status: 200, headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
		}
		// Metrics view excludes the rolling log (see /logs) to stay compact, and
		// adds the SLO/health view (latency percentiles + breaches vs targets).
		const { recent, ...summary } = m;
		return json({ ...summary, slo: sloReport(m) });
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
			recent: recent.slice(0, limit).map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
		});
	}

	if (url.pathname === "/feedback") {
		const t = url.searchParams.get("type");
		const kind: FeedbackKind | undefined = t === "issue" || t === "suggest" ? t : undefined;
		const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
		const items = await readFeedback(env, kind, limit);
		return json({ count: items.length, items: items.map((e) => ({ ...e, at: new Date(e.at).toISOString() })) });
	}

	return null;
}
