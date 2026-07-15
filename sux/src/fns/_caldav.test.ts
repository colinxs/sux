import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVEvent, buildVTodo, caldavFetch, dateProp, hasCalDav, icalDateToIso, icalStamp, listCalendars, parseICal, replaceProps, reportObjects, textProp, zonedStamp } from "./_caldav";

const octets = (s: string) => new TextEncoder().encode(s).length;

const env = () => ({ FASTMAIL_CALDAV_USER: "me@fastmail.com", FASTMAIL_APP_PASSWORD: "app-pw" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("_caldav iCal build/parse", () => {
	it("icalStamp: ISO date-time → UTC stamp; date-only → VALUE=DATE", () => {
		expect(icalStamp("2026-07-11T09:00:00Z")).toEqual({ value: "20260711T090000Z", dateOnly: false });
		expect(icalStamp("2026-07-11")).toEqual({ value: "20260711", dateOnly: true });
		expect(() => icalStamp("not-a-date")).toThrow(/invalid/);
	});

	it("zonedStamp renders an absolute instant as wall-clock digits in tz, DST-aware", () => {
		expect(zonedStamp("2026-07-11T13:00:00Z", "America/New_York")).toBe("20260711T090000"); // EDT (UTC-4)
		expect(zonedStamp("2026-01-11T13:00:00Z", "America/New_York")).toBe("20260111T080000"); // EST (UTC-5)
		expect(() => zonedStamp("not-a-date", "America/New_York")).toThrow(/invalid/);
	});

	it("dateProp with a tz re-anchors to TZID instead of collapsing to a UTC Z stamp", () => {
		expect(dateProp("DTSTART", "2026-07-11T13:00:00Z", "America/New_York")).toBe("DTSTART;TZID=America/New_York:20260711T090000");
		expect(dateProp("DTSTART", "2026-07-11T13:00:00Z")).toBe("DTSTART:20260711T130000Z"); // no tz → unchanged Z behavior
		expect(dateProp("DTSTART", "2026-12-25", "America/New_York")).toBe("DTSTART;VALUE=DATE:20261225"); // all-day ignores tz
		expect(dateProp("DTSTART", "2026-07-11T13:00:00Z", "Not/AZone")).toBe("DTSTART:20260711T130000Z"); // unrecognized zone falls back, never throws
	});

	it("buildVEvent emits a valid VCALENDAR/VEVENT with escaping", () => {
		const ical = buildVEvent({ uid: "u1", summary: "Lunch, w/ Ada; notes", start: "2026-07-11T12:00:00Z", end: "2026-07-11T13:00:00Z", location: "Cafe", dtstamp: "2026-07-10T00:00:00Z" });
		expect(ical).toContain("BEGIN:VEVENT");
		expect(ical).toContain("UID:u1");
		expect(ical).toContain("DTSTART:20260711T120000Z");
		expect(ical).toContain("DTEND:20260711T130000Z");
		expect(ical).toContain("SUMMARY:Lunch\\, w/ Ada\\; notes"); // TEXT escaping
		expect(ical).toContain("LOCATION:Cafe");
	});

	it("all-day event uses VALUE=DATE", () => {
		const ical = buildVEvent({ uid: "u2", summary: "Holiday", start: "2026-12-25", dtstamp: "2026-07-10T00:00:00Z" });
		expect(ical).toContain("DTSTART;VALUE=DATE:20261225");
	});

	it("buildVTodo emits a VTODO with STATUS", () => {
		const ical = buildVTodo({ uid: "t1", summary: "File taxes", due: "2026-04-15", dtstamp: "2026-07-10T00:00:00Z" });
		expect(ical).toContain("BEGIN:VTODO");
		expect(ical).toContain("DUE;VALUE=DATE:20260415");
		expect(ical).toContain("STATUS:NEEDS-ACTION");
	});

	it("parseICal round-trips a built event, unfolding + unescaping", () => {
		const long = "x".repeat(200);
		const ical = buildVEvent({ uid: "u3", summary: "A, B; C", start: "2026-07-11T09:00:00Z", description: long, dtstamp: "2026-07-10T00:00:00Z" });
		const [comp] = parseICal(ical);
		expect(comp.component).toBe("VEVENT");
		expect(comp.props.SUMMARY).toBe("A, B; C"); // unescaped
		expect(comp.props.DESCRIPTION).toBe(long); // folded then unfolded intact
		expect(comp.props.UID).toBe("u3");
	});

	it("folding counts UTF-8 octets at 75 and never splits a multibyte sequence", () => {
		// A multibyte (emoji + accented) summary long enough to fold several times.
		const summary = "café 🎉 déjà vu — ".repeat(12);
		const ical = buildVEvent({ uid: "u4", summary, start: "2026-07-11T09:00:00Z", dtstamp: "2026-07-10T00:00:00Z" });
		for (const line of ical.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75); // no physical line exceeds 75 octets
		// A byte-level split would corrupt a code point; round-trip proves every sequence stayed whole.
		expect(parseICal(ical)[0].props.SUMMARY).toBe(summary);
	});
});

describe("_caldav parseICal — component isolation + normalization", () => {
	it("a VALARM's DESCRIPTION never overwrites the VEVENT's props", () => {
		const ical = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:evt-1",
			"SUMMARY:Real Meeting",
			"DTSTART:20260711T090000Z",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"DESCRIPTION:ALARM POPUP TEXT",
			"TRIGGER:-PT15M",
			"END:VALARM",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const [comp] = parseICal(ical);
		expect(comp.props.SUMMARY).toBe("Real Meeting");
		expect(comp.props.DESCRIPTION).toBeUndefined(); // the alarm's DESCRIPTION did NOT bleed in
		expect(comp.props.TRIGGER).toBeUndefined();
		expect(comp.props.ACTION).toBeUndefined();
	});

	it("a sibling VTIMEZONE's DTSTART never becomes the event's start; TZID is surfaced", () => {
		const ical = [
			"BEGIN:VCALENDAR",
			"BEGIN:VTIMEZONE",
			"TZID:America/New_York",
			"BEGIN:STANDARD",
			"DTSTART:20241103T020000",
			"TZOFFSETTO:-0500",
			"END:STANDARD",
			"END:VTIMEZONE",
			"BEGIN:VEVENT",
			"UID:evt-2",
			"DTSTART;TZID=America/New_York:20260711T090000",
			"SUMMARY:NY Event",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const [comp] = parseICal(ical);
		expect(comp.start).toBe("2026-07-11T09:00:00"); // the event's wall time, NOT 2024-11-03 from VTIMEZONE
		expect(comp.tz).toBe("America/New_York"); // non-UTC zone preserved, not coerced to Z
		expect(comp.all_day).toBe(false);
		expect(comp.props.TZOFFSETTO).toBeUndefined();
	});

	it("icalDateToIso: UTC → Z, VALUE=DATE → all-day, TZID → floating wall time + zone", () => {
		expect(icalDateToIso("20260711T090000Z")).toEqual({ iso: "2026-07-11T09:00:00Z", all_day: false, tz: null });
		expect(icalDateToIso("20261225", { VALUE: "DATE" })).toEqual({ iso: "2026-12-25", all_day: true, tz: null });
		expect(icalDateToIso("20260711T090000", { TZID: "Europe/Berlin" })).toEqual({ iso: "2026-07-11T09:00:00", all_day: false, tz: "Europe/Berlin" });
	});

	it("parses every top-level VEVENT in a multi-event blob", () => {
		const ical = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a", "SUMMARY:One", "END:VEVENT", "BEGIN:VEVENT", "UID:b", "SUMMARY:Two", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
		const comps = parseICal(ical);
		expect(comps.map((c) => c.props.UID)).toEqual(["a", "b"]);
	});

	it("buildVTodo COMPLETED carries a COMPLETED stamp + PERCENT-COMPLETE:100", () => {
		const ical = buildVTodo({ uid: "t9", summary: "done", status: "COMPLETED", completed: "2026-07-11T10:00:00Z", dtstamp: "2026-07-11T10:00:00Z" });
		expect(ical).toContain("STATUS:COMPLETED");
		expect(ical).toContain("COMPLETED:20260711T100000Z");
		expect(ical).toContain("PERCENT-COMPLETE:100");
	});
});

describe("_caldav replaceProps", () => {
	it("rewrites requested props in place, preserving UID, TZID encoding, and the VALARM", () => {
		const ical = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"UID:keep-me",
			"DTSTART;TZID=America/New_York:20260711T090000",
			"SUMMARY:Old Title",
			"BEGIN:VALARM",
			"ACTION:DISPLAY",
			"TRIGGER:-PT15M",
			"END:VALARM",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const out = replaceProps(ical, "VEVENT", { SUMMARY: textProp("SUMMARY", "New Title"), LOCATION: textProp("LOCATION", "Room 5") });
		const [comp] = parseICal(out);
		expect(comp.props.UID).toBe("keep-me"); // untouched
		expect(comp.props.SUMMARY).toBe("New Title"); // replaced in place
		expect(comp.props.LOCATION).toBe("Room 5"); // appended
		expect(comp.tz).toBe("America/New_York"); // the TZID DTSTART line survived verbatim
		expect(out).toContain("BEGIN:VALARM"); // the alarm was preserved
		expect(out).toContain("TRIGGER:-PT15M");
	});

	it("a null set deletes a property", () => {
		const ical = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "SUMMARY:s", "LOCATION:gone", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
		const out = replaceProps(ical, "VEVENT", { LOCATION: null });
		expect(parseICal(out)[0].props.LOCATION).toBeUndefined();
	});

	it("rewriting DTSTART itself keeps the TZID (re-anchors, doesn't collapse to UTC) — the bug this fixes", () => {
		const ical = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:z", "DTSTART;TZID=America/New_York:20260711T090000", "SUMMARY:Standup", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
		// Caller moves it an hour later: the same NY wall-clock day, 10:00 instead of 9:00 → 14:00Z.
		const out = replaceProps(ical, "VEVENT", { DTSTART: dateProp("DTSTART", "2026-07-11T14:00:00Z", "America/New_York") });
		const [comp] = parseICal(out);
		expect(out).toContain("DTSTART;TZID=America/New_York:20260711T100000"); // zone preserved, not a bare Z stamp
		expect(comp.tz).toBe("America/New_York");
		expect(comp.start).toBe("2026-07-11T10:00:00");
	});
});

const MULTISTATUS_CALS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/dav/calendars/user/me@fastmail.com/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/calendars/user/me@fastmail.com/personal/</d:href>
    <d:propstat><d:prop><d:displayname>Personal</d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/calendars/user/me@fastmail.com/tasks/</d:href>
    <d:propstat><d:prop><d:displayname>Tasks</d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>
</d:multistatus>`;

describe("_caldav discovery + report", () => {
	it("hasCalDav reflects both secrets", () => {
		expect(hasCalDav(env())).toBe(true);
		expect(hasCalDav({ FASTMAIL_CALDAV_USER: "x" } as any)).toBe(false);
	});

	it("listCalendars parses a multistatus, separating tasks from event calendars", async () => {
		global.fetch = vi.fn(async () => new Response(MULTISTATUS_CALS, { status: 207 })) as any;
		const cals = await listCalendars(env());
		expect(cals).toHaveLength(2); // the home collection (no calendar resourcetype) is skipped
		expect(cals.find((c) => c.name === "Personal")).toMatchObject({ isTasks: false });
		expect(cals.find((c) => c.name === "Tasks")).toMatchObject({ isTasks: true });
	});

	it("caldavFetch injects Basic auth + returns etag", async () => {
		const f = vi.fn(async () => new Response("ok", { status: 200, headers: { etag: '"abc"' } }));
		global.fetch = f as any;
		const r = await caldavFetch(env(), "GET", "/dav/calendars/user/me@fastmail.com/personal/x.ics");
		expect(r.etag).toBe('"abc"');
		expect(((f.mock.calls[0] as any[])[1] as any).headers.Authorization).toMatch(/^Basic /);
	});

	it("caldavFetch accepts an absolute href on CALDAV_HOST itself", async () => {
		const f = vi.fn(async () => new Response("ok", { status: 200 }));
		global.fetch = f as any;
		await caldavFetch(env(), "GET", "https://caldav.fastmail.com/dav/calendars/user/me@fastmail.com/personal/x.ics");
		expect(f).toHaveBeenCalledTimes(1);
	});

	it("caldavFetch rejects an off-host absolute href before issuing any fetch (SSRF / credential exfil guard, #402/#453)", async () => {
		const f = vi.fn(async () => new Response("ok", { status: 200 }));
		global.fetch = f as any;
		await expect(caldavFetch(env(), "GET", "https://attacker.example/x")).rejects.toThrow(/CalDAV href must be on/);
		// A near-miss host (prefix/suffix trick) must not slip past a naive startsWith check.
		await expect(caldavFetch(env(), "GET", "https://caldav.fastmail.com.attacker.example/x")).rejects.toThrow(/CalDAV href must be on/);
		await expect(caldavFetch(env(), "GET", "https://notcaldav.fastmail.com/x")).rejects.toThrow(/CalDAV href must be on/);
		expect(f).not.toHaveBeenCalled();
	});

	it("reportObjects pulls calendar-data blocks from a REPORT multistatus", async () => {
		const ical = buildVEvent({ uid: "e9", summary: "Standup", start: "2026-07-11T09:00:00Z", dtstamp: "2026-07-10T00:00:00Z" });
		const body = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/user/me@fastmail.com/personal/e9.ics</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><c:calendar-data>${ical}</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`;
		global.fetch = vi.fn(async () => new Response(body, { status: 207 })) as any;
		const objs = await reportObjects(env(), "/dav/calendars/user/me@fastmail.com/personal/", "VEVENT");
		expect(objs).toHaveLength(1);
		expect(objs[0]).toMatchObject({ etag: '"e1"' });
		expect(parseICal(objs[0].ical)[0].props.SUMMARY).toBe("Standup");
	});

	it("bounds a VEVENT REPORT with a default time-range; leaves VTODO unbounded unless a window is given", async () => {
		const bodies: string[] = [];
		global.fetch = vi.fn(async (_url: any, init: any) => {
			bodies.push(String(init?.body ?? ""));
			return new Response(`<d:multistatus xmlns:d="DAV:"></d:multistatus>`, { status: 207 });
		}) as any;
		await reportObjects(env(), "/cal/", "VEVENT"); // default now..+90d
		expect(bodies[0]).toMatch(/<c:time-range start="\d{8}T\d{6}Z" end="\d{8}T\d{6}Z"\/>/);
		await reportObjects(env(), "/cal/", "VTODO"); // undated tasks must survive → no filter
		expect(bodies[1]).not.toContain("time-range");
		await reportObjects(env(), "/cal/", "VTODO", { start: "2026-01-01", end: "2026-12-31" }); // explicit window opts in
		expect(bodies[2]).toContain("<c:time-range");
	});
});

// A fuzz/property sweep: malformed, non-UTC, TZID-bearing, VALARM-laden, folded iCal fed into
// parseICal must NEVER throw and NEVER cross-contaminate one component's props with another's
// (a VALARM/VTIMEZONE child, or a following component).
describe("_caldav parseICal fuzz", () => {
	function mulberry32(seed: number) {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// Harmless junk that may appear anywhere — none of it carries a contaminant marker, so if it
	// lands directly in a component that's legitimate, not contamination.
	const NOISE = [
		"",
		"   ",
		"\t",
		":::",
		"NOCOLONHERE",
		"X-JUNK;PARAM=val:whatever",
		"DTSTART", // no colon
		"SUMMARY:", // empty value (would only overwrite with empty, still CANON-free)
		"COMMENT:with, commas; and \\n escapes \\\\ and semicolons",
		"BEGIN:", // malformed BEGIN
		"END:", // malformed END
		"café 🎉 unfolded noise 🚀",
	];
	// A properly-nested VALARM whose DESCRIPTION must NOT reach the enclosing event.
	const VALARM = ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:ALARM-CONTAMINANT", "TRIGGER:-PT10M", "END:VALARM"];

	it("never throws and never cross-contaminates over random blobs", () => {
		const rnd = mulberry32(0xc0ffee);
		for (let i = 0; i < 800; i++) {
			const lines: string[] = ["BEGIN:VCALENDAR"];
			// A sibling VTIMEZONE (its TZID/DTSTART must never reach a real component).
			if (rnd() < 0.5) lines.push("BEGIN:VTIMEZONE", "TZID:Poison/Zone", "DTSTART:19700101T000000", "END:VTIMEZONE");
			const nComps = 1 + Math.floor(rnd() * 3);
			for (let c = 0; c < nComps; c++) {
				const isTodo = rnd() < 0.5;
				lines.push(isTodo ? "BEGIN:VTODO" : "BEGIN:VEVENT");
				lines.push(`UID:comp-${i}-${c}`);
				lines.push(`SUMMARY:CANON-${i}-${c}`);
				if (rnd() < 0.4) lines.push(`DTSTART;TZID=Antarctica/Troll:20260711T1230${String(c).padStart(2, "0")}`);
				const noiseCount = Math.floor(rnd() * 6);
				for (let n = 0; n < noiseCount; n++) lines.push(NOISE[Math.floor(rnd() * NOISE.length)]);
				if (rnd() < 0.6) lines.push(...VALARM); // a nested alarm block
				// Randomly drop the END to simulate truncation/corruption.
				if (rnd() < 0.85) lines.push(isTodo ? "END:VTODO" : "END:VEVENT");
			}
			if (rnd() < 0.9) lines.push("END:VCALENDAR");
			// Fold some lines at arbitrary points to stress the unfolder.
			const raw = lines
				.map((l) => (l.length > 8 && rnd() < 0.3 ? `${l.slice(0, 5)}\r\n ${l.slice(5)}` : l))
				.join(rnd() < 0.5 ? "\r\n" : "\n");

			let comps: ReturnType<typeof parseICal>;
			expect(() => (comps = parseICal(raw))).not.toThrow();
			for (const comp of comps!) {
				// The alarm/timezone contaminants must never land on a real component.
				expect(comp.props.DESCRIPTION).not.toBe("ALARM-CONTAMINANT");
				expect(comp.props.TZID).not.toBe("Poison/Zone");
				expect(comp.props.TRIGGER).toBeUndefined();
				expect(comp.props.ACTION).toBeUndefined();
				expect(comp.props.TZOFFSETTO).toBeUndefined();
				// UID is written only by real components (never by noise/alarm/timezone), so a captured
				// component's UID is always a canonical marker — proof no foreign frame leaked its identity
				// in. (trailing whitespace can accrue from a space-led continuation line, hence trimEnd.)
				if (comp.props.UID !== undefined) expect(comp.props.UID.replace(/\s+$/, "")).toMatch(/^comp-\d+-\d+$/);
			}
		}
	});
});
