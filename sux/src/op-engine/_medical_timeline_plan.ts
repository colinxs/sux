// Leaf logic for the `medical-timeline-plan` durable op (registry.ts): turns a batch of raw
// health-event records (vault Health/ notes + any caller-supplied MyChart records, already
// gathered by the `medical_timeline_plan` fn — a leaf only sees `caps`, never `env`) into
// normalized, chronologically-orderable timeline entries, each stamped with its source
// citation. Purely a validation/formatting pass — no LLM, no invention: `title`/`detail` are
// copied verbatim from the source record, mirroring _mychart_reconcile_plan.ts's proposer
// shape but with nothing for a model to condense or embellish here at all.

export type MedicalEventInput = { date: string; kind: string; title: string; detail?: string; source: string };
export type MedicalTimelineItem = MedicalEventInput;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Validate one raw event record. Returns null for anything malformed (missing/unparseable
 *  date, empty title, no source citation) rather than throwing — one bad record must not sink
 *  the whole batch's `map` fan-out. */
export function proposeMedicalEvent(e: MedicalEventInput): MedicalTimelineItem | null {
	if (!e?.date || typeof e.date !== "string" || !ISO_DATE.test(e.date) || Number.isNaN(Date.parse(e.date))) return null;
	if (!e?.title || typeof e.title !== "string" || !e.title.trim()) return null;
	if (!e?.source || typeof e.source !== "string" || !e.source.trim()) return null;
	const kind = typeof e.kind === "string" && e.kind.trim() ? e.kind.trim() : "event";
	return { date: e.date.slice(0, 10), kind, title: e.title.trim(), detail: typeof e.detail === "string" && e.detail.trim() ? e.detail.trim() : undefined, source: e.source.trim() };
}

/** Drop the non-actionable `null`s a per-event propose pass leaves behind, sorted chronologically
 *  (earliest first) so the sink renders the timeline in reading order. */
export function compactMedicalTimelinePlan(items: Array<MedicalTimelineItem | null>): MedicalTimelineItem[] {
	return items.filter((i): i is MedicalTimelineItem => i !== null).sort((a, b) => a.date.localeCompare(b.date));
}
