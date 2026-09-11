import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { addDaysKey } from "@/app/_components/finance-projection";

// Parent/child status rules for decomposed tasks (migration 0053), shared by
// the cookie-session actions and the MCP/watch executors so both agree:
//
//   done     the last open child completes the parent; completing the parent
//            completes every open child. Reopening a child reopens a resolved
//            parent (its "n of m" would otherwise lie).
//   missed   ONLY a parent ever carries 'missed'. Its children are left as
//            they are: every read hides the children of a non-open parent, and
//            reopening the parent brings them straight back. A child that is
//            skipped SLIDES instead: not_before moves to tomorrow, clamped to
//            its due_date, and the planner re-places it. Status untouched.
//
// Every query pins user_id: the callers on the service client rely on it.
// Every statement's error is surfaced — a failed sibling count must never read
// as "no siblings", and a failed child write must never report a clean parent.
// The steps are not one transaction (Supabase JS has none); the parent write
// is guarded on its own status so a raced completion is a no-op, not a
// double-apply.

const OPEN = ["todo", "doing"] as const;

type Row = {
  id: string;
  title: string;
  status: "todo" | "doing" | "done" | "missed";
  parent_task_id: string | null;
  due_date: string | null;
  not_before: string | null;
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

async function loadTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<Outcome<Row>> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, parent_task_id, due_date, not_before")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "task not found" };
  return { ok: true, value: data as Row };
}

async function openChildCount(
  supabase: SupabaseClient,
  userId: string,
  parentId: string,
): Promise<Outcome<number>> {
  const { count, error } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("parent_task_id", parentId)
    .in("status", [...OPEN]);
  if (error) return { ok: false, error: error.message };
  if (count === null || count === undefined) {
    return { ok: false, error: "could not count open subtasks" };
  }
  return { ok: true, value: count };
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
): Promise<Outcome<CompleteOutcome>> {
  const loaded = await loadTask(supabase, userId, taskId);
  if (!loaded.ok) return loaded;
  const task = loaded.value;
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
    const open = await openChildCount(supabase, userId, task.parent_task_id);
    if (!open.ok) return open;
    if (open.value === 0) {
      const { data, error: parentError } = await supabase
        .from("tasks")
        .update(stamp)
        .eq("id", task.parent_task_id)
        .eq("user_id", userId)
        .in("status", [...OPEN])
        .select("id");
      if (parentError) return { ok: false, error: parentError.message };
      parentCompleted = (data ?? []).length > 0;
    }
  } else {
    const { data, error: childError } = await supabase
      .from("tasks")
      .update(stamp)
      .eq("user_id", userId)
      .eq("parent_task_id", taskId)
      .in("status", [...OPEN])
      .select("id");
    if (childError) return { ok: false, error: childError.message };
    childrenCompleted = (data ?? []).length;
  }
  return {
    ok: true,
    value: { task: { ...task, status: "done" }, parentCompleted, childrenCompleted },
  };
}

// Back to the open list. A child coming back reopens its resolved parent; a
// parent coming back simply makes its (untouched) children visible again.
export async function reopenTaskCascade(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<Outcome<{ task: Row; parentReopened: boolean }>> {
  const loaded = await loadTask(supabase, userId, taskId);
  if (!loaded.ok) return loaded;
  const task = loaded.value;
  const reset = { status: "todo", missed_at: null, completed_at: null };

  const { error } = await supabase
    .from("tasks")
    .update(reset)
    .eq("id", taskId)
    .eq("user_id", userId);
  if (error) return { ok: false, error: error.message };

  let parentReopened = false;
  if (task.parent_task_id) {
    const { data, error: parentError } = await supabase
      .from("tasks")
      .update(reset)
      .eq("id", task.parent_task_id)
      .eq("user_id", userId)
      .in("status", ["done", "missed"])
      .select("id");
    if (parentError) return { ok: false, error: parentError.message };
    parentReopened = (data ?? []).length > 0;
  }
  return { ok: true, value: { task: { ...task, status: "todo" }, parentReopened } };
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
  | { kind: "missed"; task: Row }
  | { kind: "slid"; task: Row; notBefore: string | null };

// Missing a parent is the accountability record; its children are left alone
// (hidden with it, back with it). A child never goes missed: it slides.
export async function missTaskCascade(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  today: string,
  now: Date = new Date(),
): Promise<Outcome<MissOutcome>> {
  const loaded = await loadTask(supabase, userId, taskId);
  if (!loaded.ok) return loaded;
  const task = loaded.value;
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
      value: {
        kind: "slid",
        task: { ...task, not_before: notBefore ?? task.not_before },
        notBefore,
      },
    };
  }

  // Guarded on still-open so a completion that raced in wins, not this.
  const { data, error } = await supabase
    .from("tasks")
    .update({ status: "missed", missed_at: now.toISOString() })
    .eq("id", taskId)
    .eq("user_id", userId)
    .in("status", [...OPEN])
    .select("id");
  if (error) return { ok: false, error: error.message };
  if ((data ?? []).length === 0) {
    return { ok: false, error: "task was resolved meanwhile" };
  }
  return { ok: true, value: { kind: "missed", task: { ...task, status: "missed" } } };
}
