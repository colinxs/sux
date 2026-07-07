import { describe, expect, it } from "vitest";
import { subtitles } from "./subtitles";

describe("subtitles", () => {
	it("converts SRT to VTT (header + comma->dot, drops indices)", async () => {
		const srt = "1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:00:05,500 --> 00:00:07,000\nSecond line";
		const r = await subtitles.run({} as any, { data: srt });
		const vtt = r.content[0].text;
		expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
		expect(vtt).toContain("00:00:01.000 --> 00:00:04.000");
		expect(vtt).toContain("00:00:05.500 --> 00:00:07.000");
		expect(vtt).toContain("Hello world");
		expect(vtt).not.toMatch(/,\d{3}/); // no comma timestamps left
	});

	it("converts VTT to SRT (strip header/NOTE/cue-settings, renumber, dot->comma)", async () => {
		const vtt =
			"WEBVTT\n\nNOTE this is a comment\n\n00:00:01.000 --> 00:00:04.000 align:start position:10%\nHello\n\n00:00:05.000 --> 00:00:06.000\nBye";
		const r = await subtitles.run({} as any, { data: vtt, direction: "vtt_to_srt" });
		const srt = r.content[0].text;
		expect(srt).toContain("1\n00:00:01,000 --> 00:00:04,000\nHello");
		expect(srt).toContain("2\n00:00:05,000 --> 00:00:06,000\nBye");
		expect(srt).not.toContain("WEBVTT");
		expect(srt).not.toContain("NOTE");
		expect(srt).not.toContain("align:start"); // cue settings stripped
	});

	it("round-trips SRT -> VTT -> SRT", async () => {
		const srt = "1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n";
		const vtt = (await subtitles.run({} as any, { data: srt })).content[0].text;
		const back = (await subtitles.run({} as any, { data: vtt, direction: "vtt_to_srt" })).content[0].text;
		expect(back.trim()).toBe(srt.trim());
	});

	it("rejects empty data", async () => {
		const r = await subtitles.run({} as any, { data: "" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/required/);
	});
});
