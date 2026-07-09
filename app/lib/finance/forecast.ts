import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listEventsForCalendar } from "@/utils/google/calendar";
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
  days: ForecastDay[];
};

// Timed-event durations per local day (mirror of app/finance/page.tsx hoursByDay).
function eventHoursByDay(
  events: { start: string; end: string; allDay: boolean }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) {
    if (event.allDay) continue;
    const start = new Date(event.start);
    const end = new Date(event.end);
    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const month = String(start.getMonth() + 1).padStart(2, "0");
    const day = String(start.getDate()).padStart(2, "0");
    const key = `${start.getFullYear()}-${month}-${day}`;
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
}): Promise<FinanceForecast> {
  const { supabase, userId, today, dailySpendEstimate } = params;
  const horizon = Math.min(Math.max(1, Math.trunc(params.days)), 90);
  const endKey = addDaysKey(today, horizon);
  const historyStart = addDaysKey(today, -90);

  const [accountsRes, expensesRes, incomeRes, historyRes, overridesRes] =
    await Promise.all([
      supabase
        .from("accounts")
        .select("id, balance, currency")
        .eq("user_id", userId)
        .eq("archived", false),
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
      supabase
        .from("balance_changes")
        .select("occurred_at, direction, amount, category_id, is_transfer")
        .eq("user_id", userId)
        .gte("occurred_at", historyStart)
        .limit(2000),
      supabase
        .from("spend_overrides")
        .select("date, amount")
        .eq("user_id", userId)
        .gte("date", today),
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
  const shiftStart = new Date(`${addDaysKey(today, -62)}T00:00:00`);
  const shiftEnd = new Date(`${endKey}T00:00:00`);
  shiftEnd.setDate(shiftEnd.getDate() + 1);
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
            hoursBySource[source.id] = eventHoursByDay(events);
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

  const estimatedSpendByDate: Record<string, number> = {};
  for (let d = addDaysKey(today, 1); d <= endKey; d = addDaysKey(d, 1)) {
    estimatedSpendByDate[d] = estimatedSpendOn(
      spendRate,
      dailySpendEstimate,
      overrides,
      d,
    );
  }

  const gridDays: string[] = [];
  for (let d = today; d <= endKey; d = addDaysKey(d, 1)) gridDays.push(d);

  const todayChanges = history
    .filter((row) => row.occurred_at === today)
    .map((row) => ({
      occurred_at: row.occurred_at,
      direction: row.direction,
      amount: row.amount,
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
    days: rows.map((row) => ({
      date: row.dateKey,
      inflow: row.inflow,
      outflow: row.outflow,
      estimatedEverydaySpend: row.estimatedOutflow,
      projectedNetWorth: Math.round(row.runningTotal * 100) / 100,
    })),
  };
}
