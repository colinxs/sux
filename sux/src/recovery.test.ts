import { beforeEach, describe, expect, it } from "vitest";
import { handleRecovery, RECOVERY_ACTIONS, type SignedCommand, verifyCommand } from "./recovery";

// A minimal in-memory KV that honors get/put/delete (TTL is a no-op — replay tests
// exercise the nonce presence, not its expiry). Mirrors the KV shape recovery.ts uses.
function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
		},
	};
}

const HMAC = "test-hmac-secret";
const ADMIN = "test-admin-secret";

const enc = new TextEncoder();
async function sign(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const req = (path: string, init: RequestInit = {}) => new Request(`https://sux.test${path}`, init);
const call = (env: any, path: string, init: RequestInit = {}) => handleRecovery(new URL(`https://sux.test${path}`), req(path, init), env);

async function checkinBody(env: any, overrides: Record<string, unknown> = {}) {
	const body = JSON.stringify({ node_id: "owl-tegu", timestamp: Math.floor(Date.now() / 1000), health: { wan: "down", tailscale: "wedged" }, nonce: crypto.randomUUID(), ...overrides });
	const sig = await sign(HMAC, body);
	return { body, sig };
}

const checkin = (env: any, body: string, sig: string) =>
	call(env, "/recovery/checkin", { method: "POST", body, headers: { "x-sux-signature": sig } });

describe("recovery dead-drop", () => {
	let env: any;
	beforeEach(() => {
		env = { ...fakeKv(), RECOVERY_HMAC_SECRET: HMAC, RECOVERY_ADMIN_SECRET: ADMIN };
	});

	it("404s every route when the master HMAC secret is unset (fail-closed)", async () => {
		const off = { ...fakeKv() };
		const res = await call(off, "/recovery/checkin", { method: "POST", body: "{}" });
		expect(res!.status).toBe(404);
	});

	it("returns null for non-recovery paths (falls through to OAuth)", async () => {
		expect(await call(env, "/mcp", { method: "POST" })).toBeNull();
	});

	it("accepts a valid signed checkin and persists health", async () => {
		const { body, sig } = await checkinBody(env);
		const res = await checkin(env, body, sig);
		expect(res!.status).toBe(200);
		const j = await (res!.json() as any);
		expect(j.ok).toBe(true);
		expect(j.node_id).toBe("owl-tegu");
		expect(j.commands).toEqual([]);
		expect(env.store.get("recovery:status:owl-tegu")).toContain("wedged");
	});

	it("rejects a bad signature", async () => {
		const { body } = await checkinBody(env);
		const res = await checkin(env, body, "deadbeef");
		expect(res!.status).toBe(401);
		expect((await (res!.json() as any)).error).toBe("bad_signature");
	});

	it("rejects a tampered body (signature no longer matches)", async () => {
		const { body, sig } = await checkinBody(env);
		const tampered = body.replace("owl-tegu", "attacker");
		const res = await checkin(env, tampered, sig);
		expect(res!.status).toBe(401);
	});

	it("rejects a stale timestamp outside the window", async () => {
		const { body, sig } = await checkinBody(env, { timestamp: Math.floor(Date.now() / 1000) - 10_000 });
		const res = await checkin(env, body, sig);
		expect(res!.status).toBe(401);
		expect((await (res!.json() as any)).error).toBe("stale_timestamp");
	});

	it("rejects a replayed checkin (same nonce twice)", async () => {
		const { body, sig } = await checkinBody(env);
		expect((await checkin(env, body, sig))!.status).toBe(200);
		const replay = await checkin(env, body, sig);
		expect(replay!.status).toBe(409);
		expect((await (replay!.json() as any)).error).toBe("replay");
	});

	it("enqueue → checkin delivery → consume, and the command verifies", async () => {
		const enq = await call(env, "/recovery/enqueue", {
			method: "POST",
			headers: { authorization: `Bearer ${ADMIN}` },
			body: JSON.stringify({ node_id: "owl-tegu", action: "restart-tailscale", args: { reason: "wedged" } }),
		});
		expect(enq!.status).toBe(200);
		const queued: SignedCommand = (await (enq!.json() as any)).queued;
		expect(await verifyCommand(env, queued)).toBe(true);

		const { body, sig } = await checkinBody(env);
		const res = await checkin(env, body, sig);
		const j = await (res!.json() as any);
		expect(j.commands).toHaveLength(1);
		expect(j.commands[0].action).toBe("restart-tailscale");
		expect(await verifyCommand(env, j.commands[0])).toBe(true);

		// Consumed: a second checkin gets an empty queue.
		const second = await checkinBody(env);
		const res2 = await checkin(env, second.body, second.sig);
		expect((await (res2!.json() as any)).commands).toEqual([]);
	});

	it("two concurrent enqueues for one node both survive (no lost-update clobber)", async () => {
		// A KV whose get/put yield to the event loop, so unserialized RMWs of the queue
		// key would interleave and drop a command — issue #286's back-to-back enqueue race.
		const store = new Map<string, string>();
		const tick = () => new Promise<void>((r) => setTimeout(r, 0));
		const racy: any = {
			store,
			OAUTH_KV: {
				get: async (k: string) => {
					await tick();
					return store.get(k) ?? null;
				},
				put: async (k: string, v: string) => {
					await tick();
					store.set(k, v);
				},
				delete: async (k: string) => {
					await tick();
					store.delete(k);
				},
			},
			RECOVERY_HMAC_SECRET: HMAC,
			RECOVERY_ADMIN_SECRET: ADMIN,
		};
		const enqueue = (action: string) =>
			call(racy, "/recovery/enqueue", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ node_id: "owl-tegu", action }) });
		await Promise.all([enqueue("restart-tailscale"), enqueue("restart-dns")]);
		const { body, sig } = await checkinBody(racy);
		const res = await checkin(racy, body, sig);
		const j = await (res!.json() as any);
		expect(j.commands.map((c: SignedCommand) => c.action).sort()).toEqual(["restart-dns", "restart-tailscale"]);
	});

	it("a command signed under the wrong secret fails verification", async () => {
		const forged: SignedCommand = { action: "reboot", args: {}, nonce: "x", expires: Date.now() / 1000 + 100, sig: "00" };
		expect(await verifyCommand(env, forged)).toBe(false);
	});

	it("commands sign under RECOVERY_CMD_SECRET when set (separate from checkin auth)", async () => {
		env.RECOVERY_CMD_SECRET = "cmd-only-secret";
		const enq = await call(env, "/recovery/enqueue", {
			method: "POST",
			headers: { authorization: `Bearer ${ADMIN}` },
			body: JSON.stringify({ node_id: "owl-tegu", action: "noop" }),
		});
		const queued: SignedCommand = (await (enq!.json() as any)).queued;
		expect(await verifyCommand(env, queued)).toBe(true);
		// Under the HMAC secret alone it must NOT verify.
		expect(await verifyCommand({ RECOVERY_HMAC_SECRET: HMAC } as any, queued)).toBe(false);
	});

	it("rejects an action outside the allow-list", async () => {
		const res = await call(env, "/recovery/enqueue", {
			method: "POST",
			headers: { authorization: `Bearer ${ADMIN}` },
			body: JSON.stringify({ node_id: "owl-tegu", action: "rm-rf-slash" }),
		});
		expect(res!.status).toBe(400);
		expect((await (res!.json() as any)).error).toBe("bad_action");
	});

	it("drops an expired command on delivery", async () => {
		// Enqueue with ttl=1, then checkin far enough ahead that it's expired. We force
		// expiry by writing the queue directly with a past `expires`.
		env.store.set("recovery:queue:owl-tegu", JSON.stringify([{ action: "reboot", args: {}, nonce: "n", expires: 1, sig: "x" }]));
		const { body, sig } = await checkinBody(env);
		const res = await checkin(env, body, sig);
		expect((await (res!.json() as any)).commands).toEqual([]);
	});

	it("enqueue + status 404 without the admin bearer; checkin still works", async () => {
		const noAdmin = { ...fakeKv(), RECOVERY_HMAC_SECRET: HMAC };
		const enq = await call(noAdmin, "/recovery/enqueue", { method: "POST", body: "{}" });
		expect(enq!.status).toBe(404);
		const st = await call(noAdmin, "/recovery/status?node_id=owl-tegu", { method: "GET" });
		expect(st!.status).toBe(404);
		const { body, sig } = await checkinBody(noAdmin);
		expect((await checkin(noAdmin, body, sig))!.status).toBe(200);
	});

	it("status read returns last-seen health + pending depth", async () => {
		const { body, sig } = await checkinBody(env);
		await checkin(env, body, sig);
		const res = await call(env, "/recovery/status?node_id=owl-tegu", { method: "GET", headers: { authorization: `Bearer ${ADMIN}` } });
		expect(res!.status).toBe(200);
		const j = await (res!.json() as any);
		expect(j.status.node_id).toBe("owl-tegu");
		expect(j.pending_commands).toBe(0);
	});

	it("rejects a malformed node_id (KV key-injection guard)", async () => {
		const { body, sig } = await checkinBody(env, { node_id: "a:b/../c" });
		const res = await checkin(env, body, sig);
		expect(res!.status).toBe(400);
		expect((await (res!.json() as any)).error).toBe("bad_node_id");
	});

	it("exposes exactly the intended allow-list", () => {
		expect([...RECOVERY_ACTIONS]).toEqual(["open-wan-ssh", "close-wan-ssh", "restart-tailscale", "restart-dns", "restore-config", "reboot", "noop"]);
	});
});
