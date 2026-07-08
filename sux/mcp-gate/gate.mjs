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

  const up = http.request({
    host: upstream.hostname, port: upstream.port,
    path: upstream.pathname + url.search,
    method: req.method, headers, agent,
  }, (upRes) => {
    const out = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
    res.writeHead(upRes.statusCode, out);
    upRes.pipe(res);
    upRes.on('end', () => log(req.method, `${routeName}/mcp`, upRes.statusCode, who));
  });
  up.on('error', (err) => {
    log(req.method, `${routeName}/mcp`, 502, who, err.code || err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
  });
  req.pipe(up);
}

function makeServer(handler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    handler(path, req, res, url);
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
    if (!m || m[1] !== SECRET) {
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
