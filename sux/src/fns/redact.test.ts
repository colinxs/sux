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

	it("rejects an unknown type", async () => {
		const r = await redact.run({} as any, { text: "x", types: ["passport"] });
		expect(r.isError).toBe(true);
	});
});
