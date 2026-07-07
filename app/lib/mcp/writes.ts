import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import { ownerUserId, todayKey } from "./config";
import {
  summarizeCreateRecurringTask,
  summarizeCreateTask,
  summarizeLogSpend,
  validateCreateRecurringTask,
  validateCreateTask,
  validateLogSpend,
  type Result,
} from "./validate";
import { changeFingerprint } from "@/app/lib/finance/derive";
import { recomputeAccountBalance } from "@/app/lib/finance/recompute";
import { formatRecurrence } from "@/app/lib/recurrence";
import { loadProposal, recordProposal, resolveProposal } from "./audit";
import {
  renderStockReceipt,
  resolveStockOps,
  validateResolvedOps,
  validateStockOps,
  type ResolvableGroup,
  type ResolvableItem,
} from "./inventory-ops";
import {
  financeOpsDateSpan,
  financeReceiptLine,
  renderFinanceReceipt,
  resolveFinanceOps,
  validateFinanceOps,
  validateResolvedFinanceOps,
  type ExistingChange,
  type ResolvableAccount,
  type ResolvableCategory,
  type ResolvableRecurring,
} from "./finance-ops";

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

// Shared with the in-app assistant (session client + RLS) and the MCP server
// (service client + owner scoping), like proposeUpdateStockFor below.
export async function proposeCreateRecurringTaskFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateCreateRecurringTask((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;

  let groupName: string | null = null;
  if (parsed.value.groupId) {
    const { data } = await supabase
      .from("groups")
      .select("name")
      .eq("id", parsed.value.groupId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return { ok: false, error: "group not found" };
    groupName = (data as { name: string }).name;
  }

  const summary = summarizeCreateRecurringTask(parsed.value, groupName, todayKey());
  const proposalId = await recordProposal(
    supabase,
    userId,
    "create_recurring_task",
    parsed.value as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeCreateRecurringTask(raw: unknown): Promise<Result<Proposal>> {
  return proposeCreateRecurringTaskFor(createServiceClient(), ownerUserId(), raw);
}

export async function proposeArchiveRecurringTaskFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const ruleId = (raw as { ruleId?: unknown })?.ruleId;
  if (typeof ruleId !== "string" || !ruleId) {
    return { ok: false, error: "ruleId is required" };
  }

  const { data } = await supabase
    .from("recurring_tasks")
    .select(
      "id, title, frequency, weekdays, day_of_month, interval_days, start_date, archived",
    )
    .eq("id", ruleId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, error: "repeating task not found" };
  const rule = data as {
    title: string;
    archived: boolean;
    frequency: "daily" | "weekly" | "monthly" | "custom";
    weekdays: number[] | null;
    day_of_month: number | null;
    interval_days: number | null;
    start_date: string | null;
  };
  if (rule.archived) {
    return { ok: false, error: `"${rule.title}" is already stopped` };
  }

  const summary = `Stop repeating "${rule.title}" (${formatRecurrence(rule)}).`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "archive_recurring_task",
    { ruleId },
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeArchiveRecurringTask(raw: unknown): Promise<Result<Proposal>> {
  return proposeArchiveRecurringTaskFor(createServiceClient(), ownerUserId(), raw);
}

// Shared with the in-app assistant (session client + RLS) and the MCP server
// (service client + owner scoping): resolve the batch against live rows, store
// the RESOLVED ops (ids, not names) on the proposal, return the receipt.
export async function proposeUpdateStockFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateStockOps(raw);
  if (!parsed.ok) return parsed;

  const [itemsRes, groupsRes] = await Promise.all([
    supabase
      .from("inventory_items")
      .select("id, name, quantity, unit, archived")
      .eq("user_id", userId),
    supabase
      .from("inventory_groups")
      .select("id, name")
      .eq("user_id", userId),
  ]);

  const resolved = resolveStockOps(
    parsed.value,
    (itemsRes.data ?? []) as ResolvableItem[],
    (groupsRes.data ?? []) as ResolvableGroup[],
  );
  if (!resolved.ok) return resolved;

  const preview = renderStockReceipt(resolved.value);
  const proposalId = await recordProposal(
    supabase,
    userId,
    "update_stock",
    { operations: resolved.value } as unknown as Record<string, unknown>,
    preview,
    options,
  );
  return { ok: true, value: { proposalId, preview } };
}

export async function proposeUpdateStock(raw: unknown): Promise<Result<Proposal>> {
  return proposeUpdateStockFor(createServiceClient(), ownerUserId(), raw);
}

// The statement-import batch (docs/finance-automation-plan.md): resolve refs
// against live accounts/categories/recurring rules, flag duplicates against
// existing fingerprints in the batch's date span, store the RESOLVED ops on the
// proposal, return the receipt. Shared by the in-app assistant and MCP.
export async function proposeUpdateFinanceFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateFinanceOps(raw);
  if (!parsed.ok) return parsed;
  const ops = parsed.value;

  const span = financeOpsDateSpan(ops);
  const changeIds = [
    ...new Set(
      ops.flatMap((op) =>
        op.op === "adjust" || op.op === "remove" ? [op.changeId] : [],
      ),
    ),
  ];

  const CHANGE_SELECT = "id, account_id, occurred_at, direction, amount, note";
  const [accountsRes, categoriesRes, recurringRes, spanRes, idsRes] =
    await Promise.all([
      supabase
        .from("accounts")
        .select("id, name, currency")
        .eq("user_id", userId)
        .eq("archived", false),
      supabase
        .from("spending_categories")
        .select("id, name")
        .eq("user_id", userId)
        .eq("archived", false),
      supabase
        .from("recurring_expenses")
        .select("id, name")
        .eq("user_id", userId)
        .eq("archived", false),
      span
        ? supabase
            .from("balance_changes")
            .select(CHANGE_SELECT)
            .eq("user_id", userId)
            .gte("occurred_at", span.min)
            .lte("occurred_at", span.max)
            .limit(1000)
        : Promise.resolve({ data: [] as unknown[] }),
      changeIds.length > 0
        ? supabase
            .from("balance_changes")
            .select(CHANGE_SELECT)
            .eq("user_id", userId)
            .in("id", changeIds)
        : Promise.resolve({ data: [] as unknown[] }),
    ]);

  const existingById = new Map<string, ExistingChange>();
  for (const row of [
    ...((spanRes.data ?? []) as ExistingChange[]),
    ...((idsRes.data ?? []) as ExistingChange[]),
  ]) {
    existingById.set(row.id, row);
  }

  const resolved = resolveFinanceOps(ops, {
    accounts: (accountsRes.data ?? []) as ResolvableAccount[],
    categories: (categoriesRes.data ?? []) as ResolvableCategory[],
    recurring: (recurringRes.data ?? []) as ResolvableRecurring[],
    existingChanges: [...existingById.values()],
    today: todayKey(),
  });
  if (!resolved.ok) return resolved;

  if (resolved.value.every((op) => op.kind === "skip_duplicate")) {
    return {
      ok: false,
      error:
        "every operation matches an existing entry — nothing to import (set force on specific ops to override)",
    };
  }

  const preview = renderFinanceReceipt(resolved.value);
  const proposalId = await recordProposal(
    supabase,
    userId,
    "update_finance",
    { operations: resolved.value } as unknown as Record<string, unknown>,
    preview,
    options,
  );
  return { ok: true, value: { proposalId, preview } };
}

export async function proposeUpdateFinance(raw: unknown): Promise<Result<Proposal>> {
  return proposeUpdateFinanceFor(createServiceClient(), ownerUserId(), raw);
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

async function executeCreateRecurringTask(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateCreateRecurringTask(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  if (v.groupId && !(await ownsRow(supabase, "groups", v.groupId, ownerId))) {
    return { ok: false, error: "group not found" };
  }

  const { data, error } = await supabase
    .from("recurring_tasks")
    .insert({
      user_id: ownerId,
      group_id: v.groupId,
      title: v.title,
      notes: v.notes,
      priority: v.priority,
      frequency: v.frequency,
      weekdays: v.weekdays,
      day_of_month: v.day_of_month,
      interval_days: v.interval_days,
      start_date:
        v.frequency === "custom" ? (v.start_date ?? todayKey()) : v.start_date,
      due_time: v.dueTime ? `${v.dueTime}:00` : null,
      duration_min: v.durationMin,
    })
    .select("id, title, frequency, weekdays, due_time")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
  return { ok: true, value: { rule: data } };
}

async function executeArchiveRecurringTask(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const ruleId = input.ruleId;
  if (typeof ruleId !== "string") return { ok: false, error: "ruleId is required" };

  const { data, error } = await supabase
    .from("recurring_tasks")
    .update({ archived: true })
    .eq("id", ruleId)
    .eq("user_id", ownerId)
    .select("id, title")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "repeating task not found" };
  return { ok: true, value: { rule: data } };
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

  if (!(await ownsRow(supabase, "accounts", v.accountId, ownerId))) {
    return { ok: false, error: "account not found" };
  }

  if (v.categoryId && !(await ownsRow(supabase, "spending_categories", v.categoryId, ownerId))) {
    return { ok: false, error: "category not found" };
  }

  const { data: change, error: insertError } = await supabase
    .from("balance_changes")
    .insert({
      user_id: ownerId,
      account_id: v.accountId,
      category_id: v.categoryId,
      direction: "out",
      amount: v.amount,
      note: v.note,
      occurred_at: todayKey(),
      source: "assistant",
      fingerprint: changeFingerprint(todayKey(), "out", v.amount),
    })
    .select("id, amount, occurred_at")
    .single();
  if (insertError || !change) {
    return { ok: false, error: insertError?.message ?? "insert failed" };
  }

  const recomputed = await recomputeAccountBalance(supabase, ownerId, v.accountId);
  if (recomputed.error) return { ok: false, error: recomputed.error };

  return { ok: true, value: { change, newBalance: recomputed.balance } };
}

// Applies a confirmed stock batch. Quantities are re-read at execute time:
// deltas re-apply on top of the live value (clamped at 0), recounts overwrite —
// same spirit as log_spend recomputing the balance. Ops apply sequentially and
// the first failure aborts the rest (already-applied ops stand; the error says
// how far it got).
async function executeUpdateStock(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateResolvedOps(input);
  if (!parsed.ok) return parsed;
  const ops = parsed.value;

  const itemIds = [
    ...new Set(
      ops.flatMap((op) => (op.kind === "create" ? [] : [op.itemId])),
    ),
  ];
  const running = new Map<string, number>();
  if (itemIds.length > 0) {
    const { data, error } = await supabase
      .from("inventory_items")
      .select("id, quantity")
      .eq("user_id", ownerId)
      .in("id", itemIds);
    if (error) return { ok: false, error: error.message };
    for (const row of (data ?? []) as { id: string; quantity: number }[]) {
      running.set(row.id, Number(row.quantity) || 0);
    }
    const missing = itemIds.filter((id) => !running.has(id));
    if (missing.length > 0) {
      return { ok: false, error: "an item in this proposal no longer exists" };
    }
  }

  const applied: string[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const fail = (message: string): Result<Record<string, unknown>> => ({
      ok: false,
      error: `${message} (applied ${i} of ${ops.length} operations)`,
    });

    switch (op.kind) {
      case "adjust":
      case "recount": {
        const before = running.get(op.itemId) ?? 0;
        const next =
          op.kind === "adjust"
            ? Math.max(0, Math.round((before + op.delta) * 1000) / 1000)
            : op.quantity;
        const updates: Record<string, unknown> = { quantity: next };
        if (next > before) updates.last_restocked_at = now;
        const { error } = await supabase
          .from("inventory_items")
          .update(updates)
          .eq("id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        running.set(op.itemId, next);
        applied.push(`${op.name}: ${before} → ${next}`);
        break;
      }
      case "create": {
        if (
          op.groupId &&
          !(await ownsRow(supabase, "inventory_groups", op.groupId, ownerId))
        ) {
          return fail(`group for "${op.name}" not found`);
        }
        const { error } = await supabase.from("inventory_items").insert({
          user_id: ownerId,
          inventory_group_id: op.groupId,
          name: op.name,
          quantity: op.quantity,
          unit: op.unit,
          last_restocked_at: op.quantity > 0 ? now : null,
        });
        if (error) return fail(error.message);
        applied.push(`${op.name}: created (${op.quantity}${op.unit ? ` ${op.unit}` : ""})`);
        break;
      }
      case "archive":
      case "restore": {
        const archived = op.kind === "archive";
        const { error } = await supabase
          .from("inventory_items")
          .update({ archived, archived_at: archived ? now : null })
          .eq("id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        applied.push(`${op.name}: ${archived ? "stopped tracking" : "tracking again"}`);
        break;
      }
      case "priority": {
        const { error } = await supabase
          .from("inventory_items")
          .update({ priority: op.priority })
          .eq("id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        applied.push(`${op.name}: priority → ${op.priority}`);
        break;
      }
    }
  }

  return { ok: true, value: { applied } };
}

// Applies a confirmed finance batch. Ops run in stored order (category creates
// first, reconciles last — the resolver guarantees it) and the first failure
// aborts the rest (already-applied ops stand; the error says how far it got).
// Every touched account's cached balance is re-derived once at the end.
async function executeUpdateFinance(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateResolvedFinanceOps(input);
  if (!parsed.ok) return parsed;
  const ops = parsed.value;

  // Ownership sweep: the stored proposal is data — re-verify every referenced
  // account and category id against the owner before writing anything.
  const accountIds = new Set<string>();
  const categoryIds = new Set<string>();
  for (const op of ops) {
    switch (op.kind) {
      case "spend":
      case "income":
      case "reconcile":
        accountIds.add(op.accountId);
        break;
      case "transfer":
        accountIds.add(op.fromId);
        accountIds.add(op.toId);
        break;
      case "adjust":
      case "remove":
        accountIds.add(op.accountId);
        break;
      default:
        break;
    }
    if ((op.kind === "spend" || op.kind === "create_recurring" || op.kind === "adjust") && op.categoryId) {
      categoryIds.add(op.categoryId);
    }
  }
  if (accountIds.size > 0) {
    const { data, error } = await supabase
      .from("accounts")
      .select("id")
      .eq("user_id", ownerId)
      .in("id", [...accountIds]);
    if (error) return { ok: false, error: error.message };
    if ((data ?? []).length !== accountIds.size) {
      return { ok: false, error: "an account in this proposal no longer exists" };
    }
  }
  if (categoryIds.size > 0) {
    const { data, error } = await supabase
      .from("spending_categories")
      .select("id")
      .eq("user_id", ownerId)
      .in("id", [...categoryIds]);
    if (error) return { ok: false, error: error.message };
    if ((data ?? []).length !== categoryIds.size) {
      return { ok: false, error: "a category in this proposal no longer exists" };
    }
  }

  const applied: string[] = [];
  const touched = new Set<string>();
  const createdCategories = new Map<string, string>(); // lowercased name → id

  const categoryFor = (
    categoryId: string | null,
    pendingCategory: string | null,
  ): Result<string | null> => {
    if (categoryId) return { ok: true, value: categoryId };
    if (pendingCategory) {
      const id = createdCategories.get(pendingCategory.toLowerCase());
      if (!id) {
        return { ok: false, error: `category "${pendingCategory}" was not created` };
      }
      return { ok: true, value: id };
    }
    return { ok: true, value: null };
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const fail = (message: string): Result<Record<string, unknown>> => ({
      ok: false,
      error: `${message} (applied ${i} of ${ops.length} operations)`,
    });

    switch (op.kind) {
      case "skip_duplicate":
        applied.push(financeReceiptLine(op));
        break;
      case "create_category": {
        const { data, error } = await supabase
          .from("spending_categories")
          .insert({ user_id: ownerId, name: op.name, color: op.color })
          .select("id")
          .single();
        if (error || !data) return fail(error?.message ?? "category insert failed");
        createdCategories.set(op.name.toLowerCase(), data.id as string);
        applied.push(financeReceiptLine(op));
        break;
      }
      case "spend": {
        const category = categoryFor(op.categoryId, op.pendingCategory);
        if (!category.ok) return fail(category.error);
        const { error } = await supabase.from("balance_changes").insert({
          user_id: ownerId,
          account_id: op.accountId,
          category_id: category.value,
          direction: "out",
          amount: op.amount,
          note: op.note,
          occurred_at: op.date,
          source: "import",
          fingerprint: changeFingerprint(op.date, "out", op.amount),
        });
        if (error) return fail(error.message);
        touched.add(op.accountId);
        applied.push(financeReceiptLine(op));
        break;
      }
      case "income": {
        const { error } = await supabase.from("balance_changes").insert({
          user_id: ownerId,
          account_id: op.accountId,
          category_id: null,
          direction: "in",
          amount: op.amount,
          note: op.note,
          occurred_at: op.date,
          source: "import",
          fingerprint: changeFingerprint(op.date, "in", op.amount),
        });
        if (error) return fail(error.message);
        touched.add(op.accountId);
        applied.push(financeReceiptLine(op));
        break;
      }
      case "transfer": {
        const { error } = await supabase.from("balance_changes").insert([
          {
            user_id: ownerId,
            account_id: op.fromId,
            category_id: null,
            direction: "out",
            amount: op.amount,
            note: op.note ?? `transfer to ${op.toName}`,
            occurred_at: op.date,
            source: "import",
            is_transfer: true,
            fingerprint: changeFingerprint(op.date, "out", op.amount),
          },
          {
            user_id: ownerId,
            account_id: op.toId,
            category_id: null,
            direction: "in",
            amount: op.amount,
            note: op.note ?? `transfer from ${op.fromName}`,
            occurred_at: op.date,
            source: "import",
            is_transfer: true,
            fingerprint: changeFingerprint(op.date, "in", op.amount),
          },
        ]);
        if (error) return fail(error.message);
        touched.add(op.fromId);
        touched.add(op.toId);
        applied.push(financeReceiptLine(op));
        break;
      }
      case "reconcile": {
        const { error } = await supabase.from("account_reconciliations").insert({
          user_id: ownerId,
          account_id: op.accountId,
          balance: op.balance,
          as_of: op.asOf,
          source: "import",
          note: "statement reconcile",
        });
        if (error) return fail(error.message);
        touched.add(op.accountId);
        applied.push(financeReceiptLine(op));
        break;
      }
      case "create_recurring": {
        const category = categoryFor(op.categoryId, op.pendingCategory);
        if (!category.ok) return fail(category.error);
        const { error } = await supabase.from("recurring_expenses").insert({
          user_id: ownerId,
          name: op.name,
          amount: op.amount,
          category_id: category.value,
          frequency: op.frequency,
          day_of_month: op.dayOfMonth,
          weekday: op.weekday,
          interval_days: op.intervalDays,
          start_date: op.startDate,
        });
        if (error) return fail(error.message);
        applied.push(financeReceiptLine(op));
        break;
      }
      case "adjust": {
        const { data: row, error: loadError } = await supabase
          .from("balance_changes")
          .select("id, direction, amount, occurred_at")
          .eq("id", op.changeId)
          .eq("user_id", ownerId)
          .maybeSingle();
        if (loadError) return fail(loadError.message);
        if (!row) return fail("a ledger row in this proposal no longer exists");
        const existing = row as {
          direction: "in" | "out";
          amount: number;
          occurred_at: string;
        };

        const category = categoryFor(op.categoryId, op.pendingCategory);
        if (!category.ok) return fail(category.error);

        const updates: Record<string, unknown> = {};
        if (op.amount !== null) updates.amount = op.amount;
        if (op.date !== null) updates.occurred_at = op.date;
        if (op.categoryId !== null || op.pendingCategory !== null) {
          updates.category_id = category.value;
        }
        if (op.note !== null) updates.note = op.note;
        if (op.markTransfer !== null) {
          updates.is_transfer = op.markTransfer;
          // transfers are never categorized spending
          if (op.markTransfer) updates.category_id = null;
        }
        if (op.amount !== null || op.date !== null) {
          updates.fingerprint = changeFingerprint(
            op.date ?? existing.occurred_at,
            existing.direction,
            op.amount ?? Number(existing.amount),
          );
        }
        const { error } = await supabase
          .from("balance_changes")
          .update(updates)
          .eq("id", op.changeId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        touched.add(op.accountId);
        applied.push(financeReceiptLine(op));
        break;
      }
      case "remove": {
        const { error } = await supabase
          .from("balance_changes")
          .delete()
          .eq("id", op.changeId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        touched.add(op.accountId);
        applied.push(financeReceiptLine(op));
        break;
      }
    }
  }

  const balances: Record<string, number> = {};
  for (const accountId of touched) {
    const recomputed = await recomputeAccountBalance(supabase, ownerId, accountId);
    if (recomputed.error) {
      return { ok: false, error: `balance recompute failed: ${recomputed.error}` };
    }
    if (recomputed.balance !== undefined) balances[accountId] = recomputed.balance;
  }

  return { ok: true, value: { applied, balances } };
}

export const EXECUTORS: Record<
  string,
  (
    supabase: SupabaseClient,
    ownerId: string,
    input: Record<string, unknown>,
  ) => Promise<Result<Record<string, unknown>>>
> = {
  create_task: executeCreateTask,
  create_recurring_task: executeCreateRecurringTask,
  archive_recurring_task: executeArchiveRecurringTask,
  complete_task: executeCompleteTask,
  log_spend: executeLogSpend,
  update_stock: executeUpdateStock,
  update_finance: executeUpdateFinance,
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
