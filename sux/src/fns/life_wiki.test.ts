import { beforeEach, describe, expect, it, vi } from "vitest";
import { life_wiki } from "./life_wiki";
import { FACETS, SANDBOX_DIR } from "./_life_wiki";

const hasLifeWiki = vi.fn();
const defaultDeps = vi.fn();
const runLifeWiki = vi.fn();
vi.mock("./_life_wiki", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_life_wiki")>();
	return { ...actual, hasLifeWiki: (...a: unknown[]) => hasLifeWiki(...a), defaultDeps: (...a: unknown[]) => defaultDeps(...a), runLifeWiki: (...a: unknown[]) => runLifeWiki(...a) };
});

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("life_wiki (front verb)", () => {
	beforeEach(() => {
		hasLifeWiki.mockReset();
		defaultDeps.mockReset();
		runLifeWiki.mockReset();
	});

	it("status reports armed state + all facets, dormant or not, without calling defaultDeps/runLifeWiki", async () => {
		hasLifeWiki.mockReturnValue(false);
		const r = await life_wiki.run({} as any, { action: "status" });
		expect(r.isError).toBeUndefined();
		const out = parse(r);
		expect(out.enabled).toBe(false);
		expect(out.sandbox).toBe(`${SANDBOX_DIR}/`);
		expect(out.facets).toHaveLength(FACETS.length);
		expect(out.note).toMatch(/dormant/);
		expect(defaultDeps).not.toHaveBeenCalled();
		expect(runLifeWiki).not.toHaveBeenCalled();

		hasLifeWiki.mockReturnValue(true);
		const armed = parse(await life_wiki.run({} as any, { action: "status" }));
		expect(armed.enabled).toBe(true);
		expect(armed.note).toMatch(/armed/);
	});

	it("is a dormant no-op (ok, not error) for run/preview unless LIFE_WIKI_ENABLED, touching neither deps nor runLifeWiki", async () => {
		hasLifeWiki.mockReturnValue(false);
		const r = await life_wiki.run({} as any, {});
		expect(r.isError).toBeUndefined();
		const out = parse(r);
		expect(out.dormant).toBe(true);
		expect(out.sandbox).toBe(`${SANDBOX_DIR}/`);
		expect(out.note).toMatch(/LIFE_WIKI_ENABLED/);
		expect(defaultDeps).not.toHaveBeenCalled();
		expect(runLifeWiki).not.toHaveBeenCalled();
	});

	it("armed: action:'run' (default) regenerates with dry_run:false", async () => {
		hasLifeWiki.mockReturnValue(true);
		defaultDeps.mockResolvedValue({ fake: "deps" });
		runLifeWiki.mockResolvedValue({ sandbox: `${SANDBOX_DIR}/`, generated: 5, written: 5, facets: [] });

		const r = await life_wiki.run({ LIFE_WIKI_ENABLED: "1" } as any, {});
		expect(r.isError).toBeUndefined();
		expect(parse(r)).toMatchObject({ generated: 5, written: 5 });
		expect(runLifeWiki).toHaveBeenCalledWith({ LIFE_WIKI_ENABLED: "1" }, { facets: undefined, dry_run: false }, { fake: "deps" });
	});

	it("armed: action:'preview' synthesizes without writing (dry_run:true), same as dry_run:true on 'run'", async () => {
		hasLifeWiki.mockReturnValue(true);
		defaultDeps.mockResolvedValue({});
		runLifeWiki.mockResolvedValue({ sandbox: `${SANDBOX_DIR}/`, generated: 5, written: 0, facets: [] });

		await life_wiki.run({} as any, { action: "preview" });
		expect(runLifeWiki).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dry_run: true }), expect.anything());

		runLifeWiki.mockClear();
		await life_wiki.run({} as any, { action: "run", dry_run: true });
		expect(runLifeWiki).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dry_run: true }), expect.anything());
	});

	it("passes a requested facets subset through as strings", async () => {
		hasLifeWiki.mockReturnValue(true);
		defaultDeps.mockResolvedValue({});
		runLifeWiki.mockResolvedValue({ sandbox: `${SANDBOX_DIR}/`, generated: 1, written: 1, facets: [] });

		await life_wiki.run({} as any, { facets: ["people", "health"] });
		expect(runLifeWiki).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ facets: ["people", "health"] }), expect.anything());
	});

	it("catches a thrown error from the synthesis and reports upstream_error", async () => {
		hasLifeWiki.mockReturnValue(true);
		defaultDeps.mockResolvedValue({});
		runLifeWiki.mockRejectedValue(new Error("recall failed"));

		const r = await life_wiki.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[upstream_error]");
		expect(r.content[0].text).toContain("recall failed");
	});
});
