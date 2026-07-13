#!/usr/bin/env node
// Lints the description strings of namespaceFn() dispatchers (sux/src/fns/vault.ts,
// mail.ts, files.ts, calendar.ts, contact.ts) against the real inputSchema of the
// namespace tool each documented example call resolves to. Catches the class of bug
// fixed in #202/#205/#206: a description example naming a param the target tool's
// schema doesn't actually have.
//
// Universal args (stage/commit_token/force/confirm) are excluded — they're legitimately
// present across many *-mcp.ts tool schemas without needing per-tool documentation.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");
const FNS_DIR = join(SRC, "fns");

const UNIVERSAL_ARGS = new Set(["stage", "commit_token", "force", "confirm"]);

const MCP_FILES = ["vault-mcp.ts", "mail-mcp.ts", "files-mcp.ts"].map((f) => join(SRC, f));

function loadMcpSource() {
	let combined = "";
	for (const f of MCP_FILES) combined += readFileSync(f, "utf8") + "\n";
	return combined;
}

// Extract inputSchema.properties keys for every `name: "toolname"` tool object in the
// combined *-mcp.ts source. Tool objects are single-line-ish records; we scan forward
// from each `name: "x"` to the next `inputSchema: { ... }` (balanced braces) that
// precedes the next `name: "` occurrence, and pull top-level `properties: { ... }` keys.
function extractToolSchemas(src) {
	const schemas = new Map();
	const nameRe = /name:\s*"([a-zA-Z_][\w]*)"/g;
	let m;
	const matches = [];
	while ((m = nameRe.exec(src))) matches.push({ name: m[1], idx: m.index });

	for (let i = 0; i < matches.length; i++) {
		const { name, idx } = matches[i];
		const nextIdx = i + 1 < matches.length ? matches[i + 1].idx : src.length;
		const window = src.slice(idx, nextIdx);
		const schemaIdx = window.indexOf("inputSchema:");
		if (schemaIdx === -1) continue;
		const braceStart = window.indexOf("{", schemaIdx);
		if (braceStart === -1) continue;
		let depth = 0;
		let end = -1;
		for (let p = braceStart; p < window.length; p++) {
			if (window[p] === "{") depth++;
			else if (window[p] === "}") {
				depth--;
				if (depth === 0) {
					end = p;
					break;
				}
			}
		}
		if (end === -1) continue;
		const schemaText = window.slice(braceStart, end + 1);
		const propsIdx = schemaText.indexOf("properties:");
		if (propsIdx === -1) {
			schemas.set(name, new Set());
			continue;
		}
		const propsBraceStart = schemaText.indexOf("{", propsIdx);
		depth = 0;
		let propsEnd = -1;
		for (let p = propsBraceStart; p < schemaText.length; p++) {
			if (schemaText[p] === "{") depth++;
			else if (schemaText[p] === "}") {
				depth--;
				if (depth === 0) {
					propsEnd = p;
					break;
				}
			}
		}
		if (propsEnd === -1) continue;
		const propsText = schemaText.slice(propsBraceStart + 1, propsEnd);
		// Top-level keys only: `key: {` or `key: TYPE_CONST` at depth 0 within propsText.
		const keys = new Set();
		let d = 0;
		let tokenStart = 0;
		for (let p = 0; p < propsText.length; p++) {
			const c = propsText[p];
			if (c === "{" || c === "[") d++;
			else if (c === "}" || c === "]") d--;
			else if (c === "," && d === 0) {
				const tok = propsText.slice(tokenStart, p);
				const km = tok.match(/^\s*([a-zA-Z_$][\w$]*)\s*:/);
				if (km) keys.add(km[1]);
				tokenStart = p + 1;
			}
		}
		const lastTok = propsText.slice(tokenStart);
		const lastKm = lastTok.match(/^\s*([a-zA-Z_$][\w$]*)\s*:/);
		if (lastKm) keys.add(lastKm[1]);
		schemas.set(name, keys);
	}
	return schemas;
}

// Parse `actions: { ... }` object literal in a fns/*.ts file into a JS map of
// action -> Dispatch (string tool name, or {tool, inject}).
function extractActions(src) {
	const constMatch = src.match(/actions:\s*([A-Z_]+)\s*,/);
	// namespaceFn is always called with `actions: SOME_ACTIONS_CONST`; find that const's
	// own declaration in the same file.
	if (!constMatch) return {};
	const constName = constMatch[1];
	const declRe = new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*:\\s*Record<[^=]*>\\s*=\\s*\\{`);
	const declMatch = declRe.exec(src);
	if (!declMatch) return {};
	const braceStart = declMatch.index + declMatch[0].length - 1;
	let depth = 0;
	let end = -1;
	for (let p = braceStart; p < src.length; p++) {
		if (src[p] === "{") depth++;
		else if (src[p] === "}") {
			depth--;
			if (depth === 0) {
				end = p;
				break;
			}
		}
	}
	const body = src.slice(braceStart + 1, end);
	const actions = {};
	// Entries: `key: "tool_name",` or `key: { tool: "tool_name", inject: {...} },`
	const entryRe = /([a-zA-Z_][\w]*)\s*:\s*(?:"([\w]+)"|\{\s*tool:\s*"([\w]+)"[^}]*\})/g;
	let em;
	while ((em = entryRe.exec(body))) {
		const key = em[1];
		const tool = em[2] || em[3];
		actions[key] = tool;
	}
	return actions;
}

// Parse `verb({action:'xyz', p1, p2:'val', ...})` example calls out of a description
// string. Multiple examples may appear per description.
function extractExampleCalls(description) {
	const calls = [];
	const callRe = /(\w+)\(\{action:\s*'([\w]+)'([^}]*)\}\)/g;
	let cm;
	while ((cm = callRe.exec(description))) {
		const [, , action, rest] = cm;
		const params = [];
		const raw = rest.replace(/^,/, "").trim();
		if (raw) {
			for (const part of raw.split(",")) {
				const trimmed = part.trim();
				if (!trimmed) continue;
				const colonIdx = trimmed.indexOf(":");
				const paramName = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx).trim();
				if (/^[a-zA-Z_][\w]*$/.test(paramName)) params.push(paramName);
			}
		}
		calls.push({ action, params });
	}
	return calls;
}

function main() {
	const mcpSrc = loadMcpSource();
	const toolSchemas = extractToolSchemas(mcpSrc);

	const fnsFiles = readdirSync(FNS_DIR).filter((f) => ["vault.ts", "mail.ts", "files.ts", "calendar.ts", "contact.ts"].includes(f));

	const problems = [];

	for (const file of fnsFiles) {
		const path = join(FNS_DIR, file);
		const src = readFileSync(path, "utf8");
		const actions = extractActions(src);
		const descMatch = src.match(/description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/);
		if (!descMatch) {
			problems.push(`${file}: could not find description string`);
			continue;
		}
		const description = descMatch[1];
		const calls = extractExampleCalls(description);
		if (calls.length === 0) {
			problems.push(`${file}: no example calls found in description (parser may need updating)`);
			continue;
		}
		for (const { action, params } of calls) {
			const toolName = actions[action];
			if (!toolName) {
				problems.push(`${file}: example uses action '${action}' not present in this file's actions map`);
				continue;
			}
			const schemaKeys = toolSchemas.get(toolName);
			if (!schemaKeys) {
				problems.push(`${file}: target tool '${toolName}' (action '${action}') not found in vault-mcp.ts/mail-mcp.ts/files-mcp.ts`);
				continue;
			}
			for (const param of params) {
				if (UNIVERSAL_ARGS.has(param)) continue;
				if (param === "action") continue;
				if (!schemaKeys.has(param)) {
					problems.push(`${file}: description example \`${action}({..., ${param}, ...})\` — '${param}' is not in ${toolName}'s inputSchema.properties (has: ${[...schemaKeys].join(", ")})`);
				}
			}
		}
	}

	if (problems.length > 0) {
		console.error("dispatcher param-doc lint FAILED:\n");
		for (const p of problems) console.error(`  - ${p}`);
		console.error(`\n${problems.length} mismatch(es) found.`);
		process.exit(1);
	}

	console.log("dispatcher param-doc lint OK — all namespaceFn() description examples match their target tools' real schemas.");
	process.exit(0);
}

main();
