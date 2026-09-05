// Pure composer for GET /api/watch/today. Row bucketing reuses the same
// day math as tasksSnapshot (daysBetween: <0 overdue, 0 today) and the same
// "lands today" predicate the dashboard uses for routines (taskRuleLandsOn on
// the user-local day), so the watch agrees with the app and the MCP snapshots.
// `today` and `now` are passed in so the function stays deterministic.

import { daysBetween } from "@/app/_components/inventory-projection";
import { priorityRank } from "@/app/_components/date-utils";
import { taskRuleLandsOn, type TaskRecurrence } from "@/app/lib/recurrence";
import { tasksSnapshot } from "@/app/lib/snapshots/tasks";
import type { ScheduleEvent, ScheduleVitals } from "@/app/lib/snapshots/schedule";
import type { TaskWithGroup } from "@/app/_components/types";

// Per-section cap: the watch shows ~8 rows plus a "more" row, so anything
// beyond this is never rendered and only costs bytes over Bluetooth.
export const WATCH_SECTION_LIMIT = 20;
// Notes are Markdown of any length; the detail screen shows this much.
export const WATCH_NOTES_MAX = 1000;

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
  title: string;
  start: string; // ISO instant, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
};

export type WatchToday = {
  meta: { serverTime: string; timeZone: string | null; today: string };
  overdue: WatchTaskRow[];
  dueToday: WatchTaskRow[];
  events: WatchEventRow[]; // today's events that haven't ended yet
  routines: WatchRoutineRow[];
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
  // Open (todo/doing), dated tasks with due_date <= today.
  tasks: WatchTaskInput[];
  doneTodayCount: number;
  rules: WatchRoutineRule[];
  completedRuleIds: ReadonlySet<string>;
  slotStartByRule: ReadonlyMap<string, string>;
  // Today's Google events (null when the calendar isn't reachable).
  events: ScheduleEvent[] | null;
  schedule: ScheduleVitals | null;
  today: string;
  now: Date;
  timeZone: string | null;
};

function shortTime(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

function clipNotes(notes: string | null): string | null {
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

// All-day events lead (no clock to sort by), then timed events by start;
// timed events that already ended are gone — this is what's left of the day.
function eventRows(events: ScheduleEvent[], nowMs: number): WatchEventRow[] {
  return events
    .filter((e) => e.allDay || new Date(e.end).getTime() > nowMs)
    .sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.start.localeCompare(b.start) || a.summary.localeCompare(b.summary);
    })
    .map((e) => ({ title: e.summary, start: e.start, end: e.end, allDay: e.allDay }));
}

export function composeWatchToday(input: WatchTodayInput): WatchToday {
  const { today } = input;
  const open = input.tasks.filter(
    (t) => (t.status === "todo" || t.status === "doing") && t.due_date,
  );

  const overdue = open
    .filter((t) => daysBetween(today, t.due_date as string) < 0)
    .sort(
      (a, b) =>
        (a.due_date as string).localeCompare(b.due_date as string) ||
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.created_at.localeCompare(b.created_at),
    );

  const dueToday = open
    .filter((t) => daysBetween(today, t.due_date as string) === 0)
    .sort(
      (a, b) =>
        (a.due_time ?? "99").localeCompare(b.due_time ?? "99") ||
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.created_at.localeCompare(b.created_at),
    );

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

  const counts = tasksSnapshot(open as unknown as TaskWithGroup[], today);

  return {
    meta: {
      serverTime: input.now.toISOString(),
      timeZone: input.timeZone,
      today,
    },
    overdue: overdue.slice(0, WATCH_SECTION_LIMIT).map(toRow),
    dueToday: dueToday.slice(0, WATCH_SECTION_LIMIT).map(toRow),
    events: eventRows(input.events ?? [], input.now.getTime()).slice(0, WATCH_SECTION_LIMIT),
    routines: routines.slice(0, WATCH_SECTION_LIMIT),
    nextEvent: input.schedule?.nextEvent
      ? { title: input.schedule.nextEvent.summary, start: input.schedule.nextEvent.start }
      : null,
    freeHours: input.schedule ? input.schedule.freeHoursToday : null,
    counts: {
      overdue: counts.overdue,
      dueToday: counts.dueToday,
      doneToday: input.doneTodayCount,
      routines: routines.length,
      routinesDone: routines.filter((r) => r.done).length,
    },
  };
}
