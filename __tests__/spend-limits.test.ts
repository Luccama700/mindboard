import { afterEach, describe, expect, it, vi } from "vitest";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import type { SpendLimit } from "@/app/_components/finance-types";
import type {
  BillRule,
  SpendHistoryRow,
} from "@/app/_components/spend-baseline";
import {
  computeLimitStatus,
  limitWarningsForSpend,
  limitWarningsForSpends,
  periodBounds,
} from "@/app/_components/spend-limits";

// 2026-07-06 is a Monday, 2026-07-09 a Thursday, 2026-07-12 a Sunday.
const TODAY = "2026-07-09";

function limit(over: Partial<SpendLimit> = {}): SpendLimit {
  return {
    id: "limit-1",
    scope: "overall",
    category_id: null,
    period: "monthly",
    amount: 500,
    archived: false,
    created_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function spend(
  occurred_at: string,
  amount: number,
  extra?: Partial<SpendHistoryRow>,
): SpendHistoryRow {
  return {
    occurred_at,
    direction: "out",
    amount,
    category_id: null,
    is_transfer: false,
    ...extra,
  };
}

describe("periodBounds", () => {
  it("daily is the day itself", () => {
    expect(periodBounds(TODAY, "daily")).toEqual({
      startKey: "2026-07-09",
      endKey: "2026-07-09",
    });
  });

  it("weekly is the Mon-Sun week containing today", () => {
    expect(periodBounds(TODAY, "weekly")).toEqual({
      startKey: "2026-07-06",
      endKey: "2026-07-12",
    });
  });

  it("weekly Monday maps to its own week, Sunday to the week ending that day", () => {
    // 2026-07-06 is Monday, 2026-07-12 is Sunday — both in the same week.
    expect(periodBounds("2026-07-06", "weekly")).toEqual({
      startKey: "2026-07-06",
      endKey: "2026-07-12",
    });
    expect(periodBounds("2026-07-12", "weekly")).toEqual({
      startKey: "2026-07-06",
      endKey: "2026-07-12",
    });
  });

  it("weekly spans a month boundary", () => {
    // 2026-08-01 is a Saturday; its Monday is 2026-07-27.
    expect(periodBounds("2026-08-01", "weekly")).toEqual({
      startKey: "2026-07-27",
      endKey: "2026-08-02",
    });
  });

  it("weekly spans a year boundary", () => {
    // 2027-01-01 is a Friday; its Monday is 2026-12-28.
    expect(periodBounds("2027-01-01", "weekly")).toEqual({
      startKey: "2026-12-28",
      endKey: "2027-01-03",
    });
  });

  it("monthly is the calendar month, clamped to the month's length", () => {
    expect(periodBounds("2026-07-09", "monthly")).toEqual({
      startKey: "2026-07-01",
      endKey: "2026-07-31",
    });
    // February in a non-leap year ends on the 28th.
    expect(periodBounds("2026-02-15", "monthly")).toEqual({
      startKey: "2026-02-01",
      endKey: "2026-02-28",
    });
    // December rolls the "first of next month" across the year.
    expect(periodBounds("2026-12-10", "monthly")).toEqual({
      startKey: "2026-12-01",
      endKey: "2026-12-31",
    });
  });
});

describe("computeLimitStatus — inclusion rules", () => {
  it("sums only discretionary out-flows inside the period", () => {
    const rows = [
      spend("2026-07-02", 100),
      spend("2026-07-08", 60),
      spend("2026-06-30", 999), // previous month — excluded
      { ...spend("2026-07-03", 40), direction: "in" as const }, // income — excluded
    ];
    const status = computeLimitStatus({ limit: limit(), rows, rules: [], today: TODAY });
    expect(status.spent).toBe(160);
    expect(status.remaining).toBe(340);
    expect(status.state).toBe("under");
  });

  it("excludes transfers", () => {
    const rows = [
      spend("2026-07-02", 100),
      spend("2026-07-04", 250, { is_transfer: true }), // card payment — excluded
    ];
    const status = computeLimitStatus({ limit: limit(), rows, rules: [], today: TODAY });
    expect(status.spent).toBe(100);
  });

  it("excludes recurring bills by amount+category match, no date requirement", () => {
    const rules: BillRule[] = [{ amount: 1200, category_id: null }];
    const rows = [
      spend("2026-07-01", 1200), // rent posted this month — matches bill, excluded
      spend("2026-07-05", 1215), // within 2% of 1200 — still a bill, excluded
      spend("2026-07-06", 80), // real discretionary spend
    ];
    const status = computeLimitStatus({ limit: limit(), rows, rules, today: TODAY });
    expect(status.spent).toBe(80);
  });

  it("respects category scope", () => {
    const groceries = "cat-groceries";
    const rows = [
      spend("2026-07-02", 100, { category_id: groceries }),
      spend("2026-07-03", 40, { category_id: "cat-other" }),
      spend("2026-07-04", 25, { category_id: null }),
    ];
    const catLimit = limit({
      id: "limit-cat",
      scope: "category",
      category_id: groceries,
      amount: 300,
    });
    const status = computeLimitStatus({ limit: catLimit, rows, rules: [], today: TODAY });
    expect(status.spent).toBe(100);

    const overall = computeLimitStatus({ limit: limit(), rows, rules: [], today: TODAY });
    expect(overall.spent).toBe(165);
  });
});

describe("computeLimitStatus — state thresholds", () => {
  function stateFor(spent: number, amount = 500): string {
    const rows = spent > 0 ? [spend("2026-07-05", spent)] : [];
    return computeLimitStatus({ limit: limit({ amount }), rows, rules: [], today: TODAY }).state;
  }

  it("is 'under' below 80%", () => {
    expect(stateFor(399)).toBe("under"); // 79.8%
  });

  it("is 'approaching' at exactly 80%", () => {
    expect(stateFor(400)).toBe("approaching"); // 80.0%
  });

  it("is 'approaching' at 100% (spent == amount, not yet over)", () => {
    expect(stateFor(500)).toBe("approaching");
  });

  it("is 'over' once spent exceeds the cap", () => {
    expect(stateFor(500.01)).toBe("over");
  });

  it("reports pctUsed and a negative remaining when over", () => {
    const rows = [spend("2026-07-05", 600)];
    const status = computeLimitStatus({ limit: limit(), rows, rules: [], today: TODAY });
    expect(status.pctUsed).toBe(120);
    expect(status.remaining).toBe(-100);
    expect(status.state).toBe("over");
  });
});

describe("limitWarningsForSpend", () => {
  const base = [spend("2026-07-02", 380)]; // 380 / 500 = 76% → under

  it("warns when a spend pushes a limit into approaching", () => {
    const warnings = limitWarningsForSpend({
      limits: [limit()],
      rows: base,
      rules: [],
      spend: { amount: 40, categoryId: null, dateKey: TODAY }, // → 420 = 84%
      today: TODAY,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].state).toBe("approaching");
    expect(warnings[0].spent).toBe(420);
  });

  it("warns when a spend pushes a limit over, with a negative remaining", () => {
    const warnings = limitWarningsForSpend({
      limits: [limit()],
      rows: base,
      rules: [],
      spend: { amount: 200, categoryId: null, dateKey: TODAY }, // → 580
      today: TODAY,
    });
    expect(warnings[0].state).toBe("over");
    expect(warnings[0].spent).toBe(580);
    expect(warnings[0].remaining).toBe(-80);
  });

  it("stays silent while the spend keeps the limit under 80%", () => {
    const warnings = limitWarningsForSpend({
      limits: [limit()],
      rows: base,
      rules: [],
      spend: { amount: 10, categoryId: null, dateKey: TODAY }, // → 390 = 78%
      today: TODAY,
    });
    expect(warnings).toEqual([]);
  });

  it("does not count a pending spend that matches a bill", () => {
    const warnings = limitWarningsForSpend({
      limits: [limit()],
      rows: base,
      rules: [{ amount: 200, category_id: null }],
      spend: { amount: 200, categoryId: null, dateKey: TODAY }, // matches the bill rule
      today: TODAY,
    });
    expect(warnings).toEqual([]);
  });

  it("only warns a category limit when the spend's category matches", () => {
    const groceries = "cat-groceries";
    const catLimit = limit({
      id: "limit-cat",
      scope: "category",
      category_id: groceries,
      amount: 100,
    });
    const rows = [spend("2026-07-02", 90, { category_id: groceries })];

    const miss = limitWarningsForSpend({
      limits: [catLimit],
      rows,
      rules: [],
      spend: { amount: 50, categoryId: "cat-other", dateKey: TODAY },
      today: TODAY,
    });
    expect(miss).toEqual([]);

    const hit = limitWarningsForSpend({
      limits: [catLimit],
      rows,
      rules: [],
      spend: { amount: 50, categoryId: groceries, dateKey: TODAY }, // → 140 over 100
      today: TODAY,
    });
    expect(hit).toHaveLength(1);
    expect(hit[0].state).toBe("over");
  });

  it("ignores a spend dated outside the current period", () => {
    const warnings = limitWarningsForSpend({
      limits: [limit()],
      rows: base,
      rules: [],
      spend: { amount: 300, categoryId: null, dateKey: "2026-06-15" }, // last month
      today: TODAY,
    });
    expect(warnings).toEqual([]);
  });
});

describe("limitWarningsForSpends — batch", () => {
  it("sums applicable pending spends against one limit", () => {
    const warnings = limitWarningsForSpends({
      limits: [limit()], // 500 cap, no history
      rows: [],
      rules: [],
      spends: [
        { amount: 300, categoryId: null, dateKey: TODAY },
        { amount: 250, categoryId: null, dateKey: TODAY }, // together 550 > 500
      ],
      today: TODAY,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].state).toBe("over");
    expect(warnings[0].spent).toBe(550);
  });
});

describe("timezone edges", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the period from the user's local day, not the UTC clock", () => {
    // 2026-08-01T04:30Z is still 2026-07-31 (21:30) in Vancouver (UTC-7 summer).
    const instant = new Date("2026-08-01T04:30:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(instant);

    const zone = safeTimeZone("America/Vancouver");
    const localToday = todayISO(zone);
    expect(localToday).toBe("2026-07-31");

    // The monthly period is July locally, but would be August in UTC.
    expect(periodBounds(localToday, "monthly").startKey).toBe("2026-07-01");
    expect(todayISO(safeTimeZone("UTC"))).toBe("2026-08-01");
    expect(periodBounds(todayISO(safeTimeZone("UTC")), "monthly").startKey).toBe(
      "2026-08-01",
    );

    // A spend stamped on the local day lands inside the local period.
    const rows = [spend("2026-07-31", 120)];
    const status = computeLimitStatus({
      limit: limit(),
      rows,
      rules: [],
      today: localToday,
    });
    expect(status.spent).toBe(120);
  });
});
