import { Suspense, cache } from "react";
import { createClient } from "@/utils/supabase/server";
import { DashboardCalendar } from "./_components/dashboard-calendar";
import { Landing } from "./_components/landing/landing";
import { StreamClient } from "./_components/stream-client";
import {
  formatClock12,
  formatLongWeekdayMonthDay,
  safeTimeZone,
  todayISO,
} from "./_components/date-utils";
import type {
  SpendAccount,
  SpendCategory,
} from "./_components/stream-sheets";
import {
  currentMonth,
  getDashboardData,
  getOpenTasks,
  normalizeDay,
  normalizeMonth,
} from "./lib/data/dashboard";
import {
  getAccounts,
  getActiveRecurringExpenses,
  getBalanceChangesOn,
} from "./lib/data/finance";
import { getInventoryItems, getInventoryUsages } from "./lib/data/inventory";
import {
  getMindspaceShareBar,
  type MindshareBar,
} from "./lib/mindspace/share-bar";
import {
  getActiveRecurringTasks,
  getRecurringCompletions,
  getRecurringSlots,
} from "./lib/data/recurring-tasks";
import { getUserPreferences } from "./lib/data/settings";
import {
  occurrenceBusyEvents,
  slotBusyEvents,
  taskRuleLandsOn,
} from "./lib/recurrence";
import { financeSnapshot } from "./lib/snapshots/finance";
import { planUntimedOccurrences } from "./lib/snapshots/gap-plan";
import {
  freeGaps,
  freeIntervalsForDay,
  scheduleSnapshot,
  type FreeGap,
} from "./lib/snapshots/schedule";
import {
  addDaysKey,
  streamSnapshot,
  type StreamBillInput,
  type StreamSnapshot,
} from "./lib/snapshots/stream";
import { zonedWallTimeToUtcMs } from "./lib/snapshots/zoned-time";
import type { UsageRule } from "./_components/inventory-projection";

const getStreamData = cache(
  async (
    userId: string,
  ): Promise<{
    snapshot: StreamSnapshot;
    accounts: SpendAccount[];
    categories: SpendCategory[];
    gaps: FreeGap[];
    groups: { id: string; name: string; color: string }[];
    weekDone: number;
    weekMissed: number;
    mindshare: MindshareBar | null;
  }> => {
    const prefs = await getUserPreferences(userId);
    const timeZone = safeTimeZone(prefs.timezone);
    const today = todayISO(timeZone);
    const now = new Date();
    const supabase = await createClient();

    // Monday-start week in the user's zone, as a UTC instant to compare against
    // the timestamptz completed_at/missed_at columns.
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    const weekStart = addDaysKey(today, -((dow + 6) % 7));
    const weekStartIso = new Date(
      zonedWallTimeToUtcMs(weekStart, 0, 0, timeZone),
    ).toISOString();

    const [
      dash,
      tasks,
      accounts,
      recurringExpenses,
      recurringTasks,
      recurringCompletions,
      recurringSlots,
      items,
      usages,
      todayChanges,
      goalsResult,
      logResult,
      proposalsResult,
      categoriesResult,
      weekDoneResult,
      weekMissedResult,
      mindshare,
    ] = await Promise.all([
      getDashboardData(userId, currentMonth(timeZone)),
      getOpenTasks(userId),
      getAccounts(userId),
      getActiveRecurringExpenses(userId),
      getActiveRecurringTasks(userId),
      getRecurringCompletions(userId, today, today),
      getRecurringSlots(userId, today, addDaysKey(today, 1)),
      getInventoryItems(userId),
      getInventoryUsages(userId),
      getBalanceChangesOn(userId, today),
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
      supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .gte("completed_at", weekStartIso),
      supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .gte("missed_at", weekStartIso),
      getMindspaceShareBar(userId),
    ]);

    const finance = financeSnapshot({
      accounts,
      todayChanges,
      recurringExpenses,
      today,
    });
    // Timed recurring occurrences count as busy time in the free-hours math
    // and the schedule chips, alongside real Google events. An approved slot
    // overrides its rule's due_time for that day: the occurrence is skipped and
    // the slot supplies the commitment instead (never double-counted).
    const slotKeys = new Set(
      recurringSlots.map((s) => `${s.rule_id}:${s.occurred_on}`),
    );
    const busyEvents = [
      ...dash.events,
      ...occurrenceBusyEvents(
        recurringTasks,
        [today, addDaysKey(today, 1)],
        slotKeys,
        timeZone,
      ),
      ...slotBusyEvents(recurringSlots, recurringTasks, timeZone),
    ];
    const schedule = scheduleSnapshot({
      events: busyEvents,
      now,
      wakeStartHour: prefs.wake_start_hour,
      wakeEndHour: prefs.wake_end_hour,
      timeZone,
    });
    const gaps = freeGaps({
      events: busyEvents,
      now,
      wakeStartHour: prefs.wake_start_hour,
      wakeEndHour: prefs.wake_end_hour,
      timeZone,
    });

    // Advisory soft placement: virtually drop today's untimed, not-done
    // recurring occurrences into today's free gaps. Display only — never fed
    // back into the busy/free math above.
    const completedRecurringToday = new Set(
      recurringCompletions.map((c) => c.rule_id),
    );
    // Rules with an approved slot for today are committed, not soft-placed: keep
    // them out of the untimed planner (busyEvents already counts their slot).
    const slotRuleIdsToday = new Set(
      recurringSlots.filter((s) => s.occurred_on === today).map((s) => s.rule_id),
    );
    const slotStartByRule = new Map(
      recurringSlots
        .filter((s) => s.occurred_on === today)
        .map((s) => [s.rule_id, s.start_time.slice(0, 5)]),
    );
    const todayDate = new Date(`${today}T00:00:00`);
    const untimedTodayRules = recurringTasks.filter(
      (r) =>
        r.due_time === null &&
        taskRuleLandsOn(r, todayDate) &&
        !completedRecurringToday.has(r.id) &&
        !slotRuleIdsToday.has(r.id),
    );
    const plannedStartByRule = new Map(
      planUntimedOccurrences({
        rules: untimedTodayRules.map((r) => ({
          id: r.id,
          priority: r.priority,
          duration_min: r.duration_min,
          created_at: r.created_at,
        })),
        intervals: freeIntervalsForDay({
          events: busyEvents,
          dateKey: today,
          now,
          wakeStartHour: prefs.wake_start_hour,
          wakeEndHour: prefs.wake_end_hour,
          timeZone,
        }),
        dateKey: today,
      }).map((slot) => [slot.ruleId, slot.start]),
    );

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
      recurringTasks,
      completedRecurringToday,
      plannedStartByRule,
      slotStartByRule,
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
      timeZone,
      freeHoursToday: schedule.freeHoursToday,
      todayDelta: finance.todayDelta,
      currency: finance.currency,
      maxTasks: prefs.stream_max_tasks,
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
      groups: dash.groups,
      weekDone: weekDoneResult.count ?? 0,
      weekMissed: weekMissedResult.count ?? 0,
      mindshare,
    };
  },
);

async function StreamSection({ userId }: { userId: string }) {
  const [
    {
      snapshot,
      accounts,
      categories,
      gaps,
      groups,
      weekDone,
      weekMissed,
      mindshare,
    },
    prefs,
  ] = await Promise.all([getStreamData(userId), getUserPreferences(userId)]);
  const timeZone = safeTimeZone(prefs.timezone);
  const now = new Date();

  return (
    <StreamClient
      snapshot={snapshot}
      accounts={accounts}
      categories={categories}
      gaps={gaps}
      groups={groups}
      weekDone={weekDone}
      weekMissed={weekMissed}
      mindshare={mindshare}
      todayLabel={formatLongWeekdayMonthDay(now, timeZone).toLowerCase()}
      clockLabel={formatClock12(now, timeZone)}
    />
  );
}

// Desktop-only right pane: the same week calendar /week serves, sharing the
// stream's cached getDashboardData/getUserPreferences promises for the
// current month.
async function WeekPaneSection({
  userId,
  month,
  selectedDay,
}: {
  userId: string;
  month: string;
  selectedDay: string | null;
}) {
  const [
    {
      calendarTasks,
      events,
      finance,
      calendarStatus,
      calendarLinks,
      recurringTasks,
      recurringCompletions,
      recurringSlots,
    },
    prefs,
  ] = await Promise.all([
    getDashboardData(userId, month),
    getUserPreferences(userId),
  ]);

  const timeZone = safeTimeZone(prefs.timezone);
  const today = todayISO(timeZone);
  const slotKeys = new Set(
    recurringSlots.map((s) => `${s.rule_id}:${s.occurred_on}`),
  );
  const schedule = scheduleSnapshot({
    events: [
      ...events,
      ...occurrenceBusyEvents(
        recurringTasks,
        [today, addDaysKey(today, 1)],
        slotKeys,
        timeZone,
      ),
      ...slotBusyEvents(recurringSlots, recurringTasks, timeZone),
    ],
    now: new Date(),
    wakeStartHour: prefs.wake_start_hour,
    wakeEndHour: prefs.wake_end_hour,
    timeZone,
  });

  return (
    <DashboardCalendar
      key={`${month}:${selectedDay ?? ""}`}
      month={month}
      tasks={calendarTasks}
      events={events}
      finance={finance}
      status={calendarStatus}
      calendarLinks={calendarLinks}
      initialView="week"
      selectedDay={selectedDay}
      wakeStartHour={prefs.wake_start_hour}
      wakeEndHour={prefs.wake_end_hour}
      scheduleVitals={schedule}
      basePath="/"
      recurringTasks={recurringTasks}
      recurringCompletions={recurringCompletions}
      recurringSlots={recurringSlots}
    />
  );
}

function WeekPaneSkeleton() {
  return (
    <div
      className="animate-pulse glass-panel p-3 min-h-[calc(100vh-4rem)]"
      aria-hidden
    >
      <div className="h-3 w-16 bg-card rounded-md mb-2" />
      <div className="h-6 w-32 bg-card rounded-md mb-6" />
      <div className="h-full max-h-[36rem] bg-card rounded-panel" />
    </div>
  );
}

function StreamSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden>
      <div className="flex items-center justify-between mb-8">
        <div className="h-4 w-40 bg-card rounded-md" />
        <div className="h-4 w-48 bg-card rounded-md" />
      </div>
      {[3, 2, 2].map((rows, section) => (
        <div key={section} className="mb-8">
          <div className="h-3 w-full bg-card rounded-md mb-2" />
          <div className="space-y-px">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="h-16 bg-card rounded-panel" />
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
  searchParams: Promise<{
    m?: string | string[] | undefined;
    d?: string | string[] | undefined;
  }>;
}) {
  const query = await searchParams;
  const selectedDay = normalizeDay(query.d);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <Landing />;
  }

  // The selected day owns the month it lives in, so its week's data loads.
  // Resolved after auth because the default month is the USER'S current month:
  // on the process clock the last evening of a month fetched the next one.
  // getUserPreferences is cache()-deduped, so WeekPaneSection reuses this read.
  const month = selectedDay
    ? selectedDay.slice(0, 7)
    : normalizeMonth(
        query.m,
        safeTimeZone((await getUserPreferences(user.id)).timezone),
      );

  return (
    <main className="min-h-screen px-5 pt-6 pb-64 mx-auto max-w-2xl lg:max-w-none lg:px-10 2xl:max-w-[110rem]">
      <div className="lg:grid lg:grid-cols-2 lg:gap-12 lg:items-start">
        <div className="min-w-0 w-full max-w-2xl mx-auto">
          <Suspense fallback={<StreamSkeleton />}>
            <StreamSection userId={user.id} />
          </Suspense>
        </div>
        <div className="hidden lg:block min-w-0" data-tour="calendar-pane">
          <Suspense fallback={<WeekPaneSkeleton />}>
            <WeekPaneSection
              userId={user.id}
              month={month}
              selectedDay={selectedDay}
            />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
