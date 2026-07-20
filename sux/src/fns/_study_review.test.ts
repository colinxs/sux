import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_INTERVAL_DAYS, dueForReview, hasStudyReview, reviewIntervalDays } from "./_study_review";

describe("gate — fail-closed", () => {
	it("hasStudyReview needs both STUDY_REVIEW_ENABLED and AGENDA_ENABLED", () => {
		expect(hasStudyReview({} as any)).toBe(false);
		expect(hasStudyReview({ STUDY_REVIEW_ENABLED: "1" } as any)).toBe(false);
		expect(hasStudyReview({ AGENDA_ENABLED: "1" } as any)).toBe(false);
		expect(hasStudyReview({ STUDY_REVIEW_ENABLED: "1", AGENDA_ENABLED: "1" } as any)).toBe(true);
		for (const v of ["0", "false", "no", "off"]) expect(hasStudyReview({ STUDY_REVIEW_ENABLED: v, AGENDA_ENABLED: "1" } as any)).toBe(false);
	});
});

describe("reviewIntervalDays", () => {
	it("defaults to DEFAULT_REVIEW_INTERVAL_DAYS when unset or invalid", () => {
		expect(reviewIntervalDays({} as any)).toBe(DEFAULT_REVIEW_INTERVAL_DAYS);
		expect(reviewIntervalDays({ STUDY_REVIEW_INTERVAL_DAYS: "not-a-number" } as any)).toBe(DEFAULT_REVIEW_INTERVAL_DAYS);
		expect(reviewIntervalDays({ STUDY_REVIEW_INTERVAL_DAYS: "-3" } as any)).toBe(DEFAULT_REVIEW_INTERVAL_DAYS);
	});
	it("honors a valid override, clamped to 180", () => {
		expect(reviewIntervalDays({ STUDY_REVIEW_INTERVAL_DAYS: "7" } as any)).toBe(7);
		expect(reviewIntervalDays({ STUDY_REVIEW_INTERVAL_DAYS: "9000" } as any)).toBe(180);
	});
});

const DAY = 24 * 60 * 60 * 1000;

describe("dueForReview", () => {
	it("is not due before the interval elapses", () => {
		const now = 100 * DAY;
		expect(dueForReview([{ topic: "a", learned_at: now - 13 * DAY }], now, 14)).toEqual([]);
	});

	it("is due once the interval elapses, cycle 1", () => {
		const now = 100 * DAY;
		const due = dueForReview([{ topic: "a", learned_at: now - 14 * DAY }], now, 14);
		expect(due).toEqual([{ topic: "a", title: undefined, learned_at: now - 14 * DAY, cycle: 1 }]);
	});

	it("advances the cycle for material studied long ago, so it doesn't fire forever at cycle 1", () => {
		const now = 100 * DAY;
		const due = dueForReview([{ topic: "a", learned_at: now - 30 * DAY }], now, 14);
		expect(due[0].cycle).toBe(2);
	});

	it("skips a topic with no usable learned_at", () => {
		expect(dueForReview([{ topic: "a", learned_at: 0 }], 100 * DAY, 14)).toEqual([]);
		expect(dueForReview([{ topic: "a", learned_at: Number.NaN }], 100 * DAY, 14)).toEqual([]);
	});
});
