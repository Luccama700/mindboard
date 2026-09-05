import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import {
  claimProposal,
  finalizeClaimedProposal,
  type AuditStatus,
} from "@/app/lib/mcp/audit";
import { captureToBrainFor } from "@/app/lib/mcp/brain";
import { confirmAction } from "@/app/lib/mcp/writes";
import {
  summarizeCreateTask,
  summarizeLogSpend,
  validateCreateTask,
  validateLogSpend,
  type Result,
} from "@/app/lib/mcp/validate";
import { addDaysKey } from "@/app/_components/finance-projection";
import {
  captureTitleFromText,
  idempotentProposalId,
  WATCH_CAPTURE_SOURCE,
} from "./protocol";

// Write layer for the watch. Every write is the MCP write: an ai_audit_log
// proposal row (source 'mcp' — the watch is an external client of the same
// class) executed through confirmAction → EXECUTORS, so the watch and the MCP
// tools share one code path. What the watch adds is idempotency: with an
// Idempotency-Key the proposal row's id is DERIVED from (user, tool, key), so a
// retried request collides on the primary key, finds the first attempt's row,
// and replays its result (or reports it still in flight) instead of applying
// the write twice. No key → a fresh row, no dedup.

export type WatchWriteOk = {
  ok: true;
  replayed: boolean;
  result: Record<string, unknown>;
};
export type WatchWriteFail = { ok: false; status: number; error: string };
export type WatchWriteOutcome = WatchWriteOk | WatchWriteFail;

const IN_FLIGHT: WatchWriteFail = {
  ok: false,
  status: 409,
  error: "a request with this Idempotency-Key is still in progress; retry shortly",
};

type AuditRow = {
  id: string;
  status: AuditStatus;
  result: Record<string, unknown> | null;
};

async function loadRow(
  supabase: SupabaseClient,
  userId: string,
  id: string,
): Promise<AuditRow | null> {
  const { data } = await supabase
    .from("ai_audit_log")
    .select("id, status, result")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as AuditRow | null) ?? null;
}

// Insert the proposal row. With a key the id is deterministic, so a duplicate
// insert fails the primary key (23505) and `existing` carries the prior row.
async function recordWatchProposal(
  supabase: SupabaseClient,
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
  summary: string,
  idempotencyKey: string | null,
): Promise<{ proposalId: string; existing: AuditRow | null }> {
  const id = idempotencyKey
    ? idempotentProposalId(userId, toolName, idempotencyKey)
    : null;
  const { data, error } = await supabase
    .from("ai_audit_log")
    .insert({
      ...(id ? { id } : {}),
      user_id: userId,
      source: "mcp",
      status: "proposed",
      tool_name: toolName,
      input: idempotencyKey ? { ...input, idempotencyKey } : input,
      summary,
    })
    .select("id")
    .single();
  if (!error && data) return { proposalId: data.id as string, existing: null };
  if (error?.code === "23505" && id) {
    const existing = await loadRow(supabase, userId, id);
    if (existing) return { proposalId: id, existing };
  }
  throw new Error(error?.message ?? "failed to record proposal");
}

// A prior attempt that finished with an error (or was rejected) is re-opened
// so the retry can run it; the guarded UPDATE means only one retry wins.
async function reopenFailed(
  supabase: SupabaseClient,
  userId: string,
  proposalId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("ai_audit_log")
    .update({ status: "proposed", result: null, resolved_at: null })
    .eq("id", proposalId)
    .eq("user_id", userId)
    .in("status", ["error", "rejected"])
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

// Resolve an existing row into either "replay this", "still running", or
// "re-run it" (null = proceed to execute).
async function settleExisting(
  supabase: SupabaseClient,
  userId: string,
  existing: AuditRow,
): Promise<WatchWriteOutcome | null> {
  if (existing.status === "executed") {
    return { ok: true, replayed: true, result: existing.result ?? {} };
  }
  if (existing.status === "proposed" || existing.status === "executing") {
    return IN_FLIGHT;
  }
  return (await reopenFailed(supabase, userId, existing.id)) ? null : IN_FLIGHT;
}

function failureStatus(error: string): number {
  if (/not found/i.test(error)) return 404;
  if (/vault not connected/i.test(error)) return 503;
  if (/github|vault (write|token|repo)/i.test(error)) return 502;
  return 400;
}

async function runThroughConfirm(
  supabase: SupabaseClient,
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
  summary: string,
  idempotencyKey: string | null,
): Promise<WatchWriteOutcome> {
  const { proposalId, existing } = await recordWatchProposal(
    supabase,
    userId,
    toolName,
    input,
    summary,
    idempotencyKey,
  );
  if (existing) {
    const settled = await settleExisting(supabase, userId, existing);
    if (settled) return settled;
  }
  const confirmed = await confirmAction(userId, proposalId);
  if (!confirmed.ok) {
    return { ok: false, status: failureStatus(confirmed.error), error: confirmed.error };
  }
  return { ok: true, replayed: false, result: confirmed.value.result };
}

// ---------- complete ----------

export async function completeTaskFromWatch(
  userId: string,
  taskId: string,
  idempotencyKey: string | null,
): Promise<WatchWriteOutcome> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("tasks")
    .select("id, title, status")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, status: 404, error: "task not found" };
  const task = data as { id: string; title: string; status: string };
  // Completing twice is a no-op, not an error: a tap that raced a refresh, or a
  // retry without a key, must never surface as a failure on the wrist.
  if (task.status === "done") {
    return { ok: true, replayed: true, result: { task, alreadyDone: true } };
  }
  return runThroughConfirm(
    supabase,
    userId,
    "complete_task",
    { taskId },
    `Mark task "${task.title}" as done.`,
    idempotencyKey,
  );
}

export async function completeRecurringFromWatch(
  userId: string,
  ruleId: string,
  idempotencyKey: string | null,
): Promise<WatchWriteOutcome> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("recurring_tasks")
    .select("id, title")
    .eq("id", ruleId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, status: 404, error: "repeating task not found" };
  const rule = data as { title: string };
  // The executor upserts today's completion with ignoreDuplicates, so the
  // write itself is idempotent; the key only dedups the audit trail.
  return runThroughConfirm(
    supabase,
    userId,
    "complete_recurring",
    { ruleId, undo: false },
    `Check off today's "${rule.title}".`,
    idempotencyKey,
  );
}

// "Didn't do it": the MCP miss_task executor — an accountability record,
// distinct from done. Marking an already-missed task is a no-op success.
export async function missTaskFromWatch(
  userId: string,
  taskId: string,
  idempotencyKey: string | null,
): Promise<WatchWriteOutcome> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("tasks")
    .select("id, title, status")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, status: 404, error: "task not found" };
  const task = data as { id: string; title: string; status: string };
  if (task.status === "missed") {
    return { ok: true, replayed: true, result: { task, alreadyMissed: true } };
  }
  if (task.status === "done") {
    return { ok: false, status: 400, error: `"${task.title}" is already done` };
  }
  return runThroughConfirm(
    supabase,
    userId,
    "miss_task",
    { taskId },
    `Mark task "${task.title}" as missed.`,
    idempotencyKey,
  );
}

// "Tomorrow": push a dated task's due date by one day through the MCP
// update_task executor, which keeps due_time (and moves a pushed calendar
// block along with it). The Idempotency-Key matters here more than anywhere:
// a blind retry would otherwise push the task two days.
export async function deferTaskFromWatch(
  userId: string,
  taskId: string,
  idempotencyKey: string | null,
): Promise<WatchWriteOutcome> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("tasks")
    .select("id, title, status, due_date")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, status: 404, error: "task not found" };
  const task = data as { id: string; title: string; status: string; due_date: string | null };
  if (task.status === "done" || task.status === "missed") {
    return { ok: false, status: 400, error: `"${task.title}" is already ${task.status}` };
  }
  if (!task.due_date) {
    return { ok: false, status: 400, error: `"${task.title}" has no due date to push` };
  }
  const dueDate = addDaysKey(task.due_date, 1);
  return runThroughConfirm(
    supabase,
    userId,
    "update_task",
    { taskId, dueDate },
    `Move task "${task.title}" to ${dueDate}.`,
    idempotencyKey,
  );
}

// ---------- create task ----------

export async function createTaskFromWatch(
  userId: string,
  title: string,
  idempotencyKey: string | null,
): Promise<WatchWriteOutcome> {
  const parsed = validateCreateTask({ title, groupId: null, priority: "med" });
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  return runThroughConfirm(
    createServiceClient(),
    userId,
    "create_task",
    parsed.value as unknown as Record<string, unknown>,
    summarizeCreateTask(parsed.value, null),
    idempotencyKey,
  );
}

// ---------- spend ----------

// The default account is the dock's: the oldest active account (accounts[0]
// under the same created_at, id ordering the finance reads use).
async function defaultAccount(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ id: string; name: string; currency: string } | null> {
  const { data } = await supabase
    .from("accounts")
    .select("id, name, currency")
    .eq("user_id", userId)
    .eq("archived", false)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id: string; name: string; currency: string } | null) ?? null;
}

export async function logSpendFromWatch(
  userId: string,
  amount: number,
  note: string | null,
  idempotencyKey: string | null,
): Promise<WatchWriteOutcome> {
  const supabase = createServiceClient();
  const account = await defaultAccount(supabase, userId);
  if (!account) {
    return { ok: false, status: 400, error: "no active account to log spend against" };
  }
  const parsed = validateLogSpend({ accountId: account.id, amount, note });
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const summary = summarizeLogSpend(parsed.value, {
    accountName: account.name,
    currency: account.currency,
    categoryName: null,
  });
  const outcome = await runThroughConfirm(
    supabase,
    userId,
    "log_spend",
    parsed.value as unknown as Record<string, unknown>,
    summary,
    idempotencyKey,
  );
  if (!outcome.ok) return outcome;
  return {
    ...outcome,
    result: { ...outcome.result, account: { id: account.id, name: account.name } },
  };
}

// ---------- capture ----------

// capture_to_brain has no executor (the vault's review flow is its
// confirmation) and records no audit row over MCP. The watch records one
// anyway — purely as the idempotency ledger — and runs the same claim →
// execute → finalize sequence confirmAction uses around the same capture writer.
export async function captureFromWatch(
  userId: string,
  text: string,
  idempotencyKey: string | null,
): Promise<WatchWriteOutcome> {
  const supabase = createServiceClient();
  const title = captureTitleFromText(text);
  const input = {
    title,
    summary_markdown: text,
    source: WATCH_CAPTURE_SOURCE,
    topics: [] as string[],
  };
  const { proposalId, existing } = await recordWatchProposal(
    supabase,
    userId,
    "capture_to_brain",
    input,
    `Capture "${title}" to the second brain (via apple watch).`,
    idempotencyKey,
  );
  if (existing) {
    const settled = await settleExisting(supabase, userId, existing);
    if (settled) return settled;
  }
  if (!(await claimProposal(supabase, userId, proposalId))) return IN_FLIGHT;

  let captured: Result<{ path: string; message: string }>;
  try {
    captured = await captureToBrainFor(supabase, userId, input);
  } catch (err) {
    const error = err instanceof Error ? err.message : "capture failed";
    await finalizeClaimedProposal(supabase, userId, proposalId, "error", { error });
    return { ok: false, status: 502, error };
  }
  if (!captured.ok) {
    await finalizeClaimedProposal(supabase, userId, proposalId, "error", {
      error: captured.error,
    });
    return { ok: false, status: failureStatus(captured.error), error: captured.error };
  }
  const result = { path: captured.value.path };
  await finalizeClaimedProposal(supabase, userId, proposalId, "executed", result);
  return { ok: true, replayed: false, result };
}
