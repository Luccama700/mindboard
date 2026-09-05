// Pure composer for GET /api/watch/today. Row bucketing reuses the same
// day math as tasksSnapshot (daysBetween: <0 overdue, 0 today, 1..7 soon) and
// the same "lands today" predicate the dashboard uses for routines
// (taskRuleLandsOn on the user-local day), so the watch agrees with the app
// and the MCP snapshots. `today` and `now` are passed in so the function
// stays deterministic.

import { daysBetween } from "@/app/_components/inventory-projection";
import { priorityRank } from "@/app/_components/date-utils";
import { addDaysKey } from "@/app/_components/finance-projection";
import { taskRuleLandsOn, type TaskRecurrence } from "@/app/lib/recurrence";
import { tasksSnapshot } from "@/app/lib/snapshots/tasks";
import { scheduleSnapshot, type ScheduleEvent } from "@/app/lib/snapshots/schedule";
import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import type { TaskWithGroup } from "@/app/_components/types";

// Per-section cap: the watch shows ~8 rows plus a "more" row, so anything
// beyond this is never rendered and only costs bytes over Bluetooth.
export const WATCH_SECTION_LIMIT = 20;
// Notes are Markdown of any length; the detail screen shows this much.
export const WATCH_NOTES_MAX = 1000;
// "Upcoming" = the next 7 days after today, the same window tasksSnapshot
// calls dueSoon and MCP list_events defaults to.
export const WATCH_UPCOMING_DAYS = 7;

export type WatchTaskRow = {
  id: string;
  title: string;
  due: string; // YYYY-MM-DD
  time: string | null; // "HH:MM"
  priority: "low" | "med" | "high";
  group: string | null;
  notes: string | null;
};

export type WatchRoutineRow = {
  id: string;
  title: string;
  time: string | null; // "HH:MM" — an approved slot for today wins over the rule's due_time
  done: boolean;
};

export type WatchEventRow = {
  id: string;
  title: string;
  start: string; // ISO instant, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  calendar: string | null; // linked Mindboard group name, else the Google calendar name
  location: string | null;
  description: string | null;
};

// Google event fields the watch's detail screen shows, on top of the
// schedule shape the free-time math consumes.
export type WatchEventInput = ScheduleEvent & {
  id?: string;
  calendar?: string | null;
  location?: string | null;
  description?: string | null;
};

export type WatchToday = {
  meta: { serverTime: string; timeZone: string | null; today: string };
  overdue: WatchTaskRow[];
  dueToday: WatchTaskRow[];
  events: WatchEventRow[]; // today's events that haven't ended yet
  routines: WatchRoutineRow[];
  upcomingEvents: WatchEventRow[]; // tomorrow … +7 days
  upcomingTasks: WatchTaskRow[]; // due tomorrow … +7 days
  nextEvent: { title: string; start: string } | null;
  freeHours: number | null;
  counts: {
    overdue: number;
    dueToday: number; // open tasks due today
    doneToday: number; // tasks due today already completed
    routines: number;
    routinesDone: number;
  };
};

export type WatchRoutineRule = TaskRecurrence & {
  id: string;
  title: string;
  due_time: string | null;
};

export type WatchTaskInput = Pick<
  TaskWithGroup,
  "id" | "title" | "due_date" | "due_time" | "status" | "priority" | "notes" | "created_at"
> & { group_name: string | null };

export type WatchTodayInput = {
  // Open (todo/doing), dated tasks with due_date <= today + WATCH_UPCOMING_DAYS.
  tasks: WatchTaskInput[];
  doneTodayCount: number;
  rules: WatchRoutineRule[];
  completedRuleIds: ReadonlySet<string>;
  slotStartByRule: ReadonlyMap<string, string>;
  // Google events from the start of today through +WATCH_UPCOMING_DAYS in the
  // user's zone (null when the calendar isn't reachable).
  events: WatchEventInput[] | null;
  wakeStartHour: number;
  wakeEndHour: number;
  today: string;
  now: Date;
  timeZone: string | null;
};

function shortTime(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

function clipNotes(notes: string | null | undefined): string | null {
  const trimmed = notes?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.length > WATCH_NOTES_MAX ? `${trimmed.slice(0, WATCH_NOTES_MAX - 1)}…` : trimmed;
}

function toRow(task: WatchTaskInput): WatchTaskRow {
  return {
    id: task.id,
    title: task.title,
    due: task.due_date ?? "",
    time: shortTime(task.due_time),
    priority: task.priority,
    group: task.group_name,
    notes: clipNotes(task.notes),
  };
}

function byDueThenPriority(a: WatchTaskInput, b: WatchTaskInput): number {
  return (
    (a.due_date as string).localeCompare(b.due_date as string) ||
    (a.due_time ?? "99").localeCompare(b.due_time ?? "99") ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    a.created_at.localeCompare(b.created_at)
  );
}

// The user-local day an event belongs to: all-day events carry a date key
// already; timed ones are instants, bucketed in the user's zone.
function eventDayKey(event: ScheduleEvent, timeZone: string | null): string {
  if (event.allDay) return event.start.slice(0, 10);
  const ms = new Date(event.start).getTime();
  return Number.isFinite(ms) ? zonedDateKey(ms, timeZone) : event.start.slice(0, 10);
}

// Still part of today: an all-day event covering today (Google's all-day
// `end` is the exclusive next day), or a timed event that hasn't ended.
function isLeftToday(event: ScheduleEvent, today: string, nowMs: number, timeZone: string | null): boolean {
  if (event.allDay) return event.start.slice(0, 10) <= today && event.end.slice(0, 10) > today;
  return eventDayKey(event, timeZone) <= today && new Date(event.end).getTime() > nowMs;
}

function byDayThenStart(timeZone: string | null) {
  return (a: ScheduleEvent, b: ScheduleEvent): number => {
    const dayA = eventDayKey(a, timeZone);
    const dayB = eventDayKey(b, timeZone);
    if (dayA !== dayB) return dayA.localeCompare(dayB);
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start.localeCompare(b.start) || a.summary.localeCompare(b.summary);
  };
}

function toEventRow(e: WatchEventInput): WatchEventRow {
  return {
    id: e.id ?? `${e.start}|${e.end}|${e.summary}`,
    title: e.summary,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    calendar: e.calendar ?? null,
    location: e.location?.trim() || null,
    description: clipNotes(e.description),
  };
}

export function composeWatchToday(input: WatchTodayInput): WatchToday {
  const { today, timeZone } = input;
  const nowMs = input.now.getTime();
  const horizon = addDaysKey(today, WATCH_UPCOMING_DAYS);

  const open = input.tasks.filter(
    (t) => (t.status === "todo" || t.status === "doing") && t.due_date,
  );
  const dayOffset = (t: WatchTaskInput) => daysBetween(today, t.due_date as string);

  const overdue = open.filter((t) => dayOffset(t) < 0).sort(byDueThenPriority);
  const dueToday = open.filter((t) => dayOffset(t) === 0).sort(byDueThenPriority);
  const upcomingTasks = open
    .filter((t) => dayOffset(t) > 0 && dayOffset(t) <= WATCH_UPCOMING_DAYS)
    .sort(byDueThenPriority);

  const todayDate = new Date(`${today}T00:00:00`);
  const routines: WatchRoutineRow[] = input.rules
    .filter((rule) => taskRuleLandsOn(rule, todayDate))
    .map((rule) => ({
      id: rule.id,
      title: rule.title,
      time: shortTime(input.slotStartByRule.get(rule.id) ?? rule.due_time),
      done: input.completedRuleIds.has(rule.id),
    }))
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        (a.time ?? "99").localeCompare(b.time ?? "99") ||
        a.title.localeCompare(b.title),
    );

  const allEvents = input.events ?? [];
  const todayEvents = allEvents
    .filter((e) => isLeftToday(e, today, nowMs, timeZone))
    .sort(byDayThenStart(timeZone));
  const upcomingEvents = allEvents
    .filter((e) => {
      const day = eventDayKey(e, timeZone);
      return day > today && day <= horizon;
    })
    .sort(byDayThenStart(timeZone));

  // Header vitals are about TODAY: the next event still to come today and the
  // free waking hours left, so the "No more events" line stays true to the
  // screen even when tomorrow is busy.
  const schedule = input.events
    ? scheduleSnapshot({
        events: todayEvents,
        now: input.now,
        wakeStartHour: input.wakeStartHour,
        wakeEndHour: input.wakeEndHour,
        timeZone,
      })
    : null;

  const counts = tasksSnapshot(open as unknown as TaskWithGroup[], today);

  return {
    meta: {
      serverTime: input.now.toISOString(),
      timeZone,
      today,
    },
    overdue: overdue.slice(0, WATCH_SECTION_LIMIT).map(toRow),
    dueToday: dueToday.slice(0, WATCH_SECTION_LIMIT).map(toRow),
    events: todayEvents.slice(0, WATCH_SECTION_LIMIT).map(toEventRow),
    routines: routines.slice(0, WATCH_SECTION_LIMIT),
    upcomingEvents: upcomingEvents.slice(0, WATCH_SECTION_LIMIT).map(toEventRow),
    upcomingTasks: upcomingTasks.slice(0, WATCH_SECTION_LIMIT).map(toRow),
    nextEvent: schedule?.nextEvent
      ? { title: schedule.nextEvent.summary, start: schedule.nextEvent.start }
      : null,
    freeHours: schedule ? schedule.freeHoursToday : null,
    counts: {
      overdue: counts.overdue,
      dueToday: counts.dueToday,
      doneToday: input.doneTodayCount,
      routines: routines.length,
      routinesDone: routines.filter((r) => r.done).length,
    },
  };
}
