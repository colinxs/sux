import type { RtEnv, ToolResult } from "./registry";

// MCP "Tasks" primitive (spec 2025-11-25, still experimental as of the
// 2026-07-28 release candidate) — durable state for long-running tool calls,
// so a requestor can create a task-augmented tools/call, disconnect, and poll
// tasks/get / tasks/result later instead of holding one HTTP round-trip open.
// See https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
//
// This is the KV-backed store + lifecycle for that primitive. It replaces the
// ad-hoc fire-and-forget pattern sux already uses for the daily cron sub-jobs
// (runSubJob writes a best-effort heartbeat and forgets) and gives pipe/batch/
// render/crawl/batch_fetch/shop — today bounded by FN_DEADLINE_MS / the
// FANOUT_BUDGET_MS soft budget inside one request — a way to keep running past
// that single request/response and be polled to completion instead.
//
// FIRST CUT — deliberately simplified vs. full spec compliance (see PR
// description): single-tenant (no per-caller task ownership beyond the
// existing ALLOWED_GITHUB_LOGIN gate), `tasks/result` blocks via bounded
// polling (not a true long-lived stream), and `tasks/cancel` is
// best-effort — it flips the stored status but cannot abort an in-flight
// fn.run already mid-execution (the isolate keeps running it; the result is
// just discarded once cancelled).

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/** The wire-visible Task object (spec §Data Types). No `tool`/`result` — those
 * are sux-internal bookkeeping, stripped by `toPublicTask`/kept out of tasks/get. */
export type PublicTask = {
	taskId: string;
	status: TaskStatus;
	statusMessage?: string;
	createdAt: string;
	lastUpdatedAt: string;
	ttl: number;
	pollInterval: number;
};

/** What we actually persist in KV — the public task plus the tool name (for
 * logging/observability) and the terminal ToolResult once one exists. */
export type TaskRecord = PublicTask & { tool: string; result?: ToolResult };

const TASK_PREFIX = "sux:task:";
const taskKey = (id: string): string => `${TASK_PREFIX}${id}`;

// Requested ttl is clamped into this range (ms). Floor matches KV's own
// expirationTtl minimum (60s) so every write is valid regardless of how close
// to expiry it is; ceiling is a sane "don't let a forgotten task pin KV
// forever" bound — bump if a real workload needs longer async jobs.
const MIN_TASK_TTL_MS = 60_000;
const MAX_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TASK_TTL_MS = 10 * 60 * 1000;

// Suggested tasks/get polling cadence (spec: receivers MAY include this).
export const TASK_POLL_INTERVAL_MS = 2_000;

// tasks/result blocks (bounded poll) for at most this long before giving up
// and surfacing the still-non-terminal task instead of hanging the request
// indefinitely — Workers requests aren't a good fit for an unbounded block.
export const TASK_RESULT_MAX_WAIT_MS = 45_000;
const TASK_RESULT_POLL_STEP_MS = 500;

export function clampTaskTtl(requestedMs: unknown): number {
	const n = Number(requestedMs);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_TASK_TTL_MS;
	return Math.min(MAX_TASK_TTL_MS, Math.max(MIN_TASK_TTL_MS, Math.floor(n)));
}

const nowIso = (): string => new Date().toISOString();

/** Seconds remaining until this task's original ttl (from createdAt) elapses,
 * clamped to KV's 60s floor — so a re-write near expiry never extends the
 * task's life past its originally granted ttl (nor trips KV's minimum). */
function remainingTtlSeconds(rec: Pick<TaskRecord, "createdAt" | "ttl">): number {
	const createdMs = Date.parse(rec.createdAt);
	const expiresAt = (Number.isFinite(createdMs) ? createdMs : Date.now()) + rec.ttl;
	return Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
}

async function putTask(env: RtEnv, rec: TaskRecord): Promise<void> {
	await env.OAUTH_KV.put(taskKey(rec.taskId), JSON.stringify(rec), { expirationTtl: remainingTtlSeconds(rec) });
}

export async function getTask(env: RtEnv, taskId: string): Promise<TaskRecord | null> {
	const raw = await env.OAUTH_KV.get(taskKey(taskId));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as TaskRecord;
	} catch {
		return null;
	}
}

export function isTerminal(status: TaskStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

export function toPublicTask(rec: TaskRecord): PublicTask {
	const { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttl, pollInterval } = rec;
	return { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttl, pollInterval };
}

/** The CallToolResult tasks/result returns for a terminal task: the stored
 * ToolResult with the required related-task _meta stamped on. */
export function toTaskResult(rec: TaskRecord): ToolResult & { _meta: Record<string, unknown> } {
	const result = rec.result ?? { content: [{ type: "text" as const, text: "Task finished with no result recorded." }], isError: true };
	return { ...result, _meta: { "io.modelcontextprotocol/related-task": { taskId: rec.taskId } } };
}

/**
 * Create a task, persist its initial `working` record, and kick off `run` in
 * the background via `ctx.waitUntil` — the caller gets the initial record
 * back immediately (the CreateTaskResult), and the eventual result lands in
 * KV for tasks/get / tasks/result to pick up. `run` should already carry its
 * own hard deadline (withDeadline) — a task that never settles pins its KV
 * entry until ttl expiry, same as any other fn.
 */
export function createTask(env: RtEnv, ctx: ExecutionContext, tool: string, ttlRequested: unknown, run: () => Promise<ToolResult>): TaskRecord {
	const now = nowIso();
	const rec: TaskRecord = {
		taskId: crypto.randomUUID(),
		tool,
		status: "working",
		statusMessage: "The operation is now in progress.",
		createdAt: now,
		lastUpdatedAt: now,
		ttl: clampTaskTtl(ttlRequested),
		pollInterval: TASK_POLL_INTERVAL_MS,
	};
	// Write the initial record BEFORE returning it, but don't block the response
	// on the write landing — same "fire the KV write off the response path"
	// shape as deferCacheWrite. A tasks/get that races the write and misses is
	// vanishingly unlikely (single ctx.waitUntil, no cross-isolate hop yet) and
	// falls back to "not found" — a transient miss, not a wrong answer.
	ctx.waitUntil(putTask(env, rec));
	ctx.waitUntil(
		run()
			.then(
				(result) => finishTask(env, rec.taskId, result),
				(e) => finishTask(env, rec.taskId, { content: [{ type: "text", text: `Tool execution threw: ${String((e as Error)?.message ?? e)}` }], isError: true }),
			)
			.catch((e) => console.warn(`sux task ${rec.taskId} (${tool}) failed to persist its finish: ${String((e as Error)?.message ?? e)}`)),
	);
	return rec;
}

/** Write the terminal result for a task — unless it was already moved to a
 * terminal status (cancelled) by a concurrent tasks/cancel, in which case the
 * late result is dropped: "once cancelled, a task MUST remain cancelled". */
async function finishTask(env: RtEnv, taskId: string, result: ToolResult): Promise<void> {
	const current = await getTask(env, taskId);
	if (!current || isTerminal(current.status)) return;
	const status: TaskStatus = result.isError ? "failed" : "completed";
	const statusMessage = result.isError ? (result.content?.[0]?.text ?? "Tool execution failed.") : undefined;
	await putTask(env, { ...current, status, statusMessage, result, lastUpdatedAt: nowIso() });
}

/** Best-effort cancel: flips a non-terminal task to `cancelled` immediately
 * (spec: receivers MUST transition to cancelled before responding). It cannot
 * actually abort the in-flight fn.run in the isolate that's running it — that
 * run keeps executing to completion, but `finishTask` will see the task is
 * already terminal and drop its result, so `cancelled` sticks. */
export async function cancelTask(env: RtEnv, taskId: string): Promise<{ ok: true; rec: TaskRecord } | { ok: false; error: "not_found" } | { ok: false; error: "terminal"; status: TaskStatus }> {
	const current = await getTask(env, taskId);
	if (!current) return { ok: false, error: "not_found" };
	if (isTerminal(current.status)) return { ok: false, error: "terminal", status: current.status };
	const rec: TaskRecord = { ...current, status: "cancelled", statusMessage: "The task was cancelled by request.", lastUpdatedAt: nowIso() };
	await putTask(env, rec);
	return { ok: true, rec };
}

/**
 * tasks/result "MUST block until the task reaches a terminal status" — but a
 * Workers invocation can't literally block forever, so this polls KV up to
 * `maxWaitMs` (bounded well under FN_DEADLINE_MS) and returns whatever the
 * task's state is at that point (terminal, or still working/input_required if
 * the budget ran out — a documented deviation from strict spec text, not a
 * silent one: see the module doc comment and the PR description).
 */
export async function waitForTerminal(env: RtEnv, taskId: string, maxWaitMs: number = TASK_RESULT_MAX_WAIT_MS): Promise<TaskRecord | null> {
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		const rec = await getTask(env, taskId);
		if (!rec || isTerminal(rec.status)) return rec;
		if (Date.now() >= deadline) return rec;
		await new Promise((resolve) => setTimeout(resolve, TASK_RESULT_POLL_STEP_MS));
	}
}

export type TaskPage = { tasks: PublicTask[]; nextCursor?: string };

/** List tasks (cursor-paginated straight off KV's own list cursor — it's
 * already an opaque token, so we just pass it through unchanged). */
export async function listTasks(env: RtEnv, cursor?: string, limit = 50): Promise<TaskPage> {
	const page = await env.OAUTH_KV.list({ prefix: TASK_PREFIX, cursor, limit: Math.min(200, Math.max(1, limit)) });
	const recs = await Promise.all(page.keys.map((k) => env.OAUTH_KV.get(k.name)));
	const tasks: PublicTask[] = [];
	for (const raw of recs) {
		if (!raw) continue;
		try {
			tasks.push(toPublicTask(JSON.parse(raw) as TaskRecord));
		} catch {
			// Corrupt/foreign entry under the prefix — skip rather than fail the list.
		}
	}
	return { tasks, nextCursor: page.list_complete ? undefined : page.cursor };
}
