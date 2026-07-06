import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { fetchGitHubUser, fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, isAllowedLogin, type Props } from "./utils";
import {
	addApprovedClient,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
} from "./workers-oauth-utils";
import { hmacHex, isTailscaleConfigured, proxyEnabled, smartFetch, type TailscaleEnv } from "./proxy";

type HandlerEnv = Env &
	TailscaleEnv & { OAUTH_PROVIDER: OAuthHelpers } & {
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
		ALLOWED_GITHUB_LOGIN?: string;
		KAGI_API_KEY?: string;
	};

const text = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const GitHubHandler = {
	async fetch(request: Request, env: HandlerEnv): Promise<Response> {
		const url = new URL(request.url);
		const p = url.pathname;
		const m = request.method;
		if (m === "GET" && p === "/health") return handleHealth(url, env);
		if (m === "GET" && p === "/authorize") return handleAuthorizeGet(request, env);
		if (m === "POST" && p === "/authorize") return handleAuthorizePost(request, env);
		if (m === "GET" && p === "/callback") return handleCallback(request, url, env);
		return text("Not found", 404);
	},
};

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** Race a promise against a timeout; resolve to `fallback` if it's too slow. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/** IP + geo of whoever makes the request — residential (via proxy) vs datacenter (direct) egress.
 * Uses Cloudflare's cdn-cgi/trace (reliable from Workers) for the IP, enriched best-effort with geo. */
async function ipInfo(fetcher: (u: string) => Promise<Response>): Promise<Record<string, unknown> | null> {
	let ip: string | undefined, country: string | undefined, colo: string | undefined;
	try {
		const t = await (await fetcher("https://cloudflare.com/cdn-cgi/trace")).text();
		const m: Record<string, string> = Object.fromEntries(t.trim().split("\n").map((l) => l.split("=") as [string, string]));
		ip = m.ip;
		country = m.loc;
		colo = m.colo;
	} catch {
		return null;
	}
	if (!ip) return null;
	let city: string | undefined, region: string | undefined, org: string | undefined;
	try {
		const g = (await (await fetcher(`https://ipwho.is/${ip}`)).json()) as any;
		if (g?.success !== false) {
			city = g.city;
			region = g.region;
			org = g.connection?.org ?? g.connection?.isp;
			country = g.country ?? country;
		}
	} catch {
		// geo enrichment is optional — IP + country + colo already came from trace
	}
	return { ip, city, region, country, colo, org };
}

/** Best-effort `tailscale status --json` from the node's /status endpoint (HMAC-signed, same secret as /fetch). */
async function nodeStatus(env: HandlerEnv): Promise<Record<string, unknown>> {
	if (!isTailscaleConfigured(env)) return { available: false, reason: "proxy not configured" };
	try {
		const ts = String(Date.now());
		const sig = await hmacHex(env.TAILSCALE_PROXY_SECRET!, `${ts}\n/status`);
		const endpoint = new URL("/status", env.TAILSCALE_PROXY_URL).href;
		const r = await fetch(endpoint, { headers: { "x-timestamp": ts, "x-signature": sig }, signal: AbortSignal.timeout(8000) });
		if (!r.ok) return { available: false, reason: `node /status returned HTTP ${r.status} (add the /status endpoint to the node)` };
		const j = (await r.json()) as any;
		const peers = j.Peer ? Object.values(j.Peer) : [];
		return {
			available: true,
			backendState: j.BackendState,
			version: j.Version,
			hostname: j.Self?.HostName,
			tailscaleIPs: j.Self?.TailscaleIPs,
			online: j.Self?.Online,
			exitNode: j.ExitNodeStatus?.ID ?? null,
			peers: peers.length,
			peersOnline: peers.filter((p: any) => p?.Online).length,
		};
	} catch (e) {
		return { available: false, reason: String((e as Error).message ?? e) };
	}
}

async function gatherHealth(env: HandlerEnv): Promise<Record<string, unknown>> {
	const config = {
		kagiKey: Boolean(env.KAGI_API_KEY),
		allowlist: Boolean(env.ALLOWED_GITHUB_LOGIN?.trim()),
		githubClient: Boolean(env.GITHUB_CLIENT_ID),
	};

	// Residential (through the proxy) vs datacenter (direct) egress + tunnel latency.
	const t0 = Date.now();
	const [proxied, direct, status] = await Promise.all([
		withTimeout(ipInfo((u) => smartFetch(env, u, {})), 9000, null),
		withTimeout(ipInfo((u) => fetch(u)), 9000, null),
		withTimeout(nodeStatus(env), 9000, { available: false, reason: "timeout" } as Record<string, unknown>),
	]);
	const tunnelMs = Date.now() - t0;

	const configured = isTailscaleConfigured(env);
	let proxyUrlValid = false;
	try {
		proxyUrlValid = Boolean(env.TAILSCALE_PROXY_URL && /^https?:/i.test(env.TAILSCALE_PROXY_URL) && new URL(env.TAILSCALE_PROXY_URL));
	} catch {
		proxyUrlValid = false;
	}
	const routing = configured && proxyEnabled(env) && proxied && direct && proxied.ip !== direct.ip;

	const tailscale = {
		configured,
		proxy_url_valid: proxyUrlValid, // false = TAILSCALE_PROXY_URL is malformed (needs an absolute https:// URL)
		routing, // true = requests are actually exiting via the residential IP (not falling back to direct)
		tunnel_ms: tunnelMs,
		residential: proxied,
		datacenter: direct,
		node: status,
	};

	// Kagi upstream reachability.
	let upstream: Record<string, unknown>;
	try {
		const r = await withTimeout(
			fetch("https://mcp.kagi.com/mcp", {
				method: "POST",
				headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${env.KAGI_API_KEY ?? ""}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health", version: "1" } } }),
			}),
			8000,
			null as unknown as Response,
		);
		upstream = { reachable: Boolean(r?.ok), status: r?.status ?? 0 };
	} catch {
		upstream = { reachable: false, status: 0 };
	}

	const ok = config.kagiKey && config.githubClient && upstream.reachable;
	return { status: ok ? "ok" : "degraded", config, tailscale, upstream };
}

function renderHealthHtml(h: any): string {
	const dot = (v: boolean) => `<span class="dot ${v ? "on" : "off"}"></span>`;
	const ts = h.tailscale ?? {};
	const res = ts.residential;
	const dc = ts.datacenter;
	const node = ts.node ?? {};
	const loc = (o: any) => (o ? `${[o.city, o.region, o.country].filter(Boolean).join(", ") || "?"}${o.colo ? " · " + o.colo : ""}` : "—");
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sux · health</title>
<style>
 :root{color-scheme:dark light}
 body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:720px;margin:2rem auto;padding:0 1rem;background:#0b0e14;color:#c9d1d9}
 h1{font-size:1.3rem;margin:0 0 .2rem} .sub{color:#6e7681;margin-bottom:1.5rem}
 .card{background:#11161f;border:1px solid #21262d;border-radius:10px;padding:1rem 1.2rem;margin:0 0 1rem}
 .card h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin:0 0 .8rem}
 .row{display:flex;justify-content:space-between;gap:1rem;padding:.25rem 0;border-bottom:1px solid #1b212b}
 .row:last-child{border:0} .k{color:#8b949e} .v{text-align:right;word-break:break-word}
 .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:.4rem;vertical-align:middle}
 .dot.on{background:#3fb950;box-shadow:0 0 6px #3fb95088} .dot.off{background:#f85149}
 .pill{font-size:.7rem;padding:.1rem .5rem;border-radius:99px;border:1px solid #30363d;color:#8b949e}
 .big{font-size:1.1rem} a{color:#58a6ff}
</style>
<h1>${dot(h.status === "ok")} sux · <span class="pill">${h.status}</span></h1>
<div class="sub">residential-proxied edge engine · <a href="?format=json">json</a></div>

<div class="card"><h2>config</h2>
 <div class="row"><span class="k">Kagi API key</span><span class="v">${dot(h.config.kagiKey)}</span></div>
 <div class="row"><span class="k">GitHub OAuth</span><span class="v">${dot(h.config.githubClient)}</span></div>
 <div class="row"><span class="k">Login allowlist</span><span class="v">${dot(h.config.allowlist)}</span></div>
 <div class="row"><span class="k">Kagi upstream</span><span class="v">${dot(h.upstream.reachable)} ${h.upstream.status}</span></div>
</div>

<div class="card"><h2>tailscale · residential egress</h2>
 <div class="row"><span class="k">Proxy configured</span><span class="v">${dot(ts.configured)}</span></div>
 <div class="row"><span class="k">Proxy URL valid</span><span class="v">${dot(ts.proxy_url_valid)}${ts.configured && !ts.proxy_url_valid ? ' <span class="k">needs https:// scheme</span>' : ""}</span></div>
 <div class="row"><span class="k">Routing residentially</span><span class="v">${dot(ts.routing)} ${ts.routing ? "live" : "falling back to direct"}</span></div>
 <div class="row"><span class="k">Tunnel round-trip</span><span class="v">${ts.tunnel_ms} ms</span></div>
 <div class="row"><span class="k">Residential exit (wrapped)</span><span class="v big">${res ? res.ip : "—"}<br><span class="k">${loc(res)}${res?.org ? " · " + res.org : ""}</span></span></div>
 <div class="row"><span class="k">Datacenter exit (bare)</span><span class="v">${dc ? dc.ip : "—"}<br><span class="k">${loc(dc)}${dc?.org ? " · " + dc.org : ""}</span></span></div>
</div>

<div class="card"><h2>tailscale · node <code>tailscaled status</code></h2>
 ${
		node.available
			? `<div class="row"><span class="k">Backend</span><span class="v">${dot(node.backendState === "Running")} ${node.backendState}</span></div>
 <div class="row"><span class="k">Hostname</span><span class="v">${node.hostname ?? "—"}</span></div>
 <div class="row"><span class="k">Tailscale IPs</span><span class="v">${(node.tailscaleIPs ?? []).join(", ") || "—"}</span></div>
 <div class="row"><span class="k">Online</span><span class="v">${dot(Boolean(node.online))}</span></div>
 <div class="row"><span class="k">Peers</span><span class="v">${node.peersOnline}/${node.peers} online</span></div>
 <div class="row"><span class="k">Version</span><span class="v">${node.version ?? "—"}</span></div>`
			: `<div class="row"><span class="k">Status</span><span class="v">unavailable</span></div>
 <div class="row"><span class="k">Reason</span><span class="v">${node.reason ?? "—"}</span></div>`
	}
</div>`;
}

async function handleHealth(url: URL, env: HandlerEnv): Promise<Response> {
	const h = await gatherHealth(env);
	if (url.searchParams.get("format") === "json") return json(h, h.status === "ok" ? 200 : 503);
	return html(renderHealthHtml(h), h.status === "ok" ? 200 : 503);
}

async function handleAuthorizeGet(request: Request, env: HandlerEnv): Promise<Response> {
	const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	const { clientId } = oauthReqInfo;
	if (!clientId) return text("Invalid request", 400);

	if (await isClientApproved(request, clientId, env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
		return redirectToGithub(request, env, stateToken);
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(request, {
		client: await env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description:
				"Private bridge that lets your Claude connector reach the Kagi MCP server. Sign in with the authorized GitHub account to continue.",
			logo: "https://assets.kagi.com/v2/assets/img/logo_dark.png",
			name: "Kagi MCP (private bridge)",
		},
		setCookie,
		state: { oauthReqInfo },
	});
}

async function handleAuthorizePost(request: Request, env: HandlerEnv): Promise<Response> {
	try {
		const formData = await request.formData();

		validateCSRFToken(formData, request);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return text("Invalid request", 400);
		}

		const approvedClientCookie = await addApprovedClient(
			request,
			state.oauthReqInfo.clientId,
			env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, env.OAUTH_KV);

		return redirectToGithub(request, env, stateToken, { "Set-Cookie": approvedClientCookie });
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) return error.toResponse();
		return text(`Internal server error: ${error.message}`, 500);
	}
}

function redirectToGithub(
	request: Request,
	env: HandlerEnv,
	stateToken: string,
	headers: Record<string, string> = {},
): Response {
	return new Response(null, {
		status: 302,
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				client_id: env.GITHUB_CLIENT_ID,
				redirect_uri: new URL("/callback", request.url).href,
				scope: "read:user",
				state: stateToken,
				upstream_url: "https://github.com/login/oauth/authorize",
			}),
		},
	});
}

async function handleCallback(request: Request, url: URL, env: HandlerEnv): Promise<Response> {
	const stateFromQuery = url.searchParams.get("state");
	if (!stateFromQuery) return text("Missing state parameter", 400);

	const storedDataJson = await env.OAUTH_KV.get(`oauth:state:${stateFromQuery}`);
	if (!storedDataJson) return text("Invalid or expired state", 400);
	await env.OAUTH_KV.delete(`oauth:state:${stateFromQuery}`);

	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = JSON.parse(storedDataJson) as AuthRequest;
	} catch (_e) {
		return text("Invalid state data", 500);
	}
	if (!oauthReqInfo.clientId) return text("Invalid OAuth request data", 400);

	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: env.GITHUB_CLIENT_ID,
		client_secret: env.GITHUB_CLIENT_SECRET,
		code: url.searchParams.get("code") ?? undefined,
		redirect_uri: new URL("/callback", request.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	const { login, name, email } = await fetchGitHubUser(accessToken);

	if (!isAllowedLogin(login, env.ALLOWED_GITHUB_LOGIN)) {
		console.warn(`auth gate: rejected login=${JSON.stringify(login)}`);
		return text(`GitHub user "${login}" is not authorized for this connector.`, 403);
	}

	console.log(`callback: issuing token for login=${JSON.stringify(login)} client=${oauthReqInfo.clientId}`);

	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: name ?? login },
		props: { accessToken, email, login, name } as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: login,
	});

	return new Response(null, { status: 302, headers: { Location: redirectTo } });
}
