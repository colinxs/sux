import { type Fn, fail, ok } from "../registry";
import { detectFormat, type Format, parseSource } from "./_convert";

// json(x): convert a source document TO JSON, dispatching on the source format
// (auto-detected, or forced with `from`). The inverse converters are yaml()/csv()
// /xml(); bidirectionality comes from composing them.

const SUPPORTED: Format[] = ["json", "yaml"]; // csv/xml land with their converters

export const json: Fn = {
	name: "json",
	description:
		"Convert a document to JSON. `from`: auto (default — detects yaml/json) | json | yaml. (csv/xml sources arrive with the csv()/xml() converters.) " +
		"Returns pretty-printed JSON. Inverse of yaml(); compose them to round-trip.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "The source document." },
			from: { type: "string", enum: ["auto", "json", "yaml"], default: "auto", description: "Source format; auto-detected by default." },
			indent: { type: "integer", minimum: 0, maximum: 8, default: 2, description: "Spaces of indentation (0 = compact)." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("`data` is required.");
		const from = (args?.from ?? "auto") as Format | "auto";
		const src: Format = from === "auto" ? detectFormat(data) : from;
		if (!SUPPORTED.includes(src)) return fail(`Source format '${src}' isn't supported yet — supported: ${SUPPORTED.join(", ")}.`);
		const indent = args?.indent === undefined ? 2 : Math.max(0, Math.min(8, Number(args.indent)));
		try {
			const value = parseSource(data, src);
			return ok(JSON.stringify(value, null, indent));
		} catch (e) {
			return fail(`json (from ${src}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
