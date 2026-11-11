// PLAN-DESK Task 4, the Money view model and its sample.
//
// EVERYTHING HERE IS INVENTED. The accounts, bills, pay, notes and amounts are
// made up and round on purpose; no figure describes anybody. The one rule the
// whole file circles: the Money panes say how old their numbers are first, and
// show the source's own forecast rather than working out a second one.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { sampleMoney, sampleMoneyStale } from "@/app/lib/v2/fixtures/sample-money";
import { dayDiff, shiftDateKey, weekdayOf } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import type { Block, PlanInput } from "@/app/lib/v2/types";
import type { MoneyDay, MoneyScreenData } from "@/app/lib/v2/view/desk-data";
import { dayLabel } from "@/app/lib/v2/view/format";
import {
  MONEY_COPY,
  STALE_AFTER_DAYS,
  buildAccountsView,
  buildComingView,
  buildForecastView,
  buildHoursView,
  buildLedgerView,
  forecastSpan,
  formatAmount,
  inDaysLabel,
  ledgerRows,
  moneyAge,
} from "@/app/lib/v2/view/money";

/** A Wednesday, invented. */
const TODAY = "2026-03-11";

function row(date: string, projected: number, extra: Partial<MoneyDay> = {}): MoneyDay {
  return { date, inflow: 0, outflow: 0, everyday: 30, groceries: 0, projected, ...extra };
}

/** `count` days from `from`, each 30 lower than the one before, from 5,000. */
function series(from: string, count: number): MoneyDay[] {
  return Array.from({ length: count }, (_, index) =>
    row(shiftDateKey(from, index), 5000 - 30 * index),
  );
}

/** The forecast with one day's row patched. */
function patchDay(data: MoneyScreenData, date: string, patch: Partial<MoneyDay>): MoneyScreenData {
  return {
    ...data,
    forecast: data.forecast.map((day) => (day.date === date ? { ...day, ...patch } : day)),
  };
}

function base(): MoneyScreenData {
  return {
    today: TODAY,
    currency: "USD",
    takenAt: "2026-03-10T20:00:00Z",
    ledgerLastOn: shiftDateKey(TODAY, -2),
    accounts: [
      { id: "acc-every", name: "Everyday", kind: "checking", balance: 1500, currency: "USD" },
      { id: "acc-save", name: "Savings", kind: "savings", balance: 3000, currency: "USD" },
      { id: "acc-card", name: "Card", kind: "credit", balance: -200.75, currency: "USD" },
    ],
    // Starts two days before today, so the view has rows to drop.
    forecast: series(shiftDateKey(TODAY, -2), 72),
    everyday: { dailyRate: 30, confident: true, manualFallback: null },
    bills: [
      { id: "b-phone", name: "Phone", amount: 50, schedule: "monthly on day 20" },
      { id: "b-rent", name: "Rent", amount: 1000, schedule: "monthly on day 1" },
      { id: "b-water", name: "Water", amount: 40, schedule: "monthly on day 28" },
      { id: "b-gym", name: "Gym", amount: 30, schedule: "monthly on day 15" },
      { id: "b-music", name: "Music", amount: 30, schedule: "monthly on day 15" },
    ],
    income: [
      { id: "i-shop", name: "Shop pay", fixedMonthly: { amount: 2000, dayOfMonth: 25 } },
      { id: "i-tutor", name: "Tutoring", fixedMonthly: null },
    ],
    rows: Array.from({ length: 30 }, (_, index) => ({
      id: `r${index + 1}`,
      on: shiftDateKey(TODAY, -2 - index),
      direction: index % 3 === 0 ? ("in" as const) : ("out" as const),
      amount: 10 * (index + 1),
      account: index % 2 === 0 ? "Everyday" : "Card",
      category: index % 4 === 0 ? null : "Food",
      note: `Line ${index + 1}`,
    })),
  };
}

/** The base data with every firm day the marks tests need. */
function marked(): MoneyScreenData {
  let data = base();
  // Paid by the hour: no fixed income has this amount.
  data = patchDay(data, "2026-03-13", { inflow: 640 });
  // One cent off the phone bill, on another day.
  data = patchDay(data, "2026-03-14", { outflow: 50.01 });
  // Two bills of this amount on this day: no single name.
  data = patchDay(data, "2026-03-15", { outflow: 30 });
  data = patchDay(data, "2026-03-20", { outflow: 50 });
  data = patchDay(data, "2026-03-25", { inflow: 2000 });
  data = patchDay(data, "2026-03-27", { inflow: 300, outflow: 50 });
  data = patchDay(data, "2026-04-01", { outflow: 1000 });
  // Day 8, and the only 40 bill is on day 28.
  data = patchDay(data, "2026-04-08", { outflow: 40 });
  // Estimates only.
  data = patchDay(data, "2026-03-12", { everyday: 30, groceries: 85 });
  return data;
}

/** Every string anywhere in a value, so the copy rules can be walked. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) strings(item, into);
  }
  return into;
}

// ------------------------------------------------------------- behaviour 1

describe("it says how old it is first", () => {
  test("counts whole days from the newest ledger line to the desk's day", () => {
    const age = moneyAge(base());
    expect(age).toEqual({ days: 2, stale: false, line: null });
  });

  test("is not stale at the limit and stale one day past it", () => {
    const at = (days: number) => moneyAge({ ...base(), ledgerLastOn: shiftDateKey(TODAY, -days) });
    expect(at(STALE_AFTER_DAYS)).toMatchObject({ days: STALE_AFTER_DAYS, stale: false, line: null });
    expect(at(STALE_AFTER_DAYS + 1)).toMatchObject({ days: STALE_AFTER_DAYS + 1, stale: true });
  });

  test("names the day and the month of the last line and the count of days", () => {
    const age = moneyAge({ ...base(), ledgerLastOn: shiftDateKey(TODAY, -50) });
    expect(age.days).toBe(50);
    expect(age.stale).toBe(true);
    expect(age.line).toBe(
      "No transaction since 20 January, 50 days ago. Everything here is what was last known.",
    );
  });

  test("is zero days and not stale when the desk shows a day before the last line", () => {
    const age = moneyAge({ ...base(), ledgerLastOn: shiftDateKey(TODAY, 5) });
    expect(age).toEqual({ days: 0, stale: false, line: null });
  });

  test("says no transaction was recorded at all for an empty ledger", () => {
    const age = moneyAge({ ...base(), ledgerLastOn: null, rows: [] });
    expect(age.days).toBeNull();
    expect(age.stale).toBe(true);
    expect(age.line).toBe(MONEY_COPY.age.none);
    expect(age.line).toContain("No transaction has been recorded at all");
  });

  test("every view carries the same age", () => {
    const data = { ...base(), ledgerLastOn: shiftDateKey(TODAY, -40) };
    const age = moneyAge(data);
    expect(buildForecastView(data, 30).age).toEqual(age);
    expect(buildAccountsView(data, "UTC").age).toEqual(age);
    expect(buildComingView(data, 30).age).toEqual(age);
    expect(buildLedgerView(data, 10).age).toEqual(age);
  });
});

// ------------------------------------------------------------- behaviour 2

describe("the forecast is the source's own", () => {
  test("drops the rows before the desk's day and takes the first span rows", () => {
    for (const span of [14, 30, 60] as const) {
      const view = buildForecastView(base(), span);
      expect(view.list).toHaveLength(span);
      expect(view.list[0].date).toBe(TODAY);
      expect(view.list[span - 1].date).toBe(shiftDateKey(TODAY, span - 1));
      expect(view.span).toBe(span);
    }
  });

  test("starts at the source's first day when that is later than today", () => {
    const later = shiftDateKey(TODAY, 3);
    const view = buildForecastView({ ...base(), forecast: series(later, 20) }, 14);
    expect(view.list[0].date).toBe(later);
    expect(view.list).toHaveLength(14);
    expect(view.list.some((cell) => cell.isToday)).toBe(false);
  });

  test("shows the source's balance and works out none of its own", () => {
    // A balance that no sum of the day's flows would give: it must come through.
    const data = patchDay(base(), "2026-03-16", { projected: 777, inflow: 0, outflow: 0 });
    const cell = buildForecastView(data, 14).list.find((entry) => entry.date === "2026-03-16");
    expect(cell?.balance).toBe("777");
    // Every in range cell prints exactly the source's projected figure.
    const byDate = new Map(data.forecast.map((day) => [day.date, day.projected]));
    for (const entry of buildForecastView(data, 60).list) {
      expect(entry.balance).toBe(formatAmount(byDate.get(entry.date) as number));
    }
  });

  test("lays the span out in Monday first weeks of seven, padded", () => {
    const view = buildForecastView(base(), 14);
    expect(view.weekdays).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    // Wednesday 11 March to Tuesday 24 March: three weeks from Monday 9 March.
    expect(view.weeks).toHaveLength(3);
    for (const week of view.weeks) {
      expect(week).toHaveLength(7);
      expect(weekdayOf(week[0].date)).toBe(1);
    }
    const cells = view.weeks.flat();
    expect(cells[0].date).toBe("2026-03-09");
    expect(cells[cells.length - 1].date).toBe("2026-03-29");
    const padding = cells.filter((cell) => !cell.inRange);
    expect(padding.map((cell) => cell.date)).toEqual([
      "2026-03-09",
      "2026-03-10",
      "2026-03-25",
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
    ]);
    for (const cell of padding) {
      expect(cell).toMatchObject({ balance: null, marks: [], low: false, negative: false });
    }
    expect(view.list).toEqual(cells.filter((cell) => cell.inRange));
    expect(cells.find((cell) => cell.date === "2026-03-20")?.dayOfMonth).toBe(20);
  });

  test("counts the span in calendar days, drawing a day the source skipped with no balance", () => {
    // No row for Monday 16 March, and a firm day just past the 14 day window.
    const holed = patchDay(
      { ...base(), forecast: base().forecast.filter((day) => day.date !== "2026-03-16") },
      "2026-03-25",
      { inflow: 2000 },
    );
    const view = buildForecastView(holed, 14);
    expect(view.list).toHaveLength(14);
    expect(view.list[13].date).toBe("2026-03-24");
    const hole = view.list.find((cell) => cell.date === "2026-03-16");
    expect(hole).toMatchObject({ inRange: true, balance: null, marks: [], low: false, negative: false });
    expect(view.lowest?.date).toBe("Tuesday 24 March");
    // The day past the window is in neither pane.
    expect(view.list.some((cell) => cell.date === "2026-03-25")).toBe(false);
    expect(buildComingView(holed, 14).items).toEqual([]);
  });

  // Fix round 1. A source whose forecast stops before the span does: the view
  // hands over what is drawn, so the days past its last row are not a tail of
  // empty weeks, and it says the day the forecast ends.
  test("stops at the source's last row, with no tail of empty weeks, and says where", () => {
    const view = buildForecastView({ ...base(), forecast: series(TODAY, 10) }, 14);
    // Ten rows, Wednesday 11 March to Friday 20 March.
    expect(view.list.map((cell) => cell.date)).toEqual(
      Array.from({ length: 10 }, (_, index) => shiftDateKey(TODAY, index)),
    );
    expect(view.list.every((cell) => cell.balance !== null)).toBe(true);
    expect(view.endsOn).toBe("2026-03-20");
    // The week of 9 March and the week of 16 March are drawn; the week of 23
    // March, which the span reached and the source did not, is not.
    expect(view.weeks.map((week) => week[0].date)).toEqual(["2026-03-09", "2026-03-16"]);
    // The weekend after the last row is in the drawn week, in range, with no
    // balance, never low and with nothing marked.
    const after = view.weeks[1].filter((cell) => cell.inRange && cell.balance === null);
    expect(after.map((cell) => cell.date)).toEqual(["2026-03-21", "2026-03-22"]);
    for (const cell of after) expect(cell).toMatchObject({ low: false, negative: false, marks: [] });
    // The lowest is the last day that has a row, never a day without one.
    expect(view.lowest?.date).toBe("Friday 20 March");
  });

  test("has no end to say when the source covers the whole span", () => {
    for (const span of [14, 30, 60] as const) {
      const view = buildForecastView(base(), span);
      expect(view.endsOn).toBeNull();
      expect(view.list).toHaveLength(span);
    }
    expect(buildForecastView({ ...base(), forecast: [] }, 30).endsOn).toBeNull();
  });

  // Only the tail is trimmed: a week the source skipped in the middle is drawn,
  // day by day, so the grid never silently jumps a week.
  test("draws a whole week the source skipped in the middle", () => {
    const skipped = ["2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19", "2026-03-20", "2026-03-21", "2026-03-22"];
    const view = buildForecastView(
      { ...base(), forecast: base().forecast.filter((day) => !skipped.includes(day.date)) },
      30,
    );
    expect(view.endsOn).toBeNull();
    expect(view.list).toHaveLength(30);
    const gap = view.weeks.find((week) => week[0].date === "2026-03-16");
    expect(gap?.map((cell) => cell.balance)).toEqual([null, null, null, null, null, null, null]);
  });

  // The rule: rows are put in date order first, and of two rows for one day the
  // one the source sent first is kept.
  test("keeps the row the source sent first when a day comes twice", () => {
    const extra = row("2026-03-20", 1, { outflow: 50 });
    const first = buildForecastView({ ...base(), forecast: [extra, ...base().forecast] }, 14);
    expect(first.list.find((cell) => cell.date === "2026-03-20")).toMatchObject({
      balance: "1",
      marks: [{ kind: "out", label: "Phone 50" }],
    });
    const last = buildForecastView({ ...base(), forecast: [...base().forecast, extra] }, 14);
    // The series' own row: 5,000 less 30 a day from Monday 9 March.
    expect(last.list.find((cell) => cell.date === "2026-03-20")).toMatchObject({
      balance: "4,670",
      marks: [],
    });
  });

  test("keeps date order and one row per day whatever order the source sent", () => {
    const data = marked();
    const shuffled = {
      ...data,
      // Reversed, with a second row for the pay day that must not be drawn.
      forecast: [...data.forecast].reverse().concat(row("2026-03-25", 1, { inflow: 999 })),
    };
    expect(buildForecastView(shuffled, 30)).toEqual(buildForecastView(data, 30));
    expect(buildComingView(shuffled, 30)).toEqual(buildComingView(data, 30));
  });

  test("marks today once", () => {
    const view = buildForecastView(base(), 30);
    const today = view.weeks.flat().filter((cell) => cell.isToday);
    expect(today.map((cell) => cell.date)).toEqual([TODAY]);
  });

  test("is empty, and draws nothing, when the source has no forecast rows", () => {
    const view = buildForecastView({ ...base(), forecast: [] }, 30);
    expect(view).toMatchObject({ empty: true, weeks: [], list: [], lowest: null });
    expect(view.estimate.length).toBeGreaterThan(0);
    expect(buildForecastView(base(), 30).empty).toBe(false);
  });

  // Fix round 1. A cell beside a 50px day number has room for a short month
  // and no more, and only where the number alone would not say which month.
  test("names the month, short, on the first day drawn and on each 1st, and nowhere else", () => {
    const months = (view: ReturnType<typeof buildForecastView>) =>
      view.weeks.flat().flatMap((cell) => (cell.month === null ? [] : [[cell.date, cell.month]]));
    expect(months(buildForecastView(base(), 30))).toEqual([
      ["2026-03-11", "Mar"],
      ["2026-04-01", "Apr"],
    ]);
    // A 1st that only pads the last week is not drawn, so it names nothing.
    const late = buildForecastView({ ...base(), forecast: series("2026-03-18", 20) }, 14);
    const april = late.weeks.flat().find((cell) => cell.date === "2026-04-01");
    expect(april).toMatchObject({ inRange: false, month: null });
    expect(months(late)).toEqual([["2026-03-18", "Mar"]]);
  });
});

// Fix round 1: the pane options are read here, beside the views they choose,
// so a server module can import them without reaching a client file.
describe("the options a pane is handed", () => {
  test("takes a span of 14, 30 or 60 days, and 30 for anything else", () => {
    expect(forecastSpan("14")).toBe(14);
    expect(forecastSpan("30")).toBe(30);
    expect(forecastSpan("60")).toBe(60);
    for (const other of [undefined, "", "90", " 14", "14.0", "constructor", "toString"]) {
      expect(forecastSpan(other), String(other)).toBe(30);
    }
  });

  test("takes 10, 25 or 50 ledger lines, and 25 for anything else", () => {
    expect(ledgerRows("10")).toBe(10);
    expect(ledgerRows("25")).toBe(25);
    expect(ledgerRows("50")).toBe(50);
    for (const other of [undefined, "", "100", "10 ", "__proto__", "valueOf"]) {
      expect(ledgerRows(other), String(other)).toBe(25);
    }
  });
});

// ------------------------------------------------------------- behaviour 3

describe("marks are only what is firm", () => {
  const cellOn = (date: string, span: 14 | 30 | 60 = 60) =>
    buildForecastView(marked(), span).list.find((cell) => cell.date === date);

  test("names a bill whose amount and day match exactly one bill", () => {
    expect(cellOn("2026-03-20")?.marks).toEqual([{ kind: "out", label: "Phone 50" }]);
    expect(cellOn("2026-04-01")?.marks).toEqual([{ kind: "out", label: "Rent 1,000" }]);
  });

  test("names a fixed monthly income by its amount", () => {
    expect(cellOn("2026-03-25")?.marks).toEqual([{ kind: "in", label: "Shop pay 2,000" }]);
  });

  test("uses the plain word for pay nobody fixed in advance", () => {
    expect(cellOn("2026-03-13")?.marks).toEqual([{ kind: "in", label: "Pay 640" }]);
  });

  test("uses the plain word when the amount is a cent off", () => {
    expect(cellOn("2026-03-14")?.marks).toEqual([{ kind: "out", label: "Bill 50" }]);
  });

  test("uses the plain word when two bills match", () => {
    expect(cellOn("2026-03-15")?.marks).toEqual([{ kind: "out", label: "Bill 30" }]);
  });

  test("uses the plain word when two fixed incomes match", () => {
    const data = marked();
    const twins = {
      ...data,
      income: [
        ...data.income,
        { id: "i-stall", name: "Stall pay", fixedMonthly: { amount: 2000, dayOfMonth: 25 } },
      ],
    };
    const cell = buildForecastView(twins, 30).list.find((entry) => entry.date === "2026-03-25");
    expect(cell?.marks).toEqual([{ kind: "in", label: "Pay 2,000" }]);
  });

  test("matches the day as a whole number, so day 8 is not day 28", () => {
    expect(cellOn("2026-04-08")?.marks).toEqual([{ kind: "out", label: "Bill 40" }]);
  });

  /** The one mark on `date` when a single 70 bill with this schedule exists. */
  const billMark = (schedule: string, date: string, today: string = TODAY) => {
    const data: MoneyScreenData = {
      ...base(),
      today,
      forecast: series(today, 60),
      bills: [{ id: "b-only", name: "Water", amount: 70, schedule }],
    };
    return buildForecastView(patchDay(data, date, { outflow: 70 }), 60).list.find(
      (cell) => cell.date === date,
    )?.marks;
  };

  test("names a bill only by the monthly phrase, whatever numbers another schedule holds", () => {
    const every14 = "every 14 days from 2026-03-01";
    expect(billMark(every14, "2026-03-14")).toEqual([{ kind: "out", label: "Bill 70" }]);
    expect(billMark(every14, "2026-04-03")).toEqual([{ kind: "out", label: "Bill 70" }]);
    expect(billMark(every14, "2026-04-01")).toEqual([{ kind: "out", label: "Bill 70" }]);
    expect(billMark("every 2 weeks", "2026-04-02")).toEqual([{ kind: "out", label: "Bill 70" }]);
    expect(billMark("bimonthly on day 5", "2026-04-05")).toEqual([{ kind: "out", label: "Bill 70" }]);
    expect(billMark("monthly on day 123", "2026-04-12")).toEqual([{ kind: "out", label: "Bill 70" }]);
  });

  test("reads the monthly phrase in any case and anywhere in the schedule", () => {
    expect(billMark("Monthly On Day 20", "2026-03-20")).toEqual([{ kind: "out", label: "Water 70" }]);
    expect(billMark("paid monthly on day 5 by card", "2026-04-05")).toEqual([
      { kind: "out", label: "Water 70" },
    ]);
    expect(billMark("monthly on day 05", "2026-04-05")).toEqual([{ kind: "out", label: "Water 70" }]);
  });

  test("uses the plain word for a bill moved off a day the month does not have", () => {
    expect(billMark("monthly on day 31", "2026-04-30")).toEqual([{ kind: "out", label: "Bill 70" }]);
    expect(billMark("monthly on day 29", "2027-02-28", "2027-02-20")).toEqual([
      { kind: "out", label: "Bill 70" },
    ]);
  });

  test("gives one mark each way on a day with both, money in first", () => {
    expect(cellOn("2026-03-27")?.marks).toEqual([
      { kind: "in", label: "Pay 300" },
      { kind: "out", label: "Bill 50" },
    ]);
  });

  test("never marks an estimate", () => {
    expect(cellOn("2026-03-12")?.marks).toEqual([]);
    // The plain series has an everyday estimate on every day and no firm money.
    for (const cell of buildForecastView(base(), 60).list) expect(cell.marks).toEqual([]);
  });
});

// ------------------------------------------------------------- behaviour 4

describe("the lowest day", () => {
  test("is flagged once, and worded with the weekday, the day and the month", () => {
    const view = buildForecastView(base(), 14);
    const low = view.list.filter((cell) => cell.low);
    expect(low.map((cell) => cell.date)).toEqual(["2026-03-24"]);
    // The series falls by 30 a day from 5,000 two days before today.
    expect(view.lowest).toEqual({ date: "Tuesday 24 March", dateKey: "2026-03-24", balance: "4,550" });
  });

  // Fix round 1. Every day under zero is low too, so a pane finds the one
  // lowest day by this key, never by comparing words.
  test("carries the key of the one day it names, which is a low day of the span", () => {
    let data = base();
    data = patchDay(data, "2026-03-16", { projected: -50 });
    data = patchDay(data, "2026-03-18", { projected: -120.6 });
    for (const source of [base(), data]) {
      for (const span of [14, 30, 60] as const) {
        const view = buildForecastView(source, span);
        const named = view.list.filter((cell) => cell.date === view.lowest?.dateKey);
        expect(named).toHaveLength(1);
        expect(named[0].low).toBe(true);
        expect(view.lowest?.date).toBe(dayLabel(named[0].date));
      }
    }
  });

  test("is the earliest of a tie", () => {
    let data = base();
    data = patchDay(data, "2026-03-13", { projected: 100 });
    data = patchDay(data, "2026-03-17", { projected: 100 });
    const view = buildForecastView(data, 14);
    expect(view.list.filter((cell) => cell.low).map((cell) => cell.date)).toEqual(["2026-03-13"]);
    expect(view.lowest?.date).toBe("Friday 13 March");
  });

  test("flags every day under zero as negative and low", () => {
    let data = base();
    data = patchDay(data, "2026-03-16", { projected: -50 });
    data = patchDay(data, "2026-03-18", { projected: -120.6 });
    const view = buildForecastView(data, 14);
    expect(view.list.filter((cell) => cell.negative).map((cell) => cell.date)).toEqual([
      "2026-03-16",
      "2026-03-18",
    ]);
    expect(view.list.filter((cell) => cell.low).map((cell) => cell.date)).toEqual([
      "2026-03-16",
      "2026-03-18",
    ]);
    expect(view.lowest).toEqual({ date: "Wednesday 18 March", dateKey: "2026-03-18", balance: "-121" });
  });
});

// ------------------------------------------------------------- behaviour 5

describe("the estimate sentence", () => {
  const sentence = (everyday: MoneyScreenData["everyday"]) =>
    buildForecastView({ ...base(), everyday }, 30).estimate;

  test("says the figure comes from the ledger when it is confident", () => {
    expect(sentence({ dailyRate: 30, confident: true, manualFallback: 45 })).toBe(
      "Everyday spending is a guess of 30 a day, worked out from the ledger.",
    );
  });

  test("says a manual figure was typed in, and uses that figure", () => {
    expect(sentence({ dailyRate: 12, confident: false, manualFallback: 45 })).toBe(
      "Everyday spending is a guess of 45 a day, typed in by hand.",
    );
  });

  test("says there is no estimate when neither holds", () => {
    expect(sentence({ dailyRate: 12, confident: false, manualFallback: null })).toBe(
      MONEY_COPY.estimate.none,
    );
  });

  test("adds that grocery trips are a guess when the span has one", () => {
    const withTrip = buildForecastView(patchDay(base(), "2026-03-12", { groceries: 85 }), 30);
    expect(withTrip.estimate).toBe(
      `Everyday spending is a guess of 30 a day, worked out from the ledger. ${MONEY_COPY.estimate.groceries}`,
    );
    // A trip before today is not in the span, so it is not mentioned.
    const before = buildForecastView(patchDay(base(), shiftDateKey(TODAY, -1), { groceries: 85 }), 30);
    expect(before.estimate).not.toContain(MONEY_COPY.estimate.groceries);
  });
});

// ------------------------------------------------------------- behaviour 6

describe("the accounts", () => {
  test("lists each account in the source's order with the sum as the total", () => {
    const view = buildAccountsView(base(), "UTC");
    expect(view.accounts).toEqual([
      { id: "acc-every", name: "Everyday", kind: "checking", balance: "1,500", currency: "USD", negative: false },
      { id: "acc-save", name: "Savings", kind: "savings", balance: "3,000", currency: "USD", negative: false },
      { id: "acc-card", name: "Card", kind: "credit", balance: "-201", currency: "USD", negative: true },
    ]);
    // 1,500 + 3,000 - 200.75 = 4,299.25.
    expect(view.total).toBe("4,299");
    expect(view.totalNote).toBeNull();
    expect(view.currency).toBe("USD");
    expect(view.empty).toBe(false);
  });

  const jars = (balances: number[], currency = "USD") =>
    balances.map((balance, index) => ({
      id: `a${index}`,
      name: `Jar ${index}`,
      kind: "savings",
      balance,
      currency,
    }));

  // 0.1 + 0.7 - 0.3 is 0.49999999999999994 in floats, which prints "0"; in
  // whole cents it is 50, which prints "1". The total must be the second.
  test("adds the balances in whole cents, not in floats", () => {
    const balances = [0.1, 0.7, -0.3];
    expect(formatAmount(balances.reduce((sum, value) => sum + value, 0))).toBe("0");
    expect(buildAccountsView({ ...base(), accounts: jars(balances) }, "UTC").total).toBe("1");
  });

  test("adds nothing up when the accounts are in more than one currency, and says so", () => {
    const accounts = [...jars([100, 200]), { ...jars([300])[0], id: "a-eur", currency: "EUR" }];
    const view = buildAccountsView({ ...base(), accounts }, "UTC");
    expect(view.total).toBeNull();
    expect(view.totalNote).toBe(MONEY_COPY.mixedCurrencies);
    expect(view.accounts.map((account) => account.currency)).toEqual(["USD", "USD", "EUR"]);
  });

  test("names the accounts' own currency when they share one", () => {
    const view = buildAccountsView({ ...base(), currency: "USD", accounts: jars([100, 250], "EUR") }, "UTC");
    expect(view).toMatchObject({ total: "350", totalNote: null, currency: "EUR" });
  });

  test("says when the source read them, as a day, a month and a clock in the desk's zone", () => {
    expect(buildAccountsView(base(), "UTC").takenLine).toBe("Last read 10 March at 20:00.");
    expect(buildAccountsView(base(), "Asia/Tokyo").takenLine).toBe("Last read 11 March at 05:00.");
  });

  test("is empty with no accounts", () => {
    const view = buildAccountsView({ ...base(), accounts: [] }, "UTC");
    expect(view).toMatchObject({ empty: true, accounts: [], total: "0", totalNote: null, currency: "USD" });
  });
});

// ------------------------------------------------------------- behaviour 7

describe("coming up", () => {
  test("lists the firm money of the span in date order, with the days from today", () => {
    const view = buildComingView(marked(), 14);
    expect(view.items.map(({ date, inDays, kind, name, amount }) => ({ date, inDays, kind, name, amount }))).toEqual([
      { date: "Friday 13 March", inDays: 2, kind: "in", name: "Pay", amount: "640" },
      { date: "Saturday 14 March", inDays: 3, kind: "out", name: "Bill", amount: "50" },
      { date: "Sunday 15 March", inDays: 4, kind: "out", name: "Bill", amount: "30" },
      { date: "Friday 20 March", inDays: 9, kind: "out", name: "Phone", amount: "50" },
    ]);
    expect(view.empty).toBe(false);
    expect(new Set(view.items.map((item) => item.id)).size).toBe(view.items.length);
  });

  test("grows with the span", () => {
    const names = buildComingView(marked(), 30).items.map((item) => `${item.inDays} ${item.name}`);
    expect(names).toEqual([
      "2 Pay",
      "3 Bill",
      "4 Bill",
      "9 Phone",
      "14 Shop pay",
      "16 Pay",
      "16 Bill",
      "21 Rent",
      "28 Bill",
    ]);
  });

  test("says exactly what the forecast's marks say", () => {
    const data = marked();
    const fromMarks = buildForecastView(data, 60).list.flatMap((cell) =>
      cell.marks.map((mark) => `${mark.kind} ${mark.label}`),
    );
    const fromList = buildComingView(data, 60).items.map(
      (item) => `${item.kind} ${item.name} ${item.amount}`,
    );
    expect(fromList).toEqual(fromMarks);
  });

  test("never lists an estimate", () => {
    const view = buildComingView(base(), 60);
    expect(view.items).toEqual([]);
    expect(view.empty).toBe(true);
  });

  test("words the days from today", () => {
    expect(inDaysLabel(0)).toBe(MONEY_COPY.when.today);
    expect(inDaysLabel(1)).toBe(MONEY_COPY.when.tomorrow);
    expect(inDaysLabel(9)).toBe("In 9 days");
  });
});

// ------------------------------------------------------------- behaviour 8

describe("the ledger", () => {
  test("shows the newest lines as the source ordered them and counts the rest", () => {
    const view = buildLedgerView(base(), 10);
    expect(view.rows.map((line) => line.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `r${index + 1}`),
    );
    expect(view.more).toBe(20);
    expect(view.rows[0]).toEqual({
      id: "r1",
      date: "9 March",
      kind: "in",
      amount: "10",
      note: "Line 1",
      account: "Everyday",
      category: null,
    });
    expect(view.rows[1]).toMatchObject({ kind: "out", category: "Food", account: "Card" });
    expect(buildLedgerView(base(), 50)).toMatchObject({ more: 0 });
    expect(buildLedgerView(base(), 50).rows).toHaveLength(30);
  });

  const withNote = (note: string) =>
    buildLedgerView({ ...base(), rows: [{ ...base().rows[0], note }] }, 10).rows[0].note;

  // Fix round 1. A note cut here was whole on no surface: the pane printed the
  // cut text and titled it with the same cut text, and a title is not
  // reachable by touch anyway. The view hands over the whole note, and the
  // pane's line clamp does the cutting where the eye needs it.
  test("carries a long note whole, every character of it", () => {
    const long = Array.from({ length: 60 }, (_, index) => `w${index}`).join(" ").padEnd(300, "z");
    expect(long).toHaveLength(300);
    expect(withNote(long)).toBe(long);
    expect(withNote("x".repeat(300))).toBe("x".repeat(300));
  });

  test("collapses runs of white space and trims the ends, and changes nothing else", () => {
    expect(withNote("  Two  spaces, ODD case  ")).toBe("Two spaces, ODD case");
    expect(withNote("line one\n\tline two")).toBe("line one line two");
    expect(withNote("y".repeat(80))).toBe("y".repeat(80));
  });

  test("is empty with no lines", () => {
    expect(buildLedgerView({ ...base(), rows: [] }, 25)).toMatchObject({
      rows: [],
      more: 0,
      empty: true,
    });
  });
});

// ------------------------------------------------------------- behaviour 9

describe("hours come from the planner's own numbers", () => {
  const day = sampleDay();
  const date = day.input.date;
  const at = (clock: string, on: string = date) => `${on}T${clock}:00-07:00`;

  function block(id: string, kind: Block["kind"], from: string, to: string, extra: Partial<Block> = {}): Block {
    return {
      id,
      date,
      start: at(from),
      end: at(to),
      kind,
      lane: kind === "income" ? "work" : null,
      taskId: null,
      title: id,
      state: "planned",
      reason: "test",
      ...extra,
    };
  }

  const blocks: Block[] = [
    block("inc-planned", "income", "11:00", "13:00"),
    block("inc-done", "income", "16:00", "16:30", { state: "done" }),
    block("inc-skipped", "income", "15:00", "17:00", { state: "skipped" }),
    block("focus", "focus", "16:00", "16:50"),
    block("inc-tomorrow", "income", "11:00", "13:00", {
      date: shiftDateKey(date, 1),
      start: at("11:00", shiftDateKey(date, 1)),
      end: at("13:00", shiftDateKey(date, 1)),
    }),
    block("inc-unreadable", "income", "11:00", "13:00", { start: "not an instant" }),
  ];

  function input(patch: Partial<PlanInput> = {}, rules: Partial<PlanInput["rules"]> = {}): PlanInput {
    return {
      ...day.input,
      week: { capHoursElsewhere: 12.1, incomeHoursElsewhere: 4.1, gymSessionsDone: 0 },
      ...patch,
      rules: { ...day.input.rules, ...rules },
    };
  }

  test("adds this day's income blocks that are not skipped to the week's own hours", () => {
    const view = buildHoursView(input(), blocks);
    // 4.1 elsewhere + 2 planned + 0.5 done = 6.6, to a quarter 6.5.
    expect(view.target).toEqual({
      hours: 10,
      done: 6.5,
      label: "6.5 of 10 hours",
      share: 0.65,
      valueNow: 6.5,
    });
  });

  test("counts the day's capped fixed events and the same income blocks toward the cap", () => {
    // The sample day fixes one shift of 2.5 hours that counts toward the cap.
    const counted = day.input.fixed.filter((event) => event.countsTowardCap && !event.allDay);
    expect(counted).toHaveLength(1);
    const view = buildHoursView(input(), blocks);
    // 12.1 elsewhere + 2.5 shift + 2.5 income = 17.1, to a quarter 17.
    expect(view.cap).toEqual({
      hours: 30,
      used: 17,
      label: "17 of 30 hours",
      over: false,
      share: 17 / 30,
      valueNow: 17,
    });
    expect(view.empty).toBe(false);
  });

  test("says when the cap is crossed", () => {
    const view = buildHoursView(
      input({ week: { capHoursElsewhere: 28, incomeHoursElsewhere: 4, gymSessionsDone: 0 } }),
      blocks,
    );
    // The bar is drawn full, never past its end, and the meter's value is held
    // to its range; the true figure is the label.
    expect(view.cap).toEqual({
      hours: 30,
      used: 33,
      label: "33 of 30 hours",
      over: true,
      share: 1,
      valueNow: 30,
    });
  });

  // The cap is a wall in the planner, so a tenth past it is past it, even when
  // the label rounds it back down to the cap.
  test("judges over on the hours themselves, not on the rounded label", () => {
    const view = buildHoursView(
      input({ week: { capHoursElsewhere: 25.1, incomeHoursElsewhere: 4, gymSessionsDone: 0 } }),
      blocks,
    );
    expect(view.cap).toEqual({
      hours: 30,
      used: 30,
      label: "30 of 30 hours",
      over: true,
      share: 1,
      valueNow: 30,
    });
  });

  // Fix round 1: what the bar draws is the view's, never the pane's division.
  test("gives each bar its share, held to 0..1, and none when there is no maximum", () => {
    const quiet = { capHoursElsewhere: 0, incomeHoursElsewhere: 0, gymSessionsDone: 0 };
    const none = buildHoursView(input({ week: quiet, fixed: [] }), []);
    expect(none.target).toMatchObject({ done: 0, share: 0, valueNow: 0 });
    expect(none.cap).toMatchObject({ used: 0, share: 0, valueNow: 0 });

    const zero = buildHoursView(
      input({}, { incomeTarget: { lane: "work", weeklyHours: 0, blockMinutes: 60 }, weeklyHourCap: 0 }),
      blocks,
    );
    expect(zero.target).toMatchObject({ hours: 0, share: 0, valueNow: 0 });
    expect(zero.cap).toMatchObject({ hours: 0, over: true, share: 0, valueNow: 0 });

    const target = buildHoursView(input(), blocks).target;
    expect(target?.share).toBe((target?.done ?? 0) / (target?.hours ?? 1));
  });

  test("has no cap in travel mode, where the planner lifts it", () => {
    const view = buildHoursView(input({ mode: "travel" }), blocks);
    expect(view.cap).toBeNull();
    expect(view.target).not.toBeNull();
    // A short night does not lift it: the planner only stops placing income.
    expect(buildHoursView(input({ mode: "short-night" }), blocks).cap).not.toBeNull();
  });

  test("leaves out an all day event and one that does not count", () => {
    const fixed = [
      ...day.input.fixed,
      {
        id: "fx-allday-paid",
        title: "Paid all day",
        start: at("00:00"),
        end: at("00:00", shiftDateKey(date, 1)),
        allDay: true,
        calendarId: null,
        location: null,
        countsTowardCap: true,
        source: "google" as const,
      },
    ];
    expect(buildHoursView(input({ fixed }), blocks).cap?.used).toBe(17);
  });

  test("has no target when the rules set none", () => {
    const view = buildHoursView(input({}, { incomeTarget: null }), blocks);
    expect(view.target).toBeNull();
    expect(view.cap).not.toBeNull();
  });

  test("has no cap when the rules set none, or inside an exempt range", () => {
    expect(buildHoursView(input({}, { weeklyHourCap: null }), blocks).cap).toBeNull();
    const exempt = buildHoursView(
      input({}, { capExemptRanges: [{ from: date, to: shiftDateKey(date, 6) }] }),
      blocks,
    );
    expect(exempt.cap).toBeNull();
    expect(exempt.target).not.toBeNull();
    // A range that ended the day before does not lift it.
    const ended = buildHoursView(
      input({}, { capExemptRanges: [{ from: shiftDateKey(date, -7), to: shiftDateKey(date, -1) }] }),
      blocks,
    );
    expect(ended.cap).not.toBeNull();
  });

  test("is empty when neither is set", () => {
    const view = buildHoursView(input({}, { incomeTarget: null, weeklyHourCap: null }), blocks);
    expect(view).toEqual({ target: null, cap: null, empty: true });
  });

  test("says hour for a target of one", () => {
    const view = buildHoursView(
      input(
        { week: { capHoursElsewhere: 0, incomeHoursElsewhere: 0, gymSessionsDone: 0 } },
        { incomeTarget: { lane: "work", weeklyHours: 1, blockMinutes: 60 } },
      ),
      [],
    );
    expect(view.target?.label).toBe("0 of 1 hour");
  });
});

// ------------------------------------------------------------- behaviour 10

describe("formatAmount", () => {
  test("groups whole units by thousands with a comma", () => {
    expect(formatAmount(0)).toBe("0");
    expect(formatAmount(999)).toBe("999");
    expect(formatAmount(1000)).toBe("1,000");
    expect(formatAmount(1234567)).toBe("1,234,567");
  });

  test("puts a minus sign before a negative", () => {
    expect(formatAmount(-1500.4)).toBe("-1,500");
    expect(formatAmount(-0.4)).toBe("0");
  });

  test("rounds halves away from zero", () => {
    expect(formatAmount(2.5)).toBe("3");
    expect(formatAmount(-2.5)).toBe("-3");
    expect(formatAmount(0.49)).toBe("0");
    expect(formatAmount(1999.5)).toBe("2,000");
  });

  // Once, on the magnitude: a value just under a half rounds down, however
  // close it is to the cent that would round up.
  test("rounds once, so only a half goes up", () => {
    expect(formatAmount(0.496)).toBe("0");
    expect(formatAmount(0.5)).toBe("1");
    expect(formatAmount(2.4961)).toBe("2");
    expect(formatAmount(2.5)).toBe("3");
    expect(formatAmount(-0.4)).toBe("0");
    expect(formatAmount(-0.5)).toBe("-1");
    expect(formatAmount(999.5)).toBe("1,000");
  });

  test("prints the word for an unknown amount for a number that is not finite", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatAmount(value)).toBe(MONEY_COPY.unknownAmount);
    }
  });

  test("never makes a day whose balance is not a number the lowest", () => {
    const view = buildForecastView(patchDay(base(), TODAY, { projected: Number.NaN }), 14);
    expect(view.list[0]).toMatchObject({ balance: MONEY_COPY.unknownAmount, low: false, negative: false });
    expect(view.lowest?.date).toBe("Tuesday 24 March");
  });
});

// ------------------------------------------------------------- behaviour 11

describe("the sample", () => {
  const day = sampleDay();
  const fresh = sampleMoney(day);
  const stale = sampleMoneyStale(day);

  test("is deterministic, and on the desk's own day and clock", () => {
    expect(sampleMoney(sampleDay())).toEqual(fresh);
    expect(sampleMoneyStale(sampleDay())).toEqual(stale);
    expect(fresh.today).toBe(day.input.date);
    expect(fresh.takenAt).toBe(day.input.now);
  });

  test("has an everyday account and a savings account", () => {
    expect(fresh.accounts.map((account) => account.kind)).toEqual(["checking", "savings"]);
    for (const account of fresh.accounts) {
      expect(account.balance % 50).toBe(0);
      expect(account.currency).toBe(fresh.currency);
    }
  });

  test("forecasts 60 days in a row from the sample day, from what the accounts hold", () => {
    expect(fresh.forecast).toHaveLength(60);
    fresh.forecast.forEach((entry, index) => {
      expect(entry.date).toBe(shiftDateKey(fresh.today, index));
    });
    const held = fresh.accounts.reduce((sum, account) => sum + account.balance, 0);
    expect(fresh.forecast[0].projected).toBe(held);
  });

  test("has a pay day, two bills and an everyday estimate, all named by the marks", () => {
    expect(fresh.bills).toHaveLength(2);
    expect(fresh.income.filter((income) => income.fixedMonthly !== null)).toHaveLength(1);
    const labels = buildForecastView(fresh, 60).list.flatMap((cell) => cell.marks.map((mark) => mark.label));
    for (const name of [...fresh.bills.map((bill) => bill.name), fresh.income[0].name]) {
      expect(labels.some((label) => label.startsWith(`${name} `))).toBe(true);
    }
    expect(labels.some((label) => label.startsWith(`${MONEY_COPY.bill} `))).toBe(false);
    expect(buildForecastView(fresh, 60).estimate).not.toBe(MONEY_COPY.estimate.none);
    expect(fresh.forecast.every((entry) => entry.everyday >= 0)).toBe(true);
    expect(fresh.forecast.slice(1).every((entry) => entry.everyday > 0)).toBe(true);
  });

  test("has fifteen ledger lines, newest first, the newest two days back", () => {
    expect(fresh.rows).toHaveLength(15);
    expect(fresh.ledgerLastOn).toBe(shiftDateKey(fresh.today, -2));
    expect(fresh.rows[0].on).toBe(fresh.ledgerLastOn);
    for (let index = 1; index < fresh.rows.length; index += 1) {
      expect(dayDiff(fresh.rows[index].on, fresh.rows[index - 1].on)).toBeGreaterThanOrEqual(0);
    }
    expect(moneyAge(fresh)).toEqual({ days: 2, stale: false, line: null });
  });

  test("has a stale twin whose newest line is 80 days back, and nothing else changed", () => {
    expect(stale.rows).toHaveLength(15);
    expect(stale.ledgerLastOn).toBe(shiftDateKey(stale.today, -80));
    expect(stale.rows[0].on).toBe(stale.ledgerLastOn);
    expect(moneyAge(stale)).toMatchObject({ days: 80, stale: true });
    const withoutLedger = (data: MoneyScreenData) => ({ ...data, rows: [], ledgerLastOn: null });
    expect(withoutLedger(stale)).toEqual(withoutLedger(fresh));
    const undated = (data: MoneyScreenData) => data.rows.map((line) => ({ ...line, on: "" }));
    expect(undated(stale)).toEqual(undated(fresh));
  });
});

// ------------------------------------------------------------- behaviour 13

describe("the copy rules", () => {
  const day = sampleDay();
  const views = (data: MoneyScreenData) => [
    moneyAge(data),
    ...([14, 30, 60] as const).flatMap((span) => [
      buildForecastView(data, span),
      buildComingView(data, span),
    ]),
    buildAccountsView(data, day.input.rules.timeZone),
    ...([10, 25, 50] as const).map((rows) => buildLedgerView(data, rows)),
  ];
  const everything = [
    ...strings(MONEY_COPY),
    ...strings(views(sampleMoney(day))),
    ...strings(views(sampleMoneyStale(day))),
    ...strings(views(marked())),
    ...strings(views({ ...base(), ledgerLastOn: null, rows: [], forecast: [], accounts: [] })),
    ...strings(buildHoursView(day.input, planDay(day.input).blocks)),
    ...[0, 1, 5].map(inDaysLabel),
  ];

  test("has something to walk", () => {
    expect(everything.length).toBeGreaterThan(100);
  });

  // Built from code points, so this file stays pure ASCII.
  const EM_DASH = String.fromCodePoint(0x2014);
  const EN_DASH = String.fromCodePoint(0x2013);

  test("uses no em dash and no en dash", () => {
    for (const text of everything) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
    }
  });

  test("never speaks of streaks, points, levels or penalties", () => {
    for (const text of everything) {
      expect(text).not.toMatch(/\b(streaks?|points?|levels?|penalt(y|ies)|xp)\b/i);
    }
  });
});

describe("the view model is browser safe", () => {
  // The sample is loaded by the browser too: the gallery and the sample desk.
  test.each(["app/lib/v2/view/money.ts", "app/lib/v2/fixtures/sample-money.ts"])(
    "%s imports nothing local, nothing from next and nothing from node",
    (file) => {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      const specifiers = Array.from(source.matchAll(/from\s+"([^"]+)"/g), (match) => match[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(/\/local(\/|$)|^next(\/|$)|^node:/);
      }
      expect(source).not.toMatch(/\bimport\(/);
    },
  );
});
