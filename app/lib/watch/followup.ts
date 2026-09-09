import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import { workerAllowedUserIds } from "@/app/lib/mcp/config";
import { idempotentProposalId } from "./protocol";
import type { WatchWriteOutcome } from "./writes";

// "Follow-up" on an open task — dictated from the watch, or typed in the task
// edit panel (`queueTaskFollowup` in app/actions/tasks.ts) — queued as a
// `followup` job for the home worker, where Claude Code turns it into a new
// task (same group, same due date) after doing whatever research it needs.
// Nothing runs on Vercel; the job just waits if the PC is off.
// Idempotent the same way the audit-log writes are: with an Idempotency-Key
// the job id is derived from (user, key), so a retry collides and reports the
// job that already exists instead of queuing a second run.

export const FOLLOWUP_INSTRUCTION_MAX = 4000;

type Rel<T> = T | T[] | null;
function firstRel<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);
}

type JobRow = {
  id: string;
  status: "queued" | "processing" | "done" | "failed";
  result: Record<string, unknown> | null;
  error: string | null;
};

async function loadJob(
  supabase: SupabaseClient,
  userId: string,
  id: string,
): Promise<JobRow | null> {
  const { data } = await supabase
    .from("jobs")
    .select("id, status, result, error")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as JobRow | null) ?? null;
}

function describe(job: JobRow, replayed: boolean): WatchWriteOutcome {
  return {
    ok: true,
    replayed,
    result: {
      jobId: job.id,
      status: job.status,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    },
  };
}

export type FollowupSource = "apple watch" | "mindboard app";

export async function queueFollowupFromWatch(
  userId: string,
  taskId: string,
  instruction: string,
  idempotencyKey: string | null,
  source: FollowupSource = "apple watch",
): Promise<WatchWriteOutcome> {
  if (!workerAllowedUserIds().includes(userId)) {
    return { ok: false, status: 503, error: "no home worker serves this account" };
  }
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("tasks")
    .select("id, title, notes, status, priority, due_date, due_time, group_id, groups(name)")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, status: 404, error: "task not found" };
  const task = data as unknown as {
    id: string;
    title: string;
    notes: string | null;
    status: string;
    priority: string;
    due_date: string | null;
    due_time: string | null;
    group_id: string | null;
    groups: Rel<{ name: string }>;
  };
  if (task.status === "done" || task.status === "missed") {
    return { ok: false, status: 400, error: `"${task.title}" is already ${task.status}` };
  }

  const id = idempotencyKey ? idempotentProposalId(userId, "followup", idempotencyKey) : null;
  const { data: inserted, error } = await supabase
    .from("jobs")
    .insert({
      ...(id ? { id } : {}),
      user_id: userId,
      kind: "followup",
      payload: {
        task_id: task.id,
        title: task.title,
        notes: task.notes,
        priority: task.priority,
        due_date: task.due_date,
        due_time: task.due_time,
        group_id: task.group_id,
        group_name: firstRel(task.groups)?.name ?? null,
        instruction,
        source,
      },
    })
    .select("id, status, result, error")
    .single();
  if (!error && inserted) return describe(inserted as JobRow, false);
  if (error?.code === "23505" && id) {
    const existing = await loadJob(supabase, userId, id);
    if (existing) return describe(existing, true);
  }
  return { ok: false, status: 500, error: error?.message ?? "could not queue the follow-up" };
}

// Header counts for /today: follow-ups still in flight, and ones that failed
// in the last day (so a silent PC doesn't look like success).
export async function countFollowups(
  supabase: SupabaseClient,
  userId: string,
  nowIso: string,
): Promise<{ pending: number; failed: number }> {
  const dayAgo = new Date(new Date(nowIso).getTime() - 24 * 3_600_000).toISOString();
  const [pendingRes, failedRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("kind", "followup")
      .in("status", ["queued", "processing"]),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("kind", "followup")
      .eq("status", "failed")
      .gte("created_at", dayAgo),
  ]);
  return { pending: pendingRes.count ?? 0, failed: failedRes.count ?? 0 };
}
