import { afterEach, describe, expect, it, vi } from "vitest";
import { todoist } from "./todoist";

const ENV = { TODOIST_TOKEN: "tdt" } as any;
const parse = (r: any) => JSON.parse(r.content[0].text);

afterEach(() => vi.unstubAllGlobals());

describe("todoist (REST v2 adapter)", () => {
	it("is inert (not_configured) without a token", async () => {
		const r = await todoist.run({} as any, { action: "list" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[not_configured]");
		expect(r.content[0].text).toMatch(/TODOIST_TOKEN/);
	});

	it("list GETs /tasks with project + filter query, shapes the tasks", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(init.headers.Authorization).toBe("Bearer tdt");
			const url = new URL(String(u));
			expect(url.pathname).toEqual(expect.stringContaining("/tasks"));
			expect(url.searchParams.get("project_id")).toBe("P1");
			expect(url.searchParams.get("filter")).toBe("today | overdue");
			return new Response(JSON.stringify({ results: [{ id: "1", content: "Pay rent", project_id: "P1", priority: 4, due: { string: "today", is_recurring: true }, labels: ["home"], url: "https://todoist.com/showTask?id=1" }], next_cursor: null }), { status: 200 });
		}));
		const out = parse(await todoist.run(ENV, { action: "list", project_id: "P1", filter: "today | overdue" }));
		expect(out).toMatchObject({ count: 1, tasks: [{ id: "1", content: "Pay rent", priority: 4, due: "today", is_recurring: true }] });
	});

	it("list tolerates a bare-array response (older/alternate shape)", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "2", content: "Water plants" }]), { status: 200 })));
		const out = parse(await todoist.run(ENV, { action: "list" }));
		expect(out).toMatchObject({ count: 1, tasks: [{ id: "2", content: "Water plants" }] });
	});

	it("projects unwraps the {results:[...]} shape", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			expect(String(u).endsWith("/projects")).toBe(true);
			return new Response(JSON.stringify({ results: [{ id: "p1", name: "Inbox", is_inbox_project: true }], next_cursor: null }), { status: 200 });
		}));
		const out = parse(await todoist.run(ENV, { action: "projects" }));
		expect(out).toMatchObject({ projects: [{ id: "p1", name: "Inbox", is_inbox: true }] });
	});

	it("add requires content and POSTs the defined fields", async () => {
		const bad = await todoist.run(ENV, { action: "add" });
		expect(bad.isError).toBe(true);
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u).endsWith("/tasks")).toBe(true);
			expect(init.method).toBe("POST");
			const body = JSON.parse(init.body);
			expect(body).toEqual({ content: "Call Dr. Chen", due_string: "tomorrow 9am", priority: 3 }); // undefined fields omitted
			return new Response(JSON.stringify({ id: "9", content: "Call Dr. Chen", priority: 3, due: { string: "tomorrow 9am" } }), { status: 200 });
		}));
		const out = parse(await todoist.run(ENV, { action: "add", content: "Call Dr. Chen", due_string: "tomorrow 9am", priority: 3 }));
		expect(out).toMatchObject({ ok: true, added: { id: "9", content: "Call Dr. Chen" } });
	});

	it("add_many bulk-creates over an array (NL due strings pass to Todoist), per-item report (§5)", async () => {
		let n = 0;
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			expect(init.method).toBe("POST");
			const body = JSON.parse(init.body);
			return new Response(JSON.stringify({ id: String(++n), content: body.content, due: { string: body.due_string } }), { status: 200 });
		}));
		const out = parse(await todoist.run(ENV, { action: "add_many", items: [{ content: "A", due_string: "every weekday 9am" }, { content: "B" }] }));
		expect(out).toMatchObject({ requested: 2, added: 2, failed: 0 });
		expect(out.tasks.map((t: any) => t.content)).toEqual(["A", "B"]);
	});

	it("add_many rejects an empty array + items missing content", async () => {
		expect((await todoist.run(ENV, { action: "add_many", items: [] })).isError).toBe(true);
		expect((await todoist.run(ENV, { action: "add_many", items: [{ due_string: "x" }] })).isError).toBe(true);
	});

	it("complete_many closes an array of ids, surfacing partial failures (§5)", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const good = !String(u).includes("/bad/");
			return new Response(good ? null : JSON.stringify({ error: "not found" }), { status: good ? 204 : 404 });
		}));
		const out = parse(await todoist.run(ENV, { action: "complete_many", ids: ["1", "bad", "3"] }));
		expect(out).toMatchObject({ requested: 3, completed: 2, failed: 1 });
		expect(out.completedIds).toEqual(["1", "3"]);
	});

	it("update_many edits an array, needs id + a field per item, surfaces partial failures", async () => {
		expect((await todoist.run(ENV, { action: "update_many", items: [] })).isError).toBe(true);
		expect((await todoist.run(ENV, { action: "update_many", items: [{ content: "x" }] })).isError).toBe(true); // no id
		expect((await todoist.run(ENV, { action: "update_many", items: [{ id: "1" }] })).isError).toBe(true); // no fields
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(init.method).toBe("POST");
			const tid = String(u).split("/tasks/")[1];
			if (tid === "bad") return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
			return new Response(JSON.stringify({ id: tid, content: JSON.parse(init.body).content }), { status: 200 });
		}));
		const out = parse(await todoist.run(ENV, { action: "update_many", items: [{ id: "1", content: "A" }, { id: "bad", priority: 2 }] }));
		expect(out).toMatchObject({ requested: 2, updated: 1, failed: 1 });
		expect(out.tasks[0]).toMatchObject({ id: "1", content: "A" });
	});

	it("reopen_many reopens an array of ids, surfacing partial failures", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			expect(String(u)).toContain("/reopen");
			const good = !String(u).includes("/bad/");
			return new Response(good ? null : JSON.stringify({ error: "not found" }), { status: good ? 204 : 404 });
		}));
		const out = parse(await todoist.run(ENV, { action: "reopen_many", ids: ["1", "bad", "3"] }));
		expect(out).toMatchObject({ requested: 3, reopened: 2, failed: 1 });
		expect(out.reopenedIds).toEqual(["1", "3"]);
	});

	it("delete_many STAGES a preview by default (listing the ids), force:true DELETEs each id", async () => {
		const envKv = { ...ENV, OAUTH_KV: (() => { const s = new Map<string, string>(); return { get: async (k: string) => s.get(k) ?? null, put: async (k: string, v: string) => void s.set(k, v), delete: async (k: string) => void s.delete(k) }; })() };
		const staged = parse(await todoist.run(envKv, { action: "delete_many", ids: ["1", "2"] }));
		expect(staged).toMatchObject({ staged: true, kind: "todoist_delete_many" });
		expect(staged.preview).toMatchObject({ count: 2, ids: ["1", "2"] });
		expect(staged.commit_token).toBeTruthy();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(init.method).toBe("DELETE");
			return new Response(null, { status: 204 });
		}));
		const out = parse(await todoist.run(envKv, { action: "delete_many", ids: ["1", "2"], force: true }));
		expect(out).toMatchObject({ requested: 2, deleted: 2, failed: 0 });
		expect(out.deletedIds).toEqual(["1", "2"]);
	});

	it("delete_many flags a large blast radius via the conscience advisory", async () => {
		const s = new Map<string, string>();
		const envKv = { ...ENV, OAUTH_KV: { get: async (k: string) => s.get(k) ?? null, put: async (k: string, v: string) => void s.set(k, v), delete: async (k: string) => void s.delete(k) } };
		const ids = Array.from({ length: 5 }, (_, i) => String(i));
		const staged = parse(await todoist.run(envKv, { action: "delete_many", ids }));
		expect(staged.advisory?.some((n: string) => n.includes("5 Todoist tasks"))).toBe(true);
	});

	it("update needs an id and at least one field", async () => {
		expect((await todoist.run(ENV, { action: "update", content: "x" })).isError).toBe(true); // no id
		expect((await todoist.run(ENV, { action: "update", id: "9" })).isError).toBe(true); // no fields
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u).endsWith("/tasks/9")).toBe(true);
			expect(JSON.parse(init.body)).toEqual({ content: "Call oncologist" });
			return new Response(JSON.stringify({ id: "9", content: "Call oncologist" }), { status: 200 });
		}));
		expect(parse(await todoist.run(ENV, { action: "update", id: "9", content: "Call oncologist" }))).toMatchObject({ ok: true, updated: { id: "9" } });
	});

	it("complete and reopen hit the right sub-paths and tolerate a 204", async () => {
		for (const [action, sub] of [["complete", "close"], ["reopen", "reopen"]] as const) {
			vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
				expect(String(u).endsWith(`/tasks/9/${sub}`)).toBe(true);
				return new Response(null, { status: 204 });
			}));
			expect(parse(await todoist.run(ENV, { action, id: "9" }))).toMatchObject({ ok: true, action, id: "9" });
		}
	});

	it("delete STAGES a preview by default, force:true DELETEs", async () => {
		const s = new Map<string, string>();
		const envKv = { ...ENV, OAUTH_KV: { get: async (k: string) => s.get(k) ?? null, put: async (k: string, v: string) => void s.set(k, v), delete: async (k: string) => void s.delete(k) } };
		const staged = parse(await todoist.run(envKv, { action: "delete", id: "9" }));
		expect(staged).toMatchObject({ staged: true, kind: "todoist_delete" });
		expect(staged.commit_token).toBeTruthy();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(init.method).toBe("DELETE");
			expect(String(u).endsWith("/tasks/9")).toBe(true);
			return new Response(null, { status: 204 });
		}));
		expect(parse(await todoist.run(envKv, { action: "delete", id: "9", force: true }))).toMatchObject({ ok: true, deleted: "9" });
	});

	it("maps upstream statuses to the failure taxonomy", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 })));
		expect((await todoist.run(ENV, { action: "list" })).content[0].text).toContain("[not_found]");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("rate", { status: 429 })));
		expect((await todoist.run(ENV, { action: "list" })).content[0].text).toContain("[rate_limited]");
	});
});
