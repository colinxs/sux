import { test, expect } from "vitest";
import type { Caps, Handle } from "@suxos/lib";
import { makeCaps } from "./caps.js";
import type { RtEnv } from "../registry.js";

// Fake R2: just enough of the head/get/put surface makeSinks touches.
test("sinks re-address a Handle (r2 -> published/) and a {summaryHandle} (vault -> vault/)", async () => {
	const objs = new Map<string, Uint8Array>();
	const R2 = {
		head: async (k: string) => (objs.has(k) ? {} : null),
		get: async (k: string) => (objs.has(k) ? { arrayBuffer: async () => objs.get(k)!.buffer } : null),
		put: async (k: string, v: Uint8Array) => void objs.set(k, v),
	};
	const handle: Handle = { r2Key: "cas/abc", sha256: "abc", type: "text/plain", size: 5 };
	objs.set(handle.r2Key, new TextEncoder().encode("hello"));

	const { sinks } = makeCaps({ R2 } as unknown as RtEnv);
	await sinks.r2.write(handle, {} as Caps);
	await sinks.vault.write({ summaryHandle: handle }, {} as Caps);

	expect(objs.has(`published/${handle.sha256}`)).toBe(true);
	expect(objs.has(`vault/${handle.sha256}`)).toBe(true);
});
