"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { createEvent, updateEvent } from "@/utils/google/calendar";
import { getUserPreferences } from "@/app/lib/data/settings";
import { TASK_COLUMNS } from "@/app/_components/types";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function normalizeTime(value: string): string {
  // "HH:MM" | "HH:MM:SS" -> "HH:MM:SS"
  return value.length === 5 ? `${value}:00` : value;
}

function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const capped = Math.min(total, 23 * 60 + 59);
  const hh = String(Math.floor(capped / 60)).padStart(2, "0");
  const mm = String(capped % 60).padStart(2, "0");
  return `${hh}:${mm}:00`;
}

type ScheduleRow = {
  title: string;
  due_date: string | null;
  due_time: string | null;
  duration_min: number | null;
  gcal_event_id: string | null;
  gcal_calendar_id: string | null;
};

// Mirror a pushed task's block to its Google event. Fails soft: a dangling or
// unreachable event never blocks the task write.
async function syncPushedTask(userId: string, task: ScheduleRow) {
  if (!task.gcal_event_id || !task.gcal_calendar_id) return;
  if (!task.due_date || !task.due_time) return;
  try {
    const prefs = await getUserPreferences(userId);
    const timeZone = prefs.timezone ?? "UTC";
    const start = normalizeTime(task.due_time);
    const end = addMinutesToTime(start.slice(0, 5), task.duration_min ?? 30);
    await updateEvent(userId, task.gcal_calendar_id, task.gcal_event_id, {
      start: { dateTime: `${task.due_date}T${start}`, timeZone },
      end: { dateTime: `${task.due_date}T${end}`, timeZone },
    });
  } catch {
    // fail soft — the local block is the source of truth
  }
}

export async function createTask(input: {
  title: string;
  groupId: string | null;
  dueDate: string | null;
  dueTime?: string | null;
  notes?: string | null;
  priority?: "low" | "med" | "high";
}) {
  const title = input.title?.trim();
  if (!title) return { error: "title required" };
  const notes = input.notes?.trim() || null;
  const dueTime = input.dueTime ?? null;
  if (dueTime !== null && !TIME_RE.test(dueTime)) {
    return { error: "invalid time" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: user.id,
      group_id: input.groupId,
      title,
      due_date: input.dueDate,
      due_time: dueTime && input.dueDate ? normalizeTime(dueTime) : null,
      notes,
      ...(input.priority ? { priority: input.priority } : {}),
    })
    .select(TASK_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null, task: data };
}

export async function toggleTaskStatus(id: string, currentStatus: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const nextStatus = currentStatus === "done" ? "todo" : "done";
  const completed_at = nextStatus === "done" ? new Date().toISOString() : null;

  const { error } = await supabase
    .from("tasks")
    .update({ status: nextStatus, completed_at })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null, nextStatus };
}

export async function updateTask(input: {
  id: string;
  title?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  durationMin?: number | null;
  groupId?: string | null;
  notes?: string | null;
  priority?: "low" | "med" | "high";
}) {
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
  if (input.dueDate !== undefined) {
    updates.due_date = input.dueDate;
    // A task without a date cannot hold a time-block.
    if (input.dueDate === null && input.dueTime === undefined) {
      updates.due_time = null;
    }
  }
  if (input.dueTime !== undefined) {
    if (input.dueTime !== null && !TIME_RE.test(input.dueTime)) {
      return { error: "invalid time" };
    }
    updates.due_time = input.dueTime ? normalizeTime(input.dueTime) : null;
  }
  if (input.durationMin !== undefined) {
    if (
      input.durationMin !== null &&
      (!Number.isFinite(input.durationMin) || input.durationMin < 15)
    ) {
      return { error: "duration must be at least 15 minutes" };
    }
    updates.duration_min = input.durationMin;
  }
  if (input.groupId !== undefined) updates.group_id = input.groupId;
  if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;
  if (input.priority !== undefined) updates.priority = input.priority;

  if (Object.keys(updates).length === 0) return { error: null };

  const scheduleTouched =
    input.dueDate !== undefined ||
    input.dueTime !== undefined ||
    input.durationMin !== undefined;

  const { data: updated, error } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", input.id)
    .select(
      "title, due_date, due_time, duration_min, gcal_event_id, gcal_calendar_id",
    )
    .single();

  if (error) return { error: error.message };

  if (scheduleTouched && updated) {
    await syncPushedTask(user.id, updated as ScheduleRow);
  }

  revalidatePath("/", "layout");
  return { error: null };
}

// Push a time-blocked task out as a real Google Calendar event, on the
// task's group-linked calendar when there is one, else the primary calendar.
export async function pushTaskToCalendar(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: task, error: loadError } = await supabase
    .from("tasks")
    .select(
      "id, title, due_date, due_time, duration_min, gcal_event_id, group_id, groups(google_calendar_id)",
    )
    .eq("id", id)
    .single();

  if (loadError) return { error: loadError.message };
  if (!task) return { error: "task not found" };
  if (task.gcal_event_id) return { error: "already on the calendar" };
  if (!task.due_date || !task.due_time) {
    return { error: "give the task a date and a time first" };
  }

  const groupRel = task.groups as
    | { google_calendar_id: string | null }
    | { google_calendar_id: string | null }[]
    | null;
  const group = Array.isArray(groupRel) ? (groupRel[0] ?? null) : groupRel;
  const calendarId = group?.google_calendar_id ?? "primary";

  const prefs = await getUserPreferences(user.id);
  const timeZone = prefs.timezone ?? "UTC";
  const start = normalizeTime(task.due_time as string);
  const end = addMinutesToTime(
    start.slice(0, 5),
    (task.duration_min as number | null) ?? 30,
  );

  let eventId: string;
  try {
    eventId = await createEvent(user.id, calendarId, {
      summary: task.title as string,
      start: { dateTime: `${task.due_date}T${start}`, timeZone },
      end: { dateTime: `${task.due_date}T${end}`, timeZone },
      description: "from mindboard",
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "calendar event failed",
    };
  }

  const { error: saveError } = await supabase
    .from("tasks")
    .update({ gcal_event_id: eventId, gcal_calendar_id: calendarId })
    .eq("id", id);
  if (saveError) return { error: saveError.message };

  revalidatePath("/", "layout");
  return { error: null };
}

export async function deleteTask(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("tasks").delete().eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}
