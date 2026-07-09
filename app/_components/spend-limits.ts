// Pure spending-limits tracker. No React, no server imports — unit tested
// directly (__tests__/spend-limits.test.ts).
//
// Spending limits are user-set budget caps the app tracks ACTUAL spend
// against. This is distinct from the forecast's daily-spend estimate
// (spend-baseline.ts), which predicts *future* spend; limits measure what has
// already been spent this period and warn when a cap is approached or crossed.
//
// Actual spend uses the SAME inclusion rules as the everyday-spend baseline —
// out-flows only, transfers excluded, recurring bills excluded — via the shared
// isDiscretionarySpend predicate, so the two never drift apart. A category
// limit additionally filters to that category; the overall limit counts all
// discretionary spend.
//
// Period boundaries are computed from an already-resolved local `today`
// ("YYYY-MM-DD"), so this module stays timezone-agnostic: callers resolve the
// user's local day upstream with todayISO(safeTimeZone(tz)) and hand it in.
// occurred_at is a DATE key, so period windowing is plain string comparison
// (lexicographic order === chronological order for YYYY-MM-DD).

import { addDaysKey } from "./finance-projection";
import type {
  SpendLimit,
  SpendLimitPeriod,
  SpendLimitScope,
} from "./finance-types";
import { sumMoney } from "./money";
import {
  isDiscretionarySpend,
  type BillRule,
  type SpendHistoryRow,
} from "./spend-baseline";

// A cap is "approaching" once this fraction of it has been spent.
export const APPROACHING_THRESHOLD = 0.8;

export type SpendLimitState = "under" | "approaching" | "over";

export type SpendLimitStatus = {
  limitId: string;
  scope: SpendLimitScope;
  categoryId: string | null;
  period: SpendLimitPeriod;
  amount: number;
  spent: number;
  remaining: number;
  pctUsed: number;
  state: SpendLimitState;
};

export type SpendLimitWarning = {
  limitId: string;
  scope: SpendLimitScope;
  categoryId: string | null;
  period: SpendLimitPeriod;
  state: "approaching" | "over";
  spent: number; // projected total after the pending spend
  amount: number;
  remaining: number;
};

export type PeriodBounds = { startKey: string; endKey: string };

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

// Inclusive [startKey, endKey] date-key window for the period containing
// `today`. daily = today; weekly = the Mon-Sun week; monthly = the calendar
// month.
export function periodBounds(
  today: string,
  period: SpendLimitPeriod,
): PeriodBounds {
  if (period === "daily") {
    return { startKey: today, endKey: today };
  }
  if (period === "weekly") {
    // getDay() is 0=Sun..6=Sat; shift so 0=Mon..6=Sun. The weekday of a
    // calendar date is invariant across timezones (midnight-local of that date
    // is always the same weekday).
    const dow = (new Date(`${today}T00:00:00`).getDay() + 6) % 7;
    const startKey = addDaysKey(today, -dow);
    return { startKey, endKey: addDaysKey(startKey, 6) };
  }
  // monthly: calendar month
  const startKey = `${today.slice(0, 7)}-01`;
  const [year, month] = startKey.split("-").map(Number); // month is 1..12
  const firstOfNext =
    month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { startKey, endKey: addDaysKey(firstOfNext, -1) };
}

function stateFor(spent: number, amount: number): SpendLimitState {
  if (spent > amount) return "over";
  const ratio = amount > 0 ? spent / amount : 0;
  return ratio >= APPROACHING_THRESHOLD ? "approaching" : "under";
}

// Sum discretionary spend for a limit over its current period. `rows` is raw
// balance-change history; the discretionary filter and category scope are
// applied here so callers pass unfiltered rows + the active bill rules.
export function computeLimitStatus(input: {
  limit: SpendLimit;
  rows: SpendHistoryRow[];
  rules: BillRule[];
  today: string;
}): SpendLimitStatus {
  const { limit, rows, rules, today } = input;
  const { startKey, endKey } = periodBounds(today, limit.period);

  const spent = sumMoney(
    rows
      .filter(
        (r) =>
          r.occurred_at >= startKey &&
          r.occurred_at <= endKey &&
          isDiscretionarySpend(r, rules) &&
          (limit.scope === "overall" || r.category_id === limit.category_id),
      )
      .map((r) => Number(r.amount)),
  );

  const pctUsed =
    limit.amount > 0 ? Math.round((spent / limit.amount) * 1000) / 10 : 0;

  return {
    limitId: limit.id,
    scope: limit.scope,
    categoryId: limit.category_id,
    period: limit.period,
    amount: limit.amount,
    spent,
    remaining: roundCents(limit.amount - spent),
    pctUsed,
    state: stateFor(spent, limit.amount),
  };
}

export function computeLimitStatuses(input: {
  limits: SpendLimit[];
  rows: SpendHistoryRow[];
  rules: BillRule[];
  today: string;
}): SpendLimitStatus[] {
  const { limits, rows, rules, today } = input;
  return limits
    .filter((l) => !l.archived)
    .map((limit) => computeLimitStatus({ limit, rows, rules, today }));
}

export type PendingSpend = {
  amount: number;
  categoryId: string | null;
  dateKey: string;
};

// Which active limits one or more pending spends push into 'approaching' or
// 'over'. Applicable limits: the overall limit always; a category limit only
// for spends whose category matches. A pending spend that would itself be
// classed as a bill or transfer counts against nothing (same inclusion rules),
// and a spend dated outside a limit's current period doesn't affect it.
export function limitWarningsForSpends(input: {
  limits: SpendLimit[];
  rows: SpendHistoryRow[];
  rules: BillRule[];
  spends: PendingSpend[];
  today: string;
}): SpendLimitWarning[] {
  const { limits, rows, rules, spends, today } = input;

  // Only spends that are themselves discretionary count against a limit.
  const discretionary = spends.filter((s) =>
    isDiscretionarySpend(
      {
        direction: "out",
        amount: s.amount,
        category_id: s.categoryId,
        is_transfer: false,
      },
      rules,
    ),
  );
  if (discretionary.length === 0) return [];

  const warnings: SpendLimitWarning[] = [];
  for (const limit of limits) {
    if (limit.archived) continue;

    const { startKey, endKey } = periodBounds(today, limit.period);
    const pending = discretionary
      .filter(
        (s) =>
          s.dateKey >= startKey &&
          s.dateKey <= endKey &&
          (limit.scope === "overall" || s.categoryId === limit.category_id),
      )
      .map((s) => s.amount);
    if (pending.length === 0) continue;

    const base = computeLimitStatus({ limit, rows, rules, today });
    const projected = sumMoney([base.spent, ...pending]);
    const state = stateFor(projected, limit.amount);
    if (state === "under") continue;

    warnings.push({
      limitId: limit.id,
      scope: limit.scope,
      categoryId: limit.category_id,
      period: limit.period,
      state,
      spent: projected,
      amount: limit.amount,
      remaining: roundCents(limit.amount - projected),
    });
  }
  return warnings;
}

// Single-spend convenience wrapper (the log_spend / one-off case).
export function limitWarningsForSpend(input: {
  limits: SpendLimit[];
  rows: SpendHistoryRow[];
  rules: BillRule[];
  spend: PendingSpend;
  today: string;
}): SpendLimitWarning[] {
  return limitWarningsForSpends({
    limits: input.limits,
    rows: input.rows,
    rules: input.rules,
    spends: [input.spend],
    today: input.today,
  });
}
