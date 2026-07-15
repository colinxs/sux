// A single-page WAN dashboard for sux: a live metrics snapshot + a recent-notes
// list. KISS by design (issue #359):
//   GET /dashboard              — static HTML shell, no framework
//   GET /dashboard/api/metrics  — JSON metrics snapshot (reuses metrics.ts —
//                                 the same aggregate /metrics already exposes)
//   GET /dashboard/api/notes    — recent vault notes (read-only; reuses the git
//                                 vault_ read path in fns/obsidian.ts — no new
//                                 content store)
//
// Auth model: Cloudflare Access, NOT app code. This route is served here — before
// the OAuth provider claims every path — for the same reason /metrics and /logs
// are (see observability.ts): it must NOT go through the GitHub-OAuth MCP gate,
// which is scoped to MCP JSON-RPC, not a browser session. Instead the `/dashboard`
// path is meant to be fronted by a Cloudflare Zero Trust Access "self-hosted
// application" scoped to this Worker's hostname + `/dashboard*`, so an
// unauthenticated request never reaches this code at all — Access enforces
// identity at the edge, exactly like the origins documented in
// docs/proposals/vpc-hosting.md ("Access self-hosted app" pattern) and
// sux/mcp-gate/README.md's upgrade path ("Cloudflare Access managed OAuth in
// front"). No Access application existed anywhere in this repo for a live route
// before this change; wrangler config carries no binding for it (Access apps are
// pure Zero Trust dashboard/API config, not a Worker binding), so provisioning
// the actual policy is a manual follow-up — see docs/design/dashboard.md.
//
// Defense in depth only (Access is the real gate): the same coarse per-IP
// OBS_RATE_LIMITER used by /metrics/logs/feedback also backstops the API routes
// here, since a vault notes read fans out into GitHub API calls that are worth
// rate-limiting regardless of who's asking.

import { verifyAccessJwt } from "./access-jwt";
import { compileSieve } from "./fns/_mail_sieve";
import { obsidian } from "./fns/obsidian";
import { deriveMetrics, readMetrics, sloReport } from "./metrics";
import { obsRateLimited } from "./observability";
import type { RtEnv } from "./registry";

const json = (obj: unknown, status = 200): Response =>
	new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const NOTE_FOLDERS = ["Daily", "Inbox"];
const DEFAULT_NOTES_LIMIT = 8;
const MAX_NOTES_LIMIT = 25;
const EXCERPT_CHARS = 220;

type NoteSummary = { path: string; excerpt: string };

/** Strip a leading YAML frontmatter block (--- ... ---) so the excerpt is body text. */
function stripFrontmatter(body: string): string {
	return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/**
 * Recent notes across Daily/ and Inbox/ — the two folders sux itself writes to
 * (daily capture + vault_capture/ingest). Both use date-prefixed filenames
 * (`Daily/<date>.md`, `Inbox/<date> <slug>.md`), so a lexicographic sort is a
 * chronological sort with zero extra GitHub commit-log calls — reads stay on the
 * existing vault_list/vault_read path (obsidian.ts, backend:'git'), no new store.
 * Best-effort per folder: a listing error for one folder doesn't fail the other.
 */
export async function recentNotes(env: RtEnv, limit: number): Promise<NoteSummary[]> {
	const lists = await Promise.all(NOTE_FOLDERS.map((folder) => obsidian.run(env, { action: "list", path: folder, backend: "git" })));
	const paths: string[] = [];
	for (const r of lists) {
		if (r.isError || !Array.isArray(r.content)) continue;
		try {
			const parsed = JSON.parse(r.content[0]?.text ?? "{}") as { notes?: string[] };
			if (Array.isArray(parsed.notes)) paths.push(...parsed.notes);
		} catch {
			// Malformed listing for this folder — skip it, keep the rest.
		}
	}
	// Sort by basename (not the full path) so both folders interleave by date —
	// Daily/<date>.md and Inbox/<date> <slug>.md both start with the date, but the
	// folder name itself ("Inbox" > "Daily" lexicographically) would otherwise skew
	// a whole-path sort regardless of actual recency.
	const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
	paths.sort((a, b) => basename(b).localeCompare(basename(a)));
	const top = paths.slice(0, limit);
	const reads = await Promise.all(top.map((p) => obsidian.run(env, { action: "read", path: p, backend: "git" })));
	return top.map((path, i) => {
		const r = reads[i];
		const text = !r.isError && Array.isArray(r.content) ? String(r.content[0]?.text ?? "") : "";
		const excerpt = stripFrontmatter(text).slice(0, EXCERPT_CHARS).replace(/\s+/g, " ").trim();
		return { path, excerpt };
	});
}

/** Live metrics snapshot for the dashboard — same source of truth as GET /metrics,
 * trimmed to what's worth a glance: totals, derived rates, SLO breaches, and the
 * top tools by call volume. No new metrics pipeline. */
export async function metricsSnapshot(env: RtEnv) {
	const m = await readMetrics(env);
	const derived = deriveMetrics(m);
	const slo = sloReport(m);
	const topTools = Object.entries(m.tools)
		.map(([name, t]) => ({
			name,
			calls: t.calls,
			errors: t.errors,
			avg_ms: t.calls ? Math.round(t.total_ms / t.calls) : 0,
			error_rate: t.calls ? Math.round((t.errors / t.calls) * 10000) / 10000 : 0,
		}))
		.sort((a, b) => b.calls - a.calls)
		.slice(0, 10);
	return { since: m.since, ...derived, slo, top_tools: topTools };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sux dashboard</title>
<style>
  :root { color-scheme: dark light; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #0b0d10; color: #e6e6e6; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; margin-bottom: 24px; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #15181d; border: 1px solid #262b33; border-radius: 8px; padding: 14px; }
  .card .label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
  .card .value.bad { color: #ff6b6b; }
  .card .value.ok { color: #4ade80; }
  section { margin-bottom: 28px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #aaa; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1f242b; }
  th { color: #888; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  ul.notes { list-style: none; margin: 0; padding: 0; }
  ul.notes li { padding: 10px 0; border-bottom: 1px solid #1f242b; }
  ul.notes .path { font-weight: 600; color: #93c5fd; }
  ul.notes .excerpt { color: #aaa; margin-top: 2px; }
  .err { color: #ff6b6b; font-size: 12px; }
  .breach { color: #ff6b6b; }
  .loading { color: #666; font-style: italic; }
  pre#sieve-script { background: #15181d; border: 1px solid #262b33; border-radius: 8px; padding: 14px; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre; margin: 0 0 10px; }
  button#sieve-copy { background: #1f242b; border: 1px solid #262b33; color: #e6e6e6; border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  button#sieve-copy:hover:not(:disabled) { background: #262b33; }
  button#sieve-copy:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<h1>sux</h1>
<div class="sub">Read-only WAN dashboard · gated by Cloudflare Access</div>

<section>
  <h2>Metrics</h2>
  <div id="metrics-cards" class="grid"><div class="loading">Loading metrics…</div></div>
  <div id="slo-breaches"></div>
  <table id="top-tools" style="display:none">
    <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Avg ms</th><th>Error rate</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section>
  <h2>Recent notes</h2>
  <ul class="notes" id="notes-list"><li class="loading">Loading notes…</li></ul>
</section>

<section>
  <h2>Mail pre-filter (Sieve)</h2>
  <div class="sub" id="sieve-sub">Coarse rung-0 tags applied at Fastmail delivery time. Text only — paste into Fastmail Settings → Rules → Custom rule (Sieve) yourself; nothing here installs it for you.</div>
  <pre id="sieve-script" class="loading">Loading script…</pre>
  <button id="sieve-copy" type="button" disabled>Copy script</button>
</section>

<script>
function card(label, value, cls) {
  return '<div class="card"><div class="label">' + label + '</div><div class="value' + (cls ? ' ' + cls : '') + '">' + value + '</div></div>';
}
function pct(n) { return n === null || n === undefined ? '—' : (n * 100).toFixed(1) + '%'; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function loadMetrics() {
  const el = document.getElementById('metrics-cards');
  try {
    const res = await fetch('/dashboard/api/metrics');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const m = await res.json();
    el.innerHTML =
      card('Calls', m.calls ?? 0) +
      card('Error rate', pct(m.error_rate), (m.error_rate ?? 0) > 0.05 ? 'bad' : 'ok') +
      card('Cache hit rate', pct(m.cache_hit_rate)) +
      card('p50 latency', (m.slo?.latency_ms?.p50 ?? 0) + 'ms') +
      card('p95 latency', (m.slo?.latency_ms?.p95 ?? 0) + 'ms') +
      card('SLO breaches', (m.slo?.breaches?.length ?? 0), (m.slo?.breaches?.length ?? 0) > 0 ? 'bad' : 'ok');

    const breachEl = document.getElementById('slo-breaches');
    breachEl.innerHTML = (m.slo?.breaches ?? []).map((b) => '<div class="breach">⚠ ' + esc(b) + '</div>').join('');

    const tbody = document.querySelector('#top-tools tbody');
    tbody.innerHTML = (m.top_tools ?? [])
      .map((t) => '<tr><td>' + esc(t.name) + '</td><td>' + t.calls + '</td><td>' + t.errors + '</td><td>' + t.avg_ms + '</td><td>' + pct(t.error_rate) + '</td></tr>')
      .join('');
    document.getElementById('top-tools').style.display = (m.top_tools ?? []).length ? '' : 'none';
  } catch (e) {
    el.innerHTML = '<div class="err">Failed to load metrics: ' + esc(e.message || e) + '</div>';
  }
}

async function loadNotes() {
  const el = document.getElementById('notes-list');
  try {
    const res = await fetch('/dashboard/api/notes');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { notes } = await res.json();
    el.innerHTML = notes.length
      ? notes.map((n) => '<li><div class="path">' + esc(n.path) + '</div><div class="excerpt">' + esc(n.excerpt || '(empty)') + '</div></li>').join('')
      : '<li class="loading">No recent notes.</li>';
  } catch (e) {
    el.innerHTML = '<li class="err">Failed to load notes: ' + esc(e.message || e) + '</li>';
  }
}

async function loadSieve() {
  const scriptEl = document.getElementById('sieve-script');
  const copyBtn = document.getElementById('sieve-copy');
  try {
    const res = await fetch('/dashboard/api/mail-sieve');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { script } = await res.json();
    scriptEl.textContent = script;
    scriptEl.classList.remove('loading');
    copyBtn.disabled = false;
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(script);
        copyBtn.textContent = 'Copied!';
      } catch (e) {
        copyBtn.textContent = 'Copy failed';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy script'; }, 1500);
    };
  } catch (e) {
    scriptEl.textContent = 'Failed to load script: ' + (e.message || e);
    scriptEl.classList.add('err');
  }
}

loadMetrics();
loadNotes();
loadSieve();
</script>
</body>
</html>
`;

/** Coarse per-IP backpressure for the API routes (Access already gates identity;
 * this only protects against a slow burst driving KV/GitHub spend). */
async function dashboardRateLimited(request: Request, env: RtEnv): Promise<boolean> {
	return obsRateLimited(request, env);
}

export async function handleDashboardRoutes(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;
	const DASHBOARD_PATHS = new Set(["/dashboard", "/dashboard/api/metrics", "/dashboard/api/notes", "/dashboard/api/mail-sieve"]);
	if (!DASHBOARD_PATHS.has(url.pathname)) return null;

	// Access is the primary gate, but this route serves private vault notes, so it
	// must also fail closed in code: reject unless a valid Access JWT is present,
	// rather than trusting that the Access application in front of it is (still)
	// correctly configured. See access-jwt.ts.
	if (!(await verifyAccessJwt(request, env))) {
		return json({ error: "unauthorized" }, 401);
	}

	if (url.pathname !== "/dashboard" && (await dashboardRateLimited(request, env))) {
		return json({ error: "rate_limited" }, 429);
	}

	if (url.pathname === "/dashboard") {
		return new Response(DASHBOARD_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
	}

	if (url.pathname === "/dashboard/api/metrics") {
		try {
			return json(await metricsSnapshot(env));
		} catch (e) {
			return json({ error: String((e as Error)?.message ?? e) }, 500);
		}
	}

	if (url.pathname === "/dashboard/api/mail-sieve") {
		try {
			return json(compileSieve());
		} catch (e) {
			return json({ error: String((e as Error)?.message ?? e) }, 500);
		}
	}

	// /dashboard/api/notes
	const raw = Number(url.searchParams.get("limit"));
	const limit = Math.min(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NOTES_LIMIT, MAX_NOTES_LIMIT);
	try {
		return json({ notes: await recentNotes(env, limit) });
	} catch (e) {
		return json({ error: String((e as Error)?.message ?? e) }, 500);
	}
}
