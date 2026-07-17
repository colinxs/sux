import { test, expect } from "vitest";
import { decodeEmbedding, encodeEmbedding } from "./_embed.js";

test("encodeEmbedding/decodeEmbedding round-trips a vector at float32 precision", () => {
	const vec = [0.1, -0.05234062671661377, 1, -1, 0];
	const packed = encodeEmbedding(vec);
	expect(typeof packed).toBe("string");
	const back = decodeEmbedding(packed);
	expect(back).toHaveLength(vec.length);
	back.forEach((v, i) => expect(v).toBeCloseTo(vec[i], 6));
});

test("encodeEmbedding packs a 768-dim vector far smaller than its JSON form", () => {
	const vec = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.5);
	const packed = encodeEmbedding(vec);
	expect(packed.length).toBeLessThan(JSON.stringify(vec).length / 2);
	expect(decodeEmbedding(packed)).toHaveLength(768);
});

test("encodeEmbedding of an empty vector round-trips to an empty array", () => {
	expect(decodeEmbedding(encodeEmbedding([]))).toEqual([]);
});
