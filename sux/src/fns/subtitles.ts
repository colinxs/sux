import { type Fn, fail, ok } from "../registry";

const TIMING = /(\d{1,2}:\d{2}:\d{2}|\d{2}:\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}|\d{2}:\d{2})[.,](\d{3})(.*)$/;

function srtToVtt(srt: string): string {
	const blocks = srt.replace(/\r/g, "").trim().split(/\n{2,}/);
	const out: string[] = [];
	for (const block of blocks) {
		const lines = block.split("\n");
		// Drop a leading numeric cue index.
		if (lines[0] !== undefined && /^\d+$/.test(lines[0].trim())) lines.shift();
		if (!lines.length) continue;
		// Comma -> dot in the timing line.
		lines[0] = lines[0].replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
		out.push(lines.join("\n"));
	}
	return `WEBVTT\n\n${out.join("\n\n")}\n`;
}

function vttToSrt(vtt: string): string {
	const clean = vtt.replace(/\r/g, "").replace(/^﻿/, "");
	const blocks = clean.split(/\n{2,}/);
	const cues: string[] = [];

	for (const block of blocks) {
		const lines = block.split("\n").filter((l, i) => !(i === 0 && /^WEBVTT/.test(l)));
		if (!lines.length) continue;
		// Skip metadata blocks (NOTE / STYLE / REGION) and a stray WEBVTT header.
		if (/^(NOTE|STYLE|REGION)\b/.test(lines[0]) || /^WEBVTT/.test(lines[0])) continue;

		// A cue may carry an optional identifier line before its timing line.
		let idx = 0;
		if (!TIMING.test(lines[0]) && lines[1] !== undefined && TIMING.test(lines[1])) idx = 1;

		const timingLine = lines[idx];
		const m = timingLine?.match(TIMING);
		if (!m) continue;

		// Normalize to full HH:MM:SS,mmm and drop cue settings after the end timestamp.
		const start = `${padTs(m[1])},${m[2]}`;
		const end = `${padTs(m[3])},${m[4]}`;
		const text = lines.slice(idx + 1).join("\n");
		cues.push(`${cues.length + 1}\n${start} --> ${end}${text ? `\n${text}` : ""}`);
	}
	return cues.join("\n\n") + (cues.length ? "\n" : "");
}

// Ensure a timestamp is HH:MM:SS (VTT allows the MM:SS short form).
function padTs(ts: string): string {
	return /^\d{2}:\d{2}$/.test(ts) ? `00:${ts}` : ts;
}

export const subtitles: Fn = {
	name: "subtitles",
	description:
		"Convert between SRT and WebVTT subtitles. direction: srt_to_vtt (default) | vtt_to_srt. srt_to_vtt: prepend the 'WEBVTT' header and convert ',' to '.' in timestamps (cue indices are dropped, as VTT numbering is optional). vtt_to_srt: strip the WEBVTT header, NOTE/STYLE/REGION blocks and cue settings, renumber cues from 1, and convert '.' to ','. Returns the converted string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "SRT text (srt_to_vtt) or WebVTT text (vtt_to_srt)." },
			direction: { type: "string", enum: ["srt_to_vtt", "vtt_to_srt"], default: "srt_to_vtt" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("data is required.");
		const direction = args?.direction === "vtt_to_srt" ? "vtt_to_srt" : "srt_to_vtt";
		try {
			return ok(direction === "vtt_to_srt" ? vttToSrt(data) : srtToVtt(data));
		} catch (e) {
			return fail(`${direction} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
