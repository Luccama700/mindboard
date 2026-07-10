// Pure projection helpers for the finance calendar. No React, no server imports —
// kept isolated so the running-total math can be unit tested.
//
// Model: the running total is the projected end-of-day net worth, anchored at
// today's real net worth (sum of account balances).
//   - days <= today reflect recorded actuals (recorded balance changes).
//   - days  > today are a forecast: + wage income, - recurring expenses.

export type RecurringRule = {
  frequency: "monthly" | "weekly" | "daily" | "custom";
  day_of_month: number | null;
  weekday: number | null;
  interval_days: number | null;
  start_date: string | null;
  amount: number;
};

export type RecordedDelta = {
  occurred_at: string;
  direction: "in" | "out";
  amount: number;
  // Internal transfers (e.g. a credit-card payment) move money between two
  // owned accounts and net to zero across net worth; they must not show up as
  // real income/spending in a day's inflow/outflow.
  is_transfer?: boolean;
};

export type PayFrequency = "weekly" | "biweekly" | "monthly";

export type IncomeSourceRate = {
  id: string;
  hourly_wage: number;
  tax_rate: number;
  pay_frequency: PayFrequency | null;
  anchor_payday: string | null;
  period_start: string | null;
  period_end: string | null;
  // Both set = fixed monthly income; takes precedence over the hourly fields
  // (which are preserved for toggling back but ignored while fixed).
  fixed_amount?: number | null;
  fixed_day?: number | null;
};

export type PayCycle = {
  payday: string;
  periodStart: string;
  periodEnd: string;
};

export type IncomeDetail = {
  sourceId: string;
  net: number;
  hours: number;
  periodStart: string | null;
  periodEnd: string | null;
  fixed?: boolean;
};

export type DayRow = {
  dateKey: string;
  inMonth: boolean;
  isToday: boolean;
  isPast: boolean;
  inflow: number;
  outflow: number;
  // everyday-spend estimate (future days only) — kept apart from the firm
  // recurring-bill outflow so the UI can render it as an estimate (~).
  estimatedOutflow: number;
  // projected grocery-trip spend (future days only), also an estimate but
  // rendered as its own line so trips read distinctly from the daily baseline.
  estimatedGroceries: number;
  runningTotal: number;
};

function parseKey(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

export function keyOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysKey(key: string, count: number): string {
  const date = parseKey(key);
  date.setDate(date.getDate() + count);
  return keyOf(date);
}

function daysInMonthOf(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function addMonthsKey(key: string, count: number): string {
  const date = parseKey(key);
  date.setMonth(date.getMonth() + count);
  return keyOf(date);
}

function daysBetween(aKey: string, bKey: string): number {
  return Math.round(
    (parseKey(bKey).getTime() - parseKey(aKey).getTime()) / 86_400_000,
  );
}

// Shift a date key by `cycles` pay cycles of the given frequency.
function shiftCycles(key: string, cycles: number, frequency: PayFrequency): string {
  if (frequency === "weekly") return addDaysKey(key, 7 * cycles);
  if (frequency === "biweekly") return addDaysKey(key, 14 * cycles);
  return addMonthsKey(key, cycles);
}

// Approximate number of cycles between the anchor and a target date.
function cycleIndexFor(
  anchor: string,
  target: string,
  frequency: PayFrequency,
): number {
  if (frequency === "monthly") {
    const a = parseKey(anchor);
    const t = parseKey(target);
    return (t.getFullYear() - a.getFullYear()) * 12 + (t.getMonth() - a.getMonth());
  }
  const step = frequency === "weekly" ? 7 : 14;
  return Math.round(daysBetween(anchor, target) / step);
}

// Paydays (and the shift period each covers) that fall within [start, end].
export function paydaysInWindow(
  source: IncomeSourceRate,
  start: string,
  end: string,
): PayCycle[] {
  if (
    !source.pay_frequency ||
    !source.anchor_payday ||
    !source.period_start ||
    !source.period_end
  ) {
    return [];
  }
  const freq = source.pay_frequency;
  const anchor = source.anchor_payday;
  const kStart = cycleIndexFor(anchor, start, freq) - 2;
  const kEnd = cycleIndexFor(anchor, end, freq) + 2;

  const cycles: PayCycle[] = [];
  for (let k = kStart; k <= kEnd; k++) {
    const payday = shiftCycles(anchor, k, freq);
    if (payday < start || payday > end) continue;
    cycles.push({
      payday,
      periodStart: shiftCycles(source.period_start, k, freq),
      periodEnd: shiftCycles(source.period_end, k, freq),
    });
  }
  return cycles;
}

function sumHoursInRange(
  hours: Record<string, number>,
  start: string,
  end: string,
): number {
  let total = 0;
  for (const [day, h] of Object.entries(hours)) {
    if (day >= start && day <= end) total += h;
  }
  return total;
}

// Whether a recurring rule lands on a given calendar day. Monthly day-of-month
// is clamped to the month length (e.g. the 31st lands on Feb 28/29); custom
// lands every `interval_days` days counted from `start_date`.
export function ruleLandsOn(rule: RecurringRule, date: Date): boolean {
  if (rule.frequency === "daily") return true;
  if (rule.frequency === "weekly") {
    return rule.weekday !== null && date.getDay() === rule.weekday;
  }
  if (rule.frequency === "custom") {
    if (!rule.start_date || rule.interval_days === null || rule.interval_days < 1) {
      return false;
    }
    const start = parseKey(rule.start_date);
    const diffDays = Math.round(
      (date.getTime() - start.getTime()) / 86_400_000,
    );
    if (diffDays < 0) return false;
    return diffDays % rule.interval_days === 0;
  }
  if (rule.day_of_month === null) return false;
  const target = Math.min(rule.day_of_month, daysInMonthOf(date));
  return date.getDate() === target;
}

export function expensesOnDate(rules: RecurringRule[], dateKey: string): number {
  const date = parseKey(dateKey);
  let sum = 0;
  for (const rule of rules) {
    if (ruleLandsOn(rule, date)) sum += rule.amount;
  }
  return sum;
}

function netPay(source: IncomeSourceRate, hours: number): number {
  return hours * source.hourly_wage * (1 - source.tax_rate / 100);
}

function isFixedMonthly(source: IncomeSourceRate): boolean {
  return source.fixed_amount != null && source.fixed_day != null;
}

// A fixed monthly income lands on its day-of-month, clamped to short months
// (the 31st lands on Feb 28/29) — same rule as monthly recurring expenses.
function fixedLandsOn(source: IncomeSourceRate, dateKey: string): boolean {
  const date = parseKey(dateKey);
  const target = Math.min(source.fixed_day as number, daysInMonthOf(date));
  return date.getDate() === target;
}

// Net projected income keyed by the day money is received, within
// [window.start, window.end]. Fixed monthly sources land their amount on
// their day each month. Scheduled wage sources pay a lump on each payday
// equal to the net pay for shift hours in that payday's period; unscheduled
// sources pay on the day worked.
export function computeIncomeByDate(
  sources: IncomeSourceRate[],
  hoursBySource: Record<string, Record<string, number>>,
  window: { start: string; end: string },
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const source of sources) {
    if (isFixedMonthly(source)) {
      const amount = Number(source.fixed_amount);
      for (let day = window.start; day <= window.end; day = addDaysKey(day, 1)) {
        if (fixedLandsOn(source, day)) out[day] = (out[day] ?? 0) + amount;
      }
      continue;
    }

    const hours = hoursBySource[source.id];
    if (!hours) continue;

    if (source.pay_frequency) {
      for (const cycle of paydaysInWindow(source, window.start, window.end)) {
        const periodHours = sumHoursInRange(
          hours,
          cycle.periodStart,
          cycle.periodEnd,
        );
        if (periodHours > 0) {
          out[cycle.payday] = (out[cycle.payday] ?? 0) + netPay(source, periodHours);
        }
      }
    } else {
      for (const [day, h] of Object.entries(hours)) {
        if (day >= window.start && day <= window.end) {
          out[day] = (out[day] ?? 0) + netPay(source, h);
        }
      }
    }
  }
  return out;
}

// Per-source income landing on a single day, used for the calendar's
// selected-day breakdown. Scheduled sources report the period they cover.
export function incomeDetailForDay(
  sources: IncomeSourceRate[],
  hoursBySource: Record<string, Record<string, number>>,
  dateKey: string,
): IncomeDetail[] {
  const out: IncomeDetail[] = [];
  for (const source of sources) {
    if (isFixedMonthly(source)) {
      if (fixedLandsOn(source, dateKey)) {
        out.push({
          sourceId: source.id,
          net: Number(source.fixed_amount),
          hours: 0,
          periodStart: null,
          periodEnd: null,
          fixed: true,
        });
      }
      continue;
    }

    const hours = hoursBySource[source.id];
    if (!hours) continue;

    if (source.pay_frequency) {
      for (const cycle of paydaysInWindow(source, dateKey, dateKey)) {
        const periodHours = sumHoursInRange(
          hours,
          cycle.periodStart,
          cycle.periodEnd,
        );
        if (periodHours > 0) {
          out.push({
            sourceId: source.id,
            net: netPay(source, periodHours),
            hours: periodHours,
            periodStart: cycle.periodStart,
            periodEnd: cycle.periodEnd,
          });
        }
      }
    } else {
      const h = hours[dateKey] ?? 0;
      if (h > 0) {
        out.push({
          sourceId: source.id,
          net: netPay(source, h),
          hours: h,
          periodStart: null,
          periodEnd: null,
        });
      }
    }
  }
  return out;
}

export function buildDayRows(input: {
  gridDays: string[];
  month: string;
  today: string;
  netWorthToday: number;
  changes: RecordedDelta[];
  expenses: RecurringRule[];
  incomeByDate: Record<string, number>;
  // projected everyday spend per future day (weekday baseline or manual
  // fallback); must cover (today, last grid day] like incomeByDate.
  estimatedSpendByDate?: Record<string, number>;
  // projected grocery-trip spend per future day (shopping-list prices snapped
  // to the shopping day). Callers should deduct these from the everyday
  // baseline (deductBaseline) before passing both, to avoid double-counting.
  groceriesByDate?: Record<string, number>;
}): DayRow[] {
  const { gridDays, month, today, netWorthToday, changes, expenses, incomeByDate } =
    input;
  const estimatedSpendByDate = input.estimatedSpendByDate ?? {};
  const groceriesByDate = input.groceriesByDate ?? {};

  if (gridDays.length === 0) return [];

  const inByDate = new Map<string, number>();
  const outByDate = new Map<string, number>();
  const signedByDate = new Map<string, number>();
  for (const ch of changes) {
    // A transfer still moves each account's balance on its own day — when the
    // two legs land on different days (re-dated via ledger edit / MCP adjust)
    // net worth legitimately dips while the money is in flight — so transfers
    // DO count toward the running total.
    const signed = ch.direction === "in" ? ch.amount : -ch.amount;
    signedByDate.set(
      ch.occurred_at,
      (signedByDate.get(ch.occurred_at) ?? 0) + signed,
    );
    // But a transfer is not real income/spending, so keep it out of the
    // per-day inflow/outflow figures.
    if (ch.is_transfer) continue;
    const target = ch.direction === "in" ? inByDate : outByDate;
    target.set(ch.occurred_at, (target.get(ch.occurred_at) ?? 0) + ch.amount);
  }

  const minDay = gridDays[0];
  const maxDay = gridDays[gridDays.length - 1];

  // Forward forecast: cumulative net flow over (today, d], covering any gap
  // between today and the visible grid so far-future months stay anchored.
  const futureCum = new Map<string, number>();
  let cum = 0;
  let cursor = addDaysKey(today, 1);
  while (cursor <= maxDay) {
    cum +=
      (incomeByDate[cursor] ?? 0) -
      expensesOnDate(expenses, cursor) -
      (estimatedSpendByDate[cursor] ?? 0) -
      (groceriesByDate[cursor] ?? 0);
    futureCum.set(cursor, cum);
    cursor = addDaysKey(cursor, 1);
  }

  // Backward actuals: amount to subtract from today's net worth to reach the
  // end-of-day balance for a past day d, i.e. sum of recorded deltas in (d, today].
  const pastSubtract = new Map<string, number>();
  pastSubtract.set(today, 0);
  let back = 0;
  let backCursor = today;
  while (backCursor > minDay) {
    back += signedByDate.get(backCursor) ?? 0;
    const prev = addDaysKey(backCursor, -1);
    pastSubtract.set(prev, back);
    backCursor = prev;
  }

  return gridDays.map((dateKey) => {
    const isToday = dateKey === today;
    const isPast = dateKey <= today;
    let inflow: number;
    let outflow: number;
    let estimatedOutflow: number;
    let estimatedGroceries: number;
    let runningTotal: number;

    if (isPast) {
      inflow = inByDate.get(dateKey) ?? 0;
      outflow = outByDate.get(dateKey) ?? 0;
      estimatedOutflow = 0;
      estimatedGroceries = 0;
      runningTotal = netWorthToday - (pastSubtract.get(dateKey) ?? 0);
    } else {
      inflow = incomeByDate[dateKey] ?? 0;
      outflow = expensesOnDate(expenses, dateKey);
      estimatedOutflow = estimatedSpendByDate[dateKey] ?? 0;
      estimatedGroceries = groceriesByDate[dateKey] ?? 0;
      runningTotal = netWorthToday + (futureCum.get(dateKey) ?? 0);
    }

    return {
      dateKey,
      inMonth: dateKey.startsWith(month),
      isToday,
      isPast,
      inflow,
      outflow,
      estimatedOutflow,
      estimatedGroceries,
      runningTotal,
    };
  });
}
