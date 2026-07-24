import { failWith, type Fn, invokeFn, type RtEnv, type ToolResult } from "../registry";

// A namespace tool (element of VAULT_TOOLS/MAIL_TOOLS/FILES_TOOLS) is shaped exactly
// like a leaf Fn's dispatch surface: a name + a run(env, args). We depend only on that.
type NsTool = { name: string; description: string; inputSchema: unknown; run: (env: RtEnv, a: any) => Promise<ToolResult> };

// How a front-door action maps to a namespace tool. A bare string names the tool
// 1:1; the object form re-injects an INNER `action` for the three namespace tools
// that carry their own action arg (mail_masked/mail_vacation/files_operate) — a
// verb-level {action} can't also carry a second `action` key, so those collapse into
// flattened verb actions (masked_create, vacation_set, operate_move) whose dispatch
// record re-adds the inner one.
export type Dispatch = string | { tool: string; inject?: Record<string, unknown> };

// The set of namespace tool names an action map reaches — the target of the
// completeness guard (every namespace tool must be reachable through some verb).
export const reachedTools = (actions: Record<string, Dispatch>): Set<string> => new Set(Object.values(actions).map((d) => (typeof d === "string" ? d : d.tool)));

// The target tool's own declared arg names — the front door validates against THIS, not its
// own additionalProperties:true schema (which exists only to let per-action args ride through
// at all). Without this, a caller's typo'd/wrong key (e.g. `q` where the tool wants `query`)
// silently vanishes instead of erroring, and a filter arg that vanishes degrades a search to
// match-all with no sign anything went wrong (#1312).
const knownArgs = (inputSchema: unknown): Set<string> => new Set(Object.keys((inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}));

/**
 * Build a front-door verb that dispatches `{action, ...args}` into an existing
 * namespace tool array (VAULT_TOOLS/MAIL_TOOLS/FILES_TOOLS) — the SAME handlers the
 * separate /<ns>/mcp connectors call, so no tool logic is duplicated and OAuth gating
 * (enforced upstream in index.ts before dispatch) + reversibility (staging/confirm
 * gates inside the handlers) are preserved by construction.
 *
 * `raw:true` so the call is byte-identical to the /<ns>/mcp path — the namespace
 * connectors neither normalize inputs nor clamp outputs, so note bodies / file bytes /
 * mail text pass through unaltered. Not cacheable (the default) — these are mixed
 * read/write namespaces, and mutations are never cached.
 *
 * `tools` is a THUNK (`() => VAULT_TOOLS`), resolved per call — never captured by value
 * at module-eval. This is the guard against the import cycle (fns → vault-mcp → index →
 * fns): if a namespace-mcp module happens to be the outermost import, its TOOLS export
 * is still undefined when this factory runs, so grabbing the array eagerly would freeze
 * `undefined` into the closure forever. Reading it through the thunk at call time always
 * sees the fully-evaluated live binding. The `.find` per call is cheap (arrays ≤~32).
 */
export function namespaceFn(o: { name: string; description: string; tools: () => NsTool[]; actions: Record<string, Dispatch>; properties?: Record<string, unknown> }): Fn {
	const keys = Object.keys(o.actions);
	return {
		name: o.name,
		surface: "front",
		raw: true,
		description: o.description,
		inputSchema: {
			type: "object",
			additionalProperties: true, // the per-action fields ARE the target tool's own schema
			required: ["action"],
			// `action` plus any array-shaped per-action params the caller declares explicitly. A bare
			// `additionalProperties:true` leaves array args (e.g. mail_move's `ids[]`) untyped at the
			// front door, and several MCP clients drop/mis-serialize an untyped array before it reaches
			// the Worker — so a declared `items:{type:string}` array is what makes ids[] arrive intact.
			properties: { action: { type: "string", enum: keys, description: `Which ${o.name} operation. Each action's remaining args are that namespace tool's own — see the namespace docs.` }, ...(o.properties ?? {}) },
		},
		run: async (env, args) => {
			const action = typeof args?.action === "string" ? args.action.trim() : "";
			const d = o.actions[action];
			if (!action || !d) return failWith("bad_input", `${o.name}: \`action\` must be one of: ${keys.join(", ")}.`);
			const toolName = typeof d === "string" ? d : d.tool;
			const inject = typeof d === "string" ? undefined : d.inject;
			const tool = o.tools().find((t) => t.name === toolName);
			if (!tool) return failWith("not_configured", `${o.name}: target tool ${toolName} not registered.`);
			const { action: _drop, ...rest } = (args ?? {}) as Record<string, unknown>;
			const known = knownArgs(tool.inputSchema);
			const badKeys = Object.keys(rest).filter((k) => !known.has(k));
			if (badKeys.length) return failWith("bad_input", `${o.name}: unknown arg(s) ${badKeys.join(", ")} for action "${action}" — ${toolName} accepts: ${[...known].join(", ") || "(no args)"}.`);
			return invokeFn(tool, env, { ...rest, ...inject }); // inject re-adds the inner action for masked/vacation/operate
		},
	};
}
