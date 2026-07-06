import { type Fn, fail, ok } from "../registry";

function parseXml(xml: string): any {
	xml = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
	let pos = 0;
	function parseNode(): any {
		const node: any = {};
		while (pos < xml.length) {
			const lt = xml.indexOf("<", pos);
			if (lt === -1) break;
			const text = xml.slice(pos, lt).trim();
			if (text) node["#text"] = (node["#text"] ?? "") + text;
			if (xml[lt + 1] === "/") {
				pos = xml.indexOf(">", lt) + 1;
				return node;
			}
			const gt = xml.indexOf(">", lt);
			const tagContent = xml.slice(lt + 1, gt);
			const selfClose = tagContent.endsWith("/");
			const clean = selfClose ? tagContent.slice(0, -1) : tagContent;
			const name = clean.match(/^([\w:.-]+)/)![1];
			const attrs: any = {};
			for (const a of clean.matchAll(/([\w:.-]+)\s*=\s*["']([^"']*)["']/g)) attrs["@" + a[1]] = a[2];
			pos = gt + 1;
			let child: any = selfClose ? (Object.keys(attrs).length ? attrs : "") : (() => { const c = parseNode(); return { ...attrs, ...normalize(c) }; })();
			if (child && typeof child === "object" && Object.keys(child).length === 1 && "#text" in child) child = child["#text"];
			if (name in node) { if (!Array.isArray(node[name])) node[name] = [node[name]]; node[name].push(child); }
			else node[name] = child;
		}
		return node;
	}
	function normalize(n: any) {
		if (n && typeof n === "object" && "#text" in n && Object.keys(n).length === 1) return n["#text"];
		return n;
	}
	return parseNode();
}

function toXml(obj: any, name?: string): string {
	if (obj == null) return name ? `<${name}/>` : "";
	if (Array.isArray(obj)) return obj.map((v) => toXml(v, name)).join("");
	if (typeof obj === "object") {
		const attrs = Object.entries(obj).filter(([k]) => k.startsWith("@")).map(([k, v]) => ` ${k.slice(1)}="${v}"`).join("");
		const inner = Object.entries(obj)
			.filter(([k]) => !k.startsWith("@"))
			.map(([k, v]) => (k === "#text" ? String(v) : toXml(v, k)))
			.join("");
		return name ? `<${name}${attrs}>${inner}</${name}>` : inner;
	}
	const esc = String(obj).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return name ? `<${name}>${esc}</${name}>` : esc;
}

export const xmlJson: Fn = {
	name: "xml_json",
	description: "Convert XML ↔ JSON. direction: to_json (default; attributes under '@name', text under '#text', repeated tags → arrays) | to_xml (give JSON). ",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string" },
			direction: { type: "string", enum: ["to_json", "to_xml"], default: "to_json" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("Provide `data`.");
		try {
			if (String(args?.direction ?? "to_json") === "to_xml") return ok(toXml(JSON.parse(data)));
			return ok(JSON.stringify(parseXml(data), null, 2));
		} catch (e) {
			return fail(`Conversion failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
