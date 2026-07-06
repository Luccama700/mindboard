"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/utils/supabase/server";
import { encryptSecret } from "@/app/lib/assistant/crypto";
import { loadProposal, resolveProposal } from "@/app/lib/mcp/audit";
import { EXECUTORS } from "@/app/lib/mcp/writes";
import { validateCreateTask, type Result } from "@/app/lib/mcp/validate";
import { pushTaskToCalendar, updateTask } from "@/app/actions/tasks";

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

export async function saveAssistantKey(input: {
  key: string;
}): Promise<{ error: string | null }> {
  const key = input.key?.trim() ?? "";
  if (!KEY_RE.test(key)) {
    return { error: "that does not look like an anthropic api key" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  let encrypted: string;
  try {
    encrypted = encryptSecret(key);
  } catch {
    return { error: "server key storage is not configured (ASSISTANT_KEY_SECRET)" };
  }

  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      anthropic_api_key: encrypted,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };

  revalidatePath("/plan");
  revalidatePath("/settings");
  return { error: null };
}

export async function clearAssistantKey(): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("user_settings")
    .update({ anthropic_api_key: null, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath("/plan");
  revalidatePath("/settings");
  return { error: null };
}

// ---- confirm / cancel: the only paths on which an assistant write executes.

async function executeCreateTaskWithTime(
  supabase: SupabaseClient,
  userId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateCreateTask(input);
  if (!parsed.ok) return parsed;
  const dueTime =
    typeof input.dueTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.dueTime)
      ? `${input.dueTime}:00`
      : null;

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: userId,
      group_id: parsed.value.groupId,
      title: parsed.value.title,
      due_date: parsed.value.dueDate,
      due_time: parsed.value.dueDate ? dueTime : null,
      notes: parsed.value.notes,
      priority: parsed.value.priority,
    })
    .select("id, title, due_date, due_time")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
  return { ok: true, value: { task: data } };
}

async function executeScheduleTask(
  userId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const taskId = String(input.taskId ?? "");
  const dueDate = String(input.dueDate ?? "");
  const dueTime = String(input.dueTime ?? "");
  const durationMin = Number(input.durationMin ?? 30);

  const updated = await updateTask({
    id: taskId,
    dueDate,
    dueTime,
    durationMin,
  });
  if (updated.error) return { ok: false, error: updated.error };

  if (input.pushToCalendar === true) {
    const pushed = await pushTaskToCalendar(taskId);
    if (pushed.error && pushed.error !== "already on the calendar") {
      return {
        ok: true,
        value: { scheduled: true, calendarPushFailed: pushed.error },
      };
    }
    return { ok: true, value: { scheduled: true, pushed: true } };
  }
  return { ok: true, value: { scheduled: true } };
}

async function executeUpsertGoal(
  supabase: SupabaseClient,
  userId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const goalId = typeof input.goalId === "string" && input.goalId ? input.goalId : null;

  if (goalId) {
    const updates: Record<string, unknown> = {};
    if (typeof input.title === "string" && input.title) updates.title = input.title;
    if (typeof input.why === "string") updates.why = input.why;
    if (typeof input.horizon === "string") updates.horizon = input.horizon;
    if (typeof input.status === "string") {
      updates.status = input.status;
      updates.completed_at =
        input.status === "done" ? new Date().toISOString() : null;
    }
    if (typeof input.targetDate === "string") updates.target_date = input.targetDate;
    const { data, error } = await supabase
      .from("goals")
      .update(updates)
      .eq("id", goalId)
      .eq("user_id", userId)
      .select("id, title, status")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "goal not found" };
    return { ok: true, value: { goal: data } };
  }

  const { data, error } = await supabase
    .from("goals")
    .insert({
      user_id: userId,
      title: String(input.title ?? ""),
      why: typeof input.why === "string" ? input.why : null,
      horizon: typeof input.horizon === "string" ? input.horizon : "quarter",
      target_date: typeof input.targetDate === "string" ? input.targetDate : null,
    })
    .select("id, title, status")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
  return { ok: true, value: { goal: data } };
}

export async function confirmProposal(
  proposalId: string,
): Promise<{ error: string | null; preview?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const proposal = await loadProposal(supabase, user.id, proposalId);
  if (!proposal) return { error: "proposal not found or already resolved" };

  let outcome: Result<Record<string, unknown>>;
  switch (proposal.tool_name) {
    case "create_task":
      outcome = await executeCreateTaskWithTime(supabase, user.id, proposal.input);
      break;
    case "schedule_task":
      outcome = await executeScheduleTask(user.id, proposal.input);
      break;
    case "upsert_goal":
      outcome = await executeUpsertGoal(supabase, user.id, proposal.input);
      break;
    default: {
      const executor = EXECUTORS[proposal.tool_name];
      if (!executor) {
        await resolveProposal(supabase, user.id, proposalId, "error", {
          error: `unknown tool ${proposal.tool_name}`,
        });
        return { error: `unknown tool ${proposal.tool_name}` };
      }
      outcome = await executor(supabase, user.id, proposal.input);
    }
  }

  if (!outcome.ok) {
    await resolveProposal(supabase, user.id, proposalId, "error", {
      error: outcome.error,
    });
    return { error: outcome.error };
  }

  const claimed = await resolveProposal(
    supabase,
    user.id,
    proposalId,
    "executed",
    outcome.value,
  );
  if (!claimed) return { error: "proposal was already resolved" };

  revalidatePath("/", "layout");
  return { error: null, preview: proposal.summary };
}

export async function cancelProposal(
  proposalId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const ok = await resolveProposal(supabase, user.id, proposalId, "rejected", null);
  if (!ok) return { error: "proposal not found or already resolved" };
  revalidatePath("/", "layout");
  return { error: null };
}
