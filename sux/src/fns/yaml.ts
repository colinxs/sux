import { type Fn, fail, ok } from "../registry";
import { isEmptyJsonData, resolveJsonData, toYaml } from "./_convert";

// yaml(x): serialize a JSON document TO YAML. Inverse of json(); compose as
// yaml(...) over json(...) to round-trip. Practical common subset (scalars,
// nested maps, block sequences) — no anchors/aliases or multiline scalars.

export const yaml: Fn = {
	name: "yaml",
	description: "Convert JSON to YAML (a practical common subset: scalars, nested maps, block sequences). Inverse of json(). No anchors/aliases or block scalars.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "JSON text to convert to YAML (a real object/array is also accepted)." },
		},
	},
	cacheable: true,
	ttl: 86400, // pure deterministic converter — same input always yields the same YAML
	run: async (_env, args) => {
		if (isEmptyJsonData(args?.data)) return fail("`data` is required.");
		try {
			return ok(toYaml(resolveJsonData(args?.data)));
		} catch (e) {
			return fail(`yaml failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
