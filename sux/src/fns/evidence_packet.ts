import { type Fn, failWith, ok } from "../registry";
import type { RtEnv } from "../registry";
import { errMsg, oj } from "./_util";
import { pdf } from "./pdf";
import type { VaultRecord } from "../vault-mcp";

// evidence_packet (#1206, W2) — one command → a single cited PDF bundle: select vault notes by
// tag/date-range/topic, then assemble a cover page + table of contents + chronological exhibits
// (each stamped with its source note path and date) via the EXISTING `pdf` fn (never reimplement
// PDF layout — see pdf.ts). Reuses `pdf`'s own delivery (`deliverBytes`/#910's R2-ref door): no
// blobs land in git, only a compact `/s/<uuid>` ref (or inline base64 for a small packet).
// Purpose: pro-se-quality document prep on demand — make source provenance impossible to miss.

const SCAN_CAP = 500;

function matchesTag(r: VaultRecord, tag: string): boolean {
	return r.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
}

function matchesTopic(r: VaultRecord, topic: string): boolean {
	const needle = topic.toLowerCase();
	const title = typeof r.fm?.title === "string" ? r.fm.title : r.path;
	const hay = [title, r.path, r.excerpt, ...(r.keywords ?? [])].join(" \n ").toLowerCase();
	return hay.includes(needle);
}

function recordDate(r: VaultRecord): string | undefined {
	const d = r.fm?.date;
	return typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : undefined;
}

function selectExhibits(records: VaultRecord[], a: { tag?: string; topic?: string; from?: string; to?: string; max: number }): VaultRecord[] {
	let out = records;
	if (a.tag) out = out.filter((r) => matchesTag(r, a.tag as string));
	if (a.topic) out = out.filter((r) => matchesTopic(r, a.topic as string));
	if (a.from || a.to) {
		out = out.filter((r) => {
			const d = recordDate(r);
			if (!d) return false;
			if (a.from && d < a.from) return false;
			if (a.to && d > a.to) return false;
			return true;
		});
	}
	return out
		.slice()
		.sort((x, y) => (recordDate(x) ?? "").localeCompare(recordDate(y) ?? "") || x.path.localeCompare(y.path))
		.slice(0, a.max);
}

async function readExhibitBody(env: RtEnv, path: string): Promise<string> {
	const { obsidian } = await import("./obsidian");
	const r = await obsidian.run(env, { action: "read", path, backend: "git" });
	if (r.isError) return "";
	return typeof r.content?.[0]?.text === "string" ? r.content[0].text : "";
}

export const evidence_packet: Fn = {
	name: "evidence_packet",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Assemble a single cited PDF evidence packet from vault notes: pass at least one selector — `tag`, `topic` (matches title/path/excerpt/keywords), or a `from`/`to` date range (matches frontmatter `date`) — and this builds a cover page (selectors + exhibit count), a table of contents, and one chronologically-ordered exhibit per matched note (each stamped with its source path and date), via the existing `pdf` fn. Delivered as an R2 ref (`as:'url'`, the default) — no blobs in git; pass `as:'base64'` to inline a small packet. Purpose: pro-se-quality document prep on demand for attorneys/case prep. Never writes to the vault — the only write is the assembled PDF's own R2 blob.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			folder: { type: "string", description: "Vault folder to scan (default: whole vault)." },
			tag: { type: "string", description: "Only include notes carrying this tag." },
			topic: { type: "string", description: "Only include notes whose title/path/excerpt/keywords contain this text." },
			from: { type: "string", description: "Only include notes with frontmatter date >= this ISO date." },
			to: { type: "string", description: "Only include notes with frontmatter date <= this ISO date." },
			max: { type: "integer", minimum: 1, maximum: 50, description: "Max exhibits to include (default 20)." },
			title: { type: "string", description: "Packet title (default 'Evidence Packet')." },
			as: { type: "string", enum: ["base64", "url"], default: "url", description: "Delivery: prefer the default 'url' ref over inline base64." },
		},
	},
	run: async (env, a) => {
		try {
			const tag = typeof a?.tag === "string" && a.tag.trim() ? a.tag.trim() : undefined;
			const topic = typeof a?.topic === "string" && a.topic.trim() ? a.topic.trim() : undefined;
			const from = typeof a?.from === "string" && a.from.trim() ? a.from.trim() : undefined;
			const to = typeof a?.to === "string" && a.to.trim() ? a.to.trim() : undefined;
			if (!tag && !topic && !from && !to) {
				return failWith("bad_input", "evidence_packet needs at least one selector: `tag`, `topic`, or a `from`/`to` date range.");
			}
			const max = Math.min(50, Math.max(1, Math.floor(Number(a?.max) || 20)));
			const folder = typeof a?.folder === "string" && a.folder.trim() ? a.folder.trim() : undefined;
			const title = typeof a?.title === "string" && a.title.trim() ? a.title.trim() : "Evidence Packet";

			const { scanVault } = await import("../vault-mcp");
			const { records } = await scanVault(env, folder, SCAN_CAP);
			const exhibits = selectExhibits(records, { tag, topic, from, to, max });
			if (!exhibits.length) return ok(oj({ selected: 0, note: "no notes matched those selectors — nothing to assemble" }));

			const selectors = [tag && `tag=${tag}`, topic && `topic=${topic}`, from && `from=${from}`, to && `to=${to}`].filter(Boolean).join(", ");
			const cover = `# ${title}\n\nSelectors: ${selectors}\nExhibits: ${exhibits.length}\n\n## Table of Contents\n\n${exhibits
				.map((r, i) => `${i + 1}. ${typeof r.fm?.title === "string" ? r.fm.title : r.path}${recordDate(r) ? ` (${recordDate(r)})` : ""} — ${r.path}`)
				.join("\n")}`;

			const bodies = await Promise.all(exhibits.map((r) => readExhibitBody(env, r.path)));
			const exhibitTexts = exhibits.map((r, i) => {
				const heading = typeof r.fm?.title === "string" ? r.fm.title : r.path;
				const date = recordDate(r) ?? "undated";
				const body = bodies[i] || r.excerpt || "(no content)";
				return `## Exhibit ${i + 1}: ${heading}\n\nDate: ${date}\nSource: ${r.path}\n\n${body}`;
			});

			const sources = [{ text: cover }, ...exhibitTexts.map((text) => ({ text }))];
			const pdfRes = await pdf.run(env, { sources, title, compress: true, as: a?.as === "base64" ? "base64" : "url" });
			if (pdfRes.isError) return pdfRes;
			const body = JSON.parse(pdfRes.content[0].text);
			return ok(oj({ ...body, selected: exhibits.length, citations: exhibits.map((r) => r.path) }));
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
