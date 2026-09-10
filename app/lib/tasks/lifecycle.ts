import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { addDaysKey } from "@/app/_components/finance-projection";

// Parent/child status rules for decomposed tasks (migration 0053), shared by
// the cookie-session actions and the MCP/watch executors so both agree:
//
//   done     the last open child completes the parent; completing the parent
//            completes every open child. Reopening a child reopens a resolved
//            parent (its "n of m" would otherwise lie).
//   missed   only a parent can go missed (its children follow). A child that
//            is skipped SLIDES instead: not_before moves to tomorrow, clamped
//            to its due_date, and the planner re-places it. Status untouched.
//
// Every query pins user_id: the callers on the service client rely on it.

const OPEN = ["todo", "doing"] as const;

type Row = {
  id: string;
  status: "todo" | "doing" | "done" | "missed";
  parent_task_id: string | null;
  due_date: string | null;
  not_before: string | null;
};

async function loadTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<Row | null> {
  const { data } = await supabase
    .from("tasks")
    .select("id, status, parent_task_id, due_date, not_before")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

async function openChildCount(
  supabase: SupabaseClient,
  userId: string,
  parentId: string,
): Promise<number> {
  const { count } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("parent_task_id", parentId)
    .in("status", [...OPEN]);
  return count ?? 0;
}

export type CompleteOutcome = {
  task: Row;
  parentCompleted: boolean;
  childrenCompleted: number;
};

export async function completeTaskCascade(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  now: Date = new Date(),
): Promise<{ ok: true; value: CompleteOutcome } | { ok: false; error: string }> {
  const task = await loadTask(supabase, userId, taskId);
  if (!task) return { ok: false, error: "task not found" };
  const stamp = { status: "done", completed_at: now.toISOString(), missed_at: null };

  const { error } = await supabase
    .from("tasks")
    .update(stamp)
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) return { ok: false, error: error.message };

  let parentCompleted = false;
  let childrenCompleted = 0;
  if (task.parent_task_id) {
    if ((await openChildCount(supabase, userId, task.parent_task_id)) === 0) {
      const { data } = await supabase
        .from("tasks")
        .update(stamp)
        .eq("id", task.parent_task_id)
        .eq("user_id", userId)
        .in("status", [...OPEN])
        .select("id");
      parentCompleted = (data ?? []).length > 0;
    }
  } else {
    const { data } = await supabase
      .from("tasks")
      .update(stamp)
      .eq("user_id", userId)
      .eq("parent_task_id", taskId)
      .in("status", [...OPEN])
      .select("id");
    childrenCompleted = (data ?? []).length;
  }
  return {
    ok: true,
    value: { task: { ...task, status: "done" }, parentCompleted, childrenCompleted },
  };
}

// Back to the open list. A child coming back reopens its resolved parent.
export async function reopenTaskCascade(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<{ ok: true; value: { parentReopened: boolean } } | { ok: false; error: string }> {
  const task = await loadTask(supabase, userId, taskId);
  if (!task) return { ok: false, error: "task not found" };
  const reset = { status: "todo", missed_at: null, completed_at: null };

  const { error } = await supabase
    .from("tasks")
    .update(reset)
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) return { ok: false, error: error.message };

  let parentReopened = false;
  if (task.parent_task_id) {
    const { data } = await supabase
      .from("tasks")
      .update(reset)
      .eq("id", task.parent_task_id)
      .eq("user_id", userId)
      .in("status", ["done", "missed"])
      .select("id");
    parentReopened = (data ?? []).length > 0;
  }
  return { ok: true, value: { parentReopened } };
}

// The day a skipped child may next be planned: tomorrow, but never past its
// window end. A child already on its last day stays there (null = no slide).
export function slideTarget(
  child: { due_date: string | null; not_before: string | null },
  today: string,
): string | null {
  if (!child.due_date) return null;
  const tomorrow = addDaysKey(today, 1);
  const target = tomorrow < child.due_date ? tomorrow : child.due_date;
  if (child.not_before && child.not_before >= target) return null;
  return target;
}

export type MissOutcome =
  | { kind: "missed"; task: Row; childrenMissed: number }
  | { kind: "slid"; task: Row; notBefore: string | null };

// Missing a parent is the accountability record (children follow). A child
// never goes missed: it slides within its window.
export async function missTaskCascade(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  today: string,
  now: Date = new Date(),
): Promise<{ ok: true; value: MissOutcome } | { ok: false; error: string }> {
  const task = await loadTask(supabase, userId, taskId);
  if (!task) return { ok: false, error: "task not found" };
  if (task.status === "done" || task.status === "missed") {
    return { ok: false, error: `already ${task.status}` };
  }

  if (task.parent_task_id) {
    const notBefore = slideTarget(task, today);
    if (notBefore !== null) {
      const { error } = await supabase
        .from("tasks")
        .update({ not_before: notBefore })
        .eq("id", taskId)
        .eq("user_id", userId);
      if (error) return { ok: false, error: error.message };
    }
    return {
      ok: true,
      value: { kind: "slid", task: { ...task, not_before: notBefore ?? task.not_before }, notBefore },
    };
  }

  const stamp = { status: "missed", missed_at: now.toISOString() };
  const { error } = await supabase
    .from("tasks")
    .update(stamp)
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) return { ok: false, error: error.message };
  const { data } = await supabase
    .from("tasks")
    .update(stamp)
    .eq("user_id", userId)
    .eq("parent_task_id", taskId)
    .in("status", [...OPEN])
    .select("id");
  return {
    ok: true,
    value: {
      kind: "missed",
      task: { ...task, status: "missed" },
      childrenMissed: (data ?? []).length,
    },
  };
}
