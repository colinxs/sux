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
		expect(moveCall[2]).toMatch(/^\/ingest\/processed\/\d{4}-\d{2}-\d{2}\/report\.pdf$/);
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
		expect(moveCalls.some((c) => c[1] === "/ingest/bad.pdf" && c[2] === "/ingest/failed/bad.pdf")).toBe(true);
		expect(moveCalls.some((c) => c[1] === "/ingest/good.pdf" && String(c[2]).startsWith("/ingest/processed/"))).toBe(true);
	});

	it("treats a missing/nonexistent subfolder as nothing to do, not an error", async () => {
		const ops = fakeOps({ list: vi.fn(async () => { throw new Error("path/not_found"); }) });
		const r = await dropboxIngestTick(env({ DROPBOX_INGEST_ENABLED: "1", ...DBX_CONFIGURED }), ops, fakeRouteDeps());
		expect(r).toEqual({ scanned: 0, processed: 0, failed: 0 });
	});
});
