import "server-only";
import { cache } from "react";

import { createClient } from "@/utils/supabase/server";
import {
  GoogleCalendarConnectionError,
  listEvents,
  type CalendarEvent,
} from "@/utils/google/calendar";
import type { FinanceChange } from "@/app/_components/dashboard-calendar";
import type { TaskWithGroup } from "@/app/_components/types";
import type { TaskRecurrence } from "@/app/lib/recurrence";

// Timed recurring-task rules for the calendar: occurrences are computed
// client-side per grid day; completions mark them done/struck.
export type CalendarRecurringTask = TaskRecurrence & {
  id: string;
  title: string;
  due_time: string; // timed rules only — untimed never reach the calendar
  duration_min: number | null;
  group_name: string | null;
  group_color: string | null;
};

type RawRecurringTask = Omit<
  CalendarRecurringTask,
  "group_name" | "group_color"
> & {
  groups: { name: string; color: string } | { name: string; color: string }[] | null;
};

type RawTask = {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null;
  duration_min: number | null;
  gcal_event_id: string | null;
  gcal_calendar_id: string | null;
  estimated_minutes: number | null;
  status: "todo" | "doing" | "done" | "missed";
  priority: "low" | "med" | "high";
  ai_state: "planned" | "approved" | "building" | "built" | "failed" | null;
  notes: string | null;
  group_id: string | null;
  created_at: string;
  completed_at: string | null;
  missed_at: string | null;
  groups: { name: string; color: string } | { name: string; color: string }[] | null;
};

export type CalendarLink = {
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

export type EventsBundle = {
  events: CalendarEvent[];
  status: "connected" | "connect" | "error";
};

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function currentMonth() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  return `${today.getFullYear()}-${month}`;
}

export function normalizeMonth(value: string | string[] | undefined) {
  const month = Array.isArray(value) ? value[0] : value;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return currentMonth();

  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber < 1 || monthNumber > 12) return currentMonth();
  if (year < 1970 || year > 2100) return currentMonth();

  return month;
}

// The calendar's `?d=` selected-day param (YYYY-MM-DD) that anchors the week
// view; null when absent or malformed.
export function normalizeDay(
  value: string | string[] | undefined,
): string | null {
  const day = Array.isArray(value) ? value[0] : value;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  const [year, monthNumber, dayNumber] = day.split("-").map(Number);
  if (monthNumber < 1 || monthNumber > 12) return null;
  if (dayNumber < 1 || dayNumber > 31) return null;
  if (year < 1970 || year > 2100) return null;

  return day;
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
      due_time: row.due_time,
      duration_min: row.duration_min,
      gcal_event_id: row.gcal_event_id,
      gcal_calendar_id: row.gcal_calendar_id,
      estimated_minutes: row.estimated_minutes,
      status: row.status,
      priority: row.priority,
      ai_state: row.ai_state,
      notes: row.notes,
      group_id: row.group_id,
      created_at: row.created_at,
      completed_at: row.completed_at,
      missed_at: row.missed_at,
      group_name: groupRecord?.name ?? null,
      group_color: groupRecord?.color ?? null,
    };
  });
}

// Every non-done task, with or without a due date — the Stream's task input
// (the dashboard read below only fetches dated tasks).
export const getOpenTasks = cache(
  async (userId: string): Promise<TaskWithGroup[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("tasks")
      .select(
        "id, title, due_date, due_time, duration_min, status, priority, ai_state, notes, group_id, gcal_event_id, gcal_calendar_id, created_at, completed_at, estimated_minutes, missed_at, groups(name, color)",
      )
      .eq("user_id", userId)
      .in("status", ["todo", "doing"]);
    return mapTasks((data ?? []) as RawTask[]);
  },
);

export const getDashboardData = cache(async (userId: string, month: string) => {
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

  const [
    tasksResponse,
    groupsResponse,
    changesResponse,
    recurringResponse,
    completionsResponse,
    eventsResult,
  ] = await Promise.all([
    supabase
      .from("tasks")
      .select(
        "id, title, due_date, due_time, duration_min, status, priority, ai_state, notes, group_id, gcal_event_id, gcal_calendar_id, created_at, completed_at, estimated_minutes, missed_at, groups(name, color)",
      )
      .in("status", ["todo", "doing"])
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
    supabase
      .from("recurring_tasks")
      .select(
        "id, title, frequency, weekdays, day_of_month, interval_days, start_date, due_time, duration_min, groups(name, color)",
      )
      .eq("archived", false)
      .not("due_time", "is", null),
    supabase
      .from("recurring_task_completions")
      .select("rule_id, occurred_on")
      .gte("occurred_on", startDate)
      .lt("occurred_on", endDate),
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

  const recurringTasks: CalendarRecurringTask[] = (
    (recurringResponse.data ?? []) as unknown as RawRecurringTask[]
  ).map(({ groups, ...rest }) => {
    const group = Array.isArray(groups) ? (groups[0] ?? null) : groups;
    return {
      ...rest,
      group_name: group?.name ?? null,
      group_color: group?.color ?? null,
    };
  });

  return {
    tasks,
    groups,
    calendarLinks,
    calendarTasks,
    finance,
    recurringTasks,
    recurringCompletions: (completionsResponse.data ?? []) as {
      rule_id: string;
      occurred_on: string;
    }[],
    events: eventsResult.events,
    calendarStatus: eventsResult.status,
  };
});
