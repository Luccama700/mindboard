// Pure horizon-aware planning rollup: the cross-domain read behind get_snapshot's
// verbose/horizon mode. No React, no server imports — every input is raw data and
// the clock is injected, so the whole thing is unit-tested. It reuses the tested
// projections (finance, inventory, recurrence, free-time) rather than re-deriving
// them, and emits times in the user's zone with explicit ISO offsets.

import {
  addDaysKey,
  ruleLandsOn,
  type RecurringRule,
} from "@/app/_components/finance-projection";
import {
  daysUntilEmpty,
  effectiveDailyRate,
  reorderDateKey,
  runOutDateKey,
  stockStatus,
  type UsageRule,
} from "@/app/_components/inventory-projection";
import { taskRuleLandsOn, type TaskRecurrence } from "@/app/lib/recurrence";
import {
  freeIntervalsForDay,
  type ScheduleEvent,
} from "@/app/lib/snapshots/schedule";
import {
  zonedDateKey,
  zonedIso,
  zonedWallTimeToUtcMs,
} from "@/app/lib/snapshots/zoned-time";
import type { ForecastDay } from "@/app/lib/finance/forecast";
import type { PeopleVitals } from "@/app/lib/snapshots/people";
import type { TaskWithGroup } from "@/app/_components/types";

const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_BLOCK_MINUTES = 30; // an occurrence/task with a time but no duration
const GAP_FLOOR_MINUTES = 30; // smallest gap worth surfacing for planning

// ---------- input types ----------

export type PlanningRecurringRule = TaskRecurrence & {
  id: string;
  title: string;
  due_time: string | null; // "HH:MM" or "HH:MM:SS"; null = untimed habit
  duration_min: number | null;
  priority: "low" | "med" | "high";
  group_name: string | null;
};

export type PlanningAccount = {
  id: string;
  name: string;
  balance: number;
  currency: string;
};

export type PlanningBillRule = RecurringRule & { id: string; name: string };

export type PlanningItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  reorder_threshold: number | null;
};

export type PlanningCheckin = {
  date: string;
  mood: number | null;
  energy: number | null;
  sleepHours: number | null;
};

export type PlanningGoal = {
  id: string;
  title: string;
  horizon: string | null;
  status: string;
  target_date: string | null;
};

export type PlanningInput = {
  today: string; // user-zone YYYY-MM-DD
  now: Date;
  horizonDays: number;
  timeZone: string | null;
  wakeStartHour: number;
  wakeEndHour: number;
  beforeHour: number; // e.g. 17 → "free hours before 5pm"

  events: ScheduleEvent[]; // Google Calendar events across the horizon
  recurringTasks: PlanningRecurringRule[];
  completedRecurring: Set<string>; // "ruleId|dateKey" for known (past/today) completions
  // Approved per-occurrence slots (migration 0042): each overrides its rule's
  // due_time for that day (never double-counted). Default [].
  recurringSlots?: {
    rule_id: string;
    occurred_on: string;
    start_time: string; // "HH:MM" or "HH:MM:SS"
    duration_min: number | null;
    gcal_event_id?: string | null; // promoted: the real event replaces the routine
  }[];
  tasks: TaskWithGroup[]; // every open task

  accounts: PlanningAccount[];
  recurringExpenses: PlanningBillRule[];
  todayDelta: number;
  forecast: ForecastDay[]; // buildFinanceForecast().days over the horizon
  everydaySpend: { dailyRate: number; confident: boolean; manualFallback: number | null };

  items: PlanningItem[];
  usagesByItem: Record<string, UsageRule[]>;

  checkins: PlanningCheckin[];
  goals: PlanningGoal[];
  // Already computed and hydrated by the assembler (§7's two-step): attention
  // is a BOUNDED slice carrying open loops for at most three people. Optional
  // so existing callers and tests keep compiling; absent = nobody tracked.
  people?: PeopleVitals;
};

// ---------- output types ----------

export type TimedBlock = {
  title: string;
  start: string; // ISO w/ offset
  end: string;
  source: "google" | "task" | "recurring";
};

export type FreeGap = { start: string; end: string; minutes: number };

export type PlanningDay = {
  date: string;
  weekday: string;
  committedMinutes: number;
  freeHoursBeforeHour: number;
  freeGaps: FreeGap[];
  timed: TimedBlock[];
  allDay: string[];
};

export type PlanningTask = {
  id: string;
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  priority: "low" | "med" | "high";
  group: string | null;
  durationMin: number | null;
  scheduled: boolean; // has an explicit time slot
  bucket: "overdue" | "today" | "upcoming" | "undated";
};

export type PlanningOccurrence = {
  ruleId: string;
  title: string;
  date: string;
  dueTime: string | null;
  durationMin: number | null;
  priority: "low" | "med" | "high";
  group: string | null;
  done: boolean;
  slotted: boolean; // an approved slot pins this occurrence's time for its day
};

export type PlanningInventoryItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  status: "ok" | "low" | "out";
  dailyRate: number;
  daysLeft: number | null;
  runOutDate: string | null;
  reorderBy: string | null;
};

export type PlanningSnapshot = {
  today: string;
  horizonDays: number;
  horizonEnd: string;
  timeZone: string | null;
  generatedAt: string; // ISO w/ offset
  beforeHour: number;

  finance: {
    netWorth: number;
    currency: string;
    todayDelta: number;
    accounts: PlanningAccount[];
    upcomingBills: { name: string; amount: number; dateKey: string }[];
    everydaySpend: { dailyRate: number; confident: boolean; manualFallback: number | null };
    projectedNetWorth: ForecastDay[];
  };
  tasks: {
    summary: { overdue: number; dueToday: number; dueSoon: number };
    items: PlanningTask[];
    recurringOccurrences: PlanningOccurrence[];
  };
  schedule: {
    nextEvent: { summary: string; start: string } | null;
    freeHoursToday: number;
    days: PlanningDay[];
  };
  inventory: {
    summary: { lowCount: number; outCount: number; soonestRunOut: { name: string; dateKey: string } | null };
    items: PlanningInventoryItem[];
  };
  signals: {
    checkins: PlanningCheckin[];
    goals: { id: string; title: string; horizon: string | null; status: string; targetDate: string | null }[];
  };
  // Open loops travel ONLY for the people in attention[] — never the whole
  // roster — and no mindspace mention snippets travel at all (§9). Both bounds
  // are the ones the two-step assembly already imposes for performance.
  people: PeopleVitals;
};

// ---------- helpers ----------

function parseKey(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

function parseHms(value: string): { h: number; m: number } | null {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return { h, m };
}

function minutesToClock(total: number): string {
  const h = String(Math.floor(total / 60)).padStart(2, "0");
  const m = String(total % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- main ----------

export function planningSnapshot(input: PlanningInput): PlanningSnapshot {
  const {
    today,
    now,
    horizonDays,
    timeZone,
    wakeStartHour,
    wakeEndHour,
    beforeHour,
    events,
    recurringTasks,
    completedRecurring,
    recurringSlots = [],
    tasks,
    accounts,
    recurringExpenses,
    todayDelta,
    forecast,
    everydaySpend,
    items,
    usagesByItem,
    checkins,
    goals,
  } = input;

  const nowMs = now.getTime();

  // Approved slots keyed "ruleId|dateKey" — each overrides its rule's due_time
  // (and duration) for that day, in both the timed schedule and the occurrence list.
  const slotByKey = new Map(
    recurringSlots.map((s) => [`${s.rule_id}|${s.occurred_on}`, s]),
  );
  const horizonEnd = addDaysKey(today, horizonDays);
  const dayKeys: string[] = [];
  for (let d = today; d <= horizonEnd; d = addDaysKey(d, 1)) dayKeys.push(d);

  const openTasks = tasks.filter(
    (t) => t.status !== "done" && t.status !== "missed",
  );

  // ---- schedule: materialize timed items, then per-day free/committed ----
  const timedEvents = events.filter((e) => !e.allDay && e.start && e.end);
  const allDayEvents = events.filter((e) => e.allDay);
  const timedRecurring = recurringTasks.filter((r) => r.due_time);
  const timedTasks = openTasks.filter((t) => t.due_date && t.due_time);
  const ruleById = new Map(recurringTasks.map((r) => [r.id, r]));

  // Today's free hours count every source that blocks time (events, time-blocked
  // tasks, timed habits) — captured from the day loop below.
  let freeMinutesToday = 0;

  const days: PlanningDay[] = dayKeys.map((dateKey) => {
    const date = parseKey(dateKey);
    const blocks: TimedBlock[] = [];

    for (const e of timedEvents) {
      if (zonedDateKey(new Date(e.start).getTime(), timeZone) !== dateKey) continue;
      blocks.push({ title: e.summary || "(untitled)", start: e.start, end: e.end, source: "google" });
    }
    for (const rule of timedRecurring) {
      if (!taskRuleLandsOn(rule, date)) continue;
      // A slot overrides the rule's due_time for this day — the slot block below
      // supplies it instead, so skip the rule-timed block (never double-counted).
      if (slotByKey.has(`${rule.id}|${dateKey}`)) continue;
      const hm = parseHms(rule.due_time as string);
      if (!hm) continue;
      const startMs = zonedWallTimeToUtcMs(dateKey, hm.h, hm.m, timeZone);
      const endMs = startMs + (rule.duration_min ?? DEFAULT_BLOCK_MINUTES) * 60_000;
      blocks.push({
        title: rule.title,
        start: zonedIso(startMs, timeZone),
        end: zonedIso(endMs, timeZone),
        source: "recurring",
      });
    }
    for (const slot of recurringSlots) {
      if (slot.occurred_on !== dateKey) continue;
      // A promoted slot's time is supplied by the real Google event it created.
      if (slot.gcal_event_id) continue;
      const rule = ruleById.get(slot.rule_id);
      if (!rule) continue;
      const hm = parseHms(slot.start_time);
      if (!hm) continue;
      const startMs = zonedWallTimeToUtcMs(dateKey, hm.h, hm.m, timeZone);
      const endMs =
        startMs +
        (slot.duration_min ?? rule.duration_min ?? DEFAULT_BLOCK_MINUTES) * 60_000;
      blocks.push({
        title: rule.title,
        start: zonedIso(startMs, timeZone),
        end: zonedIso(endMs, timeZone),
        source: "recurring",
      });
    }
    for (const t of timedTasks) {
      if (t.due_date !== dateKey) continue;
      const hm = parseHms(t.due_time as string);
      if (!hm) continue;
      const startMs = zonedWallTimeToUtcMs(dateKey, hm.h, hm.m, timeZone);
      const endMs = startMs + (t.duration_min ?? DEFAULT_BLOCK_MINUTES) * 60_000;
      blocks.push({
        title: t.title,
        start: zonedIso(startMs, timeZone),
        end: zonedIso(endMs, timeZone),
        source: "task",
      });
    }
    // Sort by absolute instant, not ISO string — blocks carry mixed offsets
    // (Google events keep their raw Z, ours carry the zone's numeric offset).
    blocks.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    const busy: ScheduleEvent[] = blocks.map((b) => ({
      summary: b.title,
      start: b.start,
      end: b.end,
      allDay: false,
    }));
    const free = freeIntervalsForDay({
      events: busy,
      dateKey,
      now,
      wakeStartHour,
      wakeEndHour,
      timeZone,
    });

    const wakeStartMs = zonedWallTimeToUtcMs(dateKey, wakeStartHour, 0, timeZone);
    const wakeEndMs = zonedWallTimeToUtcMs(dateKey, wakeEndHour, 0, timeZone);
    const lo = dateKey === today ? Math.max(wakeStartMs, nowMs) : wakeStartMs;
    const windowMinutes = Math.max(0, (wakeEndMs - lo) / 60_000);
    const freeMinutes = free.reduce((s, iv) => s + iv.minutes, 0);
    const committedMinutes = Math.max(0, Math.round(windowMinutes - freeMinutes));
    if (dateKey === today) freeMinutesToday = freeMinutes;

    const beforeCap = beforeHour * 60;
    const freeBefore = free.reduce((s, iv) => {
      const end = Math.min(iv.endMinutes, beforeCap);
      return s + Math.max(0, end - iv.startMinutes);
    }, 0);

    const freeGaps: FreeGap[] = free
      .filter((iv) => iv.minutes >= GAP_FLOOR_MINUTES)
      .map((iv) => ({
        start: minutesToClock(iv.startMinutes),
        end: minutesToClock(iv.endMinutes),
        minutes: iv.minutes,
      }));

    return {
      date: dateKey,
      weekday: WEEKDAY_SHORT[date.getDay()],
      committedMinutes,
      freeHoursBeforeHour: round1(freeBefore / 60),
      freeGaps,
      timed: blocks,
      // All-day dates are floating (date-only) — bucket by the date string, not
      // by a tz conversion that would shift a midnight instant to the day before.
      allDay: allDayEvents
        .filter((e) => {
          const startDate = e.start.slice(0, 10);
          const endDate = e.end ? e.end.slice(0, 10) : addDaysKey(startDate, 1);
          return dateKey >= startDate && dateKey < endDate;
        })
        .map((e) => e.summary || "(untitled)"),
    };
  });

  const upcomingTimed = timedEvents
    .filter((e) => new Date(e.end).getTime() > nowMs)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[0];
  const nextEvent = upcomingTimed
    ? { summary: upcomingTimed.summary, start: upcomingTimed.start }
    : null;
  const freeHoursToday = round1(freeMinutesToday / 60);

  // ---- tasks ----
  let overdue = 0;
  let dueToday = 0;
  let dueSoon = 0;
  const soonLimit = addDaysKey(today, 7);
  const taskItems: PlanningTask[] = [];
  for (const t of openTasks) {
    let bucket: PlanningTask["bucket"];
    if (!t.due_date) bucket = "undated";
    else if (t.due_date < today) {
      bucket = "overdue";
      overdue++;
    } else if (t.due_date === today) {
      bucket = "today";
      dueToday++;
    } else {
      bucket = "upcoming";
      if (t.due_date <= soonLimit) dueSoon++;
    }
    // Bound the list: overdue, undated, or dued within the horizon.
    if (t.due_date && t.due_date > horizonEnd) continue;
    taskItems.push({
      id: t.id,
      title: t.title,
      dueDate: t.due_date,
      dueTime: t.due_time ? t.due_time.slice(0, 5) : null,
      priority: t.priority,
      group: t.group_name,
      durationMin: t.duration_min,
      scheduled: t.due_time !== null,
      bucket,
    });
  }

  const recurringOccurrences: PlanningOccurrence[] = [];
  for (const dateKey of dayKeys) {
    const date = parseKey(dateKey);
    for (const rule of recurringTasks) {
      if (!taskRuleLandsOn(rule, date)) continue;
      const slot = slotByKey.get(`${rule.id}|${dateKey}`);
      // Promoted occurrences are replaced by their Google event that day.
      if (slot?.gcal_event_id) continue;
      recurringOccurrences.push({
        ruleId: rule.id,
        title: rule.title,
        date: dateKey,
        dueTime: slot
          ? slot.start_time.slice(0, 5)
          : rule.due_time
            ? rule.due_time.slice(0, 5)
            : null,
        durationMin: slot ? (slot.duration_min ?? rule.duration_min) : rule.duration_min,
        priority: rule.priority,
        group: rule.group_name,
        done: completedRecurring.has(`${rule.id}|${dateKey}`),
        slotted: slot !== undefined,
      });
    }
  }

  // ---- finance ----
  const netWorth = accounts.reduce((s, a) => s + Number(a.balance), 0);
  const currency = accounts[0]?.currency ?? "USD";
  const upcomingBills: { name: string; amount: number; dateKey: string }[] = [];
  for (const dateKey of dayKeys) {
    if (dateKey === today) continue; // "upcoming" is strictly ahead
    const date = parseKey(dateKey);
    for (const rule of recurringExpenses) {
      if (ruleLandsOn(rule, date)) {
        upcomingBills.push({ name: rule.name, amount: Number(rule.amount), dateKey });
      }
    }
  }

  // ---- inventory ----
  let lowCount = 0;
  let outCount = 0;
  let soonestRunOut: { name: string; dateKey: string } | null = null;
  const inventoryItems: PlanningInventoryItem[] = [];
  for (const item of items) {
    const quantity = Number(item.quantity);
    const status = stockStatus(quantity, item.reorder_threshold);
    if (status === "low") lowCount++;
    if (status === "out") outCount++;
    const rate = effectiveDailyRate(usagesByItem[item.id] ?? []);
    const runOut = runOutDateKey(today, quantity, rate);
    if (runOut && (!soonestRunOut || runOut < soonestRunOut.dateKey)) {
      soonestRunOut = { name: item.name, dateKey: runOut };
    }
    if (status !== "ok" || rate > 0 || item.reorder_threshold !== null) {
      inventoryItems.push({
        id: item.id,
        name: item.name,
        quantity,
        unit: item.unit,
        status,
        dailyRate: Math.round(rate * 1000) / 1000,
        daysLeft: daysUntilEmpty(quantity, rate),
        runOutDate: runOut,
        reorderBy: reorderDateKey(today, quantity, rate, item.reorder_threshold),
      });
    }
  }
  inventoryItems.sort((a, b) => {
    if (a.runOutDate === null && b.runOutDate === null) return a.name.localeCompare(b.name);
    if (a.runOutDate === null) return 1;
    if (b.runOutDate === null) return -1;
    return a.runOutDate.localeCompare(b.runOutDate);
  });

  return {
    today,
    horizonDays,
    horizonEnd,
    timeZone,
    generatedAt: zonedIso(nowMs, timeZone),
    beforeHour,
    finance: {
      netWorth,
      currency,
      todayDelta,
      accounts,
      upcomingBills,
      everydaySpend,
      projectedNetWorth: forecast,
    },
    tasks: {
      summary: { overdue, dueToday, dueSoon },
      items: taskItems,
      recurringOccurrences,
    },
    schedule: {
      nextEvent,
      freeHoursToday,
      days,
    },
    inventory: {
      summary: { lowCount, outCount, soonestRunOut },
      items: inventoryItems,
    },
    signals: {
      checkins,
      goals: goals.map((g) => ({
        id: g.id,
        title: g.title,
        horizon: g.horizon,
        status: g.status,
        targetDate: g.target_date,
      })),
    },
    people: input.people ?? { total: 0, tracked: 0, attention: [] },
  };
}
