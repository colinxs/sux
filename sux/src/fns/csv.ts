import { type Fn, fail, ok } from "../registry";
import { isEmptyJsonData, resolveJsonData, toCsv } from "./_convert";

// csv(x): serialize a JSON array of objects TO CSV. Inverse of json(from:'csv').
// Compose json({from:'csv'}) then csv(...) to round-trip a spreadsheet.

export const csv: Fn = {
	name: "csv",
	description:
		"Convert a JSON array of objects to CSV. `delimiter` defaults to ','. Header row = union of keys (in first-seen order); object/array values are JSON-stringified; fields needing it are RFC4180-quoted. Inverse of json({from:'csv'}).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "A JSON array of objects (a real array/object is also accepted)." },
			delimiter: { type: "string", description: "Single-character field delimiter.", default: "," },
		},
	},
	cacheable: true,
	ttl: 86400, // pure deterministic converter — same input always yields the same CSV
	run: async (_env, args) => {
		if (isEmptyJsonData(args?.data)) return fail("`data` is required.");
		const delim = String(args?.delimiter ?? ",").slice(0, 1) || ",";
		try {
			const arr = resolveJsonData(args?.data);
			if (!Array.isArray(arr)) return fail("csv expects a JSON array of objects.");
			// Headers come only from object keys; a scalar (or array) element would
			// silently serialise to a zero-column row and drop all its data. Reject
			// such elements up front so the loss surfaces as an error, not blank lines.
			if (arr.some((el) => !el || typeof el !== "object" || Array.isArray(el)))
				return fail("csv expects a JSON array of objects; found a non-object element.");
			return ok(toCsv(arr, delim));
		} catch (e) {
			return fail(`csv failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
