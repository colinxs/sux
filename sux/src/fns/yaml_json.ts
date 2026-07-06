import { type Fn, fail, ok } from "../registry";

function jsonToYaml(v: any, indent = 0): string {
	const pad = "  ".repeat(indent);
	if (v === null) return "null";
	if (Array.isArray(v)) {
		if (!v.length) return "[]";
		return v.map((item) => `${pad}- ${jsonToYaml(item, indent + 1).replace(/^\s+/, "")}`).join("\n");
	}
	if (typeof v === "object") {
		const keys = Object.keys(v);
		if (!keys.length) return "{}";
		return keys
			.map((k) => {
				const val = v[k];
				if (val && typeof val === "object" && Object.keys(val).length) return `${pad}${k}:\n${jsonToYaml(val, indent + 1)}`;
				return `${pad}${k}: ${jsonToYaml(val, indent + 1)}`;
			})
			.join("\n");
	}
	if (typeof v === "string") return /[:#\-?\[\]{}&*!|>'"%@`\n]|^\s|\s$/.test(v) || v === "" ? JSON.stringify(v) : v;
	return String(v);
}

function scalar(s: string): any {
	s = s.trim();
	if (s === "" || s === "~" || s === "null") return null;
	if (s === "true") return true;
	if (s === "false") return false;
	if (/^-?\d+$/.test(s)) return parseInt(s, 10);
	if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		try { return JSON.parse(s.replace(/^'|'$/g, '"')); } catch { return s.slice(1, -1); }
	}
	if (s.startsWith("[") || s.startsWith("{")) {
		try { return JSON.parse(s); } catch { /* fall through */ }
	}
	return s;
}

function yamlToJson(text: string): any {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
	let i = 0;
	function parseBlock(minIndent: number): any {
		const first = lines[i];
		if (first === undefined) return null;
		const isList = /^\s*-\s/.test(first) || /^\s*-\s*$/.test(first);
		if (isList) {
			const arr: any[] = [];
			while (i < lines.length) {
				const line = lines[i];
				const ind = line.match(/^\s*/)![0].length;
				if (ind < minIndent || !/^\s*-/.test(line)) break;
				const rest = line.replace(/^\s*-\s?/, "");
				i++;
				if (rest.includes(":") && !/^["'\[{]/.test(rest.trim())) {
					// inline map start on the dash line
					const obj: any = {};
					const [k, ...v] = rest.split(":");
					obj[k.trim()] = v.join(":").trim() ? scalar(v.join(":")) : parseBlock(ind + 1);
					mergeMap(obj, ind);
					arr.push(obj);
				} else arr.push(rest.trim() ? scalar(rest) : parseBlock(ind + 1));
			}
			return arr;
		}
		const obj: any = {};
		mergeMap(obj, minIndent);
		return obj;
	}
	function mergeMap(obj: any, minIndent: number) {
		while (i < lines.length) {
			const line = lines[i];
			const ind = line.match(/^\s*/)![0].length;
			if (ind < minIndent || /^\s*-/.test(line)) break;
			const m = line.match(/^\s*([^:]+):\s?(.*)$/);
			if (!m) break;
			i++;
			const key = m[1].trim();
			if (m[2].trim() === "") obj[key] = parseBlock(ind + 1);
			else obj[key] = scalar(m[2]);
		}
	}
	return parseBlock(0);
}

export const yamlJson: Fn = {
	name: "yaml_json",
	description: "Convert YAML ↔ JSON. direction: to_json (default) | to_yaml. YAML→JSON covers the common subset (nested maps, lists, scalars, quotes, comments); anchors and block-scalars are not supported.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string" },
			direction: { type: "string", enum: ["to_json", "to_yaml"], default: "to_json" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("Provide `data`.");
		try {
			if (String(args?.direction ?? "to_json") === "to_yaml") return ok(jsonToYaml(JSON.parse(data)));
			return ok(JSON.stringify(yamlToJson(data), null, 2));
		} catch (e) {
			return fail(`Conversion failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
