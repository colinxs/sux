import { type Fn, fail, ok } from "../registry";
import { hasWebPush, listSubscriptions, notify, subscribe, unsubscribe, validSubscription } from "./_webpush";

// Outbound Web Push (VAPID, #219). Landing point for a client to register the
// PushSubscription it obtained via the browser Push API, and for sux to fan a
// message out to every registered device — see _webpush.ts for the design note
// (Web Push only; Cloudflare Notifications is a separate, out-of-scope idea) and
// the crypto. Not_configured (rather than an error) when VAPID secrets are unset,
// matching the mychart/monarch/dropbox convention.
export const webpush: Fn = {
	name: "webpush",
	description:
		"Outbound Web Push (VAPID) — sux pushing OUT to a registered device instead of only appending to the vault/mail. Actions: subscribe (register a browser PushSubscription), unsubscribe (endpoint), list (registered endpoints), send (title+body to every registered device — for ops testing; the cron loops call the same path internally). Inert (not_configured) until VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT secrets are set.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["subscribe", "unsubscribe", "list", "send"], description: "Which webpush operation to perform." },
			subscription: {
				type: "object",
				description: "subscribe only: the browser's PushSubscription.toJSON() — { endpoint, keys: { p256dh, auth } }.",
				properties: {
					endpoint: { type: "string" },
					keys: { type: "object", properties: { p256dh: { type: "string" }, auth: { type: "string" } } },
				},
			},
			endpoint: { type: "string", description: "unsubscribe only: the subscription's endpoint URL to remove." },
			title: { type: "string", description: "send only: notification title." },
			body: { type: "string", description: "send only: notification body." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const action = String(args?.action ?? "");
		if (action !== "list" && !hasWebPush(env)) {
			return ok(JSON.stringify({ not_configured: true, note: "webpush is inert — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (wrangler secret) to arm it." }));
		}

		switch (action) {
			case "subscribe": {
				const sub = args?.subscription;
				if (!validSubscription(sub)) return fail("subscription.endpoint (a valid URL), subscription.keys.p256dh, and subscription.keys.auth are required.");
				await subscribe(env, sub);
				return ok(`Subscribed ${new URL(sub.endpoint).origin}.`);
			}
			case "unsubscribe": {
				if (!args?.endpoint || typeof args.endpoint !== "string") return fail("endpoint is required (string).");
				await unsubscribe(env, args.endpoint);
				return ok(`Unsubscribed ${args.endpoint}.`);
			}
			case "list": {
				const subs = await listSubscriptions(env);
				return ok(JSON.stringify({ count: subs.length, endpoints: subs.map((s) => s.endpoint) }));
			}
			case "send": {
				const title = typeof args?.title === "string" && args.title.trim() ? args.title.trim() : "sux";
				const body = typeof args?.body === "string" ? args.body.trim() : "";
				if (!body) return fail("body is required (string).");
				const result = await notify(env, { title, body });
				return ok(JSON.stringify(result));
			}
			default:
				return fail(`Unknown action '${action}'. Use subscribe, unsubscribe, list, or send.`);
		}
	},
};
