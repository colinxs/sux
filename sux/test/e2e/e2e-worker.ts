import { handleRpc } from "../../src/index";
import { parseJsonRpc } from "../../src/mcp-util";

// Test-only Worker entry for the MCP e2e harness (sux/test/e2e/README.md). It mounts
// handleRpc — the EXACT post-auth dispatch chain rtServer.fetch calls in production
// (index.ts) — directly at POST /mcp, with no OAuthProvider in front of it. The
// harness is deliberately not testing auth (that's rtServer's gate, unit-tested
// elsewhere); its job is real tools/list + tools/call dispatch: real fn.run(), real
// fetch() to whatever upstream a fn calls (GitHub, etc — nothing here mocks fetch),
// running inside a real Workers runtime (workerd via `wrangler dev`), not vitest+jsdom.
export default {
	async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") return new Response("sux-e2e-harness-ok");
		if (request.method !== "POST" || url.pathname !== "/mcp") return new Response("not found", { status: 404 });
		const bodyText = await request.text();
		const rpc = parseJsonRpc(bodyText);
		return handleRpc(env as Parameters<typeof handleRpc>[0], ctx, rpc);
	},
};
