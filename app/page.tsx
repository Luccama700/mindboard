import { Suspense, cache } from "react";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import {
  GoogleCalendarConnectionError,
  listEvents,
  type CalendarEvent,
} from "@/utils/google/calendar";
import {
  DashboardCalendar,
  type FinanceChange,
} from "./_components/dashboard-calendar";
import { GetStartedScreen } from "./_components/get-started-screen";
import { SettingsPanel } from "./_components/settings-panel";
import { WelcomeTour } from "./_components/welcome-tour";
import { signOut } from "./actions/auth";
import { TodayClient } from "./_components/today-client";
import { formatLongWeekdayMonthDay, todayISO } from "./_components/date-utils";
import type { TaskWithGroup } from "./_components/types";
import {
  getAccounts,
  getActiveRecurringExpenses,
  getBalanceChangesOn,
} from "./lib/data/finance";
import { getInventoryItems, getInventoryUsages } from "./lib/data/inventory";
import { financeSnapshot } from "./lib/snapshots/finance";
import { inventorySnapshot } from "./lib/snapshots/inventory";
import { tasksSnapshot } from "./lib/snapshots/tasks";
import { scheduleSnapshot } from "./lib/snapshots/schedule";
import { VitalsStrip } from "./_components/vitals-strip";

type RawTask = {
  id: string;
  title: string;
  due_date: string | null;
  status: "todo" | "doing" | "done";
  priority: "low" | "med" | "high";
  notes: string | null;
  group_id: string | null;
  created_at: string;
  completed_at: string | null;
  groups: { name: string; color: string } | { name: string; color: string }[] | null;
};

type CalendarLink = {
  groupName: string;
  groupColor: string;
};

type RelRecord<T> = T | T[] | null;

type RawChange = {
  id: string;
  direction: "in" | "out";
  amount: number;
  occurred_at: string;
  accounts: RelRecord<{ name: string; color: string; currency: string }>;
  spending_categories: RelRecord<{ name: string; color: string }>;
};

function firstRel<T>(rel: RelRecord<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);
}

function mapFinance(rows: RawChange[]): FinanceChange[] {
  return rows.map((row) => {
    const account = firstRel(row.accounts);
    const category = firstRel(row.spending_categories);
    const isOut = row.direction === "out";
    return {
      id: row.id,
      occurredAt: row.occurred_at,
      title: isOut ? (category?.name ?? "uncategorized") : "income",
      color: isOut
        ? (category?.color ?? account?.color ?? "#6b6b6b")
        : (account?.color ?? "#b5ff3c"),
      direction: row.direction,
      amount: Number(row.amount),
      currency: account?.currency ?? "USD",
      account: account?.name ?? "account",
    };
  });
}

type EventsBundle = {
  events: CalendarEvent[];
  status: "connected" | "connect" | "error";
};

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

function calendarRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());

  const end = new Date(start);
  end.setDate(start.getDate() + 42);

  return {
    startDate: toDateKey(start),
    endDate: toDateKey(end),
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

function mapTasks(rawTasks: RawTask[]): TaskWithGroup[] {
  return rawTasks.map((row) => {
    const groupRecord = Array.isArray(row.groups)
      ? (row.groups[0] ?? null)
      : (row.groups ?? null);
    return {
      id: row.id,
      title: row.title,
      due_date: row.due_date,
      status: row.status,
      priority: row.priority,
      notes: row.notes,
      group_id: row.group_id,
      created_at: row.created_at,
      completed_at: row.completed_at,
      group_name: groupRecord?.name ?? null,
      group_color: groupRecord?.color ?? null,
    };
  });
}

const getDashboardData = cache(async (userId: string, month: string) => {
  const { startDate, endDate, timeMin, timeMax } = calendarRange(month);
  const supabase = await createClient();

  const eventsPromise: Promise<EventsBundle> = listEvents(userId, {
    timeMin,
    timeMax,
  })
    .then<EventsBundle>((events) => ({ events, status: "connected" }))
    .catch<EventsBundle>((error) => ({
      events: [],
      status:
        error instanceof GoogleCalendarConnectionError ? "connect" : "error",
    }));

  const [tasksResponse, groupsResponse, changesResponse, eventsResult] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, title, due_date, status, priority, notes, group_id, created_at, completed_at, groups(name, color)",
        )
        .neq("status", "done")
        .not("due_date", "is", null),
      supabase
        .from("groups")
        .select("id, name, color, google_calendar_id")
        .eq("archived", false)
        .order("created_at", { ascending: false }),
      supabase
        .from("balance_changes")
        .select(
          "id, direction, amount, occurred_at, accounts(name, color, currency), spending_categories(name, color)",
        )
        .gte("occurred_at", startDate)
        .lt("occurred_at", endDate),
      eventsPromise,
    ]);

  const tasks = mapTasks((tasksResponse.data ?? []) as RawTask[]);
  const groupsRaw = (groupsResponse.data ?? []) as {
    id: string;
    name: string;
    color: string;
    google_calendar_id: string | null;
  }[];
  const groups = groupsRaw.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
  }));

  const calendarLinks: Record<string, CalendarLink> = {};
  for (const g of groupsRaw) {
    if (g.google_calendar_id) {
      calendarLinks[g.google_calendar_id] = {
        groupName: g.name,
        groupColor: g.color,
      };
    }
  }

  const calendarTasks = tasks.filter(
    (task) =>
      task.due_date && task.due_date >= startDate && task.due_date < endDate,
  );

  const finance = mapFinance((changesResponse.data ?? []) as RawChange[]);

  return {
    tasks,
    groups,
    calendarLinks,
    calendarTasks,
    finance,
    events: eventsResult.events,
    calendarStatus: eventsResult.status,
  };
});

// The vitals strip is anchored to *today*, independent of which month the
// calendar is showing. It reuses the cached dashboard read for tasks/events
// (so no extra Supabase or Google round-trips on the common current-month view)
// and adds the reads the dashboard doesn't already make: accounts, recurring
// expenses, inventory, and today's balance changes.
const getVitalsData = cache(async (userId: string, month: string) => {
  const today = todayISO();
  const [dash, accounts, recurringExpenses, items, usages, todayChanges] =
    await Promise.all([
      getDashboardData(userId, month),
      getAccounts(userId),
      getActiveRecurringExpenses(userId),
      getInventoryItems(userId),
      getInventoryUsages(userId),
      getBalanceChangesOn(userId, today),
    ]);

  return {
    finance: financeSnapshot({ accounts, todayChanges, recurringExpenses, today }),
    tasks: tasksSnapshot(dash.tasks, today),
    schedule: scheduleSnapshot({ events: dash.events, now: new Date() }),
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
    <main className="min-h-screen px-5 pt-8 pb-56 lg:px-12">
      <div className="mb-8">
        <Suspense fallback={<VitalsSkeleton />}>
          <VitalsSection userId={user.id} month={calendarMonth} />
        </Suspense>
      </div>
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-24 lg:items-start">
        <section className="min-w-0">
          <header className="flex items-start justify-between mb-8">
            <div>
              <p className="text-[10px] tracking-widest uppercase text-muted">
                {todayLabel}
              </p>
              <h1 className="text-3xl font-bold tracking-tight text-fg mt-1">
                today
              </h1>
            </div>
            <div className="flex flex-col items-end gap-3 pt-1">
              <div className="flex items-center gap-2">
                <SettingsPanel />
                <Link
                  href="/brain"
                  className="text-xs tracking-widest uppercase px-3 py-2 border border-fg text-fg hover:bg-fg hover:text-page transition-colors"
                >
                  brain →
                </Link>
                <Link
                  href="/finance"
                  className="text-xs tracking-widest uppercase px-3 py-2 border border-fg text-fg hover:bg-fg hover:text-page transition-colors"
                >
                  finance →
                </Link>
                <Link
                  href="/inventory"
                  className="text-xs tracking-widest uppercase px-3 py-2 border border-fg text-fg hover:bg-fg hover:text-page transition-colors"
                >
                  inventory →
                </Link>
                <Link
                  href="/groups"
                  className="text-xs tracking-widest uppercase px-3 py-2 border border-fg text-fg hover:bg-fg hover:text-page transition-colors"
                >
                  groups →
                </Link>
              </div>
              <form action={signOut}>
                <button
                  type="submit"
                  className="text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
                >
                  sign out
                </button>
              </form>
            </div>
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
