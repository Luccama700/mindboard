import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import { ownerUserId, todayKey } from "./config";
import {
  computeSpendBalance,
  roundCents,
  summarizeCreateTask,
  summarizeLogSpend,
  validateCreateTask,
  validateLogSpend,
  type Result,
} from "./validate";
import { loadProposal, recordProposal, resolveProposal } from "./audit";

// The MCP write layer. Each write is two steps (the plan's locked
// write-with-confirmation rule):
//   1. a propose tool (create_task / complete_task / log_spend) validates input,
//      builds a human-readable preview, and records a 'proposed' ai_audit_log
//      row — it does NOT touch the domain tables.
//   2. confirm_action(proposalId) re-executes from the stored input via the
//      service client, scoped to the owner, and flips the row to 'executed'.
// Mirrors the semantics of the cookie-session actions in app/actions/* but
// session-less and with explicit user_id scoping on every statement. Pure
// validation/preview helpers live in ./validate (unit tested).

async function ownsRow(
  supabase: SupabaseClient,
  table: string,
  id: string,
  ownerId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("user_id", ownerId)
    .maybeSingle();
  return Boolean(data);
}

export type Proposal = { proposalId: string; preview: string };

// ---------- propose (records a 'proposed' audit row) ----------

export async function proposeCreateTask(raw: unknown): Promise<Result<Proposal>> {
  const parsed = validateCreateTask((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;

  const supabase = createServiceClient();
  const ownerId = ownerUserId();

  let groupName: string | null = null;
  if (parsed.value.groupId) {
    const { data } = await supabase
      .from("groups")
      .select("name")
      .eq("id", parsed.value.groupId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!data) return { ok: false, error: "group not found" };
    groupName = (data as { name: string }).name;
  }

  const summary = summarizeCreateTask(parsed.value, groupName);
  const proposalId = await recordProposal(
    supabase,
    ownerId,
    "create_task",
    parsed.value as unknown as Record<string, unknown>,
    summary,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeCompleteTask(raw: unknown): Promise<Result<Proposal>> {
  const taskId = (raw as { taskId?: unknown })?.taskId;
  if (typeof taskId !== "string" || !taskId) {
    return { ok: false, error: "taskId is required" };
  }

  const supabase = createServiceClient();
  const ownerId = ownerUserId();

  const { data } = await supabase
    .from("tasks")
    .select("id, title, status")
    .eq("id", taskId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!data) return { ok: false, error: "task not found" };
  const task = data as { id: string; title: string; status: string };
  if (task.status === "done") {
    return { ok: false, error: `"${task.title}" is already done` };
  }

  const summary = `Mark task "${task.title}" as done.`;
  const proposalId = await recordProposal(supabase, ownerId, "complete_task", { taskId }, summary);
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeLogSpend(raw: unknown): Promise<Result<Proposal>> {
  const parsed = validateLogSpend((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;

  const supabase = createServiceClient();
  const ownerId = ownerUserId();

  const { data: account } = await supabase
    .from("accounts")
    .select("id, name, currency")
    .eq("id", parsed.value.accountId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!account) return { ok: false, error: "account not found" };
  const acct = account as { name: string; currency: string };

  let categoryName: string | null = null;
  if (parsed.value.categoryId) {
    const { data: category } = await supabase
      .from("spending_categories")
      .select("name")
      .eq("id", parsed.value.categoryId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!category) return { ok: false, error: "category not found" };
    categoryName = (category as { name: string }).name;
  }

  const summary = summarizeLogSpend(parsed.value, {
    accountName: acct.name,
    currency: acct.currency,
    categoryName,
  });
  const proposalId = await recordProposal(
    supabase,
    ownerId,
    "log_spend",
    parsed.value as unknown as Record<string, unknown>,
    summary,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

// ---------- execute (called by confirm, scoped to the owner) ----------

async function executeCreateTask(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateCreateTask(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  if (v.groupId && !(await ownsRow(supabase, "groups", v.groupId, ownerId))) {
    return { ok: false, error: "group not found" };
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: ownerId,
      group_id: v.groupId,
      title: v.title,
      due_date: v.dueDate,
      notes: v.notes,
      priority: v.priority,
    })
    .select("id, title, due_date, status, priority, group_id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
  return { ok: true, value: { task: data } };
}

async function executeCompleteTask(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const taskId = input.taskId;
  if (typeof taskId !== "string") return { ok: false, error: "taskId is required" };

  const { data, error } = await supabase
    .from("tasks")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("user_id", ownerId)
    .select("id, title, status")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "task not found" };
  return { ok: true, value: { task: data } };
}

async function executeLogSpend(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateLogSpend(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  const { data: account } = await supabase
    .from("accounts")
    .select("id, balance")
    .eq("id", v.accountId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!account) return { ok: false, error: "account not found" };

  if (v.categoryId && !(await ownsRow(supabase, "spending_categories", v.categoryId, ownerId))) {
    return { ok: false, error: "category not found" };
  }

  const current = roundCents(Number((account as { balance: number }).balance)) ?? 0;
  const newBalance = computeSpendBalance(current, v.amount);

  const { data: change, error: insertError } = await supabase
    .from("balance_changes")
    .insert({
      user_id: ownerId,
      account_id: v.accountId,
      category_id: v.categoryId,
      direction: "out",
      amount: v.amount,
      balance_after: newBalance,
      note: v.note,
      occurred_at: todayKey(),
    })
    .select("id, amount, balance_after, occurred_at")
    .single();
  if (insertError || !change) {
    return { ok: false, error: insertError?.message ?? "insert failed" };
  }

  const { error: updateError } = await supabase
    .from("accounts")
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq("id", v.accountId)
    .eq("user_id", ownerId);
  if (updateError) return { ok: false, error: updateError.message };

  return { ok: true, value: { change, newBalance } };
}

const EXECUTORS: Record<
  string,
  (
    supabase: SupabaseClient,
    ownerId: string,
    input: Record<string, unknown>,
  ) => Promise<Result<Record<string, unknown>>>
> = {
  create_task: executeCreateTask,
  complete_task: executeCompleteTask,
  log_spend: executeLogSpend,
};

// ---------- confirm / cancel ----------

export async function confirmAction(
  proposalId: unknown,
): Promise<Result<{ preview: string; result: Record<string, unknown> }>> {
  if (typeof proposalId !== "string" || !proposalId) {
    return { ok: false, error: "proposalId is required" };
  }

  const supabase = createServiceClient();
  const ownerId = ownerUserId();

  const proposal = await loadProposal(supabase, ownerId, proposalId);
  if (!proposal) {
    return { ok: false, error: "proposal not found or already resolved" };
  }

  const executor = EXECUTORS[proposal.tool_name];
  if (!executor) {
    await resolveProposal(supabase, ownerId, proposalId, "error", {
      error: `unknown tool ${proposal.tool_name}`,
    });
    return { ok: false, error: `unknown tool ${proposal.tool_name}` };
  }

  const outcome = await executor(supabase, ownerId, proposal.input);
  if (!outcome.ok) {
    await resolveProposal(supabase, ownerId, proposalId, "error", { error: outcome.error });
    return outcome;
  }

  const claimed = await resolveProposal(supabase, ownerId, proposalId, "executed", outcome.value);
  if (!claimed) {
    // Someone resolved it between load and here; the write above still ran, but
    // report the race rather than pretend a fresh execution.
    return { ok: false, error: "proposal was already resolved" };
  }

  await revalidateWeb();
  return { ok: true, value: { preview: proposal.summary, result: outcome.value } };
}

export async function cancelAction(
  proposalId: unknown,
): Promise<Result<{ cancelled: true }>> {
  if (typeof proposalId !== "string" || !proposalId) {
    return { ok: false, error: "proposalId is required" };
  }
  const supabase = createServiceClient();
  const ownerId = ownerUserId();
  const ok = await resolveProposal(supabase, ownerId, proposalId, "rejected", null);
  if (!ok) return { ok: false, error: "proposal not found or already resolved" };
  return { ok: true, value: { cancelled: true } };
}

// Best-effort refresh of the web UI's cached pages after an MCP write. Guarded
// so importing this module outside a Next request context (e.g. tests) never throws.
async function revalidateWeb(): Promise<void> {
  try {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/", "layout");
  } catch {
    // not in a Next request context
  }
}
