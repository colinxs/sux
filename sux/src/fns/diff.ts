import { type Fn, fail, ok } from "../registry";

type Op = { tag: " " | "-" | "+"; line: string };

/** LCS-based line diff of two arrays, yielding a sequence of context/removed/added ops. */
function lineDiff(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	// dp[i][j] = LCS length of a[i:] and b[j:].
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ tag: " ", line: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ tag: "-", line: a[i] });
			i++;
		} else {
			out.push({ tag: "+", line: b[j] });
			j++;
		}
	}
	while (i < n) out.push({ tag: "-", line: a[i++] });
	while (j < m) out.push({ tag: "+", line: b[j++] });
	return out;
}

/** Keep only context lines within `context` of a change; collapse the rest with `…`. */
function trimContext(ops: Op[], context: number): string[] {
	const keep = new Array<boolean>(ops.length).fill(false);
	for (let k = 0; k < ops.length; k++) {
		if (ops[k].tag !== " ") {
			for (let d = -context; d <= context; d++) {
				const idx = k + d;
				if (idx >= 0 && idx < ops.length) keep[idx] = true;
			}
		}
	}
	const lines: string[] = [];
	let gap = false;
	for (let k = 0; k < ops.length; k++) {
		if (keep[k]) {
			lines.push(`${ops[k].tag} ${ops[k].line}`);
			gap = false;
		} else if (!gap) {
			lines.push("…");
			gap = true;
		}
	}
	return lines;
}

export const diff: Fn = {
	name: "diff",
	description:
		"Line-level diff of two texts via LCS. Returns a unified-style listing where each line is prefixed with ' ' (unchanged), '-' (removed from a) or '+' (added in b), preceded by a summary line `{added, removed}`. `context` (optional) limits how many unchanged lines surround each change — omit to show every line; 0 shows only changes.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["a", "b"],
		properties: {
			a: { type: "string", description: "Original text." },
			b: { type: "string", description: "Changed text." },
			context: { type: "integer", minimum: 0, description: "Unchanged lines of context to keep around each change. Omit for full context." },
		},
	},
	cacheable: true,
	raw: true,
	run: async (_env, args) => {
		if (typeof args?.a !== "string") return fail("`a` must be a string.");
		if (typeof args?.b !== "string") return fail("`b` must be a string.");
		const a = args.a.split(/\r?\n/);
		const b = args.b.split(/\r?\n/);
		const ops = lineDiff(a, b);
		const added = ops.reduce((c, o) => c + (o.tag === "+" ? 1 : 0), 0);
		const removed = ops.reduce((c, o) => c + (o.tag === "-" ? 1 : 0), 0);
		const summary = JSON.stringify({ added, removed });
		if (!added && !removed) return ok(`${summary}\n(identical)`);
		const hasContext = typeof args?.context === "number" && Number.isFinite(args.context);
		const body = hasContext ? trimContext(ops, Math.max(0, Math.trunc(args.context))) : ops.map((o) => `${o.tag} ${o.line}`);
		return ok(`${summary}\n${body.join("\n")}`);
	},
};
