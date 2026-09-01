"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { createEvent } from "@/utils/google/calendar";
import { getUserPreferences } from "@/app/lib/data/settings";
import { endOfBlock } from "@/app/_components/date-utils";
import { todayKey } from "@/app/lib/mcp/config";
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
// patch or an error, mirroring the recurring_expenses action helpers. `today` is
// the caller's user-zone date key, used only as the custom-frequency start-date
// fallback — it is passed in rather than read off the process clock, which is
// UTC on Vercel.
function recurrenceColumns(
  input: {
    frequency: string;
    weekdays?: number[] | null;
    dayOfMonth?: number | null;
    intervalDays?: number | null;
    startDate?: string | null;
  },
  today: string,
): { error: string } | { error: null; columns: Record<string, unknown> } {
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
    const start = input.startDate ?? today;
    if (!DATE_RE.test(start)) return { error: "invalid start date" };
    columns.interval_days = interval;
    columns.start_date = start;
  }

  return { error: null, columns };
}

// due_time and duration_min are independent: a patch touches a column only when
// its field is present. Clearing the time (dueTime: null) leaves duration alone,
// so an untimed rule can still carry a duration for the gap planner to place.
function timingColumns(input: {
  dueTime?: string | null;
  durationMin?: number | null;
}): { error: string } | { error: null; columns: Record<string, unknown> } {
  const columns: Record<string, unknown> = {};
  if (input.dueTime !== undefined) {
    const dueTime = input.dueTime;
    if (dueTime !== null && !TIME_RE.test(dueTime)) {
      return { error: "invalid time" };
    }
    columns.due_time =
      dueTime === null
        ? null
        : dueTime.length === 5
          ? `${dueTime}:00`
          : dueTime;
  }
  if (input.durationMin !== undefined) {
    if (input.durationMin === null) {
      columns.duration_min = null;
    } else {
      const d = Math.trunc(Number(input.durationMin));
      if (!Number.isFinite(d) || d < 15) return { error: "duration must be 15+ minutes" };
      columns.duration_min = d;
    }
  }
  return { error: null, columns };
}

export async function createRecurringTask(input: RecurringTaskInput) {
  const title = input.title?.trim();
  if (!title) return { error: "title required" };
  if (input.priority !== undefined && !PRIORITIES.has(input.priority)) {
    return { error: "invalid priority" };
  }

  const timing = timingColumns(input);
  if (timing.error !== null) return { error: timing.error };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  // Resolved after auth because the start-date fallback has to land on the
  // user's local day, and that needs their id.
  const recurrence = recurrenceColumns(input, await todayKey(supabase, user.id));
  if (recurrence.error !== null) return { error: recurrence.error };

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
    const recurrence = recurrenceColumns(
      {
        frequency: input.frequency,
        weekdays: input.weekdays,
        dayOfMonth: input.dayOfMonth,
        intervalDays: input.intervalDays,
        startDate: input.startDate,
      },
      await todayKey(supabase, user.id),
    );
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
// yesterday to check off. "Today" is the USER'S today: the stream sends a
// zone-aware dateKey, so comparing against the UTC process clock rejected every
// completion after 17:00 in Vancouver.
export async function completeRecurringOccurrence(ruleId: string, dateKey: string) {
  if (!DATE_RE.test(dateKey)) return { error: "invalid date" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  if (dateKey !== (await todayKey(supabase, user.id))) {
    return { error: "only today can be completed" };
  }

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

// Approve a gap proposal into a persisted per-occurrence commitment. Unlike a
// completion this carries no today-guard: a slot can be placed on any future
// day. The upsert overwrites (no ignoreDuplicates) so re-approving/moving a slot
// on the same day replaces it. A cross-day move (fromDateKey !== dateKey) deletes
// the origin row after writing the new one.
export async function approveRecurringSlot(input: {
  ruleId: string;
  dateKey: string;
  start: string;
  durationMin?: number | null;
  fromDateKey?: string;
}) {
  if (!DATE_RE.test(input.dateKey)) return { error: "invalid date" };
  if (!TIME_RE.test(input.start)) return { error: "invalid time" };
  const startTime = input.start.length === 5 ? `${input.start}:00` : input.start;

  let durationMin: number | null = null;
  if (input.durationMin !== undefined && input.durationMin !== null) {
    const d = Math.trunc(Number(input.durationMin));
    if (!Number.isFinite(d) || d < 15) return { error: "duration must be 15+ minutes" };
    durationMin = d;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("recurring_task_slots").upsert(
    {
      user_id: user.id,
      rule_id: input.ruleId,
      occurred_on: input.dateKey,
      start_time: startTime,
      duration_min: durationMin,
    },
    { onConflict: "rule_id,occurred_on" },
  );

  if (error) return { error: error.message };

  if (input.fromDateKey !== undefined && input.fromDateKey !== input.dateKey) {
    const { error: moveError } = await supabase
      .from("recurring_task_slots")
      .delete()
      .eq("rule_id", input.ruleId)
      .eq("occurred_on", input.fromDateKey)
      .eq("user_id", user.id);
    if (moveError) return { error: moveError.message };
  }

  revalidatePath("/", "layout");
  return { error: null };
}

// Promote one occurrence into a real Google Calendar event: the event lands on
// the rule's group-linked calendar (else primary), the slot row records the
// event link, and the occurrence is marked done — composition then skips the
// rtask that day and the event stands in. The rule itself is untouched.
export async function promoteRecurringToEvent(input: {
  ruleId: string;
  occurredOn: string;
  title: string;
  start: string;
  durationMin: number;
}) {
  if (!DATE_RE.test(input.occurredOn)) return { error: "invalid date" };
  if (!TIME_RE.test(input.start)) return { error: "invalid time" };
  const title = input.title.trim();
  if (title.length === 0) return { error: "give the event a title" };
  const durationMin = Math.trunc(Number(input.durationMin));
  if (!Number.isFinite(durationMin) || durationMin < 15) {
    return { error: "duration must be 15+ minutes" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: rule, error: loadError } = await supabase
    .from("recurring_tasks")
    .select("id, group_id, groups(google_calendar_id)")
    .eq("id", input.ruleId)
    .eq("user_id", user.id)
    .single();
  if (loadError) return { error: loadError.message };
  if (!rule) return { error: "routine not found" };

  // Guard BEFORE creating anything on Google: a retry (or a second tab) must
  // not mint a duplicate real event. Pre-migration this select fails on the
  // missing column, which also fails the action before any event exists.
  const { data: existingSlot, error: slotLoadError } = await supabase
    .from("recurring_task_slots")
    .select("gcal_event_id")
    .eq("rule_id", input.ruleId)
    .eq("occurred_on", input.occurredOn)
    .eq("user_id", user.id)
    .maybeSingle();
  if (slotLoadError) return { error: slotLoadError.message };
  if (existingSlot?.gcal_event_id) return { error: "already on the calendar" };

  const groupRel = rule.groups as
    | { google_calendar_id: string | null }
    | { google_calendar_id: string | null }[]
    | null;
  const group = Array.isArray(groupRel) ? (groupRel[0] ?? null) : groupRel;
  const calendarId = group?.google_calendar_id ?? "primary";

  const prefs = await getUserPreferences(user.id);
  const timeZone = prefs.timezone ?? "UTC";
  const startTime = input.start.length === 5 ? `${input.start}:00` : input.start;
  const end = endOfBlock(input.occurredOn, startTime.slice(0, 5), durationMin);

  let eventId: string;
  try {
    eventId = await createEvent(user.id, calendarId, {
      summary: title,
      start: { dateTime: `${input.occurredOn}T${startTime}`, timeZone },
      end: { dateTime: `${end.date}T${end.time}`, timeZone },
      description: "from mindboard routine",
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "calendar event failed",
    };
  }

  const { error: slotError } = await supabase
    .from("recurring_task_slots")
    .upsert(
      {
        user_id: user.id,
        rule_id: input.ruleId,
        occurred_on: input.occurredOn,
        start_time: startTime,
        duration_min: durationMin,
        gcal_event_id: eventId,
        gcal_calendar_id: calendarId,
      },
      { onConflict: "rule_id,occurred_on" },
    );
  if (slotError) return { error: slotError.message };

  const { error: doneError } = await supabase
    .from("recurring_task_completions")
    .upsert(
      { user_id: user.id, rule_id: input.ruleId, occurred_on: input.occurredOn },
      { onConflict: "rule_id,occurred_on", ignoreDuplicates: true },
    );
  if (doneError) return { error: doneError.message };

  revalidatePath("/", "layout");
  return { error: null };
}

// Undo a promotion: drop the slot row (with its event link) and the completion,
// so the occurrence composes again. Mindboard never deletes Google events —
// the created event stays on the calendar until removed there.
export async function unpromoteRecurringEvent(ruleId: string, dateKey: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error: slotError } = await supabase
    .from("recurring_task_slots")
    .delete()
    .eq("rule_id", ruleId)
    .eq("occurred_on", dateKey)
    .eq("user_id", user.id);
  if (slotError) return { error: slotError.message };

  const { error: doneError } = await supabase
    .from("recurring_task_completions")
    .delete()
    .eq("rule_id", ruleId)
    .eq("occurred_on", dateKey)
    .eq("user_id", user.id);
  if (doneError) return { error: doneError.message };

  revalidatePath("/", "layout");
  return { error: null };
}

export async function clearRecurringSlot(ruleId: string, dateKey: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("recurring_task_slots")
    .delete()
    .eq("rule_id", ruleId)
    .eq("occurred_on", dateKey)
    .eq("user_id", user.id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}
