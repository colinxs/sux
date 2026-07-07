import { describe, expect, it } from "vitest";
import { singleFlight } from "./single-flight";

const deferred = <T>() => {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

describe("singleFlight", () => {
	it("collapses concurrent same-key calls to one execution, sharing the result", async () => {
		const inflight = new Map<string, Promise<number>>();
		let runs = 0;
		const d = deferred<number>();
		const thunk = () => {
			runs++;
			return d.promise;
		};
		const a = singleFlight(inflight, "k", thunk);
		const b = singleFlight(inflight, "k", thunk);
		const c = singleFlight(inflight, "k", thunk);
		expect(runs).toBe(1); // only the leader ran
		d.resolve(42);
		expect(await Promise.all([a, b, c])).toEqual([42, 42, 42]);
	});

	it("runs different keys independently", async () => {
		const inflight = new Map<string, Promise<string>>();
		let runs = 0;
		const mk = (v: string) => () => {
			runs++;
			return Promise.resolve(v);
		};
		expect(await Promise.all([singleFlight(inflight, "a", mk("A")), singleFlight(inflight, "b", mk("B"))])).toEqual(["A", "B"]);
		expect(runs).toBe(2);
	});

	it("clears the entry after settling so the next call re-runs", async () => {
		const inflight = new Map<string, Promise<number>>();
		let runs = 0;
		const thunk = () => Promise.resolve(++runs);
		expect(await singleFlight(inflight, "k", thunk)).toBe(1);
		expect(inflight.has("k")).toBe(false);
		expect(await singleFlight(inflight, "k", thunk)).toBe(2); // fresh run
	});

	it("propagates a rejection to every awaiter and still clears the entry", async () => {
		const inflight = new Map<string, Promise<number>>();
		const d = deferred<number>();
		const a = singleFlight(inflight, "k", () => d.promise);
		const b = singleFlight(inflight, "k", () => d.promise);
		d.reject(new Error("boom"));
		await expect(a).rejects.toThrow("boom");
		await expect(b).rejects.toThrow("boom");
		await Promise.resolve(); // let the cleanup microtask run
		expect(inflight.has("k")).toBe(false);
	});
});
