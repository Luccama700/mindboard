// Pure everyday-spend baseline for the cashflow forecast. No React, no server
// imports — unit tested directly (__tests__/spend-baseline.test.ts).
//
// Model (docs/finance-automation-plan.md §4, revised 2026-07-07, calibrated
// 2026-07-08): future days get a FLAT projected everyday spend read as a
// predicted MINIMUM: half the median WEEKLY total over the trailing ~12
// weeks, divided by 7. Weekly totals — not per-weekday buckets — because
// statement imports carry *posted* dates: banks park weekend purchases on
// Monday, so any weekday-shaped model learns the bank's posting calendar
// instead of real habits (observed live: 120 Monday rows vs 5 Saturday rows).
// The median across weeks also makes outlier weeks (tuition, a rent payment
// that slipped the bill filter) 1-of-N samples the median steps over.
//
// The half factor (MIN_SPEND_FACTOR) exists because the raw median is a
// *typical* week — half of real weeks come in under it — and its error
// profile is one-sided: bill payments that drift past the 2% amount
// tolerance and one-off purchases inside otherwise-normal weeks can only
// inflate the pool, never deflate it. Read live, the raw median tracked
// noticeably above lived spending, so the forecast now projects a floor
// rather than a midpoint. The factor applies only to this history-derived
// rate; explicit user inputs (spend_overrides pins, the manual
// daily_spend_estimate) are taken at face value.
//
// Bill payments are excluded by amount + category match against the active
// recurring rules — deliberately with NO date-proximity requirement, because
// real payments wander (rent posted May 19 / May 28 / Jun 29). Transfers are
// excluded (not spending). Weeks with zero discretionary spend count as $0.
//
// Per-day overrides (spend_overrides table, set via the selected-day slider)
// replace the estimate for that date, including an explicit $0.

import { addDaysKey } from "./finance-projection";

export const BASELINE_WEEKS = 12;
export const MIN_CONFIDENT_WEEKS = 4;
export const MIN_SPEND_FACTOR = 0.5;

export type SpendHistoryRow = {
  occurred_at: string;
  direction: "in" | "out";
  amount: number;
  category_id: string | null;
  is_transfer: boolean;
};

export type BillRule = {
  amount: number;
  category_id: string | null;
};

export type SpendRate = {
  dailyRate: number;
  sampledWeeks: number;
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
// compatible category matches its amount within 2%. No date check: payments
// post on whatever day the bank processed them.
export function matchesBill(
  row: Pick<SpendHistoryRow, "amount" | "category_id">,
  rules: BillRule[],
): boolean {
  for (const rule of rules) {
    const compatibleCategory =
      rule.category_id === null ||
      row.category_id === null ||
      rule.category_id === row.category_id;
    if (!compatibleCategory) continue;

    const tolerance = Math.max(rule.amount * 0.02, 0.01);
    if (Math.abs(Number(row.amount) - rule.amount) <= tolerance) return true;
  }
  return false;
}

// Predicted-minimum rate: MIN_SPEND_FACTOR × the median weekly discretionary
// total ÷ 7, over trailing 7-day blocks ending yesterday (today is a partial
// day). Only blocks fully covered by recorded history count, so a young
// ledger isn't dragged toward zero.
export function computeSpendRate(input: {
  history: SpendHistoryRow[];
  rules: BillRule[];
  today: string;
  weeks?: number;
}): SpendRate {
  const { history, rules, today } = input;
  const weeks = input.weeks ?? BASELINE_WEEKS;

  const empty: SpendRate = { dailyRate: 0, sampledWeeks: 0, confident: false };
  if (history.length === 0) return empty;

  let earliest = history[0].occurred_at;
  for (const row of history) {
    if (row.occurred_at < earliest) earliest = row.occurred_at;
  }

  const dailyTotals = new Map<string, number>();
  for (const row of history) {
    if (row.direction !== "out" || row.is_transfer) continue;
    if (matchesBill(row, rules)) continue;
    dailyTotals.set(
      row.occurred_at,
      roundCents((dailyTotals.get(row.occurred_at) ?? 0) + Number(row.amount)),
    );
  }

  const weekTotals: number[] = [];
  let blockEnd = addDaysKey(today, -1);
  for (let k = 0; k < weeks; k++) {
    const blockStart = addDaysKey(blockEnd, -6);
    if (blockStart < earliest) break; // partial block — history doesn't cover it
    let total = 0;
    for (let d = 0; d < 7; d++) {
      total += dailyTotals.get(addDaysKey(blockStart, d)) ?? 0;
    }
    weekTotals.push(roundCents(total));
    blockEnd = addDaysKey(blockStart, -1);
  }

  if (weekTotals.length === 0) return empty;

  return {
    dailyRate: roundCents((median(weekTotals) * MIN_SPEND_FACTOR) / 7),
    sampledWeeks: weekTotals.length,
    confident: weekTotals.length >= MIN_CONFIDENT_WEEKS,
  };
}

// Per-day estimate resolution: an explicit override (slider) wins — including
// an explicit $0 — then confident history, then the manual flat value.
export function estimatedSpendOn(
  rate: SpendRate,
  manual: number | null,
  overrides: Record<string, number>,
  dateKey: string,
): number {
  const override = overrides[dateKey];
  if (override !== undefined && override >= 0) return roundCents(override);
  if (rate.confident) return rate.dailyRate;
  return manual !== null && manual > 0 ? roundCents(manual) : 0;
}
