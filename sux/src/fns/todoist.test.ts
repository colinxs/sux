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
			return new Response(JSON.stringify([{ id: "1", content: "Pay rent", project_id: "P1", priority: 4, due: { string: "today", is_recurring: true }, labels: ["home"], url: "https://todoist.com/showTask?id=1" }]), { status: 200 });
		}));
		const out = parse(await todoist.run(ENV, { action: "list", project_id: "P1", filter: "today | overdue" }));
		expect(out).toMatchObject({ count: 1, tasks: [{ id: "1", content: "Pay rent", priority: 4, due: "today", is_recurring: true }] });
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

	it("delete requires confirm:true, then DELETEs", async () => {
		const blocked = await todoist.run(ENV, { action: "delete", id: "9" });
		expect(blocked.isError).toBe(true);
		expect(blocked.content[0].text).toMatch(/confirm:true/);
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(init.method).toBe("DELETE");
			expect(String(u).endsWith("/tasks/9")).toBe(true);
			return new Response(null, { status: 204 });
		}));
		expect(parse(await todoist.run(ENV, { action: "delete", id: "9", confirm: true }))).toMatchObject({ ok: true, deleted: "9" });
	});

	it("maps upstream statuses to the failure taxonomy", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 })));
		expect((await todoist.run(ENV, { action: "list" })).content[0].text).toContain("[not_found]");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("rate", { status: 429 })));
		expect((await todoist.run(ENV, { action: "list" })).content[0].text).toContain("[rate_limited]");
	});
});
