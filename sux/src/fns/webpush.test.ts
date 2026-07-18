import { beforeEach, describe, expect, it, vi } from "vitest";
import { webpush } from "./webpush";

const hasWebPush = vi.fn();
const subscribe = vi.fn();
const unsubscribe = vi.fn();
const listSubscriptions = vi.fn();
const notify = vi.fn();
const validSubscription = vi.fn();
vi.mock("./_webpush", () => ({
	hasWebPush: (...a: unknown[]) => hasWebPush(...a),
	subscribe: (...a: unknown[]) => subscribe(...a),
	unsubscribe: (...a: unknown[]) => unsubscribe(...a),
	listSubscriptions: (...a: unknown[]) => listSubscriptions(...a),
	notify: (...a: unknown[]) => notify(...a),
	validSubscription: (...a: unknown[]) => validSubscription(...a),
}));

const parse = (r: any) => JSON.parse(r.content[0].text);
const SUB = { endpoint: "https://push.example/ep1", keys: { p256dh: "p", auth: "a" } };

describe("webpush (front verb)", () => {
	beforeEach(() => {
		hasWebPush.mockReset();
		subscribe.mockReset();
		unsubscribe.mockReset();
		listSubscriptions.mockReset();
		notify.mockReset();
		validSubscription.mockReset();
	});

	it("is inert (not_configured) for subscribe/unsubscribe/send when VAPID secrets are unset", async () => {
		hasWebPush.mockReturnValue(false);
		for (const action of ["subscribe", "unsubscribe", "send"]) {
			const r = await webpush.run({} as any, { action, subscription: SUB, endpoint: SUB.endpoint, body: "hi" });
			const out = parse(r);
			expect(out.not_configured).toBe(true);
			expect(out.note).toMatch(/VAPID_PUBLIC_KEY/);
		}
		expect(subscribe).not.toHaveBeenCalled();
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("list bypasses the hasWebPush gate entirely — works even when VAPID secrets are unset", async () => {
		hasWebPush.mockReturnValue(false);
		listSubscriptions.mockResolvedValue([SUB, { ...SUB, endpoint: "https://push.example/ep2" }]);

		const r = await webpush.run({} as any, { action: "list" });

		expect(r.isError).toBeUndefined();
		expect(parse(r)).toEqual({ count: 2, endpoints: ["https://push.example/ep1", "https://push.example/ep2"] });
		expect(hasWebPush).not.toHaveBeenCalled();
	});

	it("subscribe validates the subscription shape before calling subscribe()", async () => {
		hasWebPush.mockReturnValue(true);
		validSubscription.mockReturnValue(false);

		const r = await webpush.run({} as any, { action: "subscribe", subscription: { endpoint: "not enough" } });

		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/endpoint.*keys\.p256dh.*keys\.auth/s);
		expect(subscribe).not.toHaveBeenCalled();
	});

	it("subscribe: a valid subscription is registered and echoes the endpoint's origin", async () => {
		hasWebPush.mockReturnValue(true);
		validSubscription.mockReturnValue(true);
		subscribe.mockResolvedValue(undefined);

		const r = await webpush.run({} as any, { action: "subscribe", subscription: SUB });

		expect(r.isError).toBeUndefined();
		expect(subscribe).toHaveBeenCalledWith({}, SUB);
		expect(r.content[0].text).toContain("https://push.example");
	});

	it("unsubscribe requires a string endpoint", async () => {
		hasWebPush.mockReturnValue(true);
		const r = await webpush.run({} as any, { action: "unsubscribe" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/endpoint is required/);
		expect(unsubscribe).not.toHaveBeenCalled();
	});

	it("unsubscribe: removes the given endpoint", async () => {
		hasWebPush.mockReturnValue(true);
		unsubscribe.mockResolvedValue(undefined);
		const r = await webpush.run({} as any, { action: "unsubscribe", endpoint: SUB.endpoint });
		expect(r.isError).toBeUndefined();
		expect(unsubscribe).toHaveBeenCalledWith({}, SUB.endpoint);
		expect(r.content[0].text).toContain(SUB.endpoint);
	});

	it("send requires a non-empty body and defaults the title to 'sux'", async () => {
		hasWebPush.mockReturnValue(true);
		const empty = await webpush.run({} as any, { action: "send", body: "   " });
		expect(empty.isError).toBe(true);
		expect(empty.content[0].text).toMatch(/body is required/);
		expect(notify).not.toHaveBeenCalled();

		notify.mockResolvedValue({ sent: 2, failed: 0 });
		const r = await webpush.run({} as any, { action: "send", body: " hello " });
		expect(r.isError).toBeUndefined();
		expect(notify).toHaveBeenCalledWith({}, { title: "sux", body: "hello" });
		expect(parse(r)).toEqual({ sent: 2, failed: 0 });
	});

	it("send: an explicit title is trimmed and passed through", async () => {
		hasWebPush.mockReturnValue(true);
		notify.mockResolvedValue({ sent: 1, failed: 0 });
		await webpush.run({} as any, { action: "send", title: " Alert ", body: "ping" });
		expect(notify).toHaveBeenCalledWith({}, { title: "Alert", body: "ping" });
	});

	it("rejects an unknown action, mentioning the valid ones", async () => {
		hasWebPush.mockReturnValue(true);
		const r = await webpush.run({} as any, { action: "bogus" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/subscribe, unsubscribe, list, or send/);
	});

	it("treats a missing action as unknown rather than throwing", async () => {
		hasWebPush.mockReturnValue(true);
		const r = await webpush.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown action/);
	});
});
