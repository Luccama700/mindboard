"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import { assignEnergyIfUnset } from "@/app/lib/tasks/energy";
import {
  completeTaskCascade,
  missTaskCascade,
  reopenTaskCascade,
} from "@/app/lib/tasks/lifecycle";
import { proposeDecomposeTaskFor } from "@/app/lib/tasks/decompose";
import type { ProposedChild } from "@/app/lib/mcp/decompose-ops";
import { createEvent, updateEvent } from "@/utils/google/calendar";
import { getUserPreferences } from "@/app/lib/data/settings";
import { queueFollowupFromWatch } from "@/app/lib/watch/followup";
import { validateFollowup } from "@/app/lib/watch/protocol";
import { appendSection } from "@/app/lib/notes";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { TASK_COLUMNS } from "@/app/_components/types";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validEnergy(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 1 && value <= 5);
}

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
  energyCost?: number | null;
}) {
  const title = input.title?.trim();
  if (!title) return { error: "title required" };
  if (input.energyCost !== undefined && !validEnergy(input.energyCost)) {
    return { error: "energy must be 1-5" };
  }
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
      ...(input.energyCost != null
        ? { energy_cost: input.energyCost, energy_source: "user" }
        : {}),
    })
    .select(TASK_COLUMNS)
    .single();

  if (error) return { error: error.message };

  // The AI energy default lands after the response so capture never waits on
  // a model; the update is SQL-guarded on energy_source IS NULL.
  if (input.energyCost == null) {
    after(async () => {
      try {
        const { assigned } = await assignEnergyIfUnset(supabase, user.id, data.id);
        if (assigned !== null) revalidatePath("/", "layout");
      } catch {
        // best-effort: the cost simply stays unset
      }
    });
  }

  revalidatePath("/", "layout");
  return { error: null, task: data };
}

export async function toggleTaskStatus(id: string, currentStatus: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  // Parent/child cascades (last child done → parent done; parent done → all
  // children done; a child reopened → parent reopened) live in one place so
  // the MCP/watch executors agree with this tap.
  const nextStatus = currentStatus === "done" ? "todo" : "done";
  const result =
    nextStatus === "done"
      ? await completeTaskCascade(supabase, user.id, id)
      : await reopenTaskCascade(supabase, user.id, id);
  if (!result.ok) return { error: result.error };

  revalidatePath("/", "layout");
  return { error: null, nextStatus };
}

// "missed" is a manual, accountability-focused terminal state for overdue tasks
// (like done, but negative). No-op-with-error if the task is already resolved.
// A subtask never goes missed: it slides forward inside its window instead
// (`slidTo` carries the new not-before day, null when it was already on its
// last day), and only its parent can carry the missed record.
export async function markTaskMissed(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  // The slide writes a date column, so it must be the user's day.
  const prefs = await getUserPreferences(user.id);
  const today = todayISO(safeTimeZone(prefs.timezone));
  const result = await missTaskCascade(supabase, user.id, id, today);
  if (!result.ok) return { error: result.error };

  revalidatePath("/", "layout");
  return {
    error: null,
    slidTo: result.value.kind === "slid" ? result.value.notBefore : undefined,
  };
}

// Return a done/missed task to the open list.
export async function reopenTask(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const result = await reopenTaskCascade(supabase, user.id, id);
  if (!result.ok) return { error: result.error };

  revalidatePath("/", "layout");
  return { error: null };
}

async function guardWindow(
  supabase: SupabaseClient,
  taskId: string,
  dueDate: string | null,
  notBefore: string | null | undefined,
): Promise<string | null> {
  const { data } = await supabase
    .from("tasks")
    .select("parent_task_id")
    .eq("id", taskId)
    .maybeSingle();
  const parentId = (data as { parent_task_id: string | null } | null)?.parent_task_id ?? null;
  if (parentId && dueDate) {
    const { data: parent } = await supabase
      .from("tasks")
      .select("due_date")
      .eq("id", parentId)
      .maybeSingle();
    const parentDue = (parent as { due_date: string | null } | null)?.due_date ?? null;
    if (parentDue && dueDate > parentDue) {
      return `a step cannot be due after its task (${parentDue})`;
    }
  }
  if (dueDate === null) {
    const { count } = await supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("parent_task_id", taskId);
    if ((count ?? 0) > 0) return "a task with steps keeps its due date — the steps are planned from it";
    return null;
  }
  if (notBefore === undefined) {
    const own = await supabase
      .from("tasks")
      .update({ not_before: dueDate })
      .eq("id", taskId)
      .gt("not_before", dueDate);
    if (own.error) return own.error.message;
  }
  const kidsStart = await supabase
    .from("tasks")
    .update({ not_before: dueDate })
    .eq("parent_task_id", taskId)
    .gt("not_before", dueDate);
  if (kidsStart.error) return kidsStart.error.message;
  const kidsEnd = await supabase
    .from("tasks")
    .update({ due_date: dueDate })
    .eq("parent_task_id", taskId)
    .gt("due_date", dueDate);
  if (kidsEnd.error) return kidsEnd.error.message;
  return null;
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
  energyCost?: number | null;
  notBefore?: string | null;
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
    // A task without a date cannot hold a time-block, nor a window start
    // (tasks_not_before_within_window).
    if (input.dueDate === null && input.dueTime === undefined) {
      updates.due_time = null;
    }
    if (input.dueDate === null && input.notBefore === undefined) {
      updates.not_before = null;
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
  // Any edit from the user marks the value as theirs — a clear included, so
  // an AI rating still in flight (it only fills a null source) cannot put a
  // value back the user just removed.
  if (input.energyCost !== undefined) {
    if (!validEnergy(input.energyCost)) return { error: "energy must be 1-5" };
    updates.energy_cost = input.energyCost;
    updates.energy_source = "user";
  }
  if (input.notBefore !== undefined) {
    if (input.notBefore !== null && !DATE_RE.test(input.notBefore)) {
      return { error: "invalid not-before date" };
    }
    updates.not_before = input.notBefore;
  }

  if (Object.keys(updates).length === 0) return { error: null };

  const scheduleTouched =
    input.dueDate !== undefined ||
    input.dueTime !== undefined ||
    input.durationMin !== undefined;

  // Windows stay well-formed when a due date moves: a subtask cannot be due
  // after its parent, a parent with steps cannot lose its deadline, a
  // subtask's own not_before follows an earlier due date
  // (tasks_not_before_within_window), and a parent's children are pulled in
  // behind a new earlier deadline.
  if (input.dueDate !== undefined) {
    const guard = await guardWindow(supabase, input.id, input.dueDate, input.notBefore);
    if (guard) return { error: guard };
  }

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
// The PC's poll (run.mjs --if-requested) claims agent_run_requested_at over
// the OWNER's personal MCP token, which is user-scoped — so only the owner's
// stamp is ever picked up. Same gate as the stream's ✦ do it.
async function servesAgentRuns(userId: string): Promise<boolean> {
  try {
    const { ownerUserId } = await import("@/app/lib/mcp/config");
    return ownerUserId() === userId;
  } catch {
    return false;
  }
}

// Returns the upsert error message, or null when the stamp landed.
async function stampAgentRun(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { error } = await supabase.from("user_settings").upsert(
    { user_id: userId, agent_run_requested_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  return error ? error.message : null;
}

export async function setTaskAiState(
  id: string,
  state: "approved" | "planned" | null,
): Promise<{ error: string | null; stamped: boolean; stampError: string | null }> {
  if (state !== null && state !== "approved" && state !== "planned") {
    return { error: "invalid state", stamped: false, stampError: null };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated", stamped: false, stampError: null };

  const { error } = await supabase
    .from("tasks")
    .update({ ai_state: state })
    .eq("id", id);

  if (error) return { error: error.message, stamped: false, stampError: null };

  // Approve means "act on it now": stamp the run request so the 5-minute poll
  // runs a sweep (docs/superpowers/specs/2026-09-09-agent-handoff-design.md).
  // Best-effort — the state change above already landed.
  let stamped = false;
  let stampError: string | null = null;
  if (state === "approved" && (await servesAgentRuns(user.id))) {
    stampError = await stampAgentRun(supabase, user.id);
    stamped = stampError === null;
  }

  revalidatePath("/", "layout");
  return { error: null, stamped, stampError };
}

// The task edit panel's "follow up": the same `followup` job the watch queues
// (app/lib/watch/followup.ts), so Claude Code on the home worker does the
// research and adds one follow-up task. Nothing to revalidate — the result
// only appears once the PC has run the job.
export async function queueTaskFollowup(id: string, text: string) {
  const parsed = validateFollowup({ id, text });
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const outcome = await queueFollowupFromWatch(
    user.id,
    parsed.value.id,
    parsed.value.text,
    null,
    "mindboard app",
  );
  if (!outcome.ok) return { error: outcome.error };
  return { error: null, jobId: String(outcome.result.jobId ?? "") };
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
  if (!(await servesAgentRuns(user.id))) {
    return { error: "no agent PC serves this account" };
  }
  const stampError = await stampAgentRun(supabase, user.id);
  return { error: stampError };
}

// "✦ do it": dispatch one open task to the home worker with a one-shot
// operator note (spec:
// docs/superpowers/specs/2026-07-31-task-dispatch-design.md). The dispatch row
// is the queue entry the worker claims; the note is ALSO appended to the task
// notes, which stay the human-readable source of truth.
//
// Deliberately does NOT stamp agent_run_requested_at: the PC's 5-minute poll
// drains this queue unconditionally, so the row alone is enough to be picked
// up. That stamp stays what it has always been — the "run the full sweep now"
// signal owned by ✦ run agent now — and a dispatch must not trigger a nightly
// sweep as a side effect. Owner-gated like requestAgentRun: only the owner's
// PAT polls, so for anyone else the row would never be claimed.
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

  // The note goes in BEFORE the queue row, so a half-done dispatch can only
  // ever leave a harmless extra note section — never a queue row the worker
  // will act on without its note, and never a state that needs undoing (a
  // rollback here would run on the same connection that just failed).
  //
  // ai_state goes to null in the same write: 'approved' is the nightly
  // sweep's queue and a dispatch is not that, and clearing a stale ✦ done /
  // ✦ failed stops the card contradicting the sheet. The worker sets
  // 'building' when the run actually starts.
  // The user's day, not the UTC process clock (AGENTS.md, timezone convention).
  const prefs = await getUserPreferences(user.id);
  const today = todayISO(safeTimeZone(prefs.timezone));
  const { error: updErr } = await supabase
    .from("tasks")
    .update({
      notes: appendSection(task.notes, `Operator note (${today})`, note),
      ai_state: null,
    })
    .eq("id", task.id);
  if (updErr) return { error: "could not update task" };

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

// "Break down": propose 2-6 subtasks for one task. Nothing is written — the
// returned proposal renders in a ProposalCard and confirmProposal (the same
// rail the assistant's writes use) creates the children on the user's tap.
export async function proposeBreakdown(taskId: string): Promise<{
  error: string | null;
  proposalId?: string;
  preview?: string;
  children?: ProposedChild[];
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const prefs = await getUserPreferences(user.id);
  const today = todayISO(safeTimeZone(prefs.timezone));
  const r = await proposeDecomposeTaskFor(
    supabase,
    user.id,
    { taskId },
    today,
    { source: "assistant" },
  );
  if (!r.ok) return { error: r.error };
  return {
    error: null,
    proposalId: r.value.proposalId,
    preview: r.value.preview,
    children: r.value.children,
  };
}

// The ProposalCard's two buttons for a breakdown. Dynamic import: the
// assistant actions module imports this one, so a static import would be a
// cycle; the confirm rail itself (claim → EXECUTORS.decompose_task → finalize)
// is exactly the assistant's.
export async function confirmBreakdown(proposalId: string) {
  const { confirmProposal } = await import("@/app/actions/assistant");
  return confirmProposal(proposalId);
}

export async function cancelBreakdown(proposalId: string) {
  const { cancelProposal } = await import("@/app/actions/assistant");
  return cancelProposal(proposalId);
}
