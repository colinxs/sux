import type { BrowserWorker } from "@cloudflare/puppeteer";
import { normalizeText } from "./normalize";
import type { TailscaleEnv } from "./proxy";

export type AiBinding = {
	run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
};

export type ImagesBinding = {
	input: (data: ReadableStream | ArrayBuffer | Uint8Array) => {
		transform: (opts: Record<string, unknown>) => any;
		output: (opts: Record<string, unknown>) => Promise<{ response: () => Response }>;
	};
};

export type R2Bucket = {
	put: (key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => Promise<unknown>;
	get: (key: string) => Promise<null | { size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;
	head: (key: string) => Promise<null | { size: number; uploaded?: Date; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>;
	delete: (key: string) => Promise<void>;
	list: (opts?: { prefix?: string; limit?: number; cursor?: string }) => Promise<{ objects: Array<{ key: string; size: number; uploaded?: Date }>; truncated?: boolean; cursor?: string }>;
};

export type RtEnv = Env &
	TailscaleEnv & {
		KAGI_API_KEY: string;
		ALLOWED_GITHUB_LOGIN: string;

		NCBI_API_KEY?: string;

		S2_API_KEY?: string;

		STACKEXCHANGE_KEY?: string;

		COINGECKO_API_KEY?: string;
		R2?: R2Bucket;
		// Workers Analytics Engine dataset (#220) — see wrangler.jsonc's
		// analytics_engine_datasets comment for why this rides AE over Pipelines.
		// AnalyticsEngineDataset is declared ambiently by wrangler's generated
		// worker-configuration.d.ts.
		ANALYTICS?: AnalyticsEngineDataset;

		BRAVE_API_KEY?: string;

		// Facebook Graph API access token (facebook fn). (linkedin fn now scrapes via
		// cf-residential render — Proxycurl shut down July 2025 — so it needs no key.)
		FACEBOOK_TOKEN?: string;
		// Cloudflare Access self-hosted application fronting /dashboard (dashboard.ts).
		// Team domain e.g. 'https://your-team.cloudflareaccess.com'; AUD is the
		// application's Audience tag from the Access dashboard. Both unset = the
		// dashboard route fails closed (401 on everything under /dashboard).
		CF_ACCESS_TEAM_DOMAIN?: string;
		CF_ACCESS_AUD?: string;
		// Git-backed Obsidian vault (obsidian fn): 'owner/repo', branch, optional subfolder.
		OBSIDIAN_VAULT_REPO?: string;
		OBSIDIAN_VAULT_BRANCH?: string;
		OBSIDIAN_VAULT_DIR?: string;
		// Remote Obsidian backend: the Funnel'd Local REST API URL + its bearer key.
		OBSIDIAN_REMOTE_URL?: string;
		OBSIDIAN_REMOTE_KEY?: string;
		// portal.ts: serves an unauthenticated, filtered view of the git vault at
		// /portal (only #portal-tagged / visibility:portal notes) — dormant (404) unless
		// set, since it's a NEW public surface over what's otherwise a private vault.
		PORTAL_ENABLED?: string;
		// Real hostname routed (via a Cloudflare custom domain/route) at this Worker
		// for the portal view — requests to this Host serve /portal's content at
		// root instead of needing the /portal path prefix. Defaults to
		// "portal.suxos.net" when unset; see portal.ts's hostToPortalPath.
		PORTAL_HOST?: string;
		// Dropbox app-folder blob store (dropbox fn + ingest blob routing), all
		// App-folder-scoped (can only see /Apps/<app>/). Durable path: a long-lived
		// REFRESH token + app key/secret → short-lived access tokens minted &
		// KV-cached (fns/dropbox.ts). DROPBOX_TOKEN alone = a short-lived quick test.
		DROPBOX_TOKEN?: string;
		DROPBOX_REFRESH_TOKEN?: string;
		DROPBOX_APP_KEY?: string;
		DROPBOX_APP_SECRET?: string;

		// Full-Dropbox (Mode B) — a SEPARATE full-scope credential for read/search over
		// the WHOLE Dropbox (fns/_dropbox-full.ts), kept distinct from the App-folder
		// token above so Mode A stays the /Apps/<app>/ safety wall. PKCE public client:
		// omit DROPBOX_FULL_APP_SECRET (Worker holds no secret). Absent → Mode B dormant.
		DROPBOX_FULL_REFRESH_TOKEN?: string;
		DROPBOX_FULL_APP_KEY?: string;
		DROPBOX_FULL_APP_SECRET?: string;
		DROPBOX_FULL_TOKEN?: string;
		// Mode B write firewall: comma-separated absolute path prefixes that Mode B
		// mutations (write/delete/move) REFUSE to touch (case-insensitive), e.g. a vault
		// mirror. Empty → no deny-list (the always-on guards — dry-run default, confirm on
		// delete, rev-conditioning, recoverable trash — still apply). See _dropbox-full.ts.
		DROPBOX_FULL_PROTECT_PREFIXES?: string;
		// Mode B WRITE arm — a SEPARATE truthy toggle gating the whole-account MUTATION verbs
		// (write/upload/delete/move/operate/transform full:true), DISTINCT from the read
		// credential above. READ/search light up on DROPBOX_FULL_* alone; WRITE stays dormant
		// until this is explicitly set (unset/"0"/"false"/"off" ⇒ off), so enabling recall's
		// files source can't also arm the injection-reachable whole-account write/delete. An
		// env flag is not injection-settable (unlike the in-request force:true). See _dropbox-full.ts.
		DROPBOX_FULL_WRITE_ENABLED?: string;

		// Self-improvement loop (fns/_self_improve.ts, rides the daily cron). ALL
		// fail-closed, defaults OFF, set via `wrangler secret` (NOT declared in
		// wrangler.jsonc — like DROPBOX_FULL_*). Unset ⇒ the whole loop is dormant.
		//   SELF_IMPROVE_KILL   — a truthy toggle (flagOn) = hard stop, checked before enable.
		//   SELF_IMPROVE_ENABLE — master enable (toggle); unset/"0"/"false"/"off" ⇒ inert.
		//   SELF_IMPROVE_PR     — 'on' (exact) + a GITHUB_TOKEN ⇒ may open PRs; else review-only.
		//                         The loop never merges: it opens a stub PR, labels it
		//                         `self-improve` (NOT auto-merge-eligible), and hands
		//                         authoring to the existing @claude autofix/mention loop.
		//   SELF_IMPROVE_REPO   — 'owner/repo' target (default the sux repo).
		//   SELF_IMPROVE_AUTOMERGE — exact-off by default; when 'on', HIGH-confidence
		//                         fix/refactor/cleanup findings get the `automerge` label (the
		//                         only route that can arm native auto-merge). Inert until the
		//                         security-review/automerge arming prerequisites are also in place.
		SELF_IMPROVE_KILL?: string;
		SELF_IMPROVE_ENABLE?: string;
		SELF_IMPROVE_PR?: string;
		SELF_IMPROVE_REPO?: string;
		SELF_IMPROVE_AUTOMERGE?: string;

		// IANA tz for the vault owner's "today" (daily-note tools). Default Pacific.
		VAULT_TZ?: string;

		// Weekly recall digest (fns/_weekly_recall.ts, rides the daily cron; runs at most
		// once per ISO week). Fail-closed, default OFF, set via `wrangler secret` (NOT
		// declared in wrangler.jsonc — like SELF_IMPROVE_*). Unset ⇒ dormant no-op.
		//   WEEKLY_RECALL_ENABLED   — master enable (toggle); unset/"0"/"false"/"off" ⇒ inert.
		//   WEEKLY_RECALL_QUESTIONS — optional newline/`;`-separated standing questions to run
		//                             through recall (else a built-in default set); capped to
		//                             bound cron cost. recall is READ-only; the only write is a
		//                             vault append to the Weekly note (never pushed/emailed).
		WEEKLY_RECALL_ENABLED?: string;
		WEEKLY_RECALL_QUESTIONS?: string;

		// Vault memory-consolidation sweep (fns/_consolidate.ts, rides the daily cron; runs
		// at most once per ISO week). Fail-closed, default OFF, set via `wrangler secret`
		// (NOT declared in wrangler.jsonc — like WEEKLY_RECALL_*). Unset ⇒ dormant no-op.
		//   CONSOLIDATE_ENABLED     — master enable (toggle); unset/"0"/"false"/"off" ⇒ inert.
		//   CONSOLIDATE_STALE_DAYS  — override the staleness threshold (default 90). Detection
		//                             only: flags stale/duplicate-candidate notes in a vault
		//                             digest append, never merges/deletes/patches anything.
		CONSOLIDATE_ENABLED?: string;
		CONSOLIDATE_STALE_DAYS?: string;

		// Watch-directory cron sweep (fns/_watch_sweep.ts, rides the daily cron) — the
		// proactive half of `watch` (#899): re-checks the sux:watch:index directory (which
		// `watch` itself now maintains, upserted on first_seen/change, pruned on reset:true)
		// instead of requiring a manual re-call. Fail-closed, default OFF, set via
		// `wrangler secret` (NOT declared in wrangler.jsonc — like CONSOLIDATE_*). Unset ⇒
		// dormant no-op. Changed pages feed _agenda.ts's detectWatchDrops the same way
		// consolidate/weekly_recall's findings do.
		//   WATCH_SWEEP_ENABLED — master enable (toggle); unset/"0"/"false"/"off" ⇒ inert.
		//   WATCH_SWEEP_MAX     — optional cap on watches re-checked per tick (bounds
		//                         residential-proxy fetch cost); default 10, clamped [1,50].
		WATCH_SWEEP_ENABLED?: string;
		WATCH_SWEEP_MAX?: string;

		EXA_API_KEY?: string;

		KROGER_CLIENT_ID?: string;
		KROGER_CLIENT_SECRET?: string;

		// Epic SMART-on-FHIR clinical records (mychart fn + /mychart/connect|callback
		// routes, src/mychart.ts). Confidential client: EPIC_CLIENT_ID + EPIC_CLIENT_SECRET
		// provisioned per health system at fhir.epic.com, EPIC_FHIR_BASE = the org's FHIR
		// R4 base URL (the OAuth `aud`). The durable REFRESH token is NOT here — it's
		// minted at /mychart/callback and held in OAUTH_KV (sux:mychart:grant) because
		// Epic rotates it at runtime and the org sets its lifetime. All absent → the fn
		// and routes are inert (not_configured), like monarch/dropbox.
		EPIC_CLIENT_ID?: string;
		EPIC_CLIENT_SECRET?: string;
		EPIC_FHIR_BASE?: string;

		// Apple Health ingest (/apple-health) — the bearer secret Health Auto Export
		// presents in `Authorization: Bearer`. Constant-time checked; unset ⇒ the route
		// 404s (feature off). Set via `wrangler secret`. Raw payloads land under the
		// private R2 phi/ prefix (§5), never dropbox, never a /s/ link.
		HEALTH_INGEST_TOKEN?: string;

		// Outbound Web Push (VAPID, #219) — sux pushing OUT to Colin's devices, distinct
		// from #213's inbound JMAP PushSubscription (Fastmail pushing INTO sux). All
		// absent ⇒ the webpush fn and every cron push hook are inert (not_configured),
		// like monarch/dropbox/mychart. Set via `wrangler secret` — generate a keypair
		// with e.g. `npx web-push generate-vapid-keys` (or any RFC8291-compatible
		// generator); VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are the raw base64url P-256
		// point/scalar it prints. VAPID_SUBJECT is the mailto:/https: contact URL the
		// spec requires in the JWT `sub` claim.
		VAPID_PUBLIC_KEY?: string;
		VAPID_PRIVATE_KEY?: string;
		VAPID_SUBJECT?: string;

		BESTBUY_API_KEY?: string;

		// Reddit app-only OAuth (reddit fn) — client_credentials; read-only API.
		REDDIT_CLIENT_ID?: string;
		REDDIT_CLIENT_SECRET?: string;

		// Tailscale API (tailscale fn) — OAuth client-credentials + tailnet id ("-"
		// = default tailnet for the client). DISTINCT from the TAILSCALE_PROXY_URL/
		// SECRET funnel secrets (in TailscaleEnv): those drive egress; these read the
		// control plane.
		TAILSCALE_OAUTH_CLIENT_ID?: string;
		TAILSCALE_OAUTH_CLIENT_SECRET?: string;
		TAILSCALE_TAILNET?: string;

		CONTROLD_API_TOKEN?: string;

		EBAY_CLIENT_ID?: string;
		EBAY_CLIENT_SECRET?: string;

		// Todoist REST v2 (todoist fn) — a personal API token (Todoist → Settings →
		// Integrations → Developer → API token), used as a Bearer directly. Absent → the
		// fn returns not_configured; nothing about it runs until the token is set.
		TODOIST_TOKEN?: string;

		// Monarch Money GraphQL API (monarch fn) — a personal API token used directly
		// as `Authorization: Token <token>`. NOT OAuth and NOT the email+password+MFA
		// login flow (prohibited to handle): Colin mints it out-of-band — the monarchmoney
		// Python lib's interactive login, or the `Authorization: Token …` request header
		// from app.monarchmoney.com devtools — and sets it as a write-only Worker secret.
		// Absent → the fn returns not_configured; nothing about it runs. READ-ONLY:
		// monarch never moves money (no mutation op; the graphql escape hatch refuses them).
		MONARCH_TOKEN?: string;

		// Fastmail JMAP conduit (jmap fn + /mail/mcp namespace). A JMAP-scoped API
		// token (Fastmail → Settings → Privacy & Security → API tokens), NOT an MCP
		// token. Scope it read-only for read/compose workflows so send/destroy are
		// impossible at the credential layer. accountId/session URL are derived from
		// the Session; the two overrides are escape hatches.
		FASTMAIL_TOKEN?: string;
		FASTMAIL_ACCOUNT_ID?: string;
		FASTMAIL_SESSION_URL?: string;

		// Fastmail calendar + tasks ride CalDAV (JMAP has no jmap:calendars on Fastmail),
		// authenticated by an app-specific password — Settings → Privacy & Security → App
		// passwords, with Calendars/CalDAV access. Both must be set for cal_*/task_*/caldav.
		FASTMAIL_CALDAV_USER?: string;
		FASTMAIL_APP_PASSWORD?: string;

		// Autonomous mail-triage bot (fns/_mail_triage.ts + the daily cron). Two-stage,
		// fail-closed toggle gate — NOT credentials (FASTMAIL_TOKEN is mail-access-in-
		// general, already required, so gating on it would arm the bot the moment mail
		// works). MAIL_TRIAGE_ENABLED must be truthy for the classify→suggest→digest loop
		// to run at all (unset → the fn and the cron tick are a total no-op). MAIL_TRIAGE_ACT
		// must ALSO be truthy before it may perform any REVERSIBLE mailbox move (archive/junk);
		// otherwise it is suggest-only. Both default OFF, so a first deploy is dormant and the
		// first cycle is suggest-only by construction. It never deletes.
		MAIL_TRIAGE_ENABLED?: string;
		MAIL_TRIAGE_ACT?: string;

		// Auto-start the DURABLE, human-approved sibling of mail-triage (fns/mail_triage_plan.ts
		// + op-engine's mail-triage-plan op) on the frequent cron, so the ask-gate + reminder
		// machinery (MAIL_TRIAGE_PLAN_ENABLED's own gate is separate from MAIL_TRIAGE_ENABLED —
		// they can run independently) is actually exercised instead of sitting idle behind a
		// manual `mail_triage_plan` call (#727). Fail-closed: unset ⇒ total no-op. Dedup-guarded
		// by the run index (index.ts's mailTriagePlanTick): starts at most one durable run at a
		// time — a tick is skipped while a prior run is still queued/running/waiting.
		MAIL_TRIAGE_PLAN_ENABLED?: string;

		// Morning-briefing digest (fns/_briefing.ts + the daily cron). Same two-stage,
		// fail-closed toggle gate as MAIL_TRIAGE_* (set via `wrangler secret`, NOT declared in
		// wrangler.jsonc — like MAIL_TRIAGE_*/DROPBOX_FULL_*). BRIEFING_ENABLED must be truthy
		// for the gather→compose→append loop to run at all (unset → the fn and the cron tick are
		// a total no-op). BRIEFING_STAGE_DRAFTS must ALSO be truthy before it STAGES any reply
		// draft to the Drafts folder (mail_draft, send=false — never sent); otherwise it is
		// summarize-and-nudge only. Both default OFF, so a first deploy is dormant and the first
		// cycle stages zero drafts by construction. It never sends, never deletes.
		BRIEFING_ENABLED?: string;
		BRIEFING_STAGE_DRAFTS?: string;
		// Cap on reply drafts staged per briefing run (bounded autonomy). Parsed as an integer,
		// clamped to [1, 20]; unset/invalid ⇒ default 5. Set via `wrangler secret`.
		BRIEFING_MAX_DRAFTS?: string;

		// Agenda loop (fns/_agenda.ts + the daily cron) — the "figure out what to do" engine.
		// Same two-stage fail-closed gate: AGENDA_ENABLED must be truthy for the detect→propose→
		// digest loop to run at all (unset → total no-op). AGENDA_EMAIL must ALSO be truthy before
		// the digest is mailed to Colin's own address (otherwise it's appended to the Daily note
		// only). Both default OFF. Every proposal it records is a REVERSIBLE Todoist add gated
		// behind Colin's approval (the W1 proposal kernel); the loop itself never sends to a third
		// party, never moves/deletes, never auto-approves.
		AGENDA_ENABLED?: string;
		AGENDA_EMAIL?: string;
		// W7 — Monarch financial-signal detector thresholds (fns/_agenda.ts's detectMonarchDrops).
		// Both optional; unset ⇒ sane defaults ($100 / $500). Only ever read, never gates whether
		// the detectors run at all — that's MONARCH_TOKEN (via hasMonarch), same as every other
		// Monarch surface. Read-only: these thresholds only decide what gets PROPOSED, never acted on.
		MONARCH_LOW_BALANCE_THRESHOLD?: string;
		MONARCH_UNUSUAL_CHARGE_THRESHOLD?: string;
		// W7.1 — portfolio-drift + savings-rate detector thresholds (fns/_agenda.ts's
		// detectPortfolioDrops/detectSavingsRateDrop), 0..1 fractions (e.g. "0.35" = 35%). All
		// optional; unset ⇒ sane defaults (35% concentration, 10pt drift, 15pt savings-rate drop).
		// Same read-only/proposal-only contract as the W7 thresholds above.
		MONARCH_PORTFOLIO_CONCENTRATION_THRESHOLD?: string;
		MONARCH_PORTFOLIO_DRIFT_THRESHOLD?: string;
		MONARCH_SAVINGS_RATE_DROP_THRESHOLD?: string;

		// Ask-gate reminder (fns/_ask_gate_reminder.ts) — proactively surfaces durable
		// `run` instances paused on a human `ask` gate (op-engine) instead of relying on
		// someone remembering to poll `run {action:'list'}`. Rides the FREQUENT cron (same
		// one mail_triage/metrics use), not the daily one, since an unanswered gate fails
		// closed at 24h. Same two-stage fail-closed gate as AGENDA_*/BRIEFING_*: unset
		// ASK_GATE_REMINDER_ENABLED ⇒ total no-op. ASK_GATE_REMINDER_EMAIL additionally
		// mails the digest to the vault owner's own address (else vault-append only).
		// ASK_GATE_REMINDER_AFTER_MINUTES / _COOLDOWN_MINUTES override the default 30min
		// "worth mentioning" age and 360min (6h) per-instance re-notify cooldown. It only
		// ever READS the durable-run index + a gate's static prompt text and WRITES a
		// vault append (+ optional self-mail) describing the pending gate and the exact
		// `run {action:'answer', ...}` call to unblock it — it never answers a gate itself.
		ASK_GATE_REMINDER_ENABLED?: string;
		ASK_GATE_REMINDER_EMAIL?: string;
		ASK_GATE_REMINDER_AFTER_MINUTES?: string;
		ASK_GATE_REMINDER_COOLDOWN_MINUTES?: string;

		// Learning-folder reconciliation (fns/_learning_folder.ts + the daily cron, #433) —
		// sweeps a Dropbox app-folder subfolder for PDFs not yet whitelisted in the oracle
		// and studies them. Same fail-closed gate as AGENDA_*/BRIEFING_*: unset
		// LEARNING_FOLDER_ENABLED ⇒ total no-op (also requires hasDropbox). Path/topic
		// default to /learning and "learning" when unset.
		LEARNING_FOLDER_ENABLED?: string;
		LEARNING_FOLDER_PATH?: string;
		LEARNING_FOLDER_TOPIC?: string;

		// Manual ops trigger for the daily cron ticks (POST /admin/tick?job=…), bearer-gated
		// by this token. Unset ⇒ the endpoint 404s (feature off). Lets an operator run a
		// mail-triage / self-improve / maintenance cycle on demand instead of waiting for cron.
		SUX_CRON_TOKEN?: string;

		// Raw-bytes upload door (POST /s/up), bearer-gated by this token. Unset ⇒ 404 (feature
		// off). The write-twin of the public GET /s/<uuid> read route: a local shell curls a
		// file's bytes straight into R2 (never through the model context) and gets back a
		// /s/<uuid> ref that mail_send / files_upload / ingest already consume — the on-ramp
		// that closes the "can't attach a session-local binary without inline base64" gap.
		// Dedicated (not reusing SUX_CRON_TOKEN) so a leak is bounded to blob-upload and
		// rotates independently. Same egress class as store_put (mints a world-readable URL),
		// so the token IS the containment.
		SUX_UPLOAD_TOKEN?: string;

		// Recovery dead-drop (src/recovery.ts) — the out-of-band control channel the home
		// router (owl-tegu) phones home to when it's unreachable inbound. All fail-closed,
		// default OFF, set via `wrangler secret` (NOT declared in wrangler.jsonc — like
		// SUX_CRON_TOKEN). Unset RECOVERY_HMAC_SECRET ⇒ every /recovery/* route 404s.
		//   RECOVERY_HMAC_SECRET  — shared box↔Worker secret; authenticates the box's checkin
		//                           (HMAC-SHA256 over the raw POST body) AND is the fallback
		//                           signer for commands handed back. Master gate: unset ⇒ off.
		//   RECOVERY_CMD_SECRET   — optional SEPARATE secret for signing the commands the box
		//                           executes, so the checkin-auth secret and the command-auth
		//                           secret can be rotated independently. Unset ⇒ reuse HMAC secret.
		//   RECOVERY_ADMIN_SECRET — bearer that gates the operator enqueue + status-read routes
		//                           (POST /recovery/enqueue, GET /recovery/status). Unset ⇒ those
		//                           two routes 404 while checkin still works (box can poll, nobody
		//                           can queue commands until it's set).
		RECOVERY_HMAC_SECRET?: string;
		RECOVERY_CMD_SECRET?: string;
		RECOVERY_ADMIN_SECRET?: string;

		// Life-learning living wiki (fns/_life_wiki.ts + the daily cron). A single fail-closed
		// toggle var (NOT a credential — the vault/AI creds gate what can be gathered; this arms
		// the autonomous synthesis). Declared in wrangler.jsonc vars, default "0" = OFF: unset or
		// falsy ("0"/"false"/"off"/empty) ⇒ the fn and the cron tick are a total no-op, reading
		// nothing and writing nothing. When truthy it regenerates a two-audience wiki ONLY inside
		// the sandboxed vault subdir (sux/wiki/), non-destructive by construction — never touches
		// the user's own notes. Flip to "1" to arm; the sandbox subdir is deletable with zero impact.
		LIFE_WIKI_ENABLED?: string;


		TAVILY_API_KEY?: string;


		GOOGLE_MAPS_KEY?: string;


		YOUTUBE_API_KEY?: string;
		AI?: AiBinding;
		IMAGES?: ImagesBinding;

		BROWSER?: BrowserWorker;

		// Override the stealth UA's Chrome major (cf-render). Bump as Chrome's stable
		// channel advances so the UA stays coherent with the real current major without
		// a redeploy; unset → cf-render's tracked default.
		STEALTH_CHROME_MAJOR?: string;

		// Standalone Mac-local iMessage service (chat.db read + AppleScript send) —
		// its own launchd process/plist (sux/imessage-service/), unrelated to the
		// now-removed mac-render tier (#742 dropped mac-render entirely in favor of
		// cf-residential render; iMessage never rode that server). Same Funnel+HMAC
		// transport shape mac-render used, fail-closed identically: unset → the
		// `imessage` fn reports not_configured rather than erroring.
		IMESSAGE_URL?: string;
		IMESSAGE_SECRET?: string;

		// UW Person Web Service (PWS) mutual-TLS tier for the `uw` fn. An
		// `mtls_certificates` binding (a Fetcher that presents the client cert) to
		// ws.admin.washington.edu — grants the richer, student-inclusive record that
		// the public directory.uw.edu scrape can't reach. Fail-closed like the render
		// pairs: absent → `uw` serves the faculty/staff scrape only, never erroring.
		// "Cert set" = this binding exists (declared in wrangler mtls_certificates).
		UW_PWS_CERT?: Fetcher;

		// Paid residential "web unlocker" (Bright Data / Zyte / Oxylabs) — the fallback
		// rung of the retail ladder (homedepot/costco) after cf (primary) fails. Optional
		// pair, fail-closed: unset → the rung no-ops. See sux/src/unlocker-render.ts.
		UNLOCKER_API_URL?: string;
		UNLOCKER_API_KEY?: string;

		// Grafana Cloud Loki push (observability). All three required to ship logs;
		// absent → sux emits metrics locally only. See sux/src/grafana.ts.
		GRAFANA_LOKI_URL?: string;
		GRAFANA_LOKI_USER?: string;
		GRAFANA_LOKI_TOKEN?: string;

		// Grafana Cloud Prometheus push (metrics snapshot) — the cron ships the KV-backed
		// counters + /health/SLO gauges here as Influx line protocol. Both required to arm;
		// the shared Grafana token is reused (scope it +metrics:write). Absent → the snapshot
		// push is a pure no-op. See shipMetricsSnapshot in sux/src/grafana.ts.
		GRAFANA_PROM_URL?: string;
		GRAFANA_PROM_USER?: string;

		MCP_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
		// Coarse per-IP limiter for the anonymous observability/content routes
		// (/metrics, /logs, /feedback, /s/*), which the MCP gate never touches.
		OBS_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
	};

/**
 * Machine-readable failure taxonomy. A small fixed set so callers and Grafana can
 * group failures by cause instead of parsing free-text. Every code maps to a
 * distinct operator/caller action:
 *   not_configured — a required key/binding is absent (fix config)
 *   blocked        — upstream refused us (bot wall / challenge / access denied)
 *   timeout        — upstream/render did not respond in time
 *   rate_limited   — upstream throttled us (429 / quota)
 *   not_found      — the requested resource does not exist
 *   upstream_error — upstream errored, no more precise attribution
 *   bad_input      — the caller's args are invalid (bad url, missing field, SSRF target)
 *   layout_change  — we fetched fine but the page/response shape no longer parses
 *   conflict       — an If-Match/etag guard was rejected (412) — the object changed
 *                     since it was read; refetch and retry, don't blind-retry the same write
 */
export const FAIL_CODES = ["not_configured", "blocked", "timeout", "rate_limited", "not_found", "upstream_error", "bad_input", "layout_change", "conflict"] as const;
export type FailCode = (typeof FAIL_CODES)[number];

// NOTE on MCP Apps (SEP-1865) content: the base ToolResult.content type stays
// `{ type:"text"; text:string }` — the shape every existing call site already
// narrows on without a `.type` check (`content[0].text`). Widening it to a
// discriminated union here would force a `.type === "text"` guard onto every
// one of those call sites across the repo, which is exactly the large,
// speculative blast radius this pilot is meant to avoid. Instead the one
// UI-resource content part (`{ type:"resource", resource:{...} }`, the MCP
// base-spec embedded-resource shape) is appended by `fns/_ui.ts`'s
// `withUiResource`, which owns the (locally contained) cast — see that file
// for the wire format and rationale.
export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; noCache?: boolean; errorCode?: FailCode };
export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * A fail() carrying a machine-readable code from FAIL_CODES. The code is prefixed
 * to the human text as `[code]` — so it flows into the Grafana `err` field (index.ts
 * derives `err` from the first text part) and stays visible to callers — AND is
 * attached as a structured `errorCode` on the ToolResult for typed consumers. The
 * human message is preserved verbatim after the prefix. Never used on a success path.
 */
export const failWith = (code: FailCode, text: string): ToolResult => ({ content: [{ type: "text", text: `[${code}] ${text}` }], isError: true, errorCode: code });

/**
 * MCP tool behavior hints (2025-06-18 tool `annotations`). All optional, all
 * advisory — a client MAY use them to schedule/guard, but MUST NOT trust them for
 * security (a server can lie). We emit them so a client can act without prose:
 *   readOnlyHint    — the tool does not modify its environment (safe to run/retry,
 *                     and Claude Code dispatches read-only tools concurrently).
 *   destructiveHint — only meaningful when readOnly is false: the update may be
 *                     destructive (overwrite/delete), so drive a confirm prompt.
 *   idempotentHint  — only meaningful when readOnly is false: repeating the call
 *                     with the same args has no additional effect.
 *   openWorldHint   — the tool reaches external entities (the live web / third-party
 *                     APIs), so results are non-deterministic and network-dependent.
 */
export type ToolAnnotations = {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

export type Fn = {
	name: string;
	description: string;
	inputSchema: unknown;

	cacheable?: boolean;

	cost?: number;

	ttl?: number;

	raw?: boolean;

	// Which advertised surface this fn belongs to: "front" = one of the ~10 root
	// verbs meant to be the primary tools/list surface; "leaf" = a specific
	// capability reached directly or via the `sux` capability map. Unset = leaf by
	// default. Dormant metadata for now — the front-door PR is what actually hides
	// leaves; here it only rides on the tool so that later pass has it to filter on.
	surface?: "front" | "leaf";

	// Per-fn override for the MCP tool annotations emitted by toolList. When unset,
	// toolList falls back to the central TOOL_ANNOTATIONS map (keyed by name), so a
	// fn can either self-declare here or be tagged in one place — whichever reads
	// better at the fn's own site.
	annotations?: ToolAnnotations;

	// Tool-definition `_meta`, advertised verbatim on the tools/list entry (MCP
	// base spec: an implementation-specific bag on any tool/resource/prompt).
	// The one live consumer is the MCP Apps extension's `_meta.ui.resourceUri`
	// (see `fns/_ui.ts`'s `uiMeta`), naming which `ui://` template this fn's
	// result renders into — but the field is generic, not apps-specific.
	meta?: Record<string, unknown>;

	run: (env: RtEnv, args: any) => Promise<ToolResult>;
};

// Central behavior-hint map, keyed by fn name. A fn's own `annotations` field wins;
// this is the default tagging so the obvious buckets are declared in one auditable
// place instead of sprinkled across ~95 files. Only the clearly-classifiable fns are
// listed — a mixed read/write namespace tool (jmap/obsidian/todoist) or an ambiguous
// one stays unannotated rather than claim a hint it can't honor.
const READ_WEB: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const READ_LOCAL: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE_DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
	// Read-only + reaches the live web / third-party APIs (search, fetch, scrape,
	// research DBs, retail lookups, geo/people/crypto/media reads, recall/oracle).
	...Object.fromEntries(
		[
			"search", "web_search", "tavily", "scrape", "render", "proxy", "batch_fetch", "crawl",
			"wayback", "redirects", "robots", "sitemap", "feed", "subtitles",
			"arxiv", "pubmed", "openalex", "crossref", "semantic_scholar", "clinical_trials", "stackexchange", "reddit", "citation", "find_similar",
			"shop", "product_search", "amazon", "walmart", "costco", "homedepot", "lowes", "kroger", "bestbuy", "ebay", "ace", "weekly_ad",
			"places", "people", "people_finder", "coingecko", "youtube", "watch", "linkedin", "facebook",
			"recall", "oracle",
		].map((n) => [n, READ_WEB]),
	),
	// Read-only + purely local: parse/extract over provided input, AI text transforms,
	// format converters, and the read side of KV. No environment mutation, no network.
	...Object.fromEntries(
		[
			"extract", "readability", "tables", "metadata", "extract_contacts", "entities", "select", "grep",
			"summarize", "translate", "classify", "redact", "ocr",
			"markdown", "html", "csv", "json", "xml", "yaml", "encode", "hash", "compress", "archive", "pack", "declutter", "fontcase",
			"kv_get", "kv_list",
		].map((n) => [n, READ_LOCAL]),
	),
	// Mutating: content stores + capture. Marked destructive so a client drives a
	// confirm prompt (store/dropbox/kv_delete can remove data; kv_put overwrites;
	// ingest writes new notes/blobs into the vault).
	...Object.fromEntries(["store", "ingest", "dropbox", "kv_put", "kv_delete"].map((n) => [n, WRITE_DESTRUCTIVE])),
};

export function toolList(
	fns: Fn[],
): Array<{ name: string; description: string; inputSchema: unknown; annotations?: ToolAnnotations; _meta?: Record<string, unknown> }> {
	return fns.map((f) => {
		const annotations = f.annotations ?? TOOL_ANNOTATIONS[f.name];
		const base: { name: string; description: string; inputSchema: unknown; annotations?: ToolAnnotations; _meta?: Record<string, unknown> } = {
			name: f.name,
			description: f.description,
			inputSchema: f.inputSchema,
		};
		if (annotations) base.annotations = annotations;
		if (f.meta) base._meta = f.meta;
		return base;
	});
}

// The FRONT DOOR — the curated root verbs that tools/list actually advertises.
// Everything else is a leaf: still fully dispatchable (by its own name, or via the
// `fn` escape), still described by the `sux` map, just not flooding the list. This
// keeps the advertised surface mobile-legible (~18 tools) without removing any
// capability. The single source of truth for "what's a front verb" — a fn may also
// self-declare `surface:"front"`, and either inclusion path counts.
//   sux — the capability map    · fn — call any leaf by name
//   search/scrape — web in      · shop — retail fan-out
//   ingest/recall/oracle — memory in, cited answers out
//   pipe/batch — compose leaves server-side · run — durable op runtime
//   store — blob storage        · preferences/issue — tell sux what you want / what broke
//   vault/mail/files/calendar/contact — the personal-data namespaces, dispatched into the
//     existing VAULT_TOOLS/MAIL_TOOLS/FILES_TOOLS handlers so the whole digital-life
//     spine is reachable on the ONE /mcp connector (every surface, incl. mobile). The
//     old per-namespace /<ns>/mcp connectors are retired: front verbs are how you reach
//     them now (their routes stay dormant for back-compat).
export const FRONT_VERBS = new Set<string>([
	"sux", "fn",
	"search", "scrape", "shop",
	"ingest", "recall", "oracle",
	"pipe", "batch", "run",
	"store", "preferences", "issue", "proposals", "agenda",
	"vault", "mail", "files", "calendar", "contact",
]);

/** True when a fn belongs on the advertised front-door surface. */
export function isFrontVerb(f: Fn): boolean {
	return f.surface === "front" || FRONT_VERBS.has(f.name);
}

/**
 * The tool list the MCP `tools/list` actually returns: only the front verbs. Leaves
 * stay reachable (direct dispatch by name, or `fn({name,args})`) and discoverable
 * (the `sux` map), so nothing is lost — the surface is just legible. Preserves the
 * importance ordering of the input.
 */
export function frontToolList(
	fns: Fn[],
): Array<{ name: string; description: string; inputSchema: unknown; annotations?: ToolAnnotations; _meta?: Record<string, unknown> }> {
	return toolList(fns.filter(isFrontVerb));
}

export function findFn(fns: Fn[], name: string): Fn | undefined {
	return fns.find((f) => f.name === name);
}

/**
 * Centrally enforce a leaf's own declared `inputSchema` — just `required` +
 * `additionalProperties`, the two checks every fn's schema already promises but
 * left to hand-rolled per-fn guards (or, as with `hash`, no guard at all: a wrong
 * param name silently fell back to a default instead of erroring — see #538).
 * Only fires for an object-typed schema; anything else (rare) is left alone.
 * Not a full JSON-Schema validator (no `type`/`enum`/nested checks) — deliberately
 * narrow so it can't reject an input some fn's own body already handles fine.
 */
export function validateInputSchema(schema: unknown, args: unknown): string | null {
	if (!schema || typeof schema !== "object") return null;
	const s = schema as { type?: string; required?: unknown; additionalProperties?: unknown; properties?: unknown };
	if (s.type !== "object") return null;
	const a: Record<string, unknown> = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	if (Array.isArray(s.required)) {
		const missing = s.required.filter((k): k is string => typeof k === "string" && a[k] === undefined);
		if (missing.length) return `missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`;
	}
	if (s.additionalProperties === false && s.properties && typeof s.properties === "object") {
		const allowed = new Set(Object.keys(s.properties as Record<string, unknown>));
		const extra = Object.keys(a).filter((k) => !allowed.has(k));
		if (extra.length) return `unexpected propert${extra.length > 1 ? "ies" : "y"}: ${extra.join(", ")}`;
	}
	return null;
}

/**
 * Resolve an `fn` escape call to the real leaf it targets. Returns `{name, args}`
 * of the underlying leaf when `params` is `fn({name, args})` and the inner name
 * resolves to a registered leaf (not `fn` itself); returns null otherwise (a direct
 * call, or an `fn` call with a missing/unknown/self inner name — which the `fn` fn's
 * own run then answers with a typed error).
 *
 * The SINGLE source of the unwrap rule, shared by the dispatcher (so a leaf reached
 * via `fn` runs byte-identically to a direct call) and the weighted rate limiter (so
 * an expensive leaf can't dodge its `cost` by hiding behind `fn`).
 */
export function unwrapFnCall(params: { name?: string; arguments?: unknown } | undefined, fns: Fn[]): { name: string; args: Record<string, unknown> } | null {
	if (params?.name !== "fn") return null;
	const a = params.arguments;
	if (!a || typeof a !== "object" || Array.isArray(a)) return null;
	const inner = (a as Record<string, unknown>).name;
	// Resolve the inner name against the SAME normalization the dispatcher applies to
	// every string arg (fullwidth/styled-Latin fold + zero-width/control strip). If we
	// matched the raw string, `fn({name:"ｒｅｎｄｅｒ"})` (fullwidth) or a zero-width-spaced
	// name would fail to resolve HERE — so the limiter charges the cheap `fn` cost — yet
	// normalizeArgs would later fold it to a real leaf and fnEscape.run would execute it:
	// a weighted-cost + cache bypass. Normalizing here keeps both resolution sites (this
	// and fn.ts) in lockstep with the dispatcher, so raw-resolvable == effective.
	const innerName = typeof inner === "string" ? normalizeText(inner).trim() : "";
	if (!innerName || innerName === "fn" || !findFn(fns, innerName)) return null;
	const innerArgs = (a as Record<string, unknown>).args;
	return { name: innerName, args: innerArgs && typeof innerArgs === "object" && !Array.isArray(innerArgs) ? (innerArgs as Record<string, unknown>) : {} };
}
