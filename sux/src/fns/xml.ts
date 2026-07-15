import { type Fn, fail, ok } from "../registry";
import { isEmptyJsonData, resolveJsonData, toXml } from "./_convert";

// xml(x): serialize a JSON document TO XML. Inverse of json(from:'xml').
// Attributes come from '@attr' keys, text from '#text'; arrays repeat the tag.

export const xml: Fn = {
	name: "xml",
	description:
		"Convert JSON to XML. '@attr' keys become attributes, '#text' becomes text, arrays repeat their tag, and entities are escaped. Inverse of json({from:'xml'}). (Namespaces kept verbatim; mixed text+element order not preserved.)",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "JSON text to convert to XML (a real object/array is also accepted)." },
		},
	},
	cacheable: true,
	ttl: 86400, // pure deterministic converter — same input always yields the same XML
	run: async (_env, args) => {
		if (isEmptyJsonData(args?.data)) return fail("`data` is required.");
		try {
			return ok(toXml(resolveJsonData(args?.data)));
		} catch (e) {
			return fail(`xml failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
