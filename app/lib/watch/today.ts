// Pure composer for GET /api/watch/today. Row bucketing reuses the same
// day math as tasksSnapshot (daysBetween: <0 overdue, 0 today) and the same
// "lands today" predicate the dashboard uses for routines (taskRuleLandsOn on
// the user-local day), so the watch agrees with the app and the MCP snapshots.
// `today` and `now` are passed in so the function stays deterministic.

import { daysBetween } from "@/app/_components/inventory-projection";
import { priorityRank } from "@/app/_components/date-utils";
import { taskRuleLandsOn, type TaskRecurrence } from "@/app/lib/recurrence";
import { tasksSnapshot } from "@/app/lib/snapshots/tasks";
import type { ScheduleVitals } from "@/app/lib/snapshots/schedule";
import type { TaskWithGroup } from "@/app/_components/types";

// Per-section cap: the watch shows ~8 rows plus a "more" row, so anything
// beyond this is never rendered and only costs bytes over Bluetooth.
export const WATCH_SECTION_LIMIT = 20;

export type WatchTaskRow = {
  id: string;
  title: string;
  due: string; // YYYY-MM-DD
  time: string | null; // "HH:MM"
};

export type WatchRoutineRow = {
  id: string;
  title: string;
  time: string | null; // "HH:MM" — an approved slot for today wins over the rule's due_time
  done: boolean;
};

export type WatchToday = {
  meta: { serverTime: string; timeZone: string | null; today: string };
  overdue: WatchTaskRow[];
  dueToday: WatchTaskRow[];
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

export type WatchTodayInput = {
  // Open (todo/doing), dated tasks with due_date <= today.
  tasks: Pick<TaskWithGroup, "id" | "title" | "due_date" | "due_time" | "status" | "priority" | "created_at">[];
  doneTodayCount: number;
  rules: WatchRoutineRule[];
  completedRuleIds: ReadonlySet<string>;
  slotStartByRule: ReadonlyMap<string, string>;
  schedule: ScheduleVitals | null;
  today: string;
  now: Date;
  timeZone: string | null;
};

function shortTime(value: string | null): string | null {
  return value ? value.slice(0, 5) : null;
}

function toRow(task: WatchTodayInput["tasks"][number]): WatchTaskRow {
  return {
    id: task.id,
    title: task.title,
    due: task.due_date ?? "",
    time: shortTime(task.due_time),
  };
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

  const counts = tasksSnapshot(open as TaskWithGroup[], today);

  return {
    meta: {
      serverTime: input.now.toISOString(),
      timeZone: input.timeZone,
      today,
    },
    overdue: overdue.slice(0, WATCH_SECTION_LIMIT).map(toRow),
    dueToday: dueToday.slice(0, WATCH_SECTION_LIMIT).map(toRow),
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
