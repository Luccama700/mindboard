// Pure everyday-spend baseline for the cashflow forecast. No React, no server
// imports — unit tested directly (__tests__/spend-baseline.test.ts).
//
// Model (docs/finance-automation-plan.md §4): future days get a projected
// discretionary spend = the MEDIAN of daily spend per weekday over the last
// ~12 weeks. Bill payments are excluded (they're already projected by the
// recurring rules — counting them here would double-count), transfers are
// excluded (not spending), and days with zero discretionary spend count as
// explicit $0 samples. The median is what keeps a one-off big purchase from
// replaying every week. Below MIN_CONFIDENT_DAYS of history the baseline
// reports not-confident and a manual flat estimate takes over.

import { addDaysKey, ruleLandsOn, type RecurringRule } from "./finance-projection";

export const BASELINE_WEEKS = 12;
export const MIN_CONFIDENT_DAYS = 28;

export type SpendHistoryRow = {
  occurred_at: string;
  direction: "in" | "out";
  amount: number;
  category_id: string | null;
  is_transfer: boolean;
};

export type BillRule = RecurringRule & { category_id: string | null };

export type WeekdayBaseline = {
  byWeekday: number[]; // 7 medians, sun..sat
  sampledDays: number;
  confident: boolean;
};

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : roundCents((sorted[mid - 1] + sorted[mid]) / 2);
}

// A row looks like a bill payment when an active recurring rule with a
// compatible category has a close amount and lands within ±3 days.
export function matchesBill(
  row: Pick<SpendHistoryRow, "occurred_at" | "amount" | "category_id">,
  rules: BillRule[],
): boolean {
  for (const rule of rules) {
    const compatibleCategory =
      rule.category_id === null ||
      row.category_id === null ||
      rule.category_id === row.category_id;
    if (!compatibleCategory) continue;

    const tolerance = Math.max(rule.amount * 0.02, 0.01);
    if (Math.abs(Number(row.amount) - rule.amount) > tolerance) continue;

    for (let offset = -3; offset <= 3; offset++) {
      const dateKey = addDaysKey(row.occurred_at, offset);
      if (ruleLandsOn(rule, new Date(`${dateKey}T00:00:00`))) return true;
    }
  }
  return false;
}

// Median discretionary spend per weekday over the trailing window. The window
// is clipped to the first day any history exists so a young ledger isn't
// dragged toward zero by pre-tracking days; today is excluded (partial day).
export function computeWeekdayBaseline(input: {
  history: SpendHistoryRow[];
  rules: BillRule[];
  today: string;
  weeks?: number;
}): WeekdayBaseline {
  const { history, rules, today } = input;
  const weeks = input.weeks ?? BASELINE_WEEKS;

  const empty: WeekdayBaseline = {
    byWeekday: [0, 0, 0, 0, 0, 0, 0],
    sampledDays: 0,
    confident: false,
  };
  if (history.length === 0) return empty;

  const windowStart = addDaysKey(today, -weeks * 7);
  const windowEnd = addDaysKey(today, -1);
  let earliest = history[0].occurred_at;
  for (const row of history) {
    if (row.occurred_at < earliest) earliest = row.occurred_at;
  }
  const start = earliest > windowStart ? earliest : windowStart;
  if (start > windowEnd) return empty;

  const totals = new Map<string, number>();
  for (const row of history) {
    if (row.direction !== "out" || row.is_transfer) continue;
    if (row.occurred_at < start || row.occurred_at > windowEnd) continue;
    if (matchesBill(row, rules)) continue;
    totals.set(
      row.occurred_at,
      roundCents((totals.get(row.occurred_at) ?? 0) + Number(row.amount)),
    );
  }

  const samples: number[][] = [[], [], [], [], [], [], []];
  let sampledDays = 0;
  for (let cursor = start; cursor <= windowEnd; cursor = addDaysKey(cursor, 1)) {
    const weekday = new Date(`${cursor}T00:00:00`).getDay();
    samples[weekday].push(totals.get(cursor) ?? 0);
    sampledDays++;
  }

  return {
    byWeekday: samples.map((s) => roundCents(median(s))),
    sampledDays,
    confident: sampledDays >= MIN_CONFIDENT_DAYS,
  };
}

// Per-day estimate resolution: confident history → that weekday's median;
// otherwise the manual flat value; otherwise nothing.
export function estimatedSpendOn(
  baseline: WeekdayBaseline,
  manual: number | null,
  dateKey: string,
): number {
  if (baseline.confident) {
    return baseline.byWeekday[new Date(`${dateKey}T00:00:00`).getDay()] ?? 0;
  }
  return manual !== null && manual > 0 ? roundCents(manual) : 0;
}
