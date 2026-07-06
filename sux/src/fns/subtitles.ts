import { type Fn, fail, ok } from "../registry";

function srtToVtt(srt: string): string {
	const body = srt
		.replace(/\r/g, "")
		.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
		.replace(/^\d+\s*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return `WEBVTT\n\n${body}\n`;
}

function vttToSrt(vtt: string): string {
	const cues = vtt
		.replace(/\r/g, "")
		.replace(/^WEBVTT.*$/m, "")
		.replace(/^(NOTE|STYLE|REGION)[\s\S]*?(?=\n\n|$)/gm, "")
		.trim()
		.split(/\n\n+/)
		.filter((c) => /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(c));
	return (
		cues
			.map((cue, i) => {
				const lines = cue.split("\n").filter((l) => !/^\s*$/.test(l));

				if (lines[0] && !/-->/.test(lines[0])) lines.shift();
				const timing = lines[0].replace(/\./g, ",").replace(/\s+.*$/, (m) => (/-->/.test(cue) ? m : m)).replace(/(-->\s*[\d:,]+).*/, "$1");
				return `${i + 1}\n${timing}\n${lines.slice(1).join("\n")}`;
			})
			.join("\n\n") + "\n"
	);
}

export const subtitles: Fn = {
	name: "subtitles",
	description: "Convert subtitles between SRT and WebVTT. direction: srt_to_vtt (default) | vtt_to_srt. Handles timestamp format (comma↔dot) and cue numbering.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string" },
			direction: { type: "string", enum: ["srt_to_vtt", "vtt_to_srt"], default: "srt_to_vtt" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("Provide subtitle `data`.");
		return ok(String(args?.direction ?? "srt_to_vtt") === "vtt_to_srt" ? vttToSrt(data) : srtToVtt(data));
	},
};
