import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import {
  GoogleCalendarConnectionError,
  listCalendars,
  listEventsForCalendar,
  type CalendarListEntry,
} from "@/utils/google/calendar";
import type {
  Account,
  BalanceChange,
  IncomeSource,
  RecurringExpense,
  SpendingCategory,
  SpendLimit,
} from "@/app/_components/finance-types";
import { computeSpendRate } from "@/app/_components/spend-baseline";
import { buildShoppingList } from "@/app/_components/shopping-list";
import {
  buildGroceriesByDate,
  type GroceryTrip,
} from "@/app/_components/grocery-forecast";
import type { UsageRule } from "@/app/_components/inventory-projection";
import {
  getSpendHistory,
  getSpendLimits,
  getSpendOverrides,
} from "@/app/lib/data/finance";
import {
  getInventoryItems,
  getInventoryUsages,
} from "@/app/lib/data/inventory";
import {
  getDailySpendEstimate,
  getShoppingSettings,
  getUserPreferences,
} from "@/app/lib/data/settings";
import { safeTimeZone } from "@/app/_components/date-utils";
import { FinanceClient } from "./finance-client";

type GoogleStatus = "connected" | "connect" | "error";

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentMonth() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  return `${today.getFullYear()}-${month}`;
}

function normalizeMonth(value: string | string[] | undefined) {
  const month = Array.isArray(value) ? value[0] : value;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return currentMonth();
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber < 1 || monthNumber > 12) return currentMonth();
  if (year < 1970 || year > 2100) return currentMonth();
  return month;
}

// Range covering the visible 42-cell grid, extended back to today so the
// forward forecast between today and a future month stays anchored.
function eventRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const start = new Date(gridStart < todayStart ? gridStart : todayStart);
  // Pay periods precede their payday, so reach back far enough to cover the
  // shifts a payday near the window's start is paying for (up to ~monthly + lag).
  start.setDate(start.getDate() - 62);

  return { timeMin: start.toISOString(), timeMax: gridEnd.toISOString() };
}

// Sum timed-event durations (in hours) per local day. All-day events have no
// duration and are ignored.
function hoursByDay(
  events: { start: string; end: string; allDay: boolean }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) {
    if (event.allDay) continue;
    const start = new Date(event.start);
    const end = new Date(event.end);
    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const key = toDateKey(start);
    out[key] = (out[key] ?? 0) + hours;
  }
  return out;
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ fm?: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const financeMonth = normalizeMonth(query.fm);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const timeZone = safeTimeZone((await getUserPreferences(user.id)).timezone);

  const [
    accountsResult,
    categoriesResult,
    changesResult,
    expensesResult,
    incomeResult,
    spendHistory,
    manualSpendEstimate,
    spendOverrides,
    spendLimits,
  ] = await Promise.all([
    supabase
      .from("accounts")
      .select(
        "id, name, type, color, balance, currency, archived, created_at, updated_at",
      )
      .eq("archived", false)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    supabase
      .from("spending_categories")
      .select("id, name, color, archived, created_at")
      .eq("archived", false)
      .order("created_at", { ascending: false }),
    supabase
      .from("balance_changes")
      .select(
        "id, account_id, category_id, direction, amount, note, occurred_at, created_at, source, is_transfer",
      )
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300),
    supabase
      .from("recurring_expenses")
      .select(
        "id, name, amount, category_id, frequency, day_of_month, weekday, interval_days, start_date, archived, created_at",
      )
      .eq("archived", false)
      .order("created_at", { ascending: false }),
    supabase
      .from("income_sources")
      .select(
        "id, name, hourly_wage, tax_rate, calendar_id, color, pay_frequency, anchor_payday, period_start, period_end, fixed_amount, fixed_day, archived, created_at",
      )
      .eq("archived", false)
      .order("created_at", { ascending: false }),
    getSpendHistory(user.id, 90, timeZone),
    getDailySpendEstimate(user.id),
    getSpendOverrides(user.id, timeZone),
    getSpendLimits(user.id),
  ]);

  const incomeSources = (incomeResult.data ?? []) as IncomeSource[];
  const expenses = (expensesResult.data ?? []) as RecurringExpense[];

  // Everyday-spend rate: a predicted minimum — half the median weekly
  // discretionary total over trailing history, with bill payments excluded
  // via the active recurring rules (see spend-baseline.ts for why it's flat
  // and why it's halved).
  const spendRate = computeSpendRate({
    history: spendHistory,
    rules: expenses.map((e) => ({
      amount: Number(e.amount),
      category_id: e.category_id,
    })),
    today: toDateKey(new Date()),
  });

  // Worked hours per income source for the visible window, read from each
  // source's linked Google Calendar. Income = hours * wage * (1 - tax%).
  // Fixed-monthly sources keep their calendar link dormant, so skip the fetch.
  const { timeMin, timeMax } = eventRange(financeMonth);
  const sourcesWithCalendar = incomeSources.filter(
    (s) => s.calendar_id && s.fixed_amount == null,
  );

  function statusFor(error: unknown): GoogleStatus {
    return error instanceof GoogleCalendarConnectionError ? "connect" : "error";
  }

  const [calendarsResult, hoursResults] = await Promise.all([
    listCalendars(user.id)
      .then((cals) => ({ calendars: cals, status: "connected" as GoogleStatus }))
      .catch((error) => ({
        calendars: [] as CalendarListEntry[],
        status: statusFor(error),
      })),
    Promise.all(
      sourcesWithCalendar.map((source) =>
        listEventsForCalendar(user.id, source.calendar_id as string, {
          timeMin,
          timeMax,
        })
          .then((events) => ({
            sourceId: source.id,
            hours: hoursByDay(events),
            status: "connected" as GoogleStatus,
          }))
          .catch((error) => ({
            sourceId: source.id,
            hours: {} as Record<string, number>,
            status: statusFor(error),
          })),
      ),
    ),
  ]);

  const hoursBySource: Record<string, Record<string, number>> = {};
  for (const result of hoursResults) {
    hoursBySource[result.sourceId] = result.hours;
  }

  const statuses: GoogleStatus[] = [
    calendarsResult.status,
    ...hoursResults.map((r) => r.status),
  ];
  const googleStatus: GoogleStatus = statuses.includes("connect")
    ? "connect"
    : statuses.includes("error")
      ? "error"
      : "connected";

  // Projected grocery trips: shopping-list prices snapped to the weekly
  // shopping day (see grocery-forecast.ts). Off until a shopping day is set.
  const [inventoryItems, inventoryUsages, shoppingSettings] = await Promise.all([
    getInventoryItems(user.id),
    getInventoryUsages(user.id),
    getShoppingSettings(user.id),
  ]);
  let groceryTrips: Record<string, GroceryTrip> = {};
  if (shoppingSettings.shoppingDay !== null) {
    const rulesByItem = new Map<string, UsageRule[]>();
    for (const usage of inventoryUsages) {
      const rule: UsageRule = {
        amount: Number(usage.amount),
        period: usage.period,
        interval_days: usage.interval_days,
      };
      const bucket = rulesByItem.get(usage.inventory_item_id);
      if (bucket) bucket.push(rule);
      else rulesByItem.set(usage.inventory_item_id, [rule]);
    }
    const today = toDateKey(new Date());
    groceryTrips = buildGroceriesByDate({
      entries: buildShoppingList({
        items: inventoryItems,
        rulesByItem,
        today,
        horizonDays: 90,
      }),
      today,
      shoppingDay: shoppingSettings.shoppingDay,
      horizonDays: 90,
    });
  }

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 lg:px-12">
      <header className="mb-8 flex items-center justify-between pr-10 lg:pr-0">
        <Link
          href="/"
          className="flex min-h-11 items-center text-label uppercase text-muted hover:text-fg transition-colors"
        >
          ← mindboard
        </Link>
        <h1 className="text-label uppercase text-muted">money</h1>
      </header>

      <FinanceClient
        initialAccounts={(accountsResult.data ?? []) as Account[]}
        initialCategories={(categoriesResult.data ?? []) as SpendingCategory[]}
        initialChanges={(changesResult.data ?? []) as BalanceChange[]}
        expenses={expenses}
        incomeSources={incomeSources}
        financeMonth={financeMonth}
        hoursBySource={hoursBySource}
        googleStatus={googleStatus}
        spendRate={spendRate}
        manualSpendEstimate={manualSpendEstimate}
        spendOverrides={spendOverrides}
        groceryTrips={groceryTrips}
        initialSpendLimits={spendLimits as SpendLimit[]}
      />
    </main>
  );
}
