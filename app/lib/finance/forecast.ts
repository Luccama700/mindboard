import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listEventsForCalendar } from "@/utils/google/calendar";
import {
  zonedDateKey,
  zonedWallTimeToUtcMs,
} from "@/app/lib/snapshots/zoned-time";
import {
  addDaysKey,
  buildDayRows,
  computeIncomeByDate,
  type IncomeSourceRate,
  type RecurringRule,
} from "@/app/_components/finance-projection";
import {
  computeSpendRate,
  estimatedSpendOn,
  type SpendHistoryRow,
} from "@/app/_components/spend-baseline";
import {
  buildShoppingList,
  type ShoppingListItem,
} from "@/app/_components/shopping-list";
import {
  buildGroceriesByDate,
  deductBaseline,
  groceryAmountsByDate,
  type GroceryTrip,
} from "@/app/_components/grocery-forecast";
import type { UsageRule } from "@/app/_components/inventory-projection";

// Shared cashflow-forecast core: the finance calendar's math (buildDayRows + the
// flat everyday-spend baseline), assembled session-less. Parameterized by a
// Supabase client + userId so it runs under either the MCP service-role client
// or the in-app session client — every query pins user_id explicitly, which is
// required with the service client (RLS bypassed) and harmless with the session
// client (RLS also enforces). `today` and `dailySpendEstimate` are injected so
// callers own the clock and the manual fallback.

export type ForecastDay = {
  date: string;
  inflow: number;
  outflow: number;
  estimatedEverydaySpend: number;
  estimatedGroceries: number;
  projectedNetWorth: number;
};

export type FinanceForecast = {
  today: string;
  netWorthToday: number;
  currency: string;
  everydaySpend: {
    dailyRate: number;
    sampledWeeks: number;
    confident: boolean;
    manualFallback: number | null;
  };
  // Projected grocery trips (shopping-list prices snapped to the shopping
  // day); empty when no shopping day is configured.
  groceryTrips: Record<string, GroceryTrip>;
  days: ForecastDay[];
};

// Timed-event durations per day, bucketed in the user's zone. The process clock
// is UTC on Vercel, so an evening shift that crosses UTC midnight must still be
// attributed to (and paid on) the local day it was worked. timeZone null falls
// back to the process clock (unchanged in the browser / for zone-less callers).
function eventHoursByDay(
  events: { start: string; end: string; allDay: boolean }[],
  timeZone: string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) {
    if (event.allDay) continue;
    const start = new Date(event.start);
    const end = new Date(event.end);
    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const key = zonedDateKey(start.getTime(), timeZone);
    out[key] = (out[key] ?? 0) + hours;
  }
  return out;
}

export async function buildFinanceForecast(params: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  days: number;
  dailySpendEstimate: number | null;
  timeZone?: string | null;
}): Promise<FinanceForecast> {
  const { supabase, userId, today, dailySpendEstimate } = params;
  const timeZone = params.timeZone ?? null;
  const horizon = Math.min(Math.max(1, Math.trunc(params.days)), 90);
  const endKey = addDaysKey(today, horizon);
  const historyStart = addDaysKey(today, -90);

  const [accountsRes, expensesRes, incomeRes, historyRes, overridesRes] =
    await Promise.all([
      // Ordered because `currency` below is read off accounts[0]: unordered,
      // the forecast could label the same user's money differently between
      // requests, and differently again from writes.ts's baseCurrency. Oldest
      // account wins everywhere (matches getAccounts and finance/setup).
      supabase
        .from("accounts")
        .select("id, balance, currency")
        .eq("user_id", userId)
        .eq("archived", false)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
      supabase
        .from("recurring_expenses")
        .select(
          "id, name, amount, category_id, frequency, day_of_month, weekday, interval_days, start_date",
        )
        .eq("user_id", userId)
        .eq("archived", false),
      supabase
        .from("income_sources")
        .select(
          "id, name, hourly_wage, tax_rate, calendar_id, pay_frequency, anchor_payday, period_start, period_end, fixed_amount, fixed_day",
        )
        .eq("user_id", userId)
        .eq("archived", false),
      // Same capped spend history as getSpendHistory (app/lib/data/finance.ts)
      // and ordered identically, so the MCP forecast and the app's calendar
      // train the baseline on the same rows when the cap bites.
      supabase
        .from("balance_changes")
        .select("occurred_at, direction, amount, category_id, is_transfer")
        .eq("user_id", userId)
        .gte("occurred_at", historyStart)
        .order("occurred_at", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(2000),
      supabase
        .from("spend_overrides")
        .select("date, amount")
        .eq("user_id", userId)
        .gte("date", today),
    ]);

  const [inventoryRes, usagesRes, shoppingSettingsRes] = await Promise.all([
    supabase
      .from("inventory_items")
      .select(
        "id, name, quantity, unit, reorder_threshold, archived, shopping_pinned, buy_amount, est_price, price_source",
      )
      .eq("user_id", userId)
      .eq("archived", false),
    supabase
      .from("inventory_usages")
      .select("inventory_item_id, amount, period, interval_days")
      .eq("user_id", userId),
    supabase
      .from("user_settings")
      .select("shopping_day")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const accounts = (accountsRes.data ?? []) as {
    balance: number;
    currency: string;
  }[];
  const netWorthToday = accounts.reduce((sum, a) => sum + Number(a.balance), 0);
  const currency = accounts[0]?.currency ?? "USD";

  type ExpenseRow = RecurringRule & {
    id: string;
    name: string;
    category_id: string | null;
  };
  const expenses = ((expensesRes.data ?? []) as ExpenseRow[]).map((row) => ({
    ...row,
    amount: Number(row.amount),
  }));

  const history = ((historyRes.data ?? []) as SpendHistoryRow[]).map((row) => ({
    ...row,
    amount: Number(row.amount),
  }));

  const spendRate = computeSpendRate({
    history,
    rules: expenses.map((e) => ({ amount: e.amount, category_id: e.category_id })),
    today,
  });

  const overrides: Record<string, number> = {};
  for (const row of (overridesRes.data ?? []) as { date: string; amount: number }[]) {
    overrides[row.date] = Number(row.amount);
  }

  type IncomeRow = IncomeSourceRate & { name: string; calendar_id: string | null };
  const incomeSources = ((incomeRes.data ?? []) as IncomeRow[]).map((row) => ({
    ...row,
    hourly_wage: Number(row.hourly_wage),
    tax_rate: Number(row.tax_rate),
    fixed_amount: row.fixed_amount == null ? null : Number(row.fixed_amount),
  }));

  // Reach back ~2 months so a payday inside the window covers its full period.
  // Window bounds are the user's local midnights (zoned), so a shift near the
  // window edge isn't dropped by the UTC/local offset.
  const shiftStart = new Date(
    zonedWallTimeToUtcMs(addDaysKey(today, -62), 0, 0, timeZone),
  );
  const shiftEnd = new Date(
    zonedWallTimeToUtcMs(addDaysKey(endKey, 1), 0, 0, timeZone),
  );
  const hoursBySource: Record<string, Record<string, number>> = {};
  await Promise.all(
    incomeSources
      // Fixed-monthly sources pay a set amount on a day-of-month — no shifts,
      // no Google fetch (matches computeIncomeByDate's fixed-monthly branch).
      .filter((s) => s.calendar_id && s.fixed_amount == null)
      .map((source) =>
        listEventsForCalendar(userId, source.calendar_id as string, {
          timeMin: shiftStart.toISOString(),
          timeMax: shiftEnd.toISOString(),
        })
          .then((events) => {
            hoursBySource[source.id] = eventHoursByDay(events, timeZone);
          })
          .catch(() => {
            hoursBySource[source.id] = {};
          }),
      ),
  );

  const incomeByDate = computeIncomeByDate(incomeSources, hoursBySource, {
    start: addDaysKey(today, 1),
    end: endKey,
  });

  const baselineByDate: Record<string, number> = {};
  for (let d = addDaysKey(today, 1); d <= endKey; d = addDaysKey(d, 1)) {
    baselineByDate[d] = estimatedSpendOn(
      spendRate,
      dailySpendEstimate,
      overrides,
      d,
    );
  }

  // Grocery layer: shopping-list prices snapped to the weekly shopping day,
  // then absorbed into the everyday baseline so trips aren't double-counted.
  const shoppingDay = shoppingSettingsRes.data?.shopping_day;
  let groceryTrips: Record<string, GroceryTrip> = {};
  if (typeof shoppingDay === "number") {
    const shoppingItems = (inventoryRes.data ?? []) as ShoppingListItem[];
    const rulesByItem = new Map<string, UsageRule[]>();
    type UsageRow = UsageRule & { inventory_item_id: string };
    for (const row of (usagesRes.data ?? []) as UsageRow[]) {
      const bucket = rulesByItem.get(row.inventory_item_id);
      if (bucket) bucket.push(row);
      else rulesByItem.set(row.inventory_item_id, [row]);
    }
    groceryTrips = buildGroceriesByDate({
      entries: buildShoppingList({
        items: shoppingItems,
        rulesByItem,
        today,
        horizonDays: horizon,
      }),
      today,
      shoppingDay,
      horizonDays: horizon,
    });
  }
  const groceriesByDate = groceryAmountsByDate(groceryTrips);
  const estimatedSpendByDate = deductBaseline(baselineByDate, groceriesByDate);

  const gridDays: string[] = [];
  for (let d = today; d <= endKey; d = addDaysKey(d, 1)) gridDays.push(d);

  const todayChanges = history
    .filter((row) => row.occurred_at === today)
    .map((row) => ({
      occurred_at: row.occurred_at,
      direction: row.direction,
      amount: row.amount,
      is_transfer: row.is_transfer,
    }));

  const rows = buildDayRows({
    gridDays,
    month: today.slice(0, 7),
    today,
    netWorthToday,
    changes: todayChanges,
    expenses,
    incomeByDate,
    estimatedSpendByDate,
    groceriesByDate,
  });

  return {
    today,
    netWorthToday,
    currency,
    everydaySpend: {
      dailyRate: spendRate.dailyRate,
      sampledWeeks: spendRate.sampledWeeks,
      confident: spendRate.confident,
      manualFallback: dailySpendEstimate,
    },
    groceryTrips,
    days: rows.map((row) => ({
      date: row.dateKey,
      inflow: row.inflow,
      outflow: row.outflow,
      estimatedEverydaySpend: row.estimatedOutflow,
      estimatedGroceries: row.estimatedGroceries,
      projectedNetWorth: Math.round(row.runningTotal * 100) / 100,
    })),
  };
}
