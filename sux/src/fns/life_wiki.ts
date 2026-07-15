import { type Fn, failWith, ok } from "../registry";
import { defaultDeps, FACETS, hasLifeWiki, runLifeWiki, SANDBOX_DIR } from "./_life_wiki";
import { errMsg } from "./_util";

// life_wiki — the manual + cron entrypoint for the life-learning living wiki. It synthesizes
// a two-audience wiki about YOUR life from YOUR own signals (notes, files, mail, taught
// examples) — a HUMAN set of readable notes + a ROBOT llms.txt index — into a SANDBOXED vault
// subdir (`sux/wiki/`). NON-DESTRUCTIVE by construction: every write is sandbox-fenced, never
// touching your own notes. DORMANT unless LIFE_WIKI_ENABLED is set. Edge-private (Workers-AI):
// personal signals never leave for a frontier model. The same run() rides the daily cron.
export const life_wiki: Fn = {
	name: "life_wiki",
	surface: "leaf",
	cacheable: false,
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		`Life-learning living wiki: synthesize what sux knows about YOUR life from YOUR own signals (vault notes, files, mail, taught examples — never the open web) into a two-audience wiki under the sandboxed vault folder \`${SANDBOX_DIR}/\` — a HUMAN set of readable notes (People/Health/Projects/Timeline/Interests + an index) plus a ROBOT \`llms.txt\` index for the agent. ` +
		`action:'run' (default) regenerates the wiki now; 'preview' synthesizes + returns the report but writes nothing (same as dry_run:true); 'status' reports whether it's armed and lists the facets. Pass \`facets\` to regenerate a subset. ` +
		`NON-DESTRUCTIVE by construction: every write is sandbox-fenced (\`${SANDBOX_DIR}/\`), so it can never overwrite your own notes; the whole folder is regenerable and safe to delete. Each vault write is a git commit, so history is the undo. Edge-private synthesis (Workers-AI). ` +
		"DORMANT unless LIFE_WIKI_ENABLED is set — until then this is a total no-op that reads and writes nothing.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["run", "preview", "status"], default: "run", description: "run: regenerate + write the wiki. preview: synthesize but write nothing. status: report armed state + facets." },
			facets: { type: "array", items: { type: "string", enum: FACETS.map((f) => f.slug) }, description: "Regenerate only these facets (default: all)." },
			dry_run: { type: "boolean", description: "Synthesize + render but write nothing (same as action:'preview')." },
		},
	},
	run: async (env, a) => {
		const action = String(a?.action ?? "run");
		if (action === "status") {
			return ok(
				JSON.stringify(
					{ enabled: hasLifeWiki(env), sandbox: `${SANDBOX_DIR}/`, facets: FACETS.map((f) => ({ slug: f.slug, title: f.title, file: `${SANDBOX_DIR}/${f.file}` })), note: hasLifeWiki(env) ? "armed — action:'run' regenerates the wiki." : "dormant — set LIFE_WIKI_ENABLED to arm. Nothing runs or writes until then." },
					null,
					2,
				),
			);
		}
		// Fail-closed master gate: with LIFE_WIKI_ENABLED unset the entire feature is a no-op.
		if (!hasLifeWiki(env)) {
			return ok(JSON.stringify({ dormant: true, sandbox: `${SANDBOX_DIR}/`, note: "life_wiki is disabled. Set LIFE_WIKI_ENABLED to synthesize a living wiki from your own signals into the sandbox. Nothing happens until the flag is set." }, null, 2));
		}
		try {
			const deps = await defaultDeps();
			const dryRun = action === "preview" || a?.dry_run === true;
			const report = await runLifeWiki(env, { facets: Array.isArray(a?.facets) ? a.facets.map(String) : undefined, dry_run: dryRun }, deps);
			return ok(JSON.stringify(report, null, 2));
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
