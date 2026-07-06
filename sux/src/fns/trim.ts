import { type Fn, fail, ok } from "../registry";

type Side = "start" | "end" | "both";

/** Remove `n` characters from the chosen side(s). "both" drops n from each end. */
function removeChars(text: string, n: number, side: Side): string {
	if (n <= 0) return text;
	if (side === "start") return text.slice(n);
	if (side === "end") return text.slice(0, Math.max(0, text.length - n));
	return text.slice(n, Math.max(n, text.length - n)); // both
}

/** Clean up a document's whitespace and find its content edges: strip trailing
 * whitespace per line, drop leading/trailing blank lines, optionally remove the
 * common leading indentation, then trim the requested outer edge(s). */
function trimEdges(text: string, side: Side, dedent: boolean): string {
	let lines = text.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));
	// Drop leading/trailing blank lines.
	while (lines.length && lines[0] === "") lines.shift();
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	if (dedent) {
		const indents = lines.filter((l) => l !== "").map((l) => l.match(/^[ \t]*/)![0].length);
		const common = indents.length ? Math.min(...indents) : 0;
		if (common > 0) lines = lines.map((l) => (l === "" ? l : l.slice(common)));
	}
	let out = lines.join("\n");
	if (side === "start") out = out.replace(/^\s+/, "");
	else if (side === "end") out = out.replace(/\s+$/, "");
	else out = out.trim();
	return out;
}

export const trim: Fn = {
	name: "trim",
	description:
		"Trim or shorten text. Three modes, chosen by which option is set: " +
		"(1) `remove` — drop that many characters from `side` (start | end | both); " +
		"(2) `limit` — hard-cut to at most that many characters (plain slice, no ellipsis — use `truncate` for budgeted/word/token cuts with an ellipsis); " +
		"(3) default (neither) — clean a document's whitespace: strip trailing whitespace per line, drop leading/trailing blank lines, and trim the outer edge(s); set `dedent` to also remove common leading indentation. Returns the trimmed text.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The text to trim." },
			remove: { type: "integer", minimum: 0, description: "Number of characters to remove from `side`." },
			limit: { type: "integer", minimum: 0, description: "Keep at most this many characters (sliced from the start)." },
			side: { type: "string", enum: ["start", "end", "both"], description: "Which end(s) to act on. Default 'end' for `remove`, 'both' for whitespace trimming." },
			dedent: { type: "boolean", description: "In whitespace mode, also remove the common leading indentation. Default false.", default: false },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.text !== "string") return fail("`text` must be a string.");
		const text = args.text;
		const hasRemove = args?.remove !== undefined && args?.remove !== null;
		const hasLimit = args?.limit !== undefined && args?.limit !== null;
		if (hasRemove && hasLimit) return fail("Provide either `remove` or `limit`, not both.");

		if (hasRemove) {
			if (!Number.isInteger(args.remove) || args.remove < 0) return fail("`remove` must be a non-negative integer.");
			const side = (args?.side ?? "end") as Side;
			if (!["start", "end", "both"].includes(side)) return fail("`side` must be start, end, or both.");
			return ok(removeChars(text, args.remove, side));
		}
		if (hasLimit) {
			if (!Number.isInteger(args.limit) || args.limit < 0) return fail("`limit` must be a non-negative integer.");
			return ok(text.slice(0, args.limit));
		}
		const side = (args?.side ?? "both") as Side;
		if (!["start", "end", "both"].includes(side)) return fail("`side` must be start, end, or both.");
		return ok(trimEdges(text, side, args?.dedent === true));
	},
};
