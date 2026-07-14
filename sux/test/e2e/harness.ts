import { spawn } from "node:child_process";
import { join } from "node:path";

// Drives a REAL locally-running Worker (workerd, via `wrangler dev`) over real HTTP
// JSON-RPC — the thing sux/CLAUDE.md's issue #338 asked for: tools/list + tools/call
// against the live dispatch chain, not a mocked fetch(). See e2e-worker.ts for what's
// mounted and why (handleRpc, no OAuth wrapper).

const PORT = 18790;
const HOST = `http://127.0.0.1:${PORT}`;
const CONFIG_PATH = join(__dirname, "wrangler.e2e.jsonc");
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

export type Harness = {
	rpc: (method: string, params?: unknown) => Promise<any>;
	callTool: (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }>; errorCode?: string }>;
	stop: () => Promise<void>;
};

async function waitForReady(deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${HOST}/health`);
			if (r.ok && (await r.text()) === "sux-e2e-harness-ok") return;
		} catch {
			// Not up yet — wrangler dev is still compiling/binding the port.
		}
		await new Promise((r) => setTimeout(r, READY_POLL_MS));
	}
	throw new Error(`e2e Worker did not become healthy within ${READY_TIMEOUT_MS}ms — is port ${PORT} already in use?`);
}

/**
 * Start the e2e Worker (`wrangler dev` against wrangler.e2e.jsonc) and wait until it
 * answers GET /health. `env` entries are injected via `wrangler dev --var` (e.g.
 * OBSIDIAN_VAULT_REPO/GITHUB_TOKEN for the opt-in real-vault cases) — an empty/absent
 * var reproduces the "vault not configured" path exactly as production sees it when
 * those secrets aren't set.
 */
export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
	const varArgs = Object.entries(env).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
	// Spawn from the repo ROOT, not sux/ — sux/node_modules is a (pre-existing, unrelated)
	// broken symlink, and running npx with it as cwd makes npm's local-bin resolution fail
	// silently (wrangler exits immediately, code 194, no output).
	const child = spawn("npx", ["wrangler", "dev", "--config", CONFIG_PATH, "--port", String(PORT), ...varArgs], {
		cwd: join(__dirname, "..", "..", ".."),
		stdio: ["ignore", "pipe", "pipe"],
	});

	let out = "";
	let err = "";
	child.stdout?.on("data", (d) => (out += String(d)));
	child.stderr?.on("data", (d) => (err += String(d)));

	const exited = new Promise<never>((_resolve, reject) => {
		child.once("exit", (code) => reject(new Error(`wrangler dev exited early (code ${code})\nstdout:\n${out}\nstderr:\n${err}`)));
	});

	try {
		await Promise.race([waitForReady(Date.now() + READY_TIMEOUT_MS), exited]);
	} catch (e) {
		child.kill("SIGKILL");
		throw e;
	}

	const rpc = async (method: string, params?: unknown) => {
		const res = await fetch(`${HOST}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		const text = await res.text();
		// The Worker's sseResponse frames JSON as a single `data: <json>` SSE event.
		const m = /data: (.*)/.exec(text);
		return JSON.parse(m ? m[1] : text);
	};

	const callTool = async (name: string, args?: Record<string, unknown>) => {
		const out = await rpc("tools/call", { name, arguments: args ?? {} });
		return out.result;
	};

	const stop = async () => {
		child.kill("SIGTERM");
		await new Promise((resolve) => child.once("exit", resolve));
	};

	return { rpc, callTool, stop };
}
