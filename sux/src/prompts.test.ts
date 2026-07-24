import { describe, it, expect } from "vitest";
import { PROMPTS } from "./prompts";
import { DATA_OPEN, DATA_CLOSE } from "./ai";

// The conformance gate for the prompt registry (docs/knowledge/prompt-engineering.md §6).
// Every migrated prompt must pass this, so a malformed record — or one that would break the
// injection fence — fails CI rather than shipping.

const RUNNERS = new Set(["workers-ai", "claude", "openai", "gemini"]);
const DIFFICULTIES = new Set(["trivial", "standard", "hard"]);
const METRICS = new Set(["exact", "label", "faithfulness", "format", "judge"]);
const STATES = new Set(["fluid", "crystallized"]);
const ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

const records = Object.values(PROMPTS);

describe("prompts registry conformance", () => {
	it("has at least the three landed exemplars", () => {
		expect(records.length).toBeGreaterThanOrEqual(3);
	});

	it("keys the registry by each record's own id", () => {
		for (const [key, rec] of Object.entries(PROMPTS)) expect(key).toBe(rec.id);
	});

	it("has unique, well-formed dotted ids", () => {
		const ids = records.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(ID_RE);
	});

	for (const rec of records) {
		describe(rec.id, () => {
			it("has a non-empty, trimmed system and task", () => {
				expect(rec.system.length).toBeGreaterThan(0);
				expect(rec.system).toBe(rec.system.trim());
				expect(rec.task.length).toBeGreaterThan(0);
				expect(rec.task).toBe(rec.task.trim());
			});

			it("has a positive maxTokens and valid enums", () => {
				expect(rec.maxTokens).toBeGreaterThan(0);
				expect(RUNNERS.has(rec.runner)).toBe(true);
				expect(DIFFICULTIES.has(rec.difficulty)).toBe(true);
				expect(METRICS.has(rec.metric)).toBe(true);
				expect(STATES.has(rec.state)).toBe(true);
			});

			// The load-bearing rule (standard §4): a system prompt must never contain the
			// injection-fence markers, or untrusted content could break out of the fence.
			it("does not contain the injection-fence markers", () => {
				expect(rec.system.includes(DATA_OPEN)).toBe(false);
				expect(rec.system.includes(DATA_CLOSE)).toBe(false);
			});

			it("is frozen", () => {
				expect(Object.isFrozen(rec)).toBe(true);
			});
		});
	}
});
