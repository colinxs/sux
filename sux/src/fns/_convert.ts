// Shared conversion core for the directional, output-named converters
// (json/yaml/csv/xml/markdown). Each converter fn dispatches on the SOURCE type
// (Julia-style multiple dispatch: `json(x)` parses whatever x is; `yaml(x)`
// serialises x to YAML), and bidirectionality falls out of composing them
// (`yaml(json(x))`).
//
// The actual json/yaml/csv/xml parse/serialize logic now lives in @suxos/lib's
// domain/transform.ts (absorbed there from sux-fileops, which had itself
// ported this file nearly verbatim) — this file re-exports it so call sites
// here don't break. The suxlib version is a merge of this file's original
// logic and the fileops fork's independent hardening (bomb guards, prototype-
// pollution guards, safer CSV escaping — see suxlib's transform.ts header for
// the full list), so it is not byte-identical to what used to live here.
//
// resolveJsonData/isEmptyJsonData stay local: they're MCP-argument coercion
// helpers specific to how sux's LLM tool-callers pass JSON, not file-ops logic.

export { detectFormat, toYaml, parseYaml, parseCsv, csvToRows, toCsv, parseXml, toXml, parseSource } from "@suxos/lib";

export type Format = "json" | "yaml" | "csv" | "xml";

/** csv/yaml/xml declare `data` as a pre-stringified JSON string, but an LLM
 * tool-caller naturally passes a real object/array for a param described as
 * "a JSON array/document" instead. String(obj) coerces that to the literal
 * "[object Object]", which then fails JSON.parse with a message that gives no
 * hint what went wrong — so accept the object directly instead of coercing it. */
export function resolveJsonData(raw: unknown): unknown {
	if (raw !== null && typeof raw === "object") return raw;
	return JSON.parse(String(raw ?? ""));
}

/** True when `raw` has nothing usable for resolveJsonData — an object/array is
 * always usable, so only an empty/missing string counts as "no data". */
export function isEmptyJsonData(raw: unknown): boolean {
	return raw === undefined || raw === null || (typeof raw !== "object" && !String(raw).trim());
}
