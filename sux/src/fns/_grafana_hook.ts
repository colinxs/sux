// POST /hooks/grafana — land Grafana alerts in SuxOS itself, not a placeholder inbox (#1193,
// platform audit .github#636 A1). Grafana's webhook contact point fires this on every alert
// state change; each firing alert gets upserted as one line in a vault note (Meta/Alerts.md) +
// a push notification, keyed/deduped by alertname. A resolved alert removes its line instead of
// leaving a stale "firing" entry behind. Fail-closed: unset GRAFANA_WEBHOOK_TOKEN ⇒ 404 (route
// doesn't exist), a present-but-wrong token ⇒ 401 — never processes an alert without a match.
//
// Served pre-OAuth in index.ts (same class as /hooks/* siblings and /admin/tick): Grafana can't
// do the GitHub-OAuth MCP dance, so its own shared-secret bearer IS the containment here.
import { timingSafeEqual } from "../crypto-util";
import { recordAnalyticsEvent } from "../analytics";
import { type RtEnv } from "../registry";
import { errMsg } from "./_util";
import { obsidian } from "./obsidian";
import { hasWebPush, notify } from "./_webpush";

const ALERTS_NOTE_PATH = "Meta/Alerts.md";
const NOTE_HEADER = "---\ntype: grafana_alerts\ntags: [alerts, grafana]\n---\n\n# Grafana Alerts\n\nAuto-updated by sux's `/hooks/grafana` webhook. Firing alerts are listed below; resolved alerts are removed.\n";

export type GrafanaAlert = {
	status?: string;
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
	valueString?: string;
	startsAt?: string;
};

export type GrafanaWebhookBody = {
	status?: string;
	alerts?: GrafanaAlert[];
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function alertLineMarker(name: string): RegExp {
	return new RegExp(`^- \\*\\*${escapeRegExp(name)}\\*\\*:.*$`, "m");
}

/** Render one alert's markdown line, or return null (nothing to record) when a firing alert
 *  has no usable name — never write an unattributable entry. */
export function renderAlertLine(alert: GrafanaAlert): { name: string; line: string } | null {
	const name = alert.labels?.alertname?.trim();
	if (!name) return null;
	const folder = alert.labels?.grafana_folder ? ` (${alert.labels.grafana_folder})` : "";
	const summary = alert.annotations?.summary || alert.annotations?.description || alert.valueString || "";
	const since = alert.startsAt ? ` — since ${alert.startsAt}` : "";
	return { name, line: `- **${name}**: ${alert.status ?? "firing"}${folder}${summary ? ` — ${summary}` : ""}${since}` };
}

/** Read-modify-write a single alert entry into the alerts note body: upsert the line when
 *  firing, delete it (dedupe by alertname) when resolved. Pure so it's cheaply unit-testable
 *  without a vault round-trip. */
export function upsertAlertEntry(body: string, name: string, line: string | null): string {
	const marker = alertLineMarker(name);
	if (marker.test(body)) {
		const next = line ? body.replace(marker, line) : body.replace(marker, "").replace(/\n{3,}/g, "\n\n");
		return next;
	}
	if (!line) return body; // resolved alert we never recorded — nothing to do
	return `${body.trimEnd()}\n${line}\n`;
}

async function readAlertsNote(env: RtEnv): Promise<string> {
	const r = await obsidian.run(env, { action: "read", path: ALERTS_NOTE_PATH, backend: "git" });
	if (r.isError) return NOTE_HEADER;
	return r.content?.[0]?.text || NOTE_HEADER;
}

async function writeAlertsNote(env: RtEnv, body: string): Promise<{ ok: boolean; error?: string }> {
	const r = await obsidian.run(env, { action: "write", path: ALERTS_NOTE_PATH, content: body, backend: "git" });
	if (r.isError) return { ok: false, error: r.content?.[0]?.text };
	return { ok: true };
}

/** Reject a request whose bearer doesn't match GRAFANA_WEBHOOK_TOKEN — checked via the
 *  Authorization header (Grafana webhook contact points support custom headers) or a `?t=`
 *  query param fallback (some notifier setups can't attach custom headers). */
function tokenMatches(request: Request, url: URL, token: string): boolean {
	const auth = request.headers.get("authorization") ?? "";
	const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
	const presented = bearer || url.searchParams.get("t") || "";
	return Boolean(presented) && timingSafeEqual(token, presented);
}

/** POST /hooks/grafana handler — null for any other path/method so index.ts can chain it with
 *  its other pre-OAuth routes the same way portal.ts/mychart.ts do. */
export async function handleGrafanaWebhook(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (url.pathname !== "/hooks/grafana") return null;
	if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
	const token = env.GRAFANA_WEBHOOK_TOKEN;
	if (!token) return new Response("not found", { status: 404 });
	if (!tokenMatches(request, url, token)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });

	let body: GrafanaWebhookBody;
	try {
		body = (await request.json()) as GrafanaWebhookBody;
	} catch (e) {
		return new Response(JSON.stringify({ error: `invalid JSON: ${errMsg(e)}` }), { status: 400, headers: { "content-type": "application/json" } });
	}
	const alerts = Array.isArray(body.alerts) ? body.alerts : [];

	let note = await readAlertsNote(env);
	let updated = 0;
	const firingToNotify: GrafanaAlert[] = [];
	for (const alert of alerts) {
		const rendered = renderAlertLine(alert);
		if (!rendered) continue;
		const firing = (alert.status ?? "firing").toLowerCase() !== "resolved";
		note = upsertAlertEntry(note, rendered.name, firing ? rendered.line : null);
		updated++;
		if (firing) firingToNotify.push(alert);
	}

	if (updated > 0) {
		const w = await writeAlertsNote(env, note);
		if (!w.ok) return new Response(JSON.stringify({ error: `vault write failed: ${w.error ?? "unknown"}` }), { status: 502, headers: { "content-type": "application/json" } });
	}

	if (hasWebPush(env) && firingToNotify.length > 0) {
		const first = firingToNotify[0];
		const title = firingToNotify.length === 1 ? `Grafana: ${first.labels?.alertname ?? "alert"} firing` : `Grafana: ${firingToNotify.length} alerts firing`;
		const summaryText = first.annotations?.summary || first.annotations?.description || "";
		await notify(env, { title, body: summaryText || (firingToNotify.length === 1 ? "" : firingToNotify.map((a) => a.labels?.alertname).filter(Boolean).join(", ")) }).catch(() => {});
	}

	recordAnalyticsEvent(env, "grafana_alert", { blobs: [body.status ?? null], doubles: [alerts.length, firingToNotify.length] });

	return new Response(JSON.stringify({ ok: true, alerts: alerts.length, updated, firing: firingToNotify.length }), { status: 200, headers: { "content-type": "application/json" } });
}
