import { describe, expect, it, vi } from "vitest";
import { dropboxIngestTick, hasDropboxIngest, type DropboxIngestOps } from "./_dropbox_ingest";
import type { IngestRouteDeps } from "./_ingest_route";

vi.mock("../ledger", () => ({ ledger: () => ({ mark: vi.fn(async () => {}), get: vi.fn(async () => undefined) }) }));

const env = (extra: Record<string, unknown> = {}) => ({ OAUTH_KV: undefined, ...extra }) as any;

function fakeOps(overrides: Partial<DropboxIngestOps> = {}): DropboxIngestOps {
	return {
		list: vi.fn(async () => []),
		getBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
		share: vi.fn(async () => "https://dropbox.example/shared/abc"),
		move: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		...overrides,
	};
}

function fakeRouteDeps(): IngestRouteDeps {
	return {
		extractText: vi.fn(async () => ({ hasText: false })),
		summarize: vi.fn(async () => undefined),
		storeOriginal: vi.fn(async () => ({ link: "unused", placement: "dropbox" })),
		ingestText: vi.fn(async () => ({ ok: true, note: "Inbox/2026-01-01 test.md" })),
	};
}

const DBX_CONFIGURED = { DROPBOX_TOKEN: "sl.test-token" };

describe("hasDropboxIngest gating", () => {
	it("dormant without DROPBOX_INGEST_ENABLED", () => {
		expect(hasDropboxIngest(env(DBX_CONFIGURED))).toBe(false);
	});
	it("dormant when the flag is set but Dropbox itself isn't configured", () => {
		expect(hasDropboxIngest(env({ DROPBOX_INGEST_ENABLED: "1" }))).toBe(false);
	});
	it("armed once the flag is set AND Dropbox is configured", () => {
		expect(hasDropboxIngest(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }))).toBe(true);
	});
});

describe("dropboxIngestTick", () => {
	it("is a no-op when dormant", async () => {
		const ops = fakeOps();
		const r = await dropboxIngestTick(env(), ops, fakeRouteDeps());
		expect(r).toEqual({ scanned: 0, processed: 0, failed: 0 });
		expect(ops.list).not.toHaveBeenCalled();
	});

	it("routes a root-dropped file with smart-detect (no explicit mode) and moves it to processed/", async () => {
		const ops = fakeOps({
			list: vi.fn(async (_env, path) => (path === "/ingest" ? [{ kind: "file", name: "report.pdf", path: "/ingest/report.pdf", size: 10 }] : [])),
		});
		const routeDeps = fakeRouteDeps();
		const e = env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED });
		const r = await dropboxIngestTick(e, ops, routeDeps);
		expect(r).toEqual({ scanned: 1, processed: 1, failed: 0 });
		expect(routeDeps.ingestText).toHaveBeenCalledTimes(1);
		const moveCall = (ops.move as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(moveCall[1]).toBe("/ingest/report.pdf");
		expect(moveCall[2]).toMatch(/^\/ingest\/processed\/\d{4}-\d{2}-\d{2}\/report-[a-z0-9]{6}\.pdf$/);
	});

	it("passes the subfolder name as the explicit mode override", async () => {
		const ops = fakeOps({
			list: vi.fn(async (_env, path) => (path === "/ingest/archive" ? [{ kind: "file", name: "photo.jpg", path: "/ingest/archive/photo.jpg" }] : [])),
		});
		const routeDeps = fakeRouteDeps();
		await dropboxIngestTick(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }), ops, routeDeps);
		expect(routeDeps.ingestText).toHaveBeenCalledTimes(1);
		const noteArgs = (routeDeps.ingestText as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(noteArgs.tags).toContain("ingest-archive");
	});

	it("moves a failing file to ingest/failed/ and keeps sweeping the rest", async () => {
		const ops = fakeOps({
			list: vi.fn(async (_env, path) =>
				path === "/ingest"
					? [
							{ kind: "file", name: "bad.pdf", path: "/ingest/bad.pdf" },
							{ kind: "file", name: "good.pdf", path: "/ingest/good.pdf" },
						]
					: [],
			),
			getBytes: vi.fn(async (_env, path) => {
				if (path === "/ingest/bad.pdf") throw new Error("download failed");
				return new Uint8Array([1]);
			}),
		});
		const routeDeps = fakeRouteDeps();
		const r = await dropboxIngestTick(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }), ops, routeDeps);
		expect(r).toEqual({ scanned: 2, processed: 1, failed: 1 });
		const moveCalls = (ops.move as ReturnType<typeof vi.fn>).mock.calls;
		expect(moveCalls.some((c) => c[1] === "/ingest/bad.pdf" && /^\/ingest\/failed\/\d{4}-\d{2}-\d{2}\/bad-[a-z0-9]{6}\.pdf$/.test(String(c[2])))).toBe(true);
		expect(moveCalls.some((c) => c[1] === "/ingest/good.pdf" && String(c[2]).startsWith("/ingest/processed/"))).toBe(true);
	});

	it("gives two same-named files failing back-to-back distinct failed/ destinations (no collision)", async () => {
		const ops = fakeOps({
			list: vi.fn(async (_env, path) =>
				path === "/ingest"
					? [
							{ kind: "file", name: "dup.pdf", path: "/ingest/dup.pdf" },
							{ kind: "file", name: "dup.pdf", path: "/ingest/dup-2.pdf" },
						]
					: [],
			),
			getBytes: vi.fn(async () => {
				throw new Error("always fails");
			}),
		});
		const r = await dropboxIngestTick(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }), ops, fakeRouteDeps());
		expect(r).toEqual({ scanned: 2, processed: 0, failed: 2 });
		const moveCalls = (ops.move as ReturnType<typeof vi.fn>).mock.calls;
		expect(moveCalls).toHaveLength(2);
		const dests = moveCalls.map((c) => String(c[2]));
		expect(dests[0]).toMatch(/^\/ingest\/failed\/\d{4}-\d{2}-\d{2}\/dup-[a-z0-9]{6}\.pdf$/);
		expect(dests[1]).toMatch(/^\/ingest\/failed\/\d{4}-\d{2}-\d{2}\/dup-[a-z0-9]{6}\.pdf$/);
		expect(dests[0]).not.toBe(dests[1]); // the actual regression: no collision between same-basename failures
	});

	it("gives two same-named files processed back-to-back distinct processed/ destinations (no collision)", async () => {
		const ops = fakeOps({
			list: vi.fn(async (_env, path) =>
				path === "/ingest"
					? [
							{ kind: "file", name: "dup.pdf", path: "/ingest/dup.pdf" },
							{ kind: "file", name: "dup.pdf", path: "/ingest/dup-2.pdf" },
						]
					: [],
			),
		});
		const r = await dropboxIngestTick(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }), ops, fakeRouteDeps());
		expect(r).toEqual({ scanned: 2, processed: 2, failed: 0 });
		const moveCalls = (ops.move as ReturnType<typeof vi.fn>).mock.calls;
		const dests = moveCalls.map((c) => String(c[2]));
		expect(dests[0]).toMatch(/^\/ingest\/processed\/\d{4}-\d{2}-\d{2}\/dup-[a-z0-9]{6}\.pdf$/);
		expect(dests[1]).toMatch(/^\/ingest\/processed\/\d{4}-\d{2}-\d{2}\/dup-[a-z0-9]{6}\.pdf$/);
		expect(dests[0]).not.toBe(dests[1]); // the actual regression: no collision between same-basename successes
	});

	it("treats a missing/nonexistent subfolder as nothing to do, not an error", async () => {
		const ops = fakeOps({ list: vi.fn(async () => { throw new Error("path/not_found"); }) });
		const r = await dropboxIngestTick(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }), ops, fakeRouteDeps());
		expect(r).toEqual({ scanned: 0, processed: 0, failed: 0 });
	});
});

describe("dropboxIngestTick pruning ingest/failed/", () => {
	const isoDate = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

	it("deletes a dated failed/ subfolder older than 30 days but keeps a fresh one", async () => {
		const oldDate = isoDate(40 * 24 * 60 * 60 * 1000);
		const freshDate = isoDate(2 * 24 * 60 * 60 * 1000);
		const ops = fakeOps({
			list: vi.fn(async (_env, path) => {
				if (path === "/ingest/failed") {
					return [
						{ kind: "folder", name: oldDate, path: `/ingest/failed/${oldDate}` },
						{ kind: "folder", name: freshDate, path: `/ingest/failed/${freshDate}` },
					];
				}
				return [];
			}),
		});
		await dropboxIngestTick(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }), ops, fakeRouteDeps());
		const deleteCalls = (ops.delete as ReturnType<typeof vi.fn>).mock.calls;
		expect(deleteCalls.some((c) => c[1] === `/ingest/failed/${oldDate}`)).toBe(true);
		expect(deleteCalls.some((c) => c[1] === `/ingest/failed/${freshDate}`)).toBe(false);
	});

	it("never blocks the real ingest sweep when listing/deleting failed/ itself errors", async () => {
		const ops = fakeOps({
			list: vi.fn(async (_env, path) => {
				if (path === "/ingest/failed") throw new Error("path/not_found");
				if (path === "/ingest") return [{ kind: "file", name: "a.pdf", path: "/ingest/a.pdf" }];
				return [];
			}),
		});
		const r = await dropboxIngestTick(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }), ops, fakeRouteDeps());
		expect(r).toEqual({ scanned: 1, processed: 1, failed: 0 });
	});
});
