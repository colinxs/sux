import { describe, expect, it, vi } from "vitest";
import { fileFeedbackIssue } from "./_feedback_issue";

function kvEnv(extra: Record<string, unknown> = {}) {
	const store = new Map<string, string>();
	return {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
		},
		...extra,
	} as any;
}

/** A fake GitHub API: records requests, returns queued responses (search list + POST result). */
function fakeGh(openIssues: any[] = []) {
	const calls: { method: string; url: string; body: any }[] = [];
	let nextNumber = 100;
	const fetchImpl = (async (url: string, init: any) => {
		calls.push({ method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
		if (init.method === "GET") return { status: 200, json: async () => openIssues } as any;
		const number = nextNumber++;
		return { status: 201, json: async () => ({ number, html_url: `https://github.com/SuxOS/sux/issues/${number}` }) } as any;
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe("fileFeedbackIssue", () => {
	it("is dormant without a GITHUB_TOKEN (caller keeps the KV log)", async () => {
		const { fetchImpl, calls } = fakeGh();
		const r = await fileFeedbackIssue(kvEnv(), "issue", "dns returns 500", undefined, fetchImpl);
		expect(r).toEqual({ status: "dormant" });
		expect(calls).toHaveLength(0); // never touches the network
	});

	it("files a bug for issue() with the bug+feedback labels", async () => {
		const { fetchImpl, calls } = fakeGh();
		const r = await fileFeedbackIssue(kvEnv({ GITHUB_TOKEN: "t" }), "issue", "dns returns 500", "dns", fetchImpl);
		expect(r).toMatchObject({ status: "filed", created: true, number: 100 });
		const post = calls.find((c) => c.method === "POST")!;
		expect(post.body.labels).toEqual(["bug", "feedback"]);
		expect(post.body.title).toBe("[bug(dns)] dns returns 500");
	});

	it("files an enhancement for suggest() (buildable)", async () => {
		const { fetchImpl, calls } = fakeGh();
		const r = await fileFeedbackIssue(kvEnv({ GITHUB_TOKEN: "t" }), "suggest", "add a --json flag", undefined, fetchImpl);
		expect(r).toMatchObject({ status: "filed", created: true });
		expect(calls.find((c) => c.method === "POST")!.body.labels).toEqual(["enhancement", "feedback"]);
	});

	it("dedupes onto an existing open feedback issue with the same title (no POST)", async () => {
		const { fetchImpl, calls } = fakeGh([{ number: 7, title: "[bug] dns returns 500", html_url: "u" }]);
		const r = await fileFeedbackIssue(kvEnv({ GITHUB_TOKEN: "t" }), "issue", "dns returns 500", undefined, fetchImpl);
		expect(r).toEqual({ status: "filed", number: 7, created: false, url: "u" });
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("ignores PRs sharing the /issues list when deduping", async () => {
		const { fetchImpl } = fakeGh([{ number: 8, title: "[bug] dns returns 500", pull_request: {}, html_url: "u" }]);
		const r = await fileFeedbackIssue(kvEnv({ GITHUB_TOKEN: "t" }), "issue", "dns returns 500", undefined, fetchImpl);
		expect(r).toMatchObject({ status: "filed", created: true }); // the PR is not a dedup hit
	});

	it("redacts PII before the title/body leave the worker", async () => {
		const { fetchImpl, calls } = fakeGh();
		await fileFeedbackIssue(kvEnv({ GITHUB_TOKEN: "t" }), "issue", "email me at a@b.com about it", undefined, fetchImpl);
		const post = calls.find((c) => c.method === "POST")!;
		expect(post.body.title).not.toContain("a@b.com");
		expect(post.body.body).not.toContain("a@b.com");
	});

	it("enforces the per-kind daily cap", async () => {
		const env = kvEnv({ GITHUB_TOKEN: "t" });
		const { fetchImpl } = fakeGh();
		// 20 distinct titles fill the day's cap; the 21st is capped.
		for (let i = 0; i < 20; i++) {
			const r = await fileFeedbackIssue(env, "issue", `bug number ${i}`, undefined, fetchImpl);
			expect(r.status).toBe("filed");
		}
		const capped = await fileFeedbackIssue(env, "issue", "one too many", undefined, fetchImpl);
		expect(capped).toEqual({ status: "capped" });
	});

	it("returns error (not throw) on an API failure", async () => {
		const failing = (async (_url: string, init: any) =>
			init.method === "GET" ? ({ status: 200, json: async () => [] } as any) : ({ status: 422, json: async () => ({}) } as any)) as unknown as typeof fetch;
		const r = await fileFeedbackIssue(kvEnv({ GITHUB_TOKEN: "t" }), "issue", "x", undefined, failing);
		expect(r).toMatchObject({ status: "error" });
	});
});
