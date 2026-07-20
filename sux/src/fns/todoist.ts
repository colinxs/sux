import { type Fn, type FailCode, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";
import { staged } from "../stage";

// Todoist tasks over the unified Todoist API v1 (they retired REST v2 + Sync v9
// in favor of one merged API, same resource paths, just /api/v1 as the base) —
// a thin, honest adapter (NOT the ~50-tool interactive connector). Auth is a
// personal API token used as a Bearer directly
// (no OAuth mint), so this is inert until TODOIST_TOKEN is set, exactly like the
// other keyed fns. The one scar worth carrying (vault-backends.md §2.6): updating
// `due_string` on a RECURRING task REPLACES its recurrence — reschedule a single
// occurrence in the app, not here. Delete is confirm-gated (Todoist delete is not
// a recoverable trash); complete is reversible (reopen), so it isn't gated.

const API = "https://api.todoist.com/api/v1";

/** True when the Todoist token is configured. */
export const hasTodoist = (env: RtEnv): boolean => Boolean(env.TODOIST_TOKEN);

/** Map an HTTP status to the shared failure taxonomy. */
const codeFor = (status: number): FailCode => (status === 401 || status === 403 ? "not_configured" : status === 404 ? "not_found" : status === 429 ? "rate_limited" : status === 400 ? "bad_input" : "upstream_error");

async function tapi(env: RtEnv, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
	const resp = await fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${String(env.TODOIST_TOKEN)}`,
			Accept: "application/json",
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(20_000),
	});
	const text = await resp.text().catch(() => "");
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* non-JSON (e.g. a 204 or an error page) — leave json null, keep text */
	}
	return { status: resp.status, json, text };
}

/** Keep only the defined keys of an update body (so we never blank a field we didn't mean to). */
const defined = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const task = (t: any) => ({ id: t?.id, content: t?.content, description: t?.description || undefined, project_id: t?.project_id, priority: t?.priority, due: t?.due?.string, is_recurring: t?.due?.is_recurring, labels: t?.labels, url: t?.url });

/** The unified Todoist API v1 wraps list responses as {results:[...], next_cursor}, unlike the
 *  old rest/v2's bare array — live-verified 2026-07-13. Accept both shapes so a future API
 *  change (or an endpoint that still returns bare) doesn't silently break `.map`. This fn
 *  doesn't paginate (next_cursor is ignored) — a single page is enough for its batch/pipeline
 *  use case; a caller needing more should page via Todoist's own tools. */
const results = (json: any): any[] => (Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : []);

export const todoist: Fn = {
	name: "todoist",
	cost: 1,
	cacheable: false,
	description:
		"Todoist as a BATCH/PIPELINE primitive — bulk array-in operations for use inside pipe/batch, not 50 interactive tools (for interactive task management use the official Todoist MCP). Bulk verbs: add_many ({items:[{content, due_string?, priority?, project_id?, labels?}, …]}) | update_many ({items:[{id, content?, due_string?, priority?, labels?, …}, …]}) | complete_many ({ids:[…]}) | reopen_many ({ids:[…]}) | delete_many ({ids:[…]}). Single-item: list ({project_id?, filter?}) | add ({content, …}) | update ({id, …}) | complete ({id}) | reopen ({id}) | delete ({id}) | projects. Natural-language due dates ('every weekday 9am', 'tomorrow 5pm') are parsed by Todoist. " +
		"Needs TODOIST_TOKEN (Todoist → Settings → Integrations → Developer → API token). NOTE: setting `due_string` via update on a RECURRING task REPLACES its recurrence — reschedule a single occurrence in the Todoist app, not here. Delete is permanent (not a recoverable trash) — delete/delete_many STAGE A PREVIEW BY DEFAULT (re-call with the returned commit_token, or pass force:true, to apply in one shot); complete is reversible via reopen.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["list", "add", "add_many", "update", "update_many", "complete", "complete_many", "reopen", "reopen_many", "delete", "delete_many", "projects"] },
			id: { type: "string", description: "Task id (update/complete/reopen/delete)." },
			items: { type: "array", description: "add_many: tasks to create, each {content, description?, project_id?, due_string?, priority?, labels?}. update_many: edits, each {id, …fields}. Max 50.", items: { type: "object", additionalProperties: true } },
			ids: { type: "array", description: "complete_many/reopen_many/delete_many: task ids. Max 100.", items: { type: "string" } },
			content: { type: "string", description: "add/update: the task text." },
			description: { type: "string", description: "add/update: longer note on the task." },
			project_id: { type: "string", description: "list: filter to a project / add: target project (default Inbox)." },
			filter: { type: "string", description: "list: a Todoist filter query, e.g. 'today | overdue'." },
			due_string: { type: "string", description: "Natural-language due, e.g. 'tomorrow 9am'. On a recurring task this REPLACES the recurrence." },
			priority: { type: "integer", minimum: 1, maximum: 4, description: "1 (normal) … 4 (urgent)." },
			labels: { type: "array", items: { type: "string" }, description: "add/update: label names." },
			stage: { type: "boolean", description: "delete/delete_many: preview only — returns {preview, commit_token}, deletes nothing." },
			commit_token: { type: "string", description: "delete/delete_many: commit a previously staged delete (the payload must match what was staged)." },
			force: { type: "boolean", description: "delete/delete_many: skip staging and delete in one shot (the ! override). By default a delete stages a preview first." },
		},
	},
	run: async (env: RtEnv, a: any) => {
		if (!hasTodoist(env)) return failWith("not_configured", "Todoist not configured — set TODOIST_TOKEN (Todoist → Settings → Integrations → Developer → API token).");
		const action = String(a?.action ?? "");
		const id = a?.id ? String(a.id) : "";
		try {
			if (action === "projects") {
				const r = await tapi(env, "GET", "/projects");
				if (r.status >= 400) return failWith(codeFor(r.status), `Todoist projects: ${r.json?.error ?? (r.text.slice(0, 200) || `HTTP ${r.status}`)}`);
				return ok(oj({ projects: results(r.json).map((p: any) => ({ id: p?.id, name: p?.name, is_inbox: p?.is_inbox_project })) }));
			}
			if (action === "list") {
				const qs = new URLSearchParams();
				if (a?.project_id) qs.set("project_id", String(a.project_id));
				if (a?.filter) qs.set("filter", String(a.filter));
				const r = await tapi(env, "GET", `/tasks${qs.toString() ? `?${qs}` : ""}`);
				if (r.status >= 400) return failWith(codeFor(r.status), `Todoist list: ${r.json?.error ?? (r.text.slice(0, 200) || `HTTP ${r.status}`)}`);
				const tasks = results(r.json).map(task);
				return ok(oj({ count: tasks.length, tasks }));
			}
			if (action === "add") {
				if (!a?.content) return failWith("bad_input", "todoist add requires `content`.");
				const body = defined({ content: String(a.content), description: a?.description, project_id: a?.project_id, due_string: a?.due_string, priority: a?.priority, labels: a?.labels });
				const r = await tapi(env, "POST", "/tasks", body);
				if (r.status >= 400) return failWith(codeFor(r.status), `Todoist add: ${r.json?.error ?? (r.text.slice(0, 200) || `HTTP ${r.status}`)}`);
				return ok(oj({ ok: true, added: task(r.json) }));
			}
			if (action === "add_many") {
				const items = Array.isArray(a?.items) ? a.items : [];
				if (!items.length) return failWith("bad_input", "todoist add_many requires a non-empty `items` array.");
				if (items.length > 50) return failWith("bad_input", "todoist add_many is capped at 50 items per call — split the batch.");
				if (items.some((it: any) => !it?.content)) return failWith("bad_input", "every add_many item needs `content`.");
				const results = await Promise.all(
					items.map(async (it: any) => {
						const body = defined({ content: String(it.content), description: it?.description, project_id: it?.project_id, due_string: it?.due_string, priority: it?.priority, labels: it?.labels });
						const r = await tapi(env, "POST", "/tasks", body);
						return r.status >= 400 ? { ok: false, content: String(it.content), error: r.json?.error ?? `HTTP ${r.status}` } : { ok: true, ...task(r.json) };
					}),
				);
				const added = results.filter((x: any) => x.ok);
				const failed = results.filter((x: any) => !x.ok);
				return ok(oj({ requested: items.length, added: added.length, failed: failed.length, tasks: added, ...(failed.length ? { errors: failed } : {}) }));
			}
			if (action === "update_many") {
				const items = Array.isArray(a?.items) ? a.items : [];
				if (!items.length) return failWith("bad_input", "todoist update_many requires a non-empty `items` array.");
				if (items.length > 50) return failWith("bad_input", "todoist update_many is capped at 50 items per call — split the batch.");
				if (items.some((it: any) => !it?.id)) return failWith("bad_input", "every update_many item needs an `id`.");
				if (items.some((it: any) => !Object.keys(defined({ content: it?.content, description: it?.description, due_string: it?.due_string, priority: it?.priority, labels: it?.labels })).length)) return failWith("bad_input", "every update_many item needs at least one field to change.");
				const results = await Promise.all(
					items.map(async (it: any) => {
						const tid = String(it.id);
						const body = defined({ content: it?.content, description: it?.description, due_string: it?.due_string, priority: it?.priority, labels: it?.labels });
						const r = await tapi(env, "POST", `/tasks/${encodeURIComponent(tid)}`, body);
						return r.status >= 400 ? { id: tid, ok: false, error: r.json?.error ?? `HTTP ${r.status}` } : { ok: true, ...task(r.json) };
					}),
				);
				const updated = results.filter((x: any) => x.ok);
				const failed = results.filter((x: any) => !x.ok);
				return ok(oj({ requested: items.length, updated: updated.length, failed: failed.length, tasks: updated, ...(failed.length ? { errors: failed } : {}) }));
			}
			if (action === "complete_many" || action === "reopen_many") {
				const sub = action === "complete_many" ? "close" : "reopen";
				const ids = Array.isArray(a?.ids) ? a.ids.map(String) : [];
				if (!ids.length) return failWith("bad_input", `todoist ${action} requires a non-empty \`ids\` array.`);
				if (ids.length > 100) return failWith("bad_input", `todoist ${action} is capped at 100 ids per call — split the batch.`);
				const results = await Promise.all(
					ids.map(async (tid: string) => {
						const r = await tapi(env, "POST", `/tasks/${encodeURIComponent(tid)}/${sub}`);
						return r.status >= 400 ? { id: tid, ok: false, error: r.json?.error ?? `HTTP ${r.status}` } : { id: tid, ok: true };
					}),
				);
				const done = results.filter((x) => x.ok).map((x) => x.id);
				const failed = results.filter((x) => !x.ok);
				const doneKey = action === "complete_many" ? "completed" : "reopened";
				const idsKey = action === "complete_many" ? "completedIds" : "reopenedIds";
				return ok(oj({ requested: ids.length, [doneKey]: done.length, [idsKey]: done, failed: failed.length, ...(failed.length ? { errors: failed } : {}) }));
			}
			if (action === "delete_many") {
				const ids = Array.isArray(a?.ids) ? a.ids.map(String) : [];
				if (!ids.length) return failWith("bad_input", "todoist delete_many requires a non-empty `ids` array.");
				if (ids.length > 100) return failWith("bad_input", "todoist delete_many is capped at 100 ids per call — split the batch.");
				const mutate = async () => {
					const delResults = await Promise.all(
						ids.map(async (tid: string) => {
							const r = await tapi(env, "DELETE", `/tasks/${encodeURIComponent(tid)}`);
							return r.status >= 400 ? { id: tid, ok: false, error: r.json?.error ?? `HTTP ${r.status}` } : { id: tid, ok: true };
						}),
					);
					const deleted = delResults.filter((x) => x.ok).map((x) => x.id);
					const failed = delResults.filter((x) => !x.ok);
					return { requested: ids.length, deleted: deleted.length, deletedIds: deleted, failed: failed.length, ...(failed.length ? { errors: failed } : {}) };
				};
				const gateArgs = { stage: a?.stage === true, commit_token: a?.commit_token ? String(a.commit_token) : undefined, force: a?.force === true };
				const out = await staged(env, "todoist_delete_many", gateArgs, { ids }, { action: `delete ${ids.length} Todoist tasks`, count: ids.length, ids }, mutate);
				return ok(oj("stageResult" in out ? out.stageResult : out.result));
			}
			if (action === "update") {
				if (!id) return failWith("bad_input", "todoist update requires an `id`.");
				const body = defined({ content: a?.content, description: a?.description, due_string: a?.due_string, priority: a?.priority, labels: a?.labels });
				if (!Object.keys(body).length) return failWith("bad_input", "todoist update needs at least one field to change.");
				const r = await tapi(env, "POST", `/tasks/${encodeURIComponent(id)}`, body);
				if (r.status >= 400) return failWith(codeFor(r.status), `Todoist update: ${r.json?.error ?? (r.text.slice(0, 200) || `HTTP ${r.status}`)}`);
				return ok(oj({ ok: true, updated: task(r.json) }));
			}
			if (action === "complete" || action === "reopen") {
				if (!id) return failWith("bad_input", `todoist ${action} requires an \`id\`.`);
				const r = await tapi(env, "POST", `/tasks/${encodeURIComponent(id)}/${action === "complete" ? "close" : "reopen"}`);
				if (r.status >= 400) return failWith(codeFor(r.status), `Todoist ${action}: ${r.json?.error ?? (r.text.slice(0, 200) || `HTTP ${r.status}`)}`);
				return ok(oj({ ok: true, action, id }));
			}
			if (action === "delete") {
				if (!id) return failWith("bad_input", "todoist delete requires an `id`.");
				const mutate = async () => {
					const r = await tapi(env, "DELETE", `/tasks/${encodeURIComponent(id)}`);
					if (r.status >= 400) throw new Error(`Todoist delete: ${r.json?.error ?? (r.text.slice(0, 200) || `HTTP ${r.status}`)}`);
					return { ok: true, deleted: id };
				};
				const gateArgs = { stage: a?.stage === true, commit_token: a?.commit_token ? String(a.commit_token) : undefined, force: a?.force === true };
				const out = await staged(env, "todoist_delete", gateArgs, { id }, { action: "delete todoist task", id }, mutate);
				return ok(oj("stageResult" in out ? out.stageResult : out.result));
			}
			return failWith("bad_input", `todoist: unknown action '${action}'.`);
		} catch (e) {
			return failWith("upstream_error", `todoist ${action} failed: ${errMsg(e)}`);
		}
	},
};
