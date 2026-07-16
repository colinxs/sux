import { type Fn, fail, ok } from "../registry";
import { detectFormat, type Format, parseSource } from "./_convert";
import { errMsg } from "./_util";

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
			data: { type: "string", description: "The source document (a real object/array is also accepted when `from` is 'json' or 'auto')." },
			from: { type: "string", enum: ["auto", "json", "yaml", "csv", "xml"], default: "auto", description: "Source format; auto-detected by default." },
			delimiter: { type: "string", description: "csv field delimiter (default ',').", default: "," },
			indent: { type: "integer", minimum: 0, maximum: 8, default: 2, description: "Spaces of indentation (0 = compact)." },
		},
	},
	cacheable: true,
	ttl: 86400, // pure deterministic converter — same input always yields the same JSON
	run: async (_env, args) => {
		const from = (args?.from ?? "auto") as Format | "auto";
		const raw = args?.data;
		const indent = args?.indent === undefined ? 2 : Math.max(0, Math.min(8, Number(args.indent)));
		// A tool-caller naturally passes a real object/array for a param described
		// as "the source document" rather than pre-stringifying it. That's only
		// sensible when the source format IS json (String(obj) -> "[object Object]"
		// would otherwise fail to parse as yaml/csv/xml with a confusing error), so
		// pass it through directly there and reject the mismatched case clearly.
		if (raw !== null && typeof raw === "object") {
			if (from !== "auto" && from !== "json")
				return fail(`\`data\` is an object, but from:'${from}' expects ${from} text — pass a JSON string, or use from:'json' (or omit \`from\`) to convert it as-is.`);
			return ok(JSON.stringify(raw, null, indent));
		}
		const data = String(raw ?? "");
		if (!data.trim()) return fail("`data` is required.");
		const src: Format = from === "auto" ? detectFormat(data) : from;
		if (!SUPPORTED.includes(src)) return fail(`Unsupported source '${src}' — supported: ${SUPPORTED.join(", ")}.`);
		try {
			const value = parseSource(data, src, { delimiter: args?.delimiter });
			// Auto-detect falls through to YAML for unstructured input (e.g. plain
			// prose), which parses to an empty map. Returning "{}" would silently
			// discard the input, so surface the mis-detection as an error instead.
			if (from === "auto" && src === "yaml" && value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
				return fail("Could not detect the source format (parsed to empty). Pass an explicit `from` (json/yaml/csv/xml).");
			}
			return ok(JSON.stringify(value, null, indent));
		} catch (e) {
			return fail(`json (from ${src}) failed: ${errMsg(e)}`);
		}
	},
};
