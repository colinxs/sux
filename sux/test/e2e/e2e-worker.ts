import { handleRpc } from "../../src/index";
import { parseJsonRpc } from "../../src/mcp-util";
import { registry } from "../../src/op-engine/registry";
import { makeCaps } from "../../src/op-engine/caps";
import { runVerb } from "../../src/fns/run";
import { op, pipe, map, reconcile, ask, sink, aimd, unzip, putText, resolveText, type Caps } from "@suxos/lib";

// Test-only Worker entry for the MCP e2e harness (sux/test/e2e/README.md). It mounts
// handleRpc — the EXACT post-auth dispatch chain rtServer.fetch calls in production
// (index.ts) — directly at POST /mcp, with no OAuthProvider in front of it. The
// harness is deliberately not testing auth (that's rtServer's gate, unit-tested
// elsewhere); its job is real tools/list + tools/call dispatch: real fn.run(), real
// fetch() to whatever upstream a fn calls (GitHub, etc — nothing here mocks fetch),
// running inside a real Workers runtime (workerd via `wrangler dev`), not vitest+jsdom.

// The durable op runtime's Workflow entrypoint. wrangler resolves `class_name:
// "OpWorkflow"` (wrangler.e2e.jsonc) from this entry's exports, so it must be re-exported.
export { OpWorkflow } from "../../src/op-engine/durable";

// --- Cluster-E Tier-2 (durable tracer bullet) test-only wiring ---------------------
// A stubbed sibling of the real `assimilate-pdfs` op: identical SHAPE (unzip → map ×
// fan-out → reconcile → ask('review master?') → summarize → sink.fanout(['r2','vault'])),
// but `extract`/`summarize` are pure (no Workers-AI), so the e2e harness needs no `AI`
// binding or remote creds. Registered into the SHARED registry singleton at worker
// init, so OpWorkflow's dynamic `import("./registry.js")` sees it. The `ask` prompt
// MATCHES the real op's, so `send-event --type "ask:review master?"` resumes it.
const stubExtract = op(
	"extract",
	async (pdfHandle: any, caps: Caps) => putText(caps.store, `# ${await resolveText(caps.store, pdfHandle)}`, "text/markdown"),
	{ kind: "effect", heavy: true },
);
const stubSummarize = op(
	"summarize",
	async (masterHandle: any, caps: Caps) => {
		const master = await resolveText(caps.store, masterHandle);
		return { abstract: `e2e-abstract:${master.length}`, summaryHandle: await putText(caps.store, "e2e summary", "text/markdown") };
	},
	{ kind: "effect" },
);
registry["assimilate-pdfs-e2e"] = () =>
	pipe(
		op("unzip", unzip, { kind: "effect" }),
		map(stubExtract, { concurrency: aimd({ start: 4 }) }),
		reconcile({ mode: "faithful-union" }),
		ask("review master?", { timeout: "24 hour", onTimeout: "proceed" }),
		stubSummarize,
		sink.fanout(["r2", "vault"]),
	);

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The e2e routes that drive/inspect a durable run. All test-only; production never
// mounts this worker (it mounts rtServer via index.ts).
async function handleE2eRoute(req: Request, url: URL, env: any): Promise<Response | null> {
	// Stage arbitrary bytes into the content store, returning the Handle — the durable
	// run's input is an R2 zip handle, so the test uploads its fixture here first.
	if (req.method === "POST" && url.pathname === "/e2e/stage") {
		const bytes = new Uint8Array(await req.arrayBuffer());
		const handle = await makeCaps(env).store.put(bytes, url.searchParams.get("type") ?? "application/zip");
		return json(handle);
	}
	// Start the durable op over a staged input handle → returns { instanceId }.
	if (req.method === "POST" && url.pathname === "/e2e/run") {
		const { op: opId, input } = (await req.json()) as { op: string; input: any };
		return json(await runVerb({ op: opId, input, mode: "durable" }, env));
	}
	// Poll a workflow instance's status (status + output once complete). miniflare's
	// local binding makes `get` async, so await the instance before `.status()`.
	if (req.method === "GET" && url.pathname === "/e2e/status") {
		const instance = await env.OP_WORKFLOW.get(url.searchParams.get("id")!);
		return json(await instance.status());
	}
	// Assert a sink write landed: does R2 hold this key?
	if (req.method === "GET" && url.pathname === "/e2e/r2head") {
		const head = await env.R2.head(url.searchParams.get("key")!);
		return json({ present: head !== null });
	}
	return null;
}

export default {
	async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") return new Response("sux-e2e-harness-ok");
		const e2e = await handleE2eRoute(request, url, env);
		if (e2e) return e2e;
		if (request.method !== "POST" || url.pathname !== "/mcp") return new Response("not found", { status: 404 });
		const bodyText = await request.text();
		const rpc = parseJsonRpc(bodyText);
		return handleRpc(env as Parameters<typeof handleRpc>[0], ctx, rpc);
	},
};
