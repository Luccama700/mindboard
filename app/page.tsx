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
  getCandidates,
  getLatestInteractions,
  getPeople,
} from "./lib/data/people";
import { computePeopleAttention } from "./lib/snapshots/people";
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
import { ownerUserId } from "./lib/mcp/config";
import {
  occurrenceBusyEvents,
  slotBusyEvents,
  taskRuleLandsOn,
} from "./lib/recurrence";
import { financeSnapshot } from "./lib/snapshots/finance";
import { planSubtasks, planUntimedOccurrences } from "./lib/snapshots/gap-plan";
import {
  freeGaps,
  freeIntervalsForDay,
  scheduleSnapshot,
  type FreeGap,
  type ScheduleEvent,
} from "./lib/snapshots/schedule";
import {
  addDaysKey,
  streamSnapshot,
  type StreamBillInput,
  type StreamSnapshot,
} from "./lib/snapshots/stream";
import { zonedWallTimeToUtcMs } from "./lib/snapshots/zoned-time";
import type { UsageRule } from "./_components/inventory-projection";

// How far ahead the dashboard plans decomposed children (bounded further by
// the days its calendar fetch actually covers).
const PLAN_HORIZON_DAYS = 30;

// Time-blocked tasks as busy spans, in the user's zone (the week view's
// busyFromDayItems does the same from CalendarItems).
function timedTaskBusyEvents(
  tasks: { title: string; due_date: string | null; due_time: string | null; duration_min: number | null; estimated_minutes: number | null }[],
  timeZone: string | null,
): ScheduleEvent[] {
  const out: ScheduleEvent[] = [];
  for (const t of tasks) {
    if (!t.due_date || !t.due_time) continue;
    const [h, m] = t.due_time.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    const startMs = zonedWallTimeToUtcMs(t.due_date, h, m, timeZone);
    const endMs = startMs + (t.duration_min ?? t.estimated_minutes ?? 30) * 60_000;
    out.push({
      summary: t.title,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      allDay: false,
    });
  }
  return out;
}

const getStreamData = cache(
  async (
    userId: string,
  ): Promise<{
    // The USER'S day (user_settings.timezone). The stream is classified
    // server-side against it, so the client must compare against the same key
    // rather than re-deriving one from the device clock.
    today: string;
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
      people,
      latestInteractions,
      newCandidates,
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
      getRecurringSlots(userId, today, addDaysKey(today, PLAN_HORIZON_DAYS)),
      getInventoryItems(userId),
      getInventoryUsages(userId),
      getBalanceChangesOn(userId, today),
      // getPeople now THROWS on a failed query rather than returning [], so
      // that /people can tell "nobody yet" from "the roster read is broken".
      // The dashboard is not that surface: there is no error.tsx in this app,
      // so an uncaught throw here replaces the entire home route with Next's
      // default error page over one strip. Degrade instead — /people is where
      // the failure has to be visible, and it is.
      getPeople(userId).catch(() => []),
      getLatestInteractions(userId),
      getCandidates(userId),
      supabase
        .from("goals")
        .select("id, title, status, created_at")
        .eq("status", "active"),
      supabase
        .from("daily_logs")
        .select("mood, energy")
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

    const log = logResult.data as
      | { mood: number | null; energy: number | null }
      | null;

    // Decomposed tasks: plan every open child onto a day inside its window,
    // over the days the dashboard's busy data covers. Advisory and read-time —
    // nothing here is written back (see planSubtasks).
    const openChildren = tasks
      .filter((t) => t.parent_task_id !== null && t.due_date !== null)
      .map((t) => ({
        id: t.id,
        parent_task_id: t.parent_task_id as string,
        due_date: t.due_date as string,
        not_before: t.not_before,
        duration_min: t.duration_min,
        estimated_minutes: t.estimated_minutes,
        energy_cost: t.energy_cost,
        created_at: t.created_at,
      }));
    const plannedSubtasks = new Map<string, { dateKey: string; start: string | null }>();
    const doneChildrenByParent = new Map<string, number>();
    if (openChildren.length > 0) {
      const lastCovered = addDaysKey(dash.range.endDate, -1);
      const farthest = openChildren.reduce(
        (max, c) => (c.due_date > max ? c.due_date : max),
        today,
      );
      const horizonEnd = [farthest, lastCovered, addDaysKey(today, PLAN_HORIZON_DAYS)]
        .sort()[0];
      const horizonDays: string[] = [];
      for (let d = today; d <= horizonEnd; d = addDaysKey(d, 1)) horizonDays.push(d);
      // Every real commitment blocks the planner: Google events, timed
      // recurring occurrences and slots, and time-blocked tasks (due_time).
      const horizonBusy = [
        ...dash.events,
        ...occurrenceBusyEvents(recurringTasks, horizonDays, slotKeys, timeZone),
        ...slotBusyEvents(recurringSlots, recurringTasks, timeZone),
        ...timedTaskBusyEvents(tasks, timeZone),
      ];
      const intervalsByDay = new Map(
        horizonDays.map((dateKey) => [
          dateKey,
          freeIntervalsForDay({
            events: horizonBusy,
            dateKey,
            now,
            wakeStartHour: prefs.wake_start_hour,
            wakeEndHour: prefs.wake_end_hour,
            timeZone,
          }),
        ]),
      );
      for (const p of planSubtasks({
        today,
        children: openChildren,
        intervalsByDay,
        energyByDay:
          log?.energy != null ? new Map([[today, log.energy]]) : undefined,
      })) {
        plannedSubtasks.set(p.taskId, { dateKey: p.dateKey, start: p.start });
      }
      const parentIds = [...new Set(openChildren.map((c) => c.parent_task_id))];
      const { data: doneRows } = await supabase
        .from("tasks")
        .select("parent_task_id")
        .eq("status", "done")
        .in("parent_task_id", parentIds);
      for (const row of (doneRows ?? []) as { parent_task_id: string }[]) {
        doneChildrenByParent.set(
          row.parent_task_id,
          (doneChildrenByParent.get(row.parent_task_id) ?? 0) + 1,
        );
      }
    }

    // The dashboard never pays for the vault corpus, so the stream row
    // carries no open-loop text — the person page has it (§10 M3).
    // Real candidates, not the pre-M4 [] — otherwise the dashboard nudges
    // on exactly the evidence the §2 asymmetry rule quiets (review finding 1).
    const topAttention = computePeopleAttention({
      people,
      interactions: [...latestInteractions.values()],
      candidates: newCandidates,
      today,
    }).attention[0];

    const snapshot = streamSnapshot({
      today,
      now,
      tasks,
      people: {
        suggestion: topAttention
          ? {
              personId: topAttention.personId,
              name: topAttention.name,
              daysSinceTalked: topAttention.daysSinceTalked,
              openLoop: null,
            }
          : null,
      },
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
      plannedSubtasks,
      doneChildrenByParent,
    });

    return {
      today,
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

// "✦ do it" only renders for the owner: the PC's poll runs on the owner's PAT
// alone, so for anyone else the "picks it up in ~5 min" promise would be false
// (same gate as the ✦ run agent now button on /tasks).
function agentServicesUser(userId: string): boolean {
  try {
    return ownerUserId() === userId;
  } catch {
    // env unset (e.g. local dev) — keep the affordance hidden
    return false;
  }
}

async function StreamSection({ userId }: { userId: string }) {
  const [
    {
      today,
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
      today={today}
      todayLabel={formatLongWeekdayMonthDay(now, timeZone).toLowerCase()}
      clockLabel={formatClock12(now, timeZone)}
      agentServiced={agentServicesUser(userId)}
    />
  );
}

// Desktop-only right pane: the same week calendar /week serves, sharing the
// stream's cached getDashboardData/getUserPreferences promises for the
// current month.
async function WeekPaneSection({
  userId,
  queryMonth,
  selectedDay,
}: {
  userId: string;
  // Raw ?m= — the default month needs the user's zone, and resolving it here
  // (inside the Suspense boundary, where prefs is awaited anyway) keeps it off
  // Home's critical path so both boundaries still flush immediately.
  queryMonth: string | string[] | undefined;
  selectedDay: string | null;
}) {
  // prefs first: the default month is the user's current month, so the zone has
  // to be known before the data window is chosen. Serialised on purpose, and
  // affordable because this whole section sits behind its own Suspense
  // boundary. getDashboardData is cache()-deduped, so when ?m= is absent this
  // resolves to the same month the stream already requested and shares its
  // in-flight promise.
  const prefs = await getUserPreferences(userId);
  const timeZone = safeTimeZone(prefs.timezone);
  const month = selectedDay
    ? selectedDay.slice(0, 7)
    : normalizeMonth(queryMonth, timeZone);

  const {
    calendarTasks,
    events,
    finance,
    calendarStatus,
    calendarLinks,
    recurringTasks,
    recurringCompletions,
    recurringSlots,
  } = await getDashboardData(userId, month);

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
      today={today}
      timeZone={timeZone}
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
              queryMonth={query.m}
              selectedDay={selectedDay}
            />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
