import { describe, expect, it } from "vitest";
import { redact } from "./redact";

const run = async (args: any) => JSON.parse((await redact.run({} as any, args)).content[0].text);

describe("redact", () => {
	it("redacts email, phone, ssn, valid credit card and ip", async () => {
		// 4111111111111111 is a valid Luhn test card.
		const out = await run({
			text: "Email a@b.com, call 415-555-0198, SSN 123-45-6789, card 4111 1111 1111 1111, ip 10.0.0.1",
		});
		expect(out.redacted).toContain("[REDACTED:email]");
		expect(out.redacted).toContain("[REDACTED:phone]");
		expect(out.redacted).toContain("[REDACTED:ssn]");
		expect(out.redacted).toContain("[REDACTED:credit_card]");
		expect(out.redacted).toContain("[REDACTED:ip]");
		expect(out.counts.credit_card).toBe(1);
		expect(out.redacted).not.toContain("4111");
	});

	it("leaves Luhn-invalid card-length digit runs and out-of-range IPs alone", async () => {
		const out = await run({ text: "order 1234567890123456 from 999.1.1.1", types: ["credit_card", "ip"] });
		expect(out.redacted).toContain("1234567890123456"); // fails Luhn
		expect(out.redacted).toContain("999.1.1.1"); // octet > 255
		expect(out.counts.credit_card).toBeUndefined();
	});

	it("honors the types subset", async () => {
		const out = await run({ text: "a@b.com and 10.0.0.1", types: ["email"] });
		expect(out.redacted).toContain("[REDACTED:email]");
		expect(out.redacted).toContain("10.0.0.1");
	});

	it("redacts a dotted-quad with 3-digit octets without the phone regex eating the front", async () => {
		const out = await run({ text: "server at 192.168.1.100" });
		expect(out.redacted).toBe("server at [REDACTED:ip]");
		expect(out.counts.ip).toBe(1);
		expect(out.counts.phone).toBeUndefined();
		expect(out.redacted).not.toContain("192.168");
		expect(out.redacted).not.toContain(".1.100");
	});

	it("redacts contiguous 10-digit and E.164 phone numbers without separators", async () => {
		const out = await run({ text: "call +15551234567 or 5551234567", types: ["phone"] });
		expect(out.redacted).toBe("call [REDACTED:phone] or [REDACTED:phone]");
		expect(out.counts.phone).toBe(2);
		expect(out.redacted).not.toContain("5551234567");
	});

	it("does not let the contiguous phone branch bite into a Luhn-invalid card run", async () => {
		const out = await run({ text: "order 1234567890123456 done", types: ["credit_card", "phone"] });
		expect(out.redacted).toContain("1234567890123456");
		expect(out.counts.phone).toBeUndefined();
	});

	it("redacts compressed IPv6 addresses (:: zero-compression)", async () => {
		const out = await run({ text: "ipv6 host 2001:db8::1 and ::1", types: ["ip"] });
		expect(out.redacted).toBe("ipv6 host [REDACTED:ip] and [REDACTED:ip]");
		expect(out.counts.ip).toBe(2);
		expect(out.redacted).not.toContain("2001:db8");
		expect(out.redacted).not.toContain("::1");
	});

	it("rejects an unknown type", async () => {
		const r = await redact.run({} as any, { text: "x", types: ["passport"] });
		expect(r.isError).toBe(true);
	});
});
