import { Suspense, cache } from "react";
import { createClient } from "@/utils/supabase/server";
import { DashboardCalendar } from "./_components/dashboard-calendar";
import { GetStartedScreen } from "./_components/get-started-screen";
import { StreamClient } from "./_components/stream-client";
import { formatLongWeekdayMonthDay, todayISO } from "./_components/date-utils";
import type {
  SpendAccount,
  SpendCategory,
} from "./_components/stream-sheets";
import {
  currentMonth,
  getDashboardData,
  getOpenTasks,
  normalizeMonth,
} from "./lib/data/dashboard";
import {
  getAccounts,
  getActiveRecurringExpenses,
  getBalanceChangesOn,
} from "./lib/data/finance";
import { getInventoryItems, getInventoryUsages } from "./lib/data/inventory";
import { getUserPreferences } from "./lib/data/settings";
import { financeSnapshot } from "./lib/snapshots/finance";
import {
  freeGaps,
  scheduleSnapshot,
  type FreeGap,
} from "./lib/snapshots/schedule";
import {
  streamSnapshot,
  type StreamBillInput,
  type StreamSnapshot,
} from "./lib/snapshots/stream";
import type { UsageRule } from "./_components/inventory-projection";

const getStreamData = cache(
  async (
    userId: string,
  ): Promise<{
    snapshot: StreamSnapshot;
    accounts: SpendAccount[];
    categories: SpendCategory[];
    gaps: FreeGap[];
  }> => {
    const today = todayISO();
    const now = new Date();
    const supabase = await createClient();

    const [
      dash,
      tasks,
      accounts,
      recurringExpenses,
      items,
      usages,
      todayChanges,
      prefs,
      goalsResult,
      logResult,
      proposalsResult,
      categoriesResult,
    ] = await Promise.all([
      getDashboardData(userId, currentMonth()),
      getOpenTasks(userId),
      getAccounts(userId),
      getActiveRecurringExpenses(userId),
      getInventoryItems(userId),
      getInventoryUsages(userId),
      getBalanceChangesOn(userId, today),
      getUserPreferences(userId),
      supabase
        .from("goals")
        .select("id, title, status, created_at")
        .eq("status", "active"),
      supabase
        .from("daily_logs")
        .select("mood")
        .eq("log_date", today)
        .maybeSingle(),
      supabase
        .from("ai_audit_log")
        .select("id", { count: "exact", head: true })
        .eq("status", "proposed"),
      supabase
        .from("spending_categories")
        .select("id, name, color")
        .order("name", { ascending: true }),
    ]);

    const finance = financeSnapshot({
      accounts,
      todayChanges,
      recurringExpenses,
      today,
    });
    const schedule = scheduleSnapshot({
      events: dash.events,
      now,
      wakeStartHour: prefs.wake_start_hour,
      wakeEndHour: prefs.wake_end_hour,
    });
    const gaps = freeGaps({
      events: dash.events,
      now,
      wakeStartHour: prefs.wake_start_hour,
      wakeEndHour: prefs.wake_end_hour,
    });

    const bills: StreamBillInput[] = recurringExpenses.map((expense) => ({
      id: expense.id,
      name: expense.name,
      amount: Number(expense.amount),
      frequency: expense.frequency,
      day_of_month: expense.day_of_month,
      weekday: expense.weekday,
      interval_days: expense.interval_days,
      start_date: expense.start_date,
    }));

    const usagesByItem: Record<string, UsageRule[]> = {};
    for (const usage of usages) {
      const list = usagesByItem[usage.inventory_item_id] ?? [];
      list.push({
        amount: Number(usage.amount),
        period: usage.period,
        interval_days: usage.interval_days,
      });
      usagesByItem[usage.inventory_item_id] = list;
    }

    const log = logResult.data as { mood: number | null } | null;

    const snapshot = streamSnapshot({
      today,
      now,
      tasks,
      events: dash.events.map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
      })),
      bills,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        quantity: Number(item.quantity),
        unit: item.unit,
        reorder_threshold: item.reorder_threshold,
        priority: item.priority,
      })),
      usagesByItem,
      goals: (goalsResult.data ?? []) as {
        id: string;
        title: string;
        status: string;
        created_at: string;
      }[],
      hasDailyLogToday: log !== null,
      moodToday: log?.mood ?? null,
      pendingProposals: proposalsResult.count ?? 0,
      wakeEndHour: prefs.wake_end_hour,
      freeHoursToday: schedule.freeHoursToday,
      todayDelta: finance.todayDelta,
      currency: finance.currency,
    });

    return {
      snapshot,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        balance: Number(a.balance),
        currency: a.currency,
      })),
      categories: (categoriesResult.data ?? []) as SpendCategory[],
      gaps,
    };
  },
);

async function StreamSection({ userId }: { userId: string }) {
  const { snapshot, accounts, categories, gaps } = await getStreamData(userId);
  const now = new Date();
  const clockLabel = `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;

  return (
    <StreamClient
      snapshot={snapshot}
      accounts={accounts}
      categories={categories}
      gaps={gaps}
      todayLabel={formatLongWeekdayMonthDay(now).toLowerCase()}
      clockLabel={clockLabel}
    />
  );
}

// Desktop-only right pane: the same week calendar /week serves, sharing the
// stream's cached getDashboardData/getUserPreferences promises for the
// current month.
async function WeekPaneSection({
  userId,
  month,
}: {
  userId: string;
  month: string;
}) {
  const [
    { calendarTasks, events, finance, calendarStatus, calendarLinks },
    prefs,
  ] = await Promise.all([
    getDashboardData(userId, month),
    getUserPreferences(userId),
  ]);

  const schedule = scheduleSnapshot({
    events,
    now: new Date(),
    wakeStartHour: prefs.wake_start_hour,
    wakeEndHour: prefs.wake_end_hour,
  });

  return (
    <DashboardCalendar
      key={month}
      month={month}
      tasks={calendarTasks}
      events={events}
      finance={finance}
      status={calendarStatus}
      calendarLinks={calendarLinks}
      initialView="week"
      wakeStartHour={prefs.wake_start_hour}
      wakeEndHour={prefs.wake_end_hour}
      scheduleVitals={schedule}
      basePath="/"
    />
  );
}

function WeekPaneSkeleton() {
  return (
    <div
      className="animate-pulse border border-line bg-popover p-3 min-h-[calc(100vh-4rem)]"
      aria-hidden
    >
      <div className="h-3 w-16 bg-card mb-2" />
      <div className="h-6 w-32 bg-card mb-6" />
      <div className="h-full max-h-[36rem] bg-card" />
    </div>
  );
}

function StreamSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden>
      <div className="flex items-center justify-between mb-8">
        <div className="h-4 w-40 bg-card" />
        <div className="h-4 w-48 bg-card" />
      </div>
      {[3, 2, 2].map((rows, section) => (
        <div key={section} className="mb-8">
          <div className="h-3 w-full bg-card mb-2" />
          <div className="space-y-px">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="h-16 bg-card" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ m?: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const month = normalizeMonth(query.m);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <GetStartedScreen />;
  }

  return (
    <main className="min-h-screen px-5 pt-6 pb-64 mx-auto max-w-2xl lg:max-w-none lg:px-10 2xl:max-w-[110rem]">
      <div className="lg:grid lg:grid-cols-2 lg:gap-12 lg:items-start">
        <div className="min-w-0 w-full max-w-2xl mx-auto">
          <Suspense fallback={<StreamSkeleton />}>
            <StreamSection userId={user.id} />
          </Suspense>
        </div>
        <div className="hidden lg:block min-w-0">
          <Suspense fallback={<WeekPaneSkeleton />}>
            <WeekPaneSection userId={user.id} month={month} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
