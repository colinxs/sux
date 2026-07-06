import { describe, expect, it } from "vitest";
import { parseYaml, toYaml } from "./_convert";

describe("parseYaml (zero-indent sequences under a mapping key)", () => {
	it("parses a sequence at the same indent as its key", () => {
		expect(parseYaml("key:\n- a\n- b")).toEqual({ key: ["a", "b"] });
	});

	it("preserves sibling keys after a zero-indent sequence (GitHub-Actions style)", () => {
		expect(parseYaml("on:\n- push\nname: ci")).toEqual({ on: ["push"], name: "ci" });
	});

	it("handles nested zero-relative-indent sequences (kubernetes style)", () => {
		const doc = "spec:\n  containers:\n  - name: app\n    image: nginx\n  restartPolicy: Always";
		expect(parseYaml(doc)).toEqual({
			spec: { containers: [{ name: "app", image: "nginx" }], restartPolicy: "Always" },
		});
	});

	it("still parses indented sequences and empty-value keys as before", () => {
		expect(parseYaml("key:\n  - a\n  - b")).toEqual({ key: ["a", "b"] });
		expect(parseYaml("key:\nnext: 1")).toEqual({ key: {}, next: 1 });
	});
});

describe("toYaml (multiline strings)", () => {
	it("quotes strings containing newlines so the output stays valid YAML", () => {
		const y = toYaml({ note: "line1\nline2" });
		expect(y).toBe('note: "line1\\nline2"');
	});

	it("round-trips strings with \\n, \\r and \\t", () => {
		const obj = { note: "line1\nline2", crlf: "a\r\nb", tabbed: "a\tb" };
		expect(parseYaml(toYaml(obj))).toEqual(obj);
	});
});
