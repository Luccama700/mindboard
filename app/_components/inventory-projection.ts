// Pure depletion-forecast helpers for the per-item inventory calendar. No React,
// no server imports — kept isolated so the projection math can be unit tested.
//
// Model: usage is "spread" to an effective daily consumption rate, so the
// projected quantity declines smoothly. The forecast anchors at the item's
// current quantity ("today") and only looks forward; past days are not
// back-filled because we keep no usage history.
//   day    -> amount per day
//   week   -> amount / 7 per day
//   custom -> amount / interval_days per day

export type UsagePeriod = "day" | "week" | "custom";

export type UsageRule = {
  amount: number;
  period: UsagePeriod;
  interval_days: number | null;
};

export type ProjectionDay = {
  dateKey: string;
  quantity: number;
  isToday: boolean;
  isPast: boolean;
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

export function daysBetween(aKey: string, bKey: string): number {
  return Math.round(
    (parseKey(bKey).getTime() - parseKey(aKey).getTime()) / 86_400_000,
  );
}

// Per-rule daily-equivalent consumption. Returns 0 for malformed rules so a bad
// row never poisons the whole forecast.
export function dailyRateOf(rule: UsageRule): number {
  const amount = Number(rule.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (rule.period === "day") return amount;
  if (rule.period === "week") return amount / 7;
  if (rule.period === "custom") {
    const n = rule.interval_days;
    if (n === null || !Number.isFinite(n) || n < 1) return 0;
    return amount / n;
  }
  return 0;
}

export function effectiveDailyRate(rules: UsageRule[]): number {
  return rules.reduce((sum, r) => sum + dailyRateOf(r), 0);
}

// Projected remaining quantity on a future day, clamped at zero. Past days
// (before today) report the current quantity unchanged.
export function projectedQuantity(
  quantityToday: number,
  dailyRate: number,
  daysAhead: number,
): number {
  if (daysAhead <= 0) return quantityToday;
  return Math.max(0, quantityToday - dailyRate * daysAhead);
}

// Whole days until the item reaches zero. null when nothing is being consumed.
export function daysUntilEmpty(
  quantityToday: number,
  dailyRate: number,
): number | null {
  if (dailyRate <= 0) return null;
  if (quantityToday <= 0) return 0;
  return Math.ceil(quantityToday / dailyRate);
}

// The first calendar day on which the item is projected to be empty.
export function runOutDateKey(
  today: string,
  quantityToday: number,
  dailyRate: number,
): string | null {
  const days = daysUntilEmpty(quantityToday, dailyRate);
  if (days === null) return null;
  return addDaysKey(today, days);
}

// The first calendar day on which the projected quantity is at or below the
// reorder threshold — the day to reorder by. null when no threshold is set or
// nothing is being consumed.
export function reorderDateKey(
  today: string,
  quantityToday: number,
  dailyRate: number,
  threshold: number | null,
): string | null {
  if (threshold === null || !Number.isFinite(threshold)) return null;
  if (dailyRate <= 0) return null;
  if (quantityToday <= threshold) return today;
  const days = Math.ceil((quantityToday - threshold) / dailyRate);
  return addDaysKey(today, days);
}

export type StockStatus = "ok" | "low" | "out";

export function stockStatus(
  quantity: number,
  threshold: number | null,
): StockStatus {
  if (quantity <= 0) return "out";
  if (threshold !== null && Number.isFinite(threshold) && quantity <= threshold) {
    return "low";
  }
  return "ok";
}

// Projected quantity for each day in a calendar grid.
export function buildProjectionDays(input: {
  gridDays: string[];
  today: string;
  quantityToday: number;
  dailyRate: number;
}): ProjectionDay[] {
  const { gridDays, today, quantityToday, dailyRate } = input;
  return gridDays.map((dateKey) => {
    const daysAhead = daysBetween(today, dateKey);
    return {
      dateKey,
      quantity: projectedQuantity(quantityToday, dailyRate, daysAhead),
      isToday: dateKey === today,
      isPast: dateKey < today,
    };
  });
}
