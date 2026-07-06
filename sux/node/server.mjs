// Residential fetch proxy — runs on a box in your Tailscale tailnet and does
// outbound fetches from its (residential) IP on behalf of the Cloudflare Worker,
// which egresses from datacenter IPs that big-box retailers (Akamai) block.
//
// Expose it to the Worker with Tailscale Funnel:  tailscale funnel 8787
// The Worker calls  POST https://<node>.<tailnet>.ts.net/fetch  with a bearer
// secret. See README.md.
//
// Zero dependencies — Node 20+ (built-in fetch, node:http, node:dns).

import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.PROXY_SECRET; // REQUIRED — a strong random string
const MAX_BYTES = Number(process.env.MAX_BYTES || 5 * 1024 * 1024); // 5 MiB cap
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30_000);
const CLOCK_SKEW_MS = Number(process.env.CLOCK_SKEW_MS || 300_000); // 5 min replay window
// Host allowlist (comma-separated). Empty = allow any public host (SSRF-guarded).
// Suffix match: "homedepot.com" also allows "www.homedepot.com".
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
	.split(",")
	.map((h) => h.trim().toLowerCase())
	.filter(Boolean);

if (!SECRET || SECRET.length < 16) {
	console.error("Refusing to start: set PROXY_SECRET to a strong (>=16 char) secret.");
	process.exit(1);
}

/** Verify the HMAC-SHA256 of `${ts}\n${rawBody}` (timing-safe) + freshness. */
function verifySignature(ts, rawBody, sigHex) {
	if (!ts || !sigHex) return false;
	if (Math.abs(Date.now() - Number(ts)) > CLOCK_SKEW_MS) return false; // stale/replayed
	const expected = createHmac("sha256", SECRET).update(`${ts}\n${rawBody}`).digest();
	let given;
	try {
		given = Buffer.from(sigHex, "hex");
	} catch {
		return false;
	}
	return expected.length === given.length && timingSafeEqual(expected, given);
}

function hostAllowed(host) {
	if (ALLOWED_HOSTS.length === 0) return true;
	host = host.toLowerCase();
	return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// Default browser-ish headers so targets don't insta-block a botty fingerprint.
const DEFAULT_HEADERS = {
	"user-agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"accept-language": "en-US,en;q=0.9",
	"sec-fetch-dest": "document",
	"sec-fetch-mode": "navigate",
	"sec-fetch-site": "none",
};

/** Reject loopback / private / link-local / CGNAT / metadata targets (SSRF guard). */
function isPrivateIp(ip) {
	if (ip.includes(":")) {
		// IPv6: loopback, unique-local (fc00::/7), link-local (fe80::/10), v4-mapped
		const l = ip.toLowerCase();
		if (l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return true;
		if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
		return false;
	}
	const p = ip.split(".").map(Number);
	if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
	const [a, b] = p;
	return (
		a === 0 || a === 10 || a === 127 || // this-network, private, loopback
		(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10 (Tailscale's own range!)
		(a === 169 && b === 254) || // link-local + cloud metadata 169.254.169.254
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) // private
	);
}

async function assertPublicTarget(url) {
	const u = new URL(url); // throws on garbage
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https allowed");
	if (!hostAllowed(u.hostname)) throw new Error(`host not in allowlist: ${u.hostname}`);
	// Resolve the hostname and check every returned address (blocks DNS-rebinding to internal hosts).
	const host = u.hostname;
	const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
	for (const { address } of addrs) {
		if (isPrivateIp(address)) throw new Error(`target resolves to a private address (${address})`);
	}
	return u;
}

function json(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(body);
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > 1_000_000) throw new Error("request body too large");
		chunks.push(c);
	}
	return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
	if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ok" });

	if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/fetch") {
		return json(res, 404, { error: "not_found" });
	}

	// Read the raw body first — the HMAC covers the exact bytes.
	let raw;
	try {
		raw = await readBody(req);
	} catch {
		return json(res, 400, { error: "body_read_failed" });
	}

	// Auth: HMAC(timestamp + "\n" + rawBody), replay-bounded. Secret never sent.
	if (!verifySignature(req.headers["x-timestamp"], raw, req.headers["x-signature"])) {
		return json(res, 401, { error: "unauthorized" });
	}

	let spec;
	try {
		spec = JSON.parse(raw);
	} catch {
		return json(res, 400, { error: "invalid_json" });
	}
	if (!spec?.url || typeof spec.url !== "string") return json(res, 400, { error: "missing_url" });

	let target;
	try {
		target = await assertPublicTarget(spec.url);
	} catch (e) {
		return json(res, 400, { error: "blocked_target", detail: String(e.message || e) });
	}

	try {
		const upstream = await fetch(target, {
			method: spec.method || "GET",
			headers: { ...DEFAULT_HEADERS, ...(spec.headers || {}) },
			body: spec.body,
			redirect: "follow",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});

		// Read up to MAX_BYTES so a huge page can't OOM the box.
		const reader = upstream.body?.getReader();
		const parts = [];
		let total = 0;
		if (reader) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				if (total > MAX_BYTES) {
					await reader.cancel();
					break;
				}
				parts.push(Buffer.from(value));
			}
		}
		const body = Buffer.concat(parts).toString("utf8");

		console.log(`${new Date().toISOString()} fetch ${target.host} -> ${upstream.status} ${total}b`);
		json(res, 200, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: Object.fromEntries(upstream.headers),
			bytes: total,
			truncated: total > MAX_BYTES,
			body,
		});
	} catch (e) {
		json(res, 502, { error: "upstream_failed", detail: String(e.message || e) });
	}
});

server.listen(PORT, () => console.log(`tailscale fetch-proxy on :${PORT} (expose with: tailscale funnel ${PORT})`));
