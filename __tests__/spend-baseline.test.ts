import { describe, expect, it } from "vitest";
import {
  computeWeekdayBaseline,
  estimatedSpendOn,
  matchesBill,
  MIN_CONFIDENT_DAYS,
  type BillRule,
  type SpendHistoryRow,
} from "@/app/_components/spend-baseline";
import { addDaysKey, buildDayRows } from "@/app/_components/finance-projection";

// 2026-07-07 is a tuesday; the trailing window ends 2026-07-06 (monday).
const TODAY = "2026-07-07";

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

const rentRule: BillRule = {
  frequency: "monthly",
  day_of_month: 1,
  weekday: null,
  interval_days: null,
  start_date: null,
  amount: 1200,
  category_id: "cat-housing",
};

describe("matchesBill", () => {
  it("matches amount within 2% near a landing day, category-compatible", () => {
    expect(
      matchesBill({ occurred_at: "2026-07-02", amount: 1200, category_id: "cat-housing" }, [rentRule]),
    ).toBe(true);
    expect(
      matchesBill({ occurred_at: "2026-07-02", amount: 1210, category_id: null }, [rentRule]),
    ).toBe(true);
  });

  it("rejects wrong amounts, far dates, and conflicting categories", () => {
    expect(
      matchesBill({ occurred_at: "2026-07-02", amount: 900, category_id: null }, [rentRule]),
    ).toBe(false);
    expect(
      matchesBill({ occurred_at: "2026-07-15", amount: 1200, category_id: null }, [rentRule]),
    ).toBe(false);
    expect(
      matchesBill({ occurred_at: "2026-07-02", amount: 1200, category_id: "cat-dining" }, [rentRule]),
    ).toBe(false);
  });
});

describe("computeWeekdayBaseline", () => {
  it("returns an unconfident zero baseline with no history", () => {
    const b = computeWeekdayBaseline({ history: [], rules: [], today: TODAY });
    expect(b.confident).toBe(false);
    expect(b.byWeekday).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("takes the per-weekday median with zero-days included", () => {
    // 4-week window ending mon 2026-07-06 → mondays jun 15, 22, 29, jul 6.
    // spends on three of them; the zero monday joins the samples:
    // [0, 10, 20, 30] → median 15
    const history = [
      spend("2026-06-15", 10),
      spend("2026-06-22", 20),
      spend("2026-06-29", 30),
      // anchor history before the window so it isn't clipped
      spend("2026-06-01", 5),
    ];
    const b = computeWeekdayBaseline({ history, rules: [], today: TODAY, weeks: 4 });
    expect(b.confident).toBe(true);
    expect(b.byWeekday[1]).toBe(15);
  });

  it("resists a one-off spike (median, not mean)", () => {
    // 5-week window → fridays jun 5, 12, 19, 26, jul 3, all $25, one with a
    // one-off $800 TV on top: [25, 25, 25, 25, 825] → median stays 25
    const fridays = ["2026-06-05", "2026-06-12", "2026-06-19", "2026-06-26", "2026-07-03"];
    const history = [
      ...fridays.map((d) => spend(d, 25)),
      spend("2026-06-12", 800),
      spend("2026-06-01", 5),
    ];
    const b = computeWeekdayBaseline({ history, rules: [], today: TODAY, weeks: 5 });
    expect(b.byWeekday[5]).toBe(25);
  });

  it("excludes bill payments and transfers from the totals", () => {
    const history = [
      spend("2026-07-01", 1200, { category_id: "cat-housing" }), // rent — excluded
      spend("2026-07-01", 18),
      spend("2026-07-02", 250, { is_transfer: true }), // card payment — excluded
      spend("2026-04-15", 5),
    ];
    const b = computeWeekdayBaseline({ history, rules: [rentRule], today: TODAY });
    // 2026-07-01 is a wednesday: only the $18 survives; median over ~12
    // wednesdays of mostly 0 is 0, so check via a 1-week window instead
    const tight = computeWeekdayBaseline({
      history,
      rules: [rentRule],
      today: "2026-07-03",
      weeks: 1,
    });
    expect(tight.byWeekday[3]).toBe(18);
    expect(b.byWeekday[4]).toBe(0); // thursday transfer day contributed nothing
  });

  it("clips the window to the first recorded day (young ledgers)", () => {
    // tracking started 10 days ago — only those days are samples
    const start = addDaysKey(TODAY, -10);
    const history = [spend(start, 12)];
    const b = computeWeekdayBaseline({ history, rules: [], today: TODAY });
    expect(b.sampledDays).toBe(10);
    expect(b.confident).toBe(false);
    expect(MIN_CONFIDENT_DAYS).toBeGreaterThan(10);
  });
});

describe("estimatedSpendOn", () => {
  const confident = {
    byWeekday: [34, 12, 15, 11, 14, 28, 61],
    sampledDays: 84,
    confident: true,
  };
  const thin = { byWeekday: [0, 0, 0, 0, 0, 0, 0], sampledDays: 10, confident: false };

  it("uses the weekday median when confident", () => {
    expect(estimatedSpendOn(confident, 40, "2026-07-11")).toBe(61); // saturday
  });

  it("falls back to the manual value, then to zero", () => {
    expect(estimatedSpendOn(thin, 31, "2026-07-11")).toBe(31);
    expect(estimatedSpendOn(thin, null, "2026-07-11")).toBe(0);
  });
});

describe("buildDayRows with an estimated-spend layer", () => {
  it("subtracts estimates from future running totals but not past days", () => {
    const gridDays = [
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
    ];
    const rows = buildDayRows({
      gridDays,
      month: "2026-07",
      today: TODAY,
      netWorthToday: 1000,
      changes: [],
      expenses: [],
      incomeByDate: {},
      estimatedSpendByDate: { "2026-07-08": 20, "2026-07-09": 30 },
    });
    const byDate = new Map(rows.map((r) => [r.dateKey, r]));
    expect(byDate.get("2026-07-07")?.runningTotal).toBe(1000);
    expect(byDate.get("2026-07-07")?.estimatedOutflow).toBe(0);
    expect(byDate.get("2026-07-08")?.runningTotal).toBe(980);
    expect(byDate.get("2026-07-08")?.estimatedOutflow).toBe(20);
    expect(byDate.get("2026-07-09")?.runningTotal).toBe(950);
    expect(byDate.get("2026-07-06")?.runningTotal).toBe(1000);
  });
});
