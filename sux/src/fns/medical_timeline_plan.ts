import { type Fn, failWith, ok } from "../registry";
import type { RtEnv } from "../registry";
import { runVerb } from "./run";
import { errMsg, oj } from "./_util";
import type { MedicalEventInput } from "../op-engine/_medical_timeline_plan";

// medical_timeline_plan (#1205, W2) — the entrypoint for a regenerable, per-event-cited
// chronological medical timeline: gathers dated health events from the vault's Health/ folder
// (frontmatter `date`/`kind`(or `type`)/`title`/`detail`, cited to the note path) plus any
// caller-supplied records (e.g. MyChart-sourced entries a caller already fetched — this fn has
// no FHIR parser of its own), then starts a durable run (op:'medical-timeline-plan') that
// validates/sorts them and PAUSES for one human "write this medical timeline?" approval before
// regenerating `Timeline/Medical.md`. Mirrors mychart_reconcile_plan.ts's fetch-in-the-calling-
// fn shape (a leaf only sees `caps`, not env) and _life_wiki.ts's "never hand-edited, re-run to
// refresh" convention. Gated behind MEDICAL_TIMELINE_ENABLED — fail-closed, same two-stage shape
// as the other plan-op entrypoints.

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "")
		.trim()
		.toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "off" && s !== "no";
};

export const hasMedicalTimeline = (env: RtEnv): boolean => flagOn(env.MEDICAL_TIMELINE_ENABLED);

const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

async function gatherVaultHealthEvents(env: RtEnv, folder: string, cap: number): Promise<MedicalEventInput[]> {
	const { scanVault } = await import("../vault-mcp");
	const { records } = await scanVault(env, folder, cap);
	return records
		.map((r): MedicalEventInput | null => {
			const fm = r.fm ?? {};
			const date = typeof fm.date === "string" && fm.date ? fm.date : undefined;
			if (!date) return null;
			const title = typeof fm.title === "string" && fm.title ? fm.title : r.path.split("/").pop()?.replace(/\.md$/i, "") || r.path;
			const kind = typeof fm.kind === "string" && fm.kind ? fm.kind : typeof fm.type === "string" && fm.type ? fm.type : "event";
			const detail: string | undefined = typeof fm.detail === "string" && fm.detail ? fm.detail : r.excerpt || undefined;
			return { date, kind, title, detail, source: r.path };
		})
		.filter((e): e is MedicalEventInput => e !== null);
}

export const medical_timeline_plan: Fn = {
	name: "medical_timeline_plan",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Durable medical-timeline synthesis (#1205, W2): gathers dated health events from the vault's Health/ folder (frontmatter date/kind/title/detail, cited to the note path) plus any `records` you pass in (e.g. already-fetched MyChart entries — cite each with a `source` string), then starts a durable run (op:'medical-timeline-plan') that validates and chronologically sorts them (no LLM — every title/detail is copied verbatim, nothing invented), then PAUSES for one human 'write this medical timeline?' approval. Approval regenerates ONE note, `Timeline/Medical.md`, as a full overwrite (never hand-edit it — re-run this to refresh; git is the undo). Returns {instanceId}: poll with `run {action:'status', instanceId}`; approve with `run {action:'answer', instanceId, prompt:\"write this medical timeline?\", payload:{approved:true}}`, or veto with {approved:false}. An unanswered gate writes nothing after 24h (fails closed). Needs MEDICAL_TIMELINE_ENABLED.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			folder: { type: "string", description: "Vault folder to scan for health-event notes (default 'Health')." },
			max: { type: "integer", minimum: 1, maximum: 500, description: "Max events to include this run (default 200)." },
			records: {
				type: "array",
				description: "Extra events to include verbatim (e.g. already-fetched MyChart entries), merged with the vault-gathered ones.",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["date", "title", "source"],
					properties: {
						date: { type: "string", description: "ISO date, e.g. 2026-03-05." },
						kind: { type: "string", description: "appointment | medication | result | incident | ..." },
						title: { type: "string" },
						detail: { type: "string" },
						source: { type: "string", description: "Citation, e.g. a MyChart record id/org or a note path." },
					},
				},
			},
		},
	},
	run: async (env, a) => {
		if (!hasMedicalTimeline(env)) {
			return failWith("not_configured", "medical_timeline_plan is disabled — set MEDICAL_TIMELINE_ENABLED to arm it. Nothing gathered or written until then.");
		}
		try {
			const folder = typeof a?.folder === "string" && a.folder.trim() ? a.folder.trim() : "Health";
			const max = numClamp(a?.max, 1, 500, 200);
			const vaultEvents = await gatherVaultHealthEvents(env, folder, max);
			const extra: MedicalEventInput[] = Array.isArray(a?.records)
				? a.records.filter((r: unknown): r is MedicalEventInput => typeof (r as { date?: unknown })?.date === "string" && typeof (r as { title?: unknown })?.title === "string" && typeof (r as { source?: unknown })?.source === "string")
				: [];
			const input = [...vaultEvents, ...extra].slice(0, max);
			if (!input.length) return ok(oj({ scanned: 0, note: `no dated health events found under ${folder}/ — nothing to draft` }));
			const res = await runVerb({ op: "medical-timeline-plan", input, mode: "durable" }, env);
			return ok(
				oj({
					scanned: input.length,
					...res,
					note: 'durable run started — validates and chronologically sorts these events, then pauses for a human \'write this medical timeline?\' approval. Poll with `run {action:\'status\', instanceId}`; approve/reject with `run {action:\'answer\', instanceId, prompt:"write this medical timeline?"}` ({approved:true|false}). Approval regenerates Timeline/Medical.md — never hand-edit it.',
				}),
			);
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
