import { test, expect } from "vitest";
import { runVerb } from "./run.js";

// The inline path needs no bindings (echo is a pure leaf), so an empty env exercises
// the whole runVerb → runInline → op path in plain node vitest.
test("run executes a registered op inline", async () => {
	const res = await runVerb({ op: "echo", input: "hi", mode: "inline" }, {} as any);
	expect(res).toBe("hi");
});

test("run auto-routes a simple (no fan-out / no ask) op to the inline path", async () => {
	const res = await runVerb({ op: "echo", input: { a: 1 }, mode: "auto" }, {} as any);
	expect(res).toEqual({ a: 1 });
});

test("run rejects an unknown op", async () => {
	await expect(runVerb({ op: "nope", input: 1, mode: "inline" }, {} as any)).rejects.toThrow(/unknown op/);
});
