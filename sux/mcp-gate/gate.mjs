// Unified MCP gateway: one routes map, one bearer-injection core, two trust
// tiers on separate loopback listeners.
//
//   tailnet tier (:27126, behind `tailscale serve :9443`, NOT funneled) —
//     identity is the credential. serve injects Tailscale-User-Login on
//     tailnet connections and strips any client-supplied Tailscale-*
//     headers, so the allowlist check is trustworthy. Paths: /<route>/mcp
//
//   public tier (:27125, behind `tailscale funnel :10000`) — for clients
//     that can't join the tailnet or send custom headers (claude.ai
//     connectors). A long random path segment is the only client-side
//     credential. Paths: /<secret>/<route>/mcp, plus legacy /<secret>/mcp
//     (= default route) so existing connector URLs keep working.
//
// Upstream bearer tokens are injected here and never leave this host.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const TAILNET_PORT = Number(process.env.TAILNET_PORT || 27126);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 27125);
// Bound the wait for the upstream's FIRST response (status line + headers), not the
// whole exchange: a hung upstream that accepts the TCP connection but never replies
// would otherwise hang the client forever (up's response/error callbacks never fire,
// server.requestTimeout is 0 for SSE). Cleared the moment headers arrive, so an SSE
// route that responds promptly then streams indefinitely is unaffected.
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30_000);
const SECRET = (process.env.GATE_SECRET || '').trim();
const ALLOW = (process.env.ALLOW_LOGINS || 'colinxs@github').split(',').map(s => s.trim());
const DEFAULT_ROUTE = process.env.DEFAULT_ROUTE || 'obsidian';
const ROUTES_FILE = process.env.ROUTES_FILE || new URL('./routes.json', import.meta.url).pathname;

// { "<route>": { "upstream": "http://host:port/path", "bearerFile": "...", "bearerField": "apiKey" } }
const routes = JSON.parse(readFileSync(ROUTES_FILE, 'utf8'));

// Re-read per request so upstream key rotation needs no restart.
const bearer = (r) => r.bearerFile
  ? JSON.parse(readFileSync(r.bearerFile, 'utf8'))[r.bearerField || 'apiKey']
  : null;

const HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'host', 'authorization',
]);

const agent = new http.Agent({ keepAlive: true });
const redact = (p) => SECRET ? p.split(SECRET).join('<secret>') : p;
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// Constant-time compare (avoids leaking the path secret via early-exit timing),
// mirroring tokenEq/timingSafeEq in the Worker. Length mismatch is a rejection.
const tokenEq = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

function proxy(routeName, who, req, res, url) {
  const route = routes[routeName];
  if (!route) {
    log(req.method, redact(url.pathname), 404, who);
    res.writeHead(404); res.end('no such route'); return;
  }
  const upstream = new URL(route.upstream);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
  const key = bearer(route);
  if (key) headers.authorization = `Bearer ${key}`;
  headers.host = upstream.host;

  let settled = false;
  const up = http.request({
    host: upstream.hostname, port: upstream.port,
    path: upstream.pathname + url.search,
    method: req.method, headers, agent,
  }, (upRes) => {
    settled = true;
    clearTimeout(firstByteTimer); // headers are in — streaming (incl. SSE) is now unbounded
    const out = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
    res.writeHead(upRes.statusCode, out);
    upRes.pipe(res);
    upRes.on('end', () => log(req.method, `${routeName}/mcp`, upRes.statusCode, who));
  });
  const firstByteTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    log(req.method, `${routeName}/mcp`, 504, who, 'upstream timeout');
    up.destroy(new Error('upstream timeout'));
    if (!res.headersSent) res.writeHead(504);
    res.end('upstream timeout');
  }, UPSTREAM_TIMEOUT_MS);
  up.on('error', (err) => {
    clearTimeout(firstByteTimer);
    if (settled) return; // timeout already responded (up.destroy re-emits as 'error')
    settled = true;
    log(req.method, `${routeName}/mcp`, 502, who, err.code || err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
  });
  // Client aborts (TCP RST mid-body, navigate-away mid-SSE-response) emit
  // 'error' on these streams; with zero listeners that throws asynchronously
  // and crashes the whole process, taking down every route on both listeners.
  req.on('error', (err) => {
    log(req.method, `${routeName}/mcp`, 499, who, err.code || err.message);
    up.destroy();
  });
  res.on('error', (err) => {
    log(req.method, `${routeName}/mcp`, 499, who, err.code || err.message);
    up.destroy();
  });
  req.pipe(up);
}

function makeServer(handler) {
  const server = http.createServer((req, res) => {
    // Error boundary: a transient per-request fault (a mid-rotation bearerFile that's
    // momentarily missing/invalid, a malformed route.upstream) must degrade to one 5xx,
    // never crash the process and take down every route on both listeners.
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '');
      if (path === '/healthz') { res.writeHead(200); res.end('ok'); return; }
      handler(path, req, res, url);
    } catch (err) {
      log(req.method, redact(req.url || ''), 500, err.code || err.message);
      if (res.headersSent) { res.end(); return; }
      res.writeHead(500); res.end('internal error');
    }
  });
  server.requestTimeout = 0; // SSE streams stay open indefinitely
  server.headersTimeout = 30_000;
  return server;
}

// Tailnet tier: /<route>/mcp, identity allowlist.
makeServer((path, req, res, url) => {
  const login = req.headers['tailscale-user-login'];
  if (!login || !ALLOW.includes(login)) {
    log(req.method, url.pathname, 403, login || '<no identity>');
    res.writeHead(403); res.end('forbidden'); return;
  }
  const m = path.match(/^\/([^/]+)\/mcp$/);
  if (!m) {
    log(req.method, url.pathname, 404, login);
    res.writeHead(404); res.end('not found'); return;
  }
  proxy(m[1], login, req, res, url);
}).listen(TAILNET_PORT, '127.0.0.1', () =>
  log(`tailnet tier on 127.0.0.1:${TAILNET_PORT}, allow: ${ALLOW.join(', ')}`));

// Public tier: /<secret>/[<route>/]mcp. Disabled if no secret is configured.
if (/^[0-9a-f]{32,}$/.test(SECRET)) {
  makeServer((path, req, res, url) => {
    const m = path.match(/^\/([^/]+)(?:\/([^/]+))?\/mcp$/);
    if (!m || !tokenEq(m[1], SECRET)) {
      log(req.method, redact(url.pathname), 404, '<public>');
      res.writeHead(404); res.end('not found'); return;
    }
    proxy(m[2] || DEFAULT_ROUTE, '<public>', req, res, url);
  }).listen(PUBLIC_PORT, '127.0.0.1', () =>
    log(`public tier on 127.0.0.1:${PUBLIC_PORT}, default route: ${DEFAULT_ROUTE}`));
} else {
  log('public tier disabled (GATE_SECRET missing or too weak — need >=32 hex chars)');
}

log(`routes: ${Object.keys(routes).join(', ')}`);
