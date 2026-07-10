import { describe, expect, test } from "vitest";
import {
  buildDayRows,
  computeIncomeByDate,
  expensesOnDate,
  incomeDetailForDay,
  ruleLandsOn,
  type IncomeSourceRate,
  type RecurringRule,
} from "@/app/_components/finance-projection";

function rule(partial: Partial<RecurringRule>): RecurringRule {
  return {
    frequency: "monthly",
    day_of_month: null,
    weekday: null,
    interval_days: null,
    start_date: null,
    amount: 0,
    ...partial,
  };
}

describe("recurring rule landing", () => {
  test("monthly lands on its day-of-month", () => {
    const r = rule({ frequency: "monthly", day_of_month: 15, amount: 50 });
    expect(ruleLandsOn(r, new Date(2026, 5, 15))).toBe(true);
    expect(ruleLandsOn(r, new Date(2026, 5, 14))).toBe(false);
  });

  test("monthly day-of-month clamps to short months", () => {
    const r = rule({ frequency: "monthly", day_of_month: 31, amount: 50 });
    // February 2026 has 28 days, so the 31st lands on the 28th.
    expect(ruleLandsOn(r, new Date(2026, 1, 28))).toBe(true);
    expect(ruleLandsOn(r, new Date(2026, 1, 27))).toBe(false);
    // March has 31 days.
    expect(ruleLandsOn(r, new Date(2026, 2, 31))).toBe(true);
  });

  test("day 29 lands exactly on Feb 29 in a leap year but clamps to 28 otherwise", () => {
    const r = rule({ frequency: "monthly", day_of_month: 29, amount: 50 });
    expect(ruleLandsOn(r, new Date(2028, 1, 29))).toBe(true); // 2028 is a leap year
    expect(ruleLandsOn(r, new Date(2026, 1, 28))).toBe(true); // 2026 is not
    expect(ruleLandsOn(r, new Date(2026, 1, 27))).toBe(false);
  });

  test("weekly lands on its weekday", () => {
    const r = rule({ frequency: "weekly", weekday: 1, amount: 20 }); // Monday
    expect(ruleLandsOn(r, new Date(2026, 4, 25))).toBe(true); // Mon 2026-05-25
    expect(ruleLandsOn(r, new Date(2026, 4, 26))).toBe(false);
  });

  test("daily lands on every day", () => {
    const r = rule({ frequency: "daily", amount: 5 });
    expect(ruleLandsOn(r, new Date(2026, 4, 25))).toBe(true);
    expect(ruleLandsOn(r, new Date(2026, 11, 31))).toBe(true);
  });

  test("custom lands every N days from the start date", () => {
    const r = rule({
      frequency: "custom",
      interval_days: 14,
      start_date: "2026-05-01",
      amount: 80,
    });
    expect(ruleLandsOn(r, new Date(2026, 4, 1))).toBe(true); // start
    expect(ruleLandsOn(r, new Date(2026, 4, 15))).toBe(true); // +14
    expect(ruleLandsOn(r, new Date(2026, 4, 29))).toBe(true); // +28
    expect(ruleLandsOn(r, new Date(2026, 4, 8))).toBe(false); // +7
    expect(ruleLandsOn(r, new Date(2026, 3, 17))).toBe(false); // before start
  });

  test("custom cadence lands correctly across a leap day", () => {
    const r = rule({
      frequency: "custom",
      interval_days: 7,
      start_date: "2028-02-01",
      amount: 40,
    });
    expect(ruleLandsOn(r, new Date(2028, 1, 29))).toBe(true); // 28 days elapsed
    expect(ruleLandsOn(r, new Date(2028, 2, 7))).toBe(true); // 35 days elapsed
    expect(ruleLandsOn(r, new Date(2028, 2, 6))).toBe(false); // 34 days elapsed
  });

  test("sums multiple expenses landing on the same day", () => {
    const rules = [
      rule({ frequency: "monthly", day_of_month: 1, amount: 1000 }),
      rule({ frequency: "weekly", weekday: 5, amount: 60 }), // Friday
    ];
    // 2026-05-01 is a Friday, so both land.
    expect(expensesOnDate(rules, "2026-05-01")).toBe(1060);
  });
});

describe("wage income", () => {
  function source(partial: Partial<IncomeSourceRate> & { id: string }): IncomeSourceRate {
    return {
      hourly_wage: 0,
      tax_rate: 0,
      pay_frequency: null,
      anchor_payday: null,
      period_start: null,
      period_end: null,
      ...partial,
    };
  }

  test("unscheduled sources pay on the day worked, netting wage and tax", () => {
    const sources = [
      source({ id: "job", hourly_wage: 20, tax_rate: 25 }), // 8 * 20 * 0.75 = 120
      source({ id: "side", hourly_wage: 50, tax_rate: 0 }), // 2 * 50 = 100
    ];
    const hours = {
      job: { "2026-05-26": 8 },
      side: { "2026-05-26": 2 },
    };
    const income = computeIncomeByDate(sources, hours, {
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(income["2026-05-26"]).toBeCloseTo(220, 5);
  });

  test("biweekly pay lands a lump on payday for the covered period", () => {
    // BestBuy: paid June 5 for the May 17–30 shift period, then every 14 days.
    const bestBuy = source({
      id: "bestbuy",
      hourly_wage: 20,
      tax_rate: 0,
      pay_frequency: "biweekly",
      anchor_payday: "2026-06-05",
      period_start: "2026-05-17",
      period_end: "2026-05-30",
    });
    const hours = {
      bestbuy: {
        "2026-05-20": 8,
        "2026-05-28": 8, // both inside May 17–30 -> paid on June 5
        "2026-06-02": 6, // inside next period (May 31–Jun 13) -> paid June 19
      },
    };
    const income = computeIncomeByDate([bestBuy], hours, {
      start: "2026-06-01",
      end: "2026-06-30",
    });

    expect(income["2026-06-05"]).toBeCloseTo(320, 5); // 16h * 20
    expect(income["2026-06-19"]).toBeCloseTo(120, 5); // 6h * 20
    // no income on the worked days themselves
    expect(income["2026-05-20"]).toBeUndefined();

    const detail = incomeDetailForDay([bestBuy], hours, "2026-06-05");
    expect(detail).toHaveLength(1);
    expect(detail[0].periodStart).toBe("2026-05-17");
    expect(detail[0].periodEnd).toBe("2026-05-30");
    expect(detail[0].hours).toBe(16);
  });

  test("fixed monthly income lands its amount on the same day each month", () => {
    const salary = source({ id: "salary", fixed_amount: 2000, fixed_day: 15 });
    const income = computeIncomeByDate([salary], {}, {
      start: "2026-06-01",
      end: "2026-07-31",
    });
    expect(income["2026-06-15"]).toBe(2000);
    expect(income["2026-07-15"]).toBe(2000);
    expect(Object.keys(income)).toHaveLength(2);

    const detail = incomeDetailForDay([salary], {}, "2026-06-15");
    expect(detail).toHaveLength(1);
    expect(detail[0].net).toBe(2000);
    expect(detail[0].fixed).toBe(true);
    expect(incomeDetailForDay([salary], {}, "2026-06-14")).toHaveLength(0);
  });

  test("monthly pay_frequency pays a lump on the 1st for the prior month's hours", () => {
    const salary = source({
      id: "salary",
      hourly_wage: 20,
      tax_rate: 0,
      pay_frequency: "monthly",
      anchor_payday: "2026-07-01",
      period_start: "2026-06-01",
      period_end: "2026-06-30",
    });
    const hours = {
      salary: { "2026-06-15": 10, "2026-07-10": 5 },
    };
    const income = computeIncomeByDate([salary], hours, {
      start: "2026-06-01",
      end: "2026-08-31",
    });
    expect(income["2026-07-01"]).toBeCloseTo(200, 5); // 10h * $20, paid the month after
    expect(income["2026-08-01"]).toBeCloseTo(100, 5); // 5h * $20
    expect(income["2026-06-01"]).toBeUndefined(); // no hours in the period it covers
  });

  test("fixed day 29 lands exactly on Feb 29 in a leap year", () => {
    const salary = source({ id: "salary", fixed_amount: 900, fixed_day: 29 });
    const income = computeIncomeByDate([salary], {}, {
      start: "2028-02-01",
      end: "2028-02-29",
    });
    expect(income["2028-02-29"]).toBe(900);
  });

  test("fixed day clamps to short months", () => {
    const salary = source({ id: "salary", fixed_amount: 900, fixed_day: 31 });
    const income = computeIncomeByDate([salary], {}, {
      start: "2026-02-01",
      end: "2026-03-31",
    });
    // February 2026 has 28 days, so the 31st lands on the 28th.
    expect(income["2026-02-28"]).toBe(900);
    expect(income["2026-03-31"]).toBe(900);
    expect(Object.keys(income)).toHaveLength(2);
  });

  test("fixed mode wins over a dormant wage setup", () => {
    // Hourly fields and shift hours linger from before the toggle — ignored.
    const salary = source({
      id: "salary",
      hourly_wage: 20,
      tax_rate: 25,
      pay_frequency: "biweekly",
      anchor_payday: "2026-06-05",
      period_start: "2026-05-17",
      period_end: "2026-05-30",
      fixed_amount: 1500,
      fixed_day: 1,
    });
    const hours = { salary: { "2026-06-10": 8 } };
    const income = computeIncomeByDate([salary], hours, {
      start: "2026-06-01",
      end: "2026-06-30",
    });
    expect(income).toEqual({ "2026-06-01": 1500 });
  });
});

describe("running total projection", () => {
  const gridDays = ["2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28"];

  test("anchors at today's net worth and forecasts forward", () => {
    const rows = buildDayRows({
      gridDays,
      month: "2026-05",
      today: "2026-05-26",
      netWorthToday: 1000,
      changes: [],
      expenses: [rule({ frequency: "monthly", day_of_month: 27, amount: 200 })],
      incomeByDate: { "2026-05-28": 300 },
    });
    const byDay = Object.fromEntries(rows.map((r) => [r.dateKey, r]));

    expect(byDay["2026-05-26"].runningTotal).toBe(1000); // today = anchor
    // 27th: -200 expense -> 800
    expect(byDay["2026-05-27"].runningTotal).toBe(800);
    expect(byDay["2026-05-27"].outflow).toBe(200);
    // 28th: +300 income -> 1100
    expect(byDay["2026-05-28"].runningTotal).toBe(1100);
    expect(byDay["2026-05-28"].inflow).toBe(300);
  });

  test("reconstructs past balances from recorded changes", () => {
    const rows = buildDayRows({
      gridDays,
      month: "2026-05",
      today: "2026-05-26",
      netWorthToday: 1000,
      // a 120 deduction was recorded on the 25th; before it the balance was 1120.
      changes: [{ occurred_at: "2026-05-25", direction: "out", amount: 120 }],
      expenses: [],
      incomeByDate: {},
    });
    const byDay = Object.fromEntries(rows.map((r) => [r.dateKey, r]));

    expect(byDay["2026-05-26"].runningTotal).toBe(1000);
    expect(byDay["2026-05-25"].runningTotal).toBe(1000); // end of the 25th, after the deduction
    expect(byDay["2026-05-25"].outflow).toBe(120);
    expect(byDay["2026-05-24"].runningTotal).toBe(1120); // before the deduction
  });

  test("layers estimated everyday spend and grocery-trip spend together on future days only", () => {
    const rows = buildDayRows({
      gridDays,
      month: "2026-05",
      today: "2026-05-26",
      netWorthToday: 1000,
      changes: [],
      expenses: [],
      incomeByDate: {},
      estimatedSpendByDate: { "2026-05-27": 20, "2026-05-28": 20 },
      groceriesByDate: { "2026-05-27": 50 },
    });
    const byDay = Object.fromEntries(rows.map((r) => [r.dateKey, r]));

    // today and the past are untouched by either estimate layer
    expect(byDay["2026-05-26"].estimatedOutflow).toBe(0);
    expect(byDay["2026-05-26"].estimatedGroceries).toBe(0);
    expect(byDay["2026-05-25"].estimatedOutflow).toBe(0);

    // 27th: both layers subtract -> 1000 - 20 - 50 = 930
    expect(byDay["2026-05-27"].estimatedOutflow).toBe(20);
    expect(byDay["2026-05-27"].estimatedGroceries).toBe(50);
    expect(byDay["2026-05-27"].runningTotal).toBe(930);
    // 28th: cumulative -> 930 - 20 = 910
    expect(byDay["2026-05-28"].estimatedGroceries).toBe(0);
    expect(byDay["2026-05-28"].runningTotal).toBe(910);
  });

  test("inMonth reflects each day's own calendar month across a grid spanning two months", () => {
    const rows = buildDayRows({
      gridDays: ["2026-04-29", "2026-04-30", "2026-05-01", "2026-05-02"],
      month: "2026-05",
      today: "2026-05-01",
      netWorthToday: 500,
      changes: [],
      expenses: [],
      incomeByDate: {},
    });
    expect(rows.map((r) => r.inMonth)).toEqual([false, false, true, true]);
  });
});
