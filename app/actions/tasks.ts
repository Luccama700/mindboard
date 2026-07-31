"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { createEvent, updateEvent } from "@/utils/google/calendar";
import { getUserPreferences } from "@/app/lib/data/settings";
import { appendSection } from "@/app/lib/notes";
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
  estimated_minutes: number | null;
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
    const end = addMinutesToTime(
      start.slice(0, 5),
      task.duration_min ?? task.estimated_minutes ?? 30,
    );
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
  estimatedMinutes?: number | null;
}) {
  const title = input.title?.trim();
  if (!title) return { error: "title required" };
  const notes = input.notes?.trim() || null;
  const dueTime = input.dueTime ?? null;
  if (dueTime !== null && !TIME_RE.test(dueTime)) {
    return { error: "invalid time" };
  }
  if (
    input.estimatedMinutes !== undefined &&
    input.estimatedMinutes !== null &&
    (!Number.isInteger(input.estimatedMinutes) || input.estimatedMinutes <= 0)
  ) {
    return { error: "invalid estimate" };
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
      ...(input.estimatedMinutes !== undefined
        ? { estimated_minutes: input.estimatedMinutes }
        : {}),
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

// "missed" is a manual, accountability-focused terminal state for overdue tasks
// (like done, but negative). No-op-with-error if the task is already resolved.
export async function markTaskMissed(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: task, error: loadError } = await supabase
    .from("tasks")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (loadError) return { error: loadError.message };
  if (!task) return { error: "task not found" };
  if (task.status === "done" || task.status === "missed") {
    return { error: `already ${task.status}` };
  }

  const { error } = await supabase
    .from("tasks")
    .update({ status: "missed", missed_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}

// Return a done/missed task to the open list.
export async function reopenTask(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("tasks")
    .update({ status: "todo", missed_at: null, completed_at: null })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}

export async function updateTask(input: {
  id: string;
  title?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  durationMin?: number | null;
  estimatedMinutes?: number | null;
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
  if (input.estimatedMinutes !== undefined) {
    if (
      input.estimatedMinutes !== null &&
      (!Number.isInteger(input.estimatedMinutes) || input.estimatedMinutes <= 0)
    ) {
      return { error: "invalid estimate" };
    }
    updates.estimated_minutes = input.estimatedMinutes;
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
      "title, due_date, due_time, duration_min, estimated_minutes, gcal_event_id, gcal_calendar_id",
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
      "id, title, due_date, due_time, duration_min, estimated_minutes, gcal_event_id, group_id, groups(google_calendar_id)",
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
    (task.duration_min as number | null) ??
      (task.estimated_minutes as number | null) ??
      30,
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

// User-side control of the overnight-agent lifecycle
// (docs/overnight-agent-plan.md): approve a plan, send a build back to
// planned, or clear the state entirely. The orchestrator's own transitions
// (planned/building/built/failed) go through the MCP propose → confirm rails.
export async function setTaskAiState(
  id: string,
  state: "approved" | "planned" | null,
) {
  if (state !== null && state !== "approved" && state !== "planned") {
    return { error: "invalid state" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("tasks")
    .update({ ai_state: state })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}

// "Run agent now": stamp a request the PC's 5-minute poll picks up via the
// claim_agent_run MCP tool (docs/overnight-agent-plan.md). Session-authed and
// idempotent — re-tapping just refreshes the timestamp. Owner-gated to match
// the UI: only the owner's PAT is polled, so anyone else's request would sit
// unclaimed forever.
export async function requestAgentRun() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  try {
    const { ownerUserId } = await import("@/app/lib/mcp/config");
    if (ownerUserId() !== user.id) {
      return { error: "no agent PC serves this account" };
    }
  } catch {
    return { error: "agent runs are not configured on this deployment" };
  }

  const { error } = await supabase.from("user_settings").upsert(
    { user_id: user.id, agent_run_requested_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };
  return { error: null };
}

// "✦ do it": dispatch one open task to the home worker with a one-shot
// operator note (spec:
// docs/superpowers/specs/2026-07-31-task-dispatch-design.md). The dispatch row
// is the queue entry the worker claims; the note is ALSO appended to the task
// notes, which stay the human-readable source of truth. Approving the task and
// stamping the agent-run request is what makes the PC pick it up on its next
// 5-minute poll. Owner-gated like requestAgentRun — only the owner's PAT polls.
export async function requestTaskDispatch(input: {
  taskId: string;
  note: string;
}): Promise<{ error: string | null; dispatchId?: string }> {
  const note = input.note?.trim();
  if (!note) return { error: "note required" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  try {
    const { ownerUserId } = await import("@/app/lib/mcp/config");
    if (ownerUserId() !== user.id) {
      return { error: "no agent PC serves this account" };
    }
  } catch {
    return { error: "no agent PC serves this account" };
  }

  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .select("id, notes, status")
    .eq("id", input.taskId)
    .single();
  if (taskErr || !task) return { error: "task not found" };
  if (task.status === "done" || task.status === "missed") {
    return { error: `task is already ${task.status}` };
  }

  // One live dispatch per task: a second note while the first is still in
  // flight would race the worker's own write-back.
  const { data: open } = await supabase
    .from("task_dispatches")
    .select("id")
    .eq("user_id", user.id)
    .eq("task_id", task.id)
    .in("status", ["requested", "claimed", "running"])
    .limit(1);
  if ((open ?? []).length > 0) return { error: "already dispatched" };

  const { data: dispatch, error: insErr } = await supabase
    .from("task_dispatches")
    .insert({ user_id: user.id, task_id: task.id, note, status: "requested" })
    .select("id")
    .single();
  if (insErr || !dispatch) {
    // 23505: the partial unique index caught a double-tap the read missed.
    const raced = (insErr as { code?: string } | null)?.code === "23505";
    return { error: raced ? "already dispatched" : "could not create dispatch" };
  }

  // Anything that fails from here leaves a queue row nothing will ever run,
  // so the row goes back out before the error does.
  const rollback = async () => {
    await supabase.from("task_dispatches").delete().eq("id", dispatch.id);
  };

  // No ai_state here: 'approved' is the nightly sweep's queue, and a dispatch
  // is not that. The worker stamps 'building' when it actually starts.
  const today = new Date().toISOString().slice(0, 10);
  const { error: updErr } = await supabase
    .from("tasks")
    .update({
      notes: appendSection(task.notes, `Operator note (${today})`, note),
    })
    .eq("id", task.id);
  if (updErr) {
    await rollback();
    return { error: "could not update task" };
  }

  const { error: stampErr } = await supabase.from("user_settings").upsert(
    { user_id: user.id, agent_run_requested_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (stampErr) {
    await rollback();
    return { error: "could not wake the agent" };
  }

  revalidatePath("/", "layout");
  return { error: null, dispatchId: dispatch.id };
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
