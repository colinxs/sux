import { describe, expect, it } from "vitest";
import { looksLikeNsldsFile, parseNsldsFile, tryRenderNsldsNote } from "./_nslds";

const FIXTURE = `NSLDS Aggregate Data
Recipient Name: Jane Doe
Loan Type Totals: 3
Guaranty Agency: US Dept of Ed
Loan Type: Direct Subsidized
Loan Status: Repayment
Servicer: MOHELA
Outstanding Principal Balance: $5,000.00
Outstanding Interest Balance: $120.50
Interest Rate: 4.53%
Repayment Plan: Standard
Loan PSLF Cumulative Matched Months: 24
Loan Type: Direct Unsubsidized
Loan Status: Deferment
Servicer: Aidvantage
Outstanding Principal Balance: $3,000.00
Outstanding Interest Balance: $50.00
Interest Rate: 5.28%
Repayment Plan: IBR
Loan PSLF Cumulative Matched Months: 10`;

describe("_nslds — NSLDS MyStudentData.txt detection + parsing (#1323)", () => {
	it("detects the NSLDS shape+vocabulary", () => {
		expect(looksLikeNsldsFile(FIXTURE)).toBe(true);
	});

	it("does not false-positive on an unrelated colon-delimited note", () => {
		const notes = `type: capture
created: 2026-07-22
source: "https://example.com"
tags: [capture, meeting]

Alice said: yes, let's meet Tuesday at 3pm: bring the deck.`;
		expect(looksLikeNsldsFile(notes)).toBe(false);
	});

	it("requires a minimum shape before trusting vocabulary hits alone", () => {
		const short = "Loan Status: ok\nInterest Rate: 5%";
		expect(looksLikeNsldsFile(short)).toBe(false);
	});

	it("groups fields into per-loan records via the most-repeated key", () => {
		const parsed = parseNsldsFile(FIXTURE);
		expect(parsed.anchorKey).toBe("Loan Type");
		expect(parsed.loans).toHaveLength(2);
		expect(parsed.header).toMatchObject({ "Recipient Name": "Jane Doe", "Guaranty Agency": "US Dept of Ed" });
		expect(parsed.loans[0]).toMatchObject({ "Loan Type": "Direct Subsidized", Servicer: "MOHELA" });
		expect(parsed.loans[1]).toMatchObject({ "Loan Type": "Direct Unsubsidized", Servicer: "Aidvantage" });
	});

	it("renders a structured note with known fields surfaced and totals summed", () => {
		const note = tryRenderNsldsNote(FIXTURE, "2026-07-22");
		expect(note).not.toBeNull();
		expect(note!.tags).toEqual(["student-loan", "nslds"]);
		expect(note!.frontmatter).toMatchObject({ kind: "student-loan-aggregate", loan_count: 2, total_outstanding_principal: 8000, next_review: "2026-10-21" });
		expect(note!.body).toContain("### Loan 1: Direct Subsidized");
		expect(note!.body).toContain("**Servicer:** MOHELA");
		expect(note!.body).toContain("**Outstanding principal:** $5,000.00");
		expect(note!.body).toContain("**PSLF cumulative matched months:** 24");
		expect(note!.body).toContain("### Loan 2: Direct Unsubsidized");
		// Student-level totals (before the first loan record) land in the Summary section.
		expect(note!.body).toContain("- **Loan Type Totals:** 3");
		// Every raw per-loan field is preserved even once it's already surfaced above (no data loss).
		expect(note!.body).toContain("- Loan Status: Repayment");
	});

	it("returns null for plain prose", () => {
		expect(tryRenderNsldsNote("Just some notes about my day.\nNothing structured here.", "2026-07-22")).toBeNull();
	});
});
