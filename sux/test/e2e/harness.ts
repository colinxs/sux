import { spawn } from "node:child_process";
import { join } from "node:path";

// Drives a REAL locally-running Worker (workerd, via `wrangler dev`) over real HTTP
// JSON-RPC — the thing sux/CLAUDE.md's issue #338 asked for: tools/list + tools/call
// against the live dispatch chain, not a mocked fetch(). See e2e-worker.ts for what's
// mounted and why (handleRpc, no OAuth wrapper).

const CONFIG_PATH = join(__dirname, "wrangler.e2e.jsonc");
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
// SIGTERM is given this long to let `wrangler dev` shut down its own workerd child
// cleanly before stop() escalates to killing the whole process group with SIGKILL.
const STOP_GRACE_MS = 5_000;

// Each harness instance binds its own randomly-chosen port instead of one shared
// constant. The e2e files run sequentially (fileParallelism:false in
// vitest.e2e.config.ts), so this isn't about parallel contention — it's that
// `wrangler dev` (npx → node → workerd) is a 3-level process tree, and a workerd
// grandchild that's slow to exit on teardown can still hold a fixed port when the
// next file's startHarness runs. A fresh random port per instance decouples files
// from each other regardless of teardown timing. See stop() below for the other
// half of the fix: actually killing that grandchild instead of leaking it forever.
function pickPort(): number {
	return 20000 + Math.floor(Math.random() * 20000);
}

// A random port out of 20000 candidates still occasionally collides with something
// already bound on the runner (#974 saw this in CI even after the per-instance random
// port above) — workerd's own EADDRINUSE message, distinct from an early-exit caused by
// a real compile/config error, which should fail fast rather than retry.
const ADDR_IN_USE = /EADDRINUSE|Address already in use/i;

export type Harness = {
	host: string;
	port: number;
	rpc: (method: string, params?: unknown) => Promise<any>;
	callTool: (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }>; errorCode?: string }>;
	stop: () => Promise<void>;
};

async function waitForReady(host: string, deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${host}/health`);
			if (r.ok && (await r.text()) === "sux-e2e-harness-ok") return;
		} catch {
			// Not up yet — wrangler dev is still compiling/binding the port.
		}
		await new Promise((r) => setTimeout(r, READY_POLL_MS));
	}
	throw new Error(`e2e Worker did not become healthy within ${READY_TIMEOUT_MS}ms — is ${host} already in use?`);
}

/** One boot attempt on a fixed port: spawn `wrangler dev`, wait for /health, or throw
 *  (killing the process group first) if it exits early or never comes up in time. Split
 *  out of startHarness so a port collision (#974) can retry on a fresh port without
 *  duplicating the spawn/wait machinery. */
async function bootWrangler(port: number, varArgs: string[]): Promise<{ child: ReturnType<typeof spawn>; host: string; killGroup: (sig: NodeJS.Signals) => void }> {
	const host = `http://127.0.0.1:${port}`;
	// Spawn from the repo ROOT, not sux/ — sux/node_modules is a (pre-existing, unrelated)
	// broken symlink, and running npx with it as cwd makes npm's local-bin resolution fail
	// silently (wrangler exits immediately, code 194, no output).
	// `detached: true` puts the spawned `npx` (and the `wrangler`/`workerd` it forks) in
	// its own process group, so stop() can SIGKILL the whole group by PGID instead of
	// only the `npx` wrapper — a plain `child.kill()` never reached the workerd
	// grandchild, which is exactly what left the port bound for the next test file.
	const child = spawn("npx", ["wrangler", "dev", "--config", CONFIG_PATH, "--port", String(port), ...varArgs], {
		cwd: join(__dirname, "..", "..", ".."),
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});

	let out = "";
	let err = "";
	child.stdout?.on("data", (d) => (out += String(d)));
	child.stderr?.on("data", (d) => (err += String(d)));

	const exited = new Promise<never>((_resolve, reject) => {
		child.once("exit", (code) => reject(new Error(`wrangler dev exited early (code ${code})\nstdout:\n${out}\nstderr:\n${err}`)));
	});

	// Negative pid targets the whole process group `detached: true` created above.
	const killGroup = (sig: NodeJS.Signals) => {
		try {
			if (child.pid) process.kill(-child.pid, sig);
		} catch {
			// Group is already gone (e.g. workerd exited on its own) — nothing to do.
		}
	};

	try {
		await Promise.race([waitForReady(host, Date.now() + READY_TIMEOUT_MS), exited]);
	} catch (e) {
		killGroup("SIGKILL");
		throw e;
	}

	return { child, host, killGroup };
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
	let port = pickPort();
	let booted: Awaited<ReturnType<typeof bootWrangler>>;
	try {
		booted = await bootWrangler(port, varArgs);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (!ADDR_IN_USE.test(message)) throw e;
		// The random port collided with something already bound — retry once on a
		// freshly-drawn port rather than fail the whole suite on this rare race (#974).
		// A second collision in a row is treated as a real failure, not retried again.
		port = pickPort();
		booted = await bootWrangler(port, varArgs);
	}
	const { child, host, killGroup } = booted;

	const rpc = async (method: string, params?: unknown) => {
		const res = await fetch(`${host}/mcp`, {
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
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		killGroup("SIGTERM");
		// wrangler/workerd don't always honor SIGTERM promptly (or at all) — escalate
		// to SIGKILL on the whole group rather than let a wedged grandchild outlive
		// this harness and block the next test file's port.
		const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), STOP_GRACE_MS));
		if ((await Promise.race([exited.then(() => "exited" as const), timedOut])) === "timeout") {
			killGroup("SIGKILL");
			await exited;
		}
	};

	return { host, port, rpc, callTool, stop };
}
