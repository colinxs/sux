import { type Fn, fail, ok } from "../registry";
import { detectFormat, type Format, parseSource } from "./_convert";

// json(x): convert a source document TO JSON, dispatching on the source format
// (auto-detected, or forced with `from`). The inverse converters are yaml()/csv()
// /xml(); bidirectionality comes from composing them.

const SUPPORTED: Format[] = ["json", "yaml", "csv", "xml"];

export const json: Fn = {
	name: "json",
	description:
		"Convert a document to JSON, dispatching on the source format. `from`: auto (default — detects json/yaml/csv/xml) | json | yaml | csv | xml. `delimiter` applies to csv (default ','). " +
		"Returns pretty-printed JSON. Inverse converters are yaml()/csv()/xml(); compose them to round-trip.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "The source document." },
			from: { type: "string", enum: ["auto", "json", "yaml", "csv", "xml"], default: "auto", description: "Source format; auto-detected by default." },
			delimiter: { type: "string", description: "csv field delimiter (default ',').", default: "," },
			indent: { type: "integer", minimum: 0, maximum: 8, default: 2, description: "Spaces of indentation (0 = compact)." },
		},
	},
	cacheable: true,
	ttl: 86400, // pure deterministic converter — same input always yields the same JSON
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("`data` is required.");
		const from = (args?.from ?? "auto") as Format | "auto";
		const src: Format = from === "auto" ? detectFormat(data) : from;
		if (!SUPPORTED.includes(src)) return fail(`Unsupported source '${src}' — supported: ${SUPPORTED.join(", ")}.`);
		const indent = args?.indent === undefined ? 2 : Math.max(0, Math.min(8, Number(args.indent)));
		try {
			const value = parseSource(data, src, { delimiter: args?.delimiter });
			return ok(JSON.stringify(value, null, indent));
		} catch (e) {
			return fail(`json (from ${src}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
