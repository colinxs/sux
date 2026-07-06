import { type Fn, fail, ok } from "../registry";

function lineDiff(a: string[], b: string[]): string[] {
	const n = a.length, m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out: string[] = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
		else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${a[i]}`); i++; }
		else { out.push(`+ ${b[j]}`); j++; }
	}
	while (i < n) out.push(`- ${a[i++]}`);
	while (j < m) out.push(`+ ${b[j++]}`);
	return out;
}

export const diff: Fn = {
	name: "diff",
	description: "Line-level diff between two texts. Returns a unified-style listing (' ' unchanged, '-' removed from a, '+' added in b) plus counts. only_changes=true omits unchanged context lines.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["a", "b"],
		properties: {
			a: { type: "string", description: "Original text." },
			b: { type: "string", description: "Changed text." },
			only_changes: { type: "boolean", default: false },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const a = String(args?.a ?? "").split(/\r?\n/);
		const b = String(args?.b ?? "").split(/\r?\n/);
		let lines = lineDiff(a, b);
		const added = lines.filter((l) => l.startsWith("+ ")).length;
		const removed = lines.filter((l) => l.startsWith("- ")).length;
		if (args?.only_changes === true) lines = lines.filter((l) => !l.startsWith("  "));
		if (!added && !removed) return ok("(identical)");
		return ok(`@@ +${added} -${removed} @@\n${lines.join("\n")}`);
	},
};
