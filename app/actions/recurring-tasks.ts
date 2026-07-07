"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { todayISO } from "@/app/_components/date-utils";
import {
  RECURRING_TASK_COLUMNS,
} from "@/app/lib/data/recurring-tasks";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FREQUENCIES = new Set(["daily", "weekly", "monthly", "custom"]);
const PRIORITIES = new Set(["low", "med", "high"]);

export type RecurringTaskInput = {
  title: string;
  groupId?: string | null;
  notes?: string | null;
  priority?: "low" | "med" | "high";
  frequency: "daily" | "weekly" | "monthly" | "custom";
  weekdays?: number[] | null;
  dayOfMonth?: number | null;
  intervalDays?: number | null;
  startDate?: string | null;
  dueTime?: string | null;
  durationMin?: number | null;
};

// Validates + normalizes the recurrence half of the input. Returns the column
// patch or an error, mirroring the recurring_expenses action helpers.
function recurrenceColumns(input: {
  frequency: string;
  weekdays?: number[] | null;
  dayOfMonth?: number | null;
  intervalDays?: number | null;
  startDate?: string | null;
}): { error: string } | { error: null; columns: Record<string, unknown> } {
  if (!FREQUENCIES.has(input.frequency)) return { error: "invalid frequency" };

  const columns: Record<string, unknown> = {
    frequency: input.frequency,
    weekdays: null,
    day_of_month: null,
    interval_days: null,
    start_date: null,
  };

  if (input.frequency === "weekly") {
    const weekdays = [
      ...new Set((input.weekdays ?? []).map((d) => Math.trunc(Number(d)))),
    ].sort((a, b) => a - b);
    if (
      weekdays.length === 0 ||
      weekdays.some((d) => !Number.isFinite(d) || d < 0 || d > 6)
    ) {
      return { error: "weekly needs at least one weekday (0-6)" };
    }
    columns.weekdays = weekdays;
  } else if (input.frequency === "monthly") {
    const day = Math.trunc(Number(input.dayOfMonth));
    if (!Number.isFinite(day) || day < 1 || day > 31) {
      return { error: "monthly needs a day of month (1-31)" };
    }
    columns.day_of_month = day;
  } else if (input.frequency === "custom") {
    const interval = Math.trunc(Number(input.intervalDays));
    if (!Number.isFinite(interval) || interval < 1) {
      return { error: "custom needs an interval of 1+ days" };
    }
    const start = input.startDate ?? todayISO();
    if (!DATE_RE.test(start)) return { error: "invalid start date" };
    columns.interval_days = interval;
    columns.start_date = start;
  }

  return { error: null, columns };
}

function timingColumns(input: {
  dueTime?: string | null;
  durationMin?: number | null;
}): { error: string } | { error: null; columns: Record<string, unknown> } {
  const dueTime = input.dueTime ?? null;
  if (dueTime !== null && !TIME_RE.test(dueTime)) {
    return { error: "invalid time" };
  }
  let durationMin: number | null = null;
  if (input.durationMin !== undefined && input.durationMin !== null) {
    const d = Math.trunc(Number(input.durationMin));
    if (!Number.isFinite(d) || d < 15) return { error: "duration must be 15+ minutes" };
    durationMin = d;
  }
  return {
    error: null,
    columns: {
      due_time:
        dueTime === null
          ? null
          : dueTime.length === 5
            ? `${dueTime}:00`
            : dueTime,
      duration_min: dueTime === null ? null : durationMin,
    },
  };
}

export async function createRecurringTask(input: RecurringTaskInput) {
  const title = input.title?.trim();
  if (!title) return { error: "title required" };
  if (input.priority !== undefined && !PRIORITIES.has(input.priority)) {
    return { error: "invalid priority" };
  }

  const recurrence = recurrenceColumns(input);
  if (recurrence.error !== null) return { error: recurrence.error };
  const timing = timingColumns(input);
  if (timing.error !== null) return { error: timing.error };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("recurring_tasks")
    .insert({
      user_id: user.id,
      group_id: input.groupId ?? null,
      title,
      notes: input.notes?.trim() || null,
      ...(input.priority ? { priority: input.priority } : {}),
      ...recurrence.columns,
      ...timing.columns,
    })
    .select(RECURRING_TASK_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null, rule: data };
}

export async function updateRecurringTask(
  input: { id: string } & Partial<RecurringTaskInput>,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const updates: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) return { error: "title required" };
    updates.title = title;
  }
  if (input.groupId !== undefined) updates.group_id = input.groupId;
  if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;
  if (input.priority !== undefined) {
    if (!PRIORITIES.has(input.priority)) return { error: "invalid priority" };
    updates.priority = input.priority;
  }
  if (input.frequency !== undefined) {
    const recurrence = recurrenceColumns({
      frequency: input.frequency,
      weekdays: input.weekdays,
      dayOfMonth: input.dayOfMonth,
      intervalDays: input.intervalDays,
      startDate: input.startDate,
    });
    if (recurrence.error !== null) return { error: recurrence.error };
    Object.assign(updates, recurrence.columns);
  }
  if (input.dueTime !== undefined || input.durationMin !== undefined) {
    const timing = timingColumns(input);
    if (timing.error !== null) return { error: timing.error };
    Object.assign(updates, timing.columns);
  }

  if (Object.keys(updates).length === 0) return { error: null };

  const { error } = await supabase
    .from("recurring_tasks")
    .update(updates)
    .eq("id", input.id)
    .eq("user_id", user.id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}

export async function archiveRecurringTask(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("recurring_tasks")
    .update({ archived: true })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}

// Idempotent: the unique (rule_id, occurred_on) makes a double-tap a no-op.
// Only today is completable — occurrences skip silently, so there is no
// yesterday to check off.
export async function completeRecurringOccurrence(ruleId: string, dateKey: string) {
  if (dateKey !== todayISO()) return { error: "only today can be completed" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("recurring_task_completions")
    .upsert(
      { user_id: user.id, rule_id: ruleId, occurred_on: dateKey },
      { onConflict: "rule_id,occurred_on", ignoreDuplicates: true },
    );

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}

export async function uncompleteRecurringOccurrence(
  ruleId: string,
  dateKey: string,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("recurring_task_completions")
    .delete()
    .eq("rule_id", ruleId)
    .eq("occurred_on", dateKey)
    .eq("user_id", user.id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}
