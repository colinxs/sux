// Monarch Money paste-door (W7, #1301) — the operator-gated `/monarch/connect` page
// where Colin pastes his Monarch session token so it lands DIRECTLY in sux storage,
// never transiting chat or Claude's context (the browser credential guard correctly
// blocks programmatic extraction; this is the clean alternative). Monarch's own MCP is
// temporarily closed and its copy-paste API keys are enterprise-waitlist-only, so a Pro
// user's browser SESSION token (from app.monarch.com Local Storage) is the supported
// path — a long-lived token that survives long and dies on logout-everywhere or a
// password change. The `monarch` leaf fn (fns/monarch.ts) reads the resulting grant.
//
// Storage mirrors the MyChart grant pattern (src/mychart.ts), NOT a wrangler secret: the
// token is written to KV at RUNTIME by this door, under a private `monarch:` prefix. Like
// mychart's PHI fencing, financial data is as sensitive as PHI — the token never enters
// the generic KV result cache and never a /s/ share handle; the `monarch` fn is
// cacheable:false/raw:true so amounts never cache either. The grant going stale surfaces
// as not_configured (a 401 from Monarch), never a hard error.

import { timingSafeEqual } from "./crypto-util";
import type { RtEnv } from "./registry";
import { safeParseJson } from "./fns/_util";

// Canonical Monarch GraphQL endpoint. api.monarchmoney.com now 301-redirects here (the
// legacy brand); the Local-Storage token the paste-door captures comes from app.monarch.com.
export const MONARCH_API = "https://api.monarch.com/graphql";

// One grant, one KV key (no per-org multiplicity, unlike mychart) under the private
// `monarch:` prefix — never response-cached, never a /s/ handle (finance == PHI-adjacent).
export const MONARCH_GRANT_KEY = "monarch:grant";

export interface MonarchGrant {
	token: string;
	issued_at: number;
}

/** The stored Monarch grant, or null when the paste-door has never run (or KV is unbound). */
export async function readMonarchGrant(env: RtEnv): Promise<MonarchGrant | null> {
	const raw = await env.OAUTH_KV?.get(MONARCH_GRANT_KEY);
	return safeParseJson<MonarchGrant | null>(raw, null);
}

/** Persist a freshly-pasted Monarch token as the grant. Runtime-writable by design. */
export async function writeMonarchGrant(env: RtEnv, token: string): Promise<void> {
	const grant: MonarchGrant = { token, issued_at: Date.now() };
	await env.OAUTH_KV?.put(MONARCH_GRANT_KEY, JSON.stringify(grant));
}

/** Drop the grant (used when a probe proves the pasted token is already dead). */
export async function deleteMonarchGrant(env: RtEnv): Promise<void> {
	await env.OAUTH_KV?.delete(MONARCH_GRANT_KEY).catch(() => {});
}

/** Resolve the Monarch token: the KV grant (the paste-door path, freshest) wins, then the
 * legacy MONARCH_TOKEN wrangler secret for back-compat. null when neither is set → the
 * `monarch` fn returns not_configured (pointing at /monarch/connect). */
export async function monarchToken(env: RtEnv): Promise<string | null> {
	const grant = await readMonarchGrant(env);
	if (grant?.token) return grant.token;
	if (env.MONARCH_TOKEN) return String(env.MONARCH_TOKEN);
	return null;
}

/** Validate a pasted token with ONE cheap read-only probe. Acceptance keys on HTTP status,
 * NOT the GraphQL body: Monarch answers a bad token with HTTP 401 (verified live), while a
 * valid token is 200 even if a probe FIELD is unknown — so this stays robust to schema drift
 * (a 200 means auth passed). 429/5xx are transient, reported without storing. Never logs the
 * token. Respects an explicit Retry-After only implicitly via the caller's messaging. */
export async function probeMonarchToken(token: string): Promise<{ ok: boolean; status: number }> {
	const resp = await fetch(MONARCH_API, {
		method: "POST",
		headers: {
			Authorization: `Token ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
			"Client-Platform": "web", // Monarch rejects requests without a Client-Platform.
		},
		body: JSON.stringify({ query: "query SuxConnectProbe { me { id } }" }),
		signal: AbortSignal.timeout(20_000),
	});
	// Drain the body so the socket is released; the value is irrelevant (auth == status).
	await resp.text().catch(() => "");
	return { ok: resp.status < 400, status: resp.status };
}

const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/** Escape for safe interpolation into a `<script>` string literal AND HTML text. */
function jsString(s: string): string {
	return JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

// The paste form. Self-contained: no external CSS/JS/fonts (CSP-safe). The security boundary
// is the POST (which stores the token) — it is Bearer-gated by SUX_CRON_TOKEN. The GET form
// itself carries no secret, so it renders without the operator Bearer, which is what lets
// Colin open it in a PLAIN browser (a browser can't set an Authorization header on a
// navigation). The operator token reaches the POST one of two ways: embedded here when the
// GET was loaded WITH a Bearer header (curl / a header-capable client), else read at submit
// time from the URL FRAGMENT (`/monarch/connect#<SUX_CRON_TOKEN>`) — a fragment is never sent
// to the server, so it never lands in Cloudflare access logs, and it lets the plain-browser
// flow work with zero extensions.
function connectPage(opToken: string): string {
	return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Connect Monarch</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem;line-height:1.5}
h1{font-size:1.35rem;margin:0 0 .5rem}
p{color:#666}
textarea{width:100%;box-sizing:border-box;min-height:5rem;font-family:ui-monospace,monospace;font-size:.85rem;padding:.6rem;border:1px solid #999;border-radius:.4rem;margin:.5rem 0}
button{font-size:1rem;padding:.55rem 1.2rem;border:0;border-radius:.4rem;background:#2d6cdf;color:#fff;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.hint{font-size:.8rem;color:#888;margin:.4rem 0 0}
#out{margin-top:1rem;font-size:.9rem;white-space:pre-wrap}
.ok{color:#1a7f37}.err{color:#cf222e}
code{background:rgba(128,128,128,.18);padding:.1rem .3rem;border-radius:.25rem}
</style>
<h1>Connect Monarch Money</h1>
<p>Paste your Monarch session token below. It lands directly in sux storage — read-only, and it never touches chat.</p>
<textarea id=tok placeholder="Monarch token" autocomplete=off autocapitalize=off spellcheck=false></textarea>
<div><button id=go>Save token</button></div>
<p class=hint>Grab it from Monarch's web app: DevTools (⌥⌘I) → Application → Local Storage → <code>app.monarch.com</code> → find the auth token value.</p>
<div id=out></div>
<script>
const OP=${jsString(opToken)}||location.hash.replace(/^#/,'');
const out=document.getElementById('out'),go=document.getElementById('go'),tok=document.getElementById('tok');
if(!OP){out.className='err';out.textContent='Missing operator key. Open this page as /monarch/connect#<SUX_CRON_TOKEN> (or send an Authorization: Bearer header).'}
go.onclick=async()=>{
  const token=tok.value.trim();
  if(!token){out.className='err';out.textContent='Paste a token first.';return}
  if(!OP){out.className='err';out.textContent='Missing operator key — add #<SUX_CRON_TOKEN> to the URL and reload.';return}
  go.disabled=true;out.className='';out.textContent='Validating…';
  try{
    const r=await fetch('/monarch/connect',{method:'POST',headers:{'Authorization':'Bearer '+OP,'Content-Type':'application/json'},body:JSON.stringify({token})});
    const j=await r.json().catch(()=>({error:'bad response'}));
    if(r.ok&&j.ok){out.className='ok';out.textContent='✓ '+(j.message||'Saved. You can close this tab.');tok.value=''}
    else{out.className='err';out.textContent='✗ '+(j.error||('HTTP '+r.status))}
  }catch(e){out.className='err';out.textContent='✗ '+e}
  go.disabled=false;
};
</script>`;
}

/** GET/POST /monarch/connect — the operator paste-door (W7, #1301). Served BEFORE the
 * OAuthProvider claims every path (same pre-gate trick as /mychart/connect, /health). The
 * feature is OFF (404) unless the operator gate secret SUX_CRON_TOKEN is set. The security
 * boundary is the POST (which stores the token) — it is Bearer-gated (unset/wrong ⇒ 401). The
 * GET renders the secret-free paste form so it's loadable in a plain browser; when it IS
 * loaded with a valid Bearer header, that token is embedded for the POST, otherwise the page's
 * JS reads it from the URL fragment (`#<SUX_CRON_TOKEN>`, never sent to the server). The token
 * value is never logged. Returns null when the path isn't ours. */
export async function handleMonarchRoutes(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (url.pathname !== "/monarch/connect") return null;

	const gate = env.SUX_CRON_TOKEN;
	if (!gate) return new Response("not found", { status: 404 });
	const authHeader = request.headers.get("authorization") ?? "";
	const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
	const bearerOk = Boolean(presented && timingSafeEqual(gate, presented));

	if (request.method === "GET") {
		// Embed the operator token ONLY when a valid Bearer authenticated the GET (curl / a
		// header-capable client). A plain-browser load has no header → empty embed → the form's
		// JS falls back to the URL fragment. Never echo an INVALID presented token.
		return new Response(connectPage(bearerOk ? presented : ""), { status: 200, headers: PAGE_HEADERS });
	}

	if (request.method === "POST") {
		if (!bearerOk) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
		const body = await request.json().catch(() => null);
		const token = typeof (body as any)?.token === "string" ? (body as any).token.trim() : "";
		if (!token) return new Response(JSON.stringify({ ok: false, error: "No token provided." }), { status: 400, headers: JSON_HEADERS });
		let probe: { ok: boolean; status: number };
		try {
			probe = await probeMonarchToken(token);
		} catch (e) {
			// PHI-adjacent: surface a status-free transport message only — never echo the token.
			return new Response(JSON.stringify({ ok: false, error: `Could not reach Monarch to validate the token: ${String((e as Error)?.message ?? e).slice(0, 120)}` }), { status: 502, headers: JSON_HEADERS });
		}
		if (probe.status === 401 || probe.status === 403) {
			return new Response(JSON.stringify({ ok: false, error: `Monarch rejected the token (HTTP ${probe.status}) — it may be expired, or copied incompletely. Grab a fresh one from app.monarch.com and paste again.` }), { status: 401, headers: JSON_HEADERS });
		}
		if (!probe.ok) {
			return new Response(JSON.stringify({ ok: false, error: `Monarch returned HTTP ${probe.status} while validating — not saved. Try again shortly.` }), { status: 502, headers: JSON_HEADERS });
		}
		await writeMonarchGrant(env, token);
		return new Response(JSON.stringify({ ok: true, message: "Monarch token saved. The `monarch` fn is now read-only-live." }), { status: 200, headers: JSON_HEADERS });
	}

	return new Response("method not allowed", { status: 405 });
}
