import { Suspense, cache } from "react";
import { createClient } from "@/utils/supabase/server";
import { DashboardCalendar } from "./_components/dashboard-calendar";
import { GetStartedScreen } from "./_components/get-started-screen";
import { WelcomeTour } from "./_components/welcome-tour";
import { TodayClient } from "./_components/today-client";
import { formatLongWeekdayMonthDay, todayISO } from "./_components/date-utils";
import { getDashboardData, normalizeMonth } from "./lib/data/dashboard";
import {
  getAccounts,
  getActiveRecurringExpenses,
  getBalanceChangesOn,
} from "./lib/data/finance";
import { getInventoryItems, getInventoryUsages } from "./lib/data/inventory";
import { getUserPreferences } from "./lib/data/settings";
import { financeSnapshot } from "./lib/snapshots/finance";
import { inventorySnapshot } from "./lib/snapshots/inventory";
import { tasksSnapshot } from "./lib/snapshots/tasks";
import { scheduleSnapshot } from "./lib/snapshots/schedule";
import { VitalsStrip } from "./_components/vitals-strip";

// The vitals strip is anchored to *today*, independent of which month the
// calendar is showing. It reuses the cached dashboard read for tasks/events
// (so no extra Supabase or Google round-trips on the common current-month view)
// and adds the reads the dashboard doesn't already make: accounts, recurring
// expenses, inventory, and today's balance changes.
const getVitalsData = cache(async (userId: string, month: string) => {
  const today = todayISO();
  const [dash, accounts, recurringExpenses, items, usages, todayChanges, prefs] =
    await Promise.all([
      getDashboardData(userId, month),
      getAccounts(userId),
      getActiveRecurringExpenses(userId),
      getInventoryItems(userId),
      getInventoryUsages(userId),
      getBalanceChangesOn(userId, today),
      getUserPreferences(userId),
    ]);

  return {
    finance: financeSnapshot({ accounts, todayChanges, recurringExpenses, today }),
    tasks: tasksSnapshot(dash.tasks, today),
    schedule: scheduleSnapshot({
      events: dash.events,
      now: new Date(),
      wakeStartHour: prefs.wake_start_hour,
      wakeEndHour: prefs.wake_end_hour,
    }),
    inventory: inventorySnapshot({ items, usages, today }),
  };
});

async function VitalsSection({
  userId,
  month,
}: {
  userId: string;
  month: string;
}) {
  const { finance, tasks, schedule, inventory } = await getVitalsData(
    userId,
    month,
  );
  return (
    <VitalsStrip
      finance={finance}
      tasks={tasks}
      schedule={schedule}
      inventory={inventory}
    />
  );
}

function VitalsSkeleton() {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 animate-pulse" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex-shrink-0 w-36 h-[4.75rem] border border-line bg-card"
        />
      ))}
    </div>
  );
}

async function TodaySection({
  userId,
  month,
}: {
  userId: string;
  month: string;
}) {
  const { tasks, groups, events, calendarLinks } = await getDashboardData(
    userId,
    month,
  );
  return (
    <TodayClient
      initial={tasks}
      groups={groups}
      events={events}
      calendarLinks={calendarLinks}
    />
  );
}

async function CalendarSection({
  userId,
  month,
}: {
  userId: string;
  month: string;
}) {
  const { calendarTasks, events, finance, calendarStatus, calendarLinks } =
    await getDashboardData(userId, month);
  return (
    <DashboardCalendar
      key={month}
      month={month}
      tasks={calendarTasks}
      events={events}
      finance={finance}
      status={calendarStatus}
      calendarLinks={calendarLinks}
    />
  );
}

function TodaySkeleton() {
  return (
    <div className="pb-4 animate-pulse" aria-hidden>
      <div className="h-2.5 w-16 bg-line mb-3" />
      <div className="space-y-px">
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
      </div>
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="border border-line p-4 space-y-3 animate-pulse" aria-hidden>
      <div className="flex items-center justify-between">
        <div className="h-3 w-32 bg-line" />
        <div className="h-3 w-16 bg-line" />
      </div>
      <div className="grid grid-cols-7 gap-px">
        {Array.from({ length: 42 }).map((_, i) => (
          <div key={i} className="aspect-square bg-card" />
        ))}
      </div>
    </div>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ m?: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const calendarMonth = normalizeMonth(query.m);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <GetStartedScreen />;
  }

  const todayLabel = formatLongWeekdayMonthDay(new Date());

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 lg:px-12">
      <div className="mb-8">
        <Suspense fallback={<VitalsSkeleton />}>
          <VitalsSection userId={user.id} month={calendarMonth} />
        </Suspense>
      </div>
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-24 lg:items-start">
        <section className="min-w-0">
          <header className="mb-8">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              {todayLabel}
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-fg mt-1">
              today
            </h1>
          </header>

          <Suspense fallback={<TodaySkeleton />}>
            <TodaySection userId={user.id} month={calendarMonth} />
          </Suspense>
        </section>

        <aside className="min-w-0 lg:sticky lg:top-8">
          <Suspense fallback={<CalendarSkeleton />}>
            <CalendarSection userId={user.id} month={calendarMonth} />
          </Suspense>
        </aside>
      </div>
      <WelcomeTour />
    </main>
  );
}
