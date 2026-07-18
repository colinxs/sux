import { describe, expect, it, vi } from "vitest";
import { hasLearningFolder, learningFolderPath, learningFolderTopic, runLearningFolderSync, type LearningFolderDeps, type LearningFolderEntry } from "./_learning_folder";

const env = (extra: Record<string, unknown> = {}) => ({ LEARNING_FOLDER_ENABLED: "1", DROPBOX_TOKEN: "t", ...extra }) as any;

const entries = (...paths: string[]): LearningFolderEntry[] => paths.map((p) => ({ path: p, name: p.split("/").pop() ?? p }));

const deps = (over: Partial<LearningFolderDeps> = {}): LearningFolderDeps => ({
	listFolder: vi.fn(async () => entries("/learning/a.pdf", "/learning/b.pdf")),
	listStudiedPaths: vi.fn(async () => new Set<string>()),
	shareUrl: vi.fn(async (_env: any, path: string) => `https://www.dropbox.com/s/xyz${path}?dl=0`),
	studyPdf: vi.fn(async () => ({ ok: true })),
	...over,
});

describe("hasLearningFolder", () => {
	it("is dormant unless LEARNING_FOLDER_ENABLED is truthy", () => {
		expect(hasLearningFolder(env({ LEARNING_FOLDER_ENABLED: undefined }))).toBe(false);
		expect(hasLearningFolder(env({ LEARNING_FOLDER_ENABLED: "0" }))).toBe(false);
		expect(hasLearningFolder(env())).toBe(true);
	});

	it("also requires Dropbox to be configured", () => {
		expect(hasLearningFolder(env({ DROPBOX_TOKEN: undefined }))).toBe(false);
	});
});

describe("learningFolderPath / learningFolderTopic", () => {
	it("default to /learning and \"learning\" when unset", () => {
		expect(learningFolderPath(env())).toBe("/learning");
		expect(learningFolderTopic(env())).toBe("learning");
	});

	it("honor explicit overrides", () => {
		expect(learningFolderPath(env({ LEARNING_FOLDER_PATH: "/inbox/pdfs" }))).toBe("/inbox/pdfs");
		expect(learningFolderTopic(env({ LEARNING_FOLDER_TOPIC: "papers" }))).toBe("papers");
	});
});

describe("runLearningFolderSync", () => {
	it("is a total no-op when dormant", async () => {
		const d = deps();
		const r = await runLearningFolderSync(env({ LEARNING_FOLDER_ENABLED: undefined }), d);
		expect(r).toEqual({ dormant: true });
		expect(d.listFolder).not.toHaveBeenCalled();
	});

	it("studies PDFs not already whitelisted, skipping the already-studied one", async () => {
		const d = deps({ listStudiedPaths: vi.fn(async () => new Set(["/learning/a.pdf"])) });
		const r = await runLearningFolderSync(env(), d);
		expect(r.total).toBe(2);
		expect(r.studied).toEqual(["/learning/b.pdf"]);
		expect(d.studyPdf).toHaveBeenCalledTimes(1);
		expect(d.studyPdf).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("dl=1"), "learning", "b.pdf", "dropbox:/learning/b.pdf");
	});

	it("passes a dropbox:-prefixed sourceLabel (not the fetched URL) so the studied-set dedup actually matches next run", async () => {
		const d = deps();
		await runLearningFolderSync(env(), d);
		const calls = (d.studyPdf as any).mock.calls;
		expect(calls.map((c: any[]) => c[4])).toEqual(["dropbox:/learning/a.pdf", "dropbox:/learning/b.pdf"]);
	});

	it("forces the shared link to a raw download (dl=1) before handing it to study", async () => {
		const d = deps();
		await runLearningFolderSync(env(), d);
		const call = (d.studyPdf as any).mock.calls[0];
		expect(call[1]).not.toContain("dl=0");
		expect(call[1]).toContain("dl=1");
	});

	it("caps how many new PDFs it studies in one run and reports the rest as skipped", async () => {
		const many = entries(...Array.from({ length: 7 }, (_, i) => `/learning/f${i}.pdf`));
		const d = deps({ listFolder: vi.fn(async () => many) });
		const r = await runLearningFolderSync(env(), d);
		expect(r.studied?.length).toBe(5);
		expect(r.skipped?.length).toBe(2);
	});

	it("records a per-file error without aborting the rest of the sweep", async () => {
		const d = deps({
			studyPdf: vi.fn(async (_env: any, url: string) => (url.includes("a.pdf") ? { ok: false, error: "boom" } : { ok: true })),
		});
		const r = await runLearningFolderSync(env(), d);
		expect(r.errors?.some((e) => e.includes("boom"))).toBe(true);
		expect(r.studied).toEqual(["/learning/b.pdf"]);
	});
});
