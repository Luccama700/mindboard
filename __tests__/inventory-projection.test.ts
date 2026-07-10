import { describe, expect, test } from "vitest";
import {
  addDaysKey,
  buildProjectionDays,
  dailyRateOf,
  daysBetween,
  daysUntilEmpty,
  effectiveDailyRate,
  projectedQuantity,
  reorderDateKey,
  runOutDateKey,
  stockStatus,
  type UsageRule,
} from "@/app/_components/inventory-projection";

function usage(partial: Partial<UsageRule>): UsageRule {
  return { amount: 1, period: "day", interval_days: null, ...partial };
}

describe("daily rate conversion", () => {
  test("day period is amount per day", () => {
    expect(dailyRateOf(usage({ amount: 2, period: "day" }))).toBe(2);
  });

  test("week period spreads across seven days", () => {
    expect(dailyRateOf(usage({ amount: 7, period: "week" }))).toBeCloseTo(1);
    expect(dailyRateOf(usage({ amount: 5, period: "week" }))).toBeCloseTo(5 / 7);
  });

  test("custom period spreads across interval_days", () => {
    expect(
      dailyRateOf(usage({ amount: 6, period: "custom", interval_days: 3 })),
    ).toBeCloseTo(2);
  });

  test("malformed rules contribute zero", () => {
    expect(dailyRateOf(usage({ amount: 0 }))).toBe(0);
    expect(dailyRateOf(usage({ amount: -3 }))).toBe(0);
    expect(
      dailyRateOf(usage({ amount: 5, period: "custom", interval_days: null })),
    ).toBe(0);
    expect(
      dailyRateOf(usage({ amount: 5, period: "custom", interval_days: 0 })),
    ).toBe(0);
    expect(
      dailyRateOf(usage({ amount: 5, period: "custom", interval_days: -3 })),
    ).toBe(0);
  });

  test("multiple usages sum", () => {
    const rate = effectiveDailyRate([
      usage({ amount: 1, period: "day" }),
      usage({ amount: 7, period: "week" }),
    ]);
    expect(rate).toBeCloseTo(2);
  });
});

describe("projected quantity", () => {
  test("declines by the daily rate", () => {
    expect(projectedQuantity(10, 2, 3)).toBe(4);
  });

  test("clamps at zero", () => {
    expect(projectedQuantity(10, 2, 100)).toBe(0);
  });

  test("past and today report the current quantity", () => {
    expect(projectedQuantity(10, 2, 0)).toBe(10);
    expect(projectedQuantity(10, 2, -5)).toBe(10);
  });
});

describe("days until empty", () => {
  test("rounds up to whole days", () => {
    expect(daysUntilEmpty(10, 3)).toBe(4); // 10/3 = 3.33 -> 4
  });

  test("null when nothing is consumed", () => {
    expect(daysUntilEmpty(10, 0)).toBeNull();
  });

  test("zero when already empty", () => {
    expect(daysUntilEmpty(0, 2)).toBe(0);
  });

  test("does not overshoot on an exact division", () => {
    expect(daysUntilEmpty(10, 2)).toBe(5);
  });
});

describe("date-key arithmetic across month, year, and leap-day boundaries", () => {
  test("addDaysKey rolls over a year boundary", () => {
    expect(addDaysKey("2026-12-30", 3)).toBe("2027-01-02");
  });

  test("addDaysKey and daysBetween both account for Feb 29 in a leap year", () => {
    expect(addDaysKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    // 2026 is not a leap year — the same span is one day shorter.
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
  });
});

describe("run-out date", () => {
  test("lands the day quantity reaches zero", () => {
    expect(runOutDateKey("2026-05-31", 10, 2)).toBe("2026-06-05");
  });

  test("null when nothing is consumed", () => {
    expect(runOutDateKey("2026-05-31", 10, 0)).toBeNull();
  });

  test("lands one calendar day earlier when the span crosses a leap day", () => {
    // 6 units at 2/day empties in 3 days; starting the count in a leap-year
    // February means one of those days is the extra Feb 29.
    expect(runOutDateKey("2028-02-27", 6, 2)).toBe("2028-03-01");
    expect(runOutDateKey("2026-02-27", 6, 2)).toBe("2026-03-02");
  });
});

describe("reorder date", () => {
  test("lands the day quantity crosses the threshold", () => {
    // 20 units, 2/day, threshold 6: (20-6)/2 = 7 days -> 2026-06-07
    expect(reorderDateKey("2026-05-31", 20, 2, 6)).toBe("2026-06-07");
  });

  test("today when already at or below threshold", () => {
    expect(reorderDateKey("2026-05-31", 5, 2, 6)).toBe("2026-05-31");
  });

  test("null without a threshold or consumption", () => {
    expect(reorderDateKey("2026-05-31", 20, 2, null)).toBeNull();
    expect(reorderDateKey("2026-05-31", 20, 0, 6)).toBeNull();
  });

  test("today when quantity exactly equals the threshold, not just below it", () => {
    expect(reorderDateKey("2026-05-31", 6, 2, 6)).toBe("2026-05-31");
  });
});

describe("stock status", () => {
  test("out at zero", () => {
    expect(stockStatus(0, 5)).toBe("out");
  });

  test("low at or below threshold", () => {
    expect(stockStatus(5, 5)).toBe("low");
    expect(stockStatus(3, 5)).toBe("low");
  });

  test("ok above threshold or without one", () => {
    expect(stockStatus(10, 5)).toBe("ok");
    expect(stockStatus(1, null)).toBe("ok");
  });
});

describe("projection grid", () => {
  test("maps each day to its projected quantity", () => {
    const rows = buildProjectionDays({
      gridDays: ["2026-05-30", "2026-05-31", "2026-06-01", "2026-06-02"],
      today: "2026-05-31",
      quantityToday: 10,
      dailyRate: 4,
    });
    expect(rows.map((r) => r.quantity)).toEqual([10, 10, 6, 2]);
    expect(rows.map((r) => r.isPast)).toEqual([true, false, false, false]);
    expect(rows.find((r) => r.isToday)?.dateKey).toBe("2026-05-31");
  });

  test("a grid spanning a leap day projects one extra day of consumption", () => {
    const rows = buildProjectionDays({
      gridDays: ["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"],
      today: "2028-02-27",
      quantityToday: 10,
      dailyRate: 1,
    });
    expect(rows.map((r) => r.quantity)).toEqual([10, 9, 8, 7]);
  });
});
