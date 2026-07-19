import { type Fn, type RtEnv, failWith, ok } from "../registry";
import { hmacHex } from "../proxy";
import { errMsg, oj } from "./_util";

// Thin conduit to a standalone Mac-local iMessage service (chat.db read +
// AppleScript send), reached over a Tailscale Funnel with the same
// HMAC-signed-POST transport mac-render used to use — but its OWN
// process/plist (sux/imessage-service/), never bolted onto mac-render (which
// #742 removed entirely in favor of cf-residential render, unrelated to this
// spoke). domains.md §2 originally specced this as three routes on
// mac-render's aiohttp server; re-scoped 2026-07-17 (#264) to a minimal
// standalone launchd service so the smallest-possible-surface Mac process
// handles chat.db/FDA/Automation access, with zero browser dependency. One
// POST-per-action shape (not domains.md's GET-routed REST) so the request
// verification mirrors the proven signed-POST pattern the (now-removed)
// render_server.py's h_render used (ts+sig on the query string AND mirrored
// in headers, ±5min replay window) — see sux/imessage-service/imessage_server.py.
//
// Class-B degrade (domains.md §2): Mac asleep/off-net → the spoke is simply
// down; this fn reports that honestly rather than pretending. No PII/body
// logging (jmap D21 discipline) and never cached (jmap D1 parity — messages
// are private and mutate constantly).

type ImessageResponse = { ok?: boolean; error?: string; [k: string]: unknown };

/** The Mac-local iMessage spoke is configured. Same gate shape as hasMonarch/hasCalDav —
 *  callers (recall's fromImessage, agenda's unanswered_text detector) degrade quietly
 *  rather than call through to a fn that would just fail_with not_configured. */
export const hasImessage = (env: RtEnv): boolean => Boolean(env.IMESSAGE_URL && env.IMESSAGE_SECRET);

async function imessageCall(env: RtEnv, action: string, body: Record<string, unknown>): Promise<{ ok: true; data: ImessageResponse } | { ok: false; error: string }> {
	if (!env.IMESSAGE_URL || !env.IMESSAGE_SECRET) {
		return { ok: false, error: "iMessage backend not configured (IMESSAGE_URL / IMESSAGE_SECRET)." };
	}
	const payload = JSON.stringify(body);
	const ts = String(Date.now());
	const sig = await hmacHex(env.IMESSAGE_SECRET, `${ts}\n${payload}`);
	const endpoint = new URL(`/imessage/${action}`, env.IMESSAGE_URL).href;
	let resp: Response;
	try {
		resp = await fetch(`${endpoint}?ts=${ts}&sig=${sig}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
			body: payload,
			signal: AbortSignal.timeout(20_000),
		});
	} catch (e) {
		return { ok: false, error: `iMessage backend unreachable: ${errMsg(e)}` };
	}
	let data: ImessageResponse;
	try {
		data = (await resp.json()) as ImessageResponse;
	} catch {
		return { ok: false, error: `iMessage backend returned an unreadable response (HTTP ${resp.status}).` };
	}
	if (!resp.ok || data.error) {
		return { ok: false, error: `iMessage ${action} failed: ${data.error ?? `HTTP ${resp.status}`}` };
	}
	return { ok: true, data };
}

export const imessage: Fn = {
	name: "imessage",
	cost: 1,
	cacheable: false,
	raw: true,
	description:
		"iMessage over a standalone Mac-local service (chat.db read + AppleScript send), reached via Tailscale Funnel + HMAC — the Mac-node spoke domains.md §2 specs. Actions: threads ({since?, contact?}) — recent conversations; messages ({thread, limit?}) — a thread's messages; send ({to, text, allow_send:true}) — GATED, an iMessage is unrecallable once sent (§1 law, jmap parity). Down/asleep Mac → reports the backend as unreachable rather than silently degrading. Needs IMESSAGE_URL + IMESSAGE_SECRET.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["threads", "messages", "send"] },
			since: { type: "string", description: "threads: ISO timestamp — only conversations with activity after this." },
			contact: { type: "string", description: "threads: filter to a handle (phone/email)." },
			thread: { type: "string", description: "messages: the chat/thread id from `threads`." },
			limit: { type: "integer", minimum: 1, maximum: 500, description: "messages: max messages to return (default 50)." },
			to: { type: "string", description: "send: destination handle (phone/email)." },
			text: { type: "string", description: "send: message body." },
			allow_send: { type: "boolean", default: false, description: "GATE: send is REJECTED unless true — an iMessage cannot be unsent. Accidental-send guard only, not an injection boundary." },
		},
	},
	run: async (env: RtEnv, a: any) => {
		const action = String(a?.action ?? "");
		if (action === "threads") {
			const body: Record<string, unknown> = {};
			if (a?.since) body.since = String(a.since);
			if (a?.contact) body.contact = String(a.contact);
			const r = await imessageCall(env, "threads", body);
			if (!r.ok) return failWith("upstream_error", r.error);
			return ok(oj(r.data));
		}
		if (action === "messages") {
			if (!a?.thread) return failWith("bad_input", "imessage messages requires `thread`.");
			const r = await imessageCall(env, "messages", { thread: String(a.thread), limit: a?.limit ? Number(a.limit) : undefined });
			if (!r.ok) return failWith("upstream_error", r.error);
			return ok(oj(r.data));
		}
		if (action === "send") {
			if (!a?.to || !a?.text) return failWith("bad_input", "imessage send requires `to` and `text`.");
			if (a?.allow_send !== true) return failWith("bad_input", "imessage send requires allow_send:true — an iMessage is unrecallable once sent.");
			const r = await imessageCall(env, "send", { to: String(a.to), text: String(a.text) });
			if (!r.ok) return failWith("upstream_error", r.error);
			return ok(oj({ ok: true, ...r.data }));
		}
		return failWith("bad_input", `imessage: unknown action '${action}'.`);
	},
};
