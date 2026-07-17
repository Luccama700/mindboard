import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import {
  lookupPrices,
  lookupPricesByRefs,
} from "@/app/lib/shopping/price-lookup";
import { todayKey } from "./config";
import {
  summarizeCreateRecurringTask,
  summarizeCreateTask,
  summarizeLogSpend,
  summarizeUpdateTask,
  validateCreateEvent,
  validateCreateRecurringTask,
  validateCreateTask,
  validateDailyLog,
  validateLogSpend,
  validateManageGroup,
  validateRescheduleEvent,
  validateUpdateRecurringTask,
  validateUpdateSettings,
  validateUpdateTask,
  validateUpsertGoal,
  type Result,
} from "./validate";
import {
  adminReceiptLine,
  renderAdminReceipt,
  resolveAdminOps,
  validateAdminOps,
  validateResolvedAdminOps,
  type ResolvableRef,
} from "./finance-admin-ops";
import { createEvent, updateEvent } from "@/utils/google/calendar";
import { executeGenerateAudioOverview } from "@/app/lib/learn/episodes";
import { changeFingerprint } from "@/app/lib/finance/derive";
import { recomputeAccountBalance } from "@/app/lib/finance/recompute";
import { formatRecurrence } from "@/app/lib/recurrence";
import {
  claimProposal,
  finalizeClaimedProposal,
  loadProposal,
  recordProposal,
  resolveProposal,
} from "./audit";
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
import {
  formatLimitWarnings,
  summarizeDeleteSpendLimit,
  summarizeSetSpendLimit,
  validateDeleteSpendLimit,
  validateSetSpendLimit,
} from "./spend-limit-ops";
import {
  limitWarningsForSpends,
  type PendingSpend,
} from "@/app/_components/spend-limits";
import type {
  SpendLimit,
  SpendLimitPeriod,
  SpendLimitScope,
} from "@/app/_components/finance-types";
import type { BillRule, SpendHistoryRow } from "@/app/_components/spend-baseline";
import { addDaysKey } from "@/app/_components/finance-projection";

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

export async function proposeCreateTask(userId: string, raw: unknown): Promise<Result<Proposal>> {
  const parsed = validateCreateTask((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;

  const supabase = createServiceClient();
  const ownerId = userId;

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

export async function proposeCompleteTask(userId: string, raw: unknown): Promise<Result<Proposal>> {
  const taskId = (raw as { taskId?: unknown })?.taskId;
  if (typeof taskId !== "string" || !taskId) {
    return { ok: false, error: "taskId is required" };
  }

  const supabase = createServiceClient();
  const ownerId = userId;

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

export async function proposeLogSpend(userId: string, raw: unknown): Promise<Result<Proposal>> {
  const parsed = validateLogSpend((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;

  const supabase = createServiceClient();
  const ownerId = userId;

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

  const warningBlock = await spendLimitWarningBlock(supabase, ownerId, [
    {
      amount: parsed.value.amount,
      categoryId: parsed.value.categoryId,
      dateKey: await todayKey(supabase, ownerId),
    },
  ]);
  const summary =
    summarizeLogSpend(parsed.value, {
      accountName: acct.name,
      currency: acct.currency,
      categoryName,
    }) + warningBlock;
  const proposalId = await recordProposal(
    supabase,
    ownerId,
    "log_spend",
    parsed.value as unknown as Record<string, unknown>,
    summary,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

// The base account currency, for money formatting in limit/spend previews.
async function baseCurrency(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<string> {
  const { data } = await supabase
    .from("accounts")
    .select("currency")
    .eq("user_id", ownerId)
    .eq("archived", false)
    .limit(1);
  return ((data ?? []) as { currency: string }[])[0]?.currency ?? "USD";
}

// Spend-limit warning block appended to a spend proposal's preview so the user
// sees the impact on any applicable cap before confirming. Never blocks — it is
// preview text only. Empty string when there are no limits or none are hit.
export async function spendLimitWarningBlock(
  supabase: SupabaseClient,
  ownerId: string,
  spends: PendingSpend[],
): Promise<string> {
  const today = await todayKey(supabase, ownerId);
  const windowStart = addDaysKey(today, -40); // covers the current month/week
  const [limitsRes, recurringRes, changesRes, categoriesRes, accountRes] =
    await Promise.all([
      supabase
        .from("spend_limits")
        .select("id, scope, category_id, period, amount, archived, created_at")
        .eq("user_id", ownerId)
        .eq("archived", false),
      supabase
        .from("recurring_expenses")
        .select("amount, category_id")
        .eq("user_id", ownerId)
        .eq("archived", false),
      supabase
        .from("balance_changes")
        .select("occurred_at, direction, amount, category_id, is_transfer")
        .eq("user_id", ownerId)
        .gte("occurred_at", windowStart)
        .limit(2000),
      supabase
        .from("spending_categories")
        .select("id, name")
        .eq("user_id", ownerId),
      supabase
        .from("accounts")
        .select("currency")
        .eq("user_id", ownerId)
        .eq("archived", false)
        .limit(1),
    ]);

  const limits = (limitsRes.data ?? []) as SpendLimit[];
  if (limits.length === 0) return "";

  const rules: BillRule[] = ((recurringRes.data ?? []) as BillRule[]).map(
    (r) => ({ amount: Number(r.amount), category_id: r.category_id }),
  );
  const rows = ((changesRes.data ?? []) as SpendHistoryRow[]).map((r) => ({
    ...r,
    amount: Number(r.amount),
  }));

  const warnings = limitWarningsForSpends({ limits, rows, rules, spends, today });
  if (warnings.length === 0) return "";

  const categoryNameById = new Map<string, string>(
    ((categoriesRes.data ?? []) as { id: string; name: string }[]).map((c) => [
      c.id,
      c.name,
    ]),
  );
  const currency =
    ((accountRes.data ?? []) as { currency: string }[])[0]?.currency ?? "USD";
  return formatLimitWarnings(warnings, { categoryNameById, currency });
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

  const summary = summarizeCreateRecurringTask(
    parsed.value,
    groupName,
    await todayKey(supabase, userId),
  );
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

export async function proposeCreateRecurringTask(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeCreateRecurringTaskFor(createServiceClient(), userId, raw);
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

export async function proposeArchiveRecurringTask(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeArchiveRecurringTaskFor(createServiceClient(), userId, raw);
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

export async function proposeUpdateStock(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeUpdateStockFor(createServiceClient(), userId, raw);
}

// Direct execute (no propose step): AI price lookups only write source-labeled
// cache metadata (est_price/price_source/price_checked_at) and never overwrite
// a manual price — same spend-the-user's-key category as free-form capture
// parsing, same direct-write category as icon generation.
export async function lookupShoppingPrices(userId: string, input: {
  items?: string[];
  force?: boolean;
}) {
  return lookupPricesByRefs({
    supabase: createServiceClient(),
    userId,
    items: input.items,
    force: input.force,
  });
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

  const CHANGE_SELECT =
    "id, account_id, occurred_at, direction, amount, note, is_transfer";
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
    today: await todayKey(supabase, userId),
  });
  if (!resolved.ok) return resolved;

  if (resolved.value.every((op) => op.kind === "skip_duplicate")) {
    return {
      ok: false,
      error:
        "every operation matches an existing entry — nothing to import (set force on specific ops to override)",
    };
  }

  const spends: PendingSpend[] = [];
  for (const op of resolved.value) {
    if (op.kind === "spend") {
      spends.push({
        amount: op.amount,
        categoryId: op.categoryId,
        dateKey: op.date,
      });
    }
  }
  const warningBlock = await spendLimitWarningBlock(supabase, userId, spends);
  const preview = renderFinanceReceipt(resolved.value) + warningBlock;
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

export async function proposeUpdateFinance(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeUpdateFinanceFor(createServiceClient(), userId, raw);
}

// ---------- spending limits ----------

export async function proposeSetSpendLimitFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateSetSpendLimit((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  let categoryName: string | null = null;
  if (v.scope === "category" && v.categoryId) {
    const { data } = await supabase
      .from("spending_categories")
      .select("name")
      .eq("id", v.categoryId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return { ok: false, error: "category not found" };
    categoryName = (data as { name: string }).name;
  }

  const currency = await baseCurrency(supabase, userId);
  const summary = summarizeSetSpendLimit(v, { categoryName, currency });
  const proposalId = await recordProposal(
    supabase,
    userId,
    "set_spend_limit",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeSetSpendLimit(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeSetSpendLimitFor(createServiceClient(), userId, raw);
}

export async function proposeDeleteSpendLimitFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateDeleteSpendLimit((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const { limitId } = parsed.value;

  const { data: limit } = await supabase
    .from("spend_limits")
    .select("scope, category_id, period, amount")
    .eq("id", limitId)
    .eq("user_id", userId)
    .eq("archived", false)
    .maybeSingle();
  if (!limit) return { ok: false, error: "limit not found" };
  const l = limit as {
    scope: SpendLimitScope;
    category_id: string | null;
    period: SpendLimitPeriod;
    amount: number;
  };

  let categoryName: string | null = null;
  if (l.scope === "category" && l.category_id) {
    const { data } = await supabase
      .from("spending_categories")
      .select("name")
      .eq("id", l.category_id)
      .eq("user_id", userId)
      .maybeSingle();
    categoryName = data ? (data as { name: string }).name : null;
  }

  const currency = await baseCurrency(supabase, userId);
  const summary = summarizeDeleteSpendLimit({
    scope: l.scope,
    categoryName,
    period: l.period,
    amount: Number(l.amount),
    currency,
  });
  const proposalId = await recordProposal(
    supabase,
    userId,
    "delete_spend_limit",
    { limitId },
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeDeleteSpendLimit(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeDeleteSpendLimitFor(createServiceClient(), userId, raw);
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

  // dueTime rides alongside the validated core (the assistant proposes it);
  // a time only sticks when the task has a date to live on.
  const dueTime =
    typeof input.dueTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.dueTime)
      ? `${input.dueTime}:00`
      : null;

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: ownerId,
      group_id: v.groupId,
      title: v.title,
      due_date: v.dueDate,
      due_time: v.dueDate ? dueTime : null,
      notes: v.notes,
      priority: v.priority,
    })
    .select("id, title, due_date, due_time, status, priority, group_id")
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
        v.frequency === "custom"
          ? (v.start_date ?? (await todayKey(supabase, ownerId)))
          : v.start_date,
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

  const today = await todayKey(supabase, ownerId);
  const { data: change, error: insertError } = await supabase
    .from("balance_changes")
    .insert({
      user_id: ownerId,
      account_id: v.accountId,
      category_id: v.categoryId,
      direction: "out",
      amount: v.amount,
      note: v.note,
      occurred_at: today,
      source: "assistant",
      fingerprint: changeFingerprint(today, "out", v.amount),
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

const SPEND_LIMIT_SELECT =
  "id, scope, category_id, period, amount, archived, created_at";

// "set" = create-or-update the single active limit for this scope/category
// (the partial unique indexes enforce one overall + one per category).
async function executeSetSpendLimit(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateSetSpendLimit(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  if (v.scope === "category") {
    if (
      !v.categoryId ||
      !(await ownsRow(supabase, "spending_categories", v.categoryId, ownerId))
    ) {
      return { ok: false, error: "category not found" };
    }
  }

  let existing = supabase
    .from("spend_limits")
    .select("id")
    .eq("user_id", ownerId)
    .eq("scope", v.scope)
    .eq("archived", false);
  existing =
    v.scope === "category"
      ? existing.eq("category_id", v.categoryId as string)
      : existing.is("category_id", null);
  const { data: found } = await existing.maybeSingle();

  if (found) {
    const { data, error } = await supabase
      .from("spend_limits")
      .update({
        period: v.period,
        amount: v.amount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", (found as { id: string }).id)
      .eq("user_id", ownerId)
      .select(SPEND_LIMIT_SELECT)
      .single();
    if (error || !data) {
      return { ok: false, error: error?.message ?? "update failed" };
    }
    return { ok: true, value: { limit: data } };
  }

  const { data, error } = await supabase
    .from("spend_limits")
    .insert({
      user_id: ownerId,
      scope: v.scope,
      category_id: v.categoryId,
      period: v.period,
      amount: v.amount,
    })
    .select(SPEND_LIMIT_SELECT)
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  return { ok: true, value: { limit: data } };
}

async function executeDeleteSpendLimit(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateDeleteSpendLimit(input);
  if (!parsed.ok) return parsed;
  const { limitId } = parsed.value;

  if (!(await ownsRow(supabase, "spend_limits", limitId, ownerId))) {
    return { ok: false, error: "limit not found" };
  }

  const { error } = await supabase
    .from("spend_limits")
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq("id", limitId)
    .eq("user_id", ownerId);
  if (error) return { ok: false, error: error.message };

  return { ok: true, value: { archived: true, limitId } };
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
      ops.flatMap((op) => {
        if (op.kind === "create" || op.kind === "create_group") return [];
        // Pin ops for items created earlier in the batch have no id yet.
        if (op.kind === "pin") return op.itemId ? [op.itemId] : [];
        return [op.itemId];
      }),
    ),
  ];
  const running = new Map<string, number>();
  // est_price/price_source per item, so buy-amount changes know whether an
  // AI price is now stale (manual prices are never refreshed).
  const priceMeta = new Map<
    string,
    { estPrice: number | null; source: "ai" | "manual" | null }
  >();
  if (itemIds.length > 0) {
    const { data, error } = await supabase
      .from("inventory_items")
      .select("id, quantity, est_price, price_source")
      .eq("user_id", ownerId)
      .in("id", itemIds);
    if (error) return { ok: false, error: error.message };
    for (const row of (data ?? []) as {
      id: string;
      quantity: number;
      est_price: number | null;
      price_source: "ai" | "manual" | null;
    }[]) {
      running.set(row.id, Number(row.quantity) || 0);
      priceMeta.set(row.id, {
        estPrice: row.est_price === null ? null : Number(row.est_price),
        source: row.price_source,
      });
    }
    const missing = itemIds.filter((id) => !running.has(id));
    if (missing.length > 0) {
      return { ok: false, error: "an item in this proposal no longer exists" };
    }
  }

  const applied: string[] = [];
  const now = new Date().toISOString();
  // Groups created earlier in this batch, so later create/move ops can land in
  // them (resolved as pendingGroup at propose time).
  const createdGroups = new Map<string, string>(); // lowercased name → id
  // Items created earlier in this batch, so later pin ops can target them
  // (resolved as pendingItem at propose time).
  const createdItems = new Map<string, string>(); // lowercased name → id
  // Items newly pinned without a supplied price → post-batch AI price lookup.
  const pinnedItemIds = new Set<string>();
  // Items whose planned buy amount changed while carrying an AI price → the
  // price no longer matches the plan; force-refresh it post-batch.
  const staleAiPriceIds = new Set<string>();

  const groupIdFor = (
    groupId: string | null,
    pendingGroup: string | null | undefined,
  ): Result<string | null> => {
    if (groupId) return { ok: true, value: groupId };
    if (pendingGroup) {
      const id = createdGroups.get(pendingGroup.toLowerCase());
      if (!id) return { ok: false, error: `group "${pendingGroup}" was not created` };
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
        const group = groupIdFor(op.groupId, op.pendingGroup);
        if (!group.ok) return fail(group.error);
        if (
          group.value &&
          !createdGroups.has((op.pendingGroup ?? "").toLowerCase()) &&
          !(await ownsRow(supabase, "inventory_groups", group.value, ownerId))
        ) {
          return fail(`group for "${op.name}" not found`);
        }
        const { data, error } = await supabase
          .from("inventory_items")
          .insert({
            user_id: ownerId,
            inventory_group_id: group.value,
            name: op.name,
            quantity: op.quantity,
            unit: op.unit,
            last_restocked_at: op.quantity > 0 ? now : null,
            ...(op.price != null
              ? {
                  est_price: op.price,
                  price_source: "ai",
                  price_checked_at: now,
                }
              : {}),
          })
          .select("id")
          .single();
        if (error || !data) return fail(error?.message ?? "item insert failed");
        createdItems.set(op.name.toLowerCase(), data.id as string);
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
      case "threshold": {
        const { error } = await supabase
          .from("inventory_items")
          .update({ reorder_threshold: op.threshold })
          .eq("id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        applied.push(
          op.threshold === null
            ? `${op.name}: reorder threshold cleared`
            : `${op.name}: reorder at ${op.threshold}`,
        );
        break;
      }
      case "usage": {
        // set_usage replaces the item's usage rules with the one given, so the
        // agent-facing model stays "one consumption rate per item".
        const { error: clearError } = await supabase
          .from("inventory_usages")
          .delete()
          .eq("inventory_item_id", op.itemId)
          .eq("user_id", ownerId);
        if (clearError) return fail(clearError.message);
        const { error } = await supabase.from("inventory_usages").insert({
          user_id: ownerId,
          inventory_item_id: op.itemId,
          amount: op.amount,
          period: op.period,
          interval_days: op.period === "custom" ? op.intervalDays : null,
        });
        if (error) return fail(error.message);
        applied.push(`${op.name}: usage → ${op.amount}/${op.period}`);
        break;
      }
      case "clear_usage": {
        const { error } = await supabase
          .from("inventory_usages")
          .delete()
          .eq("inventory_item_id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        applied.push(`${op.name}: usage tracking cleared`);
        break;
      }
      case "rename": {
        const { error } = await supabase
          .from("inventory_items")
          .update({ name: op.to })
          .eq("id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        applied.push(`${op.from}: renamed "${op.to}"`);
        break;
      }
      case "move": {
        const group = groupIdFor(op.groupId, op.pendingGroup);
        if (!group.ok) return fail(group.error);
        const { error } = await supabase
          .from("inventory_items")
          .update({ inventory_group_id: group.value })
          .eq("id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        applied.push(`${op.name}: moved to ${op.groupName ?? op.pendingGroup ?? "no group"}`);
        break;
      }
      case "create_group": {
        const { data, error } = await supabase
          .from("inventory_groups")
          .insert({ user_id: ownerId, name: op.name })
          .select("id")
          .single();
        if (error || !data) return fail(error?.message ?? "group insert failed");
        createdGroups.set(op.name.toLowerCase(), data.id as string);
        applied.push(`${op.name}: new group`);
        break;
      }
      case "pin": {
        const itemId =
          op.itemId ?? createdItems.get((op.pendingItem ?? "").toLowerCase());
        if (!itemId) {
          return fail(`item "${op.pendingItem ?? op.name}" was not created`);
        }
        const updates: Record<string, unknown> = { shopping_pinned: op.pinned };
        if (op.pinned && op.price != null) {
          updates.est_price = op.price;
          updates.price_source = "ai";
          updates.price_checked_at = now;
        }
        if (op.pinned && op.buyAmount != null) {
          updates.buy_amount = op.buyAmount;
        }
        const { error } = await supabase
          .from("inventory_items")
          .update(updates)
          .eq("id", itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        if (op.pinned && op.price == null) {
          if (op.buyAmount != null && priceMeta.get(itemId)?.source === "ai") {
            staleAiPriceIds.add(itemId);
          } else {
            pinnedItemIds.add(itemId);
          }
        }
        applied.push(
          `${op.name}: ${op.pinned ? "pinned to" : "removed from"} shopping list`,
        );
        break;
      }
      case "price": {
        const { error } = await supabase
          .from("inventory_items")
          .update(
            op.price === null
              ? { est_price: null, price_source: null, price_checked_at: null }
              : {
                  est_price: op.price,
                  price_source: "manual",
                  price_checked_at: now,
                },
          )
          .eq("id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        applied.push(
          op.price === null
            ? `${op.name}: price cleared`
            : `${op.name}: price → $${op.price.toFixed(2)}`,
        );
        break;
      }
      case "buy": {
        const { error } = await supabase
          .from("inventory_items")
          .update({ buy_amount: op.amount })
          .eq("id", op.itemId)
          .eq("user_id", ownerId);
        if (error) return fail(error.message);
        const meta = priceMeta.get(op.itemId);
        if (meta?.source === "ai") staleAiPriceIds.add(op.itemId);
        else if (meta?.estPrice === null) pinnedItemIds.add(op.itemId);
        applied.push(
          op.amount === null
            ? `${op.name}: buy amount cleared`
            : `${op.name}: will buy ${op.amount}`,
        );
        break;
      }
    }
  }

  // Quiet post-response AI lookups: fill prices for newly-listed items, and
  // force-refresh AI prices whose planned buy amount changed (lookupPrices
  // never touches manual prices and no-ops without a store/key).
  const fillIds = [...pinnedItemIds].filter((id) => !staleAiPriceIds.has(id));
  const refreshIds = [...staleAiPriceIds];
  if (fillIds.length > 0 || refreshIds.length > 0) {
    try {
      after(async () => {
        try {
          if (fillIds.length > 0) {
            await lookupPrices({ supabase, userId: ownerId, itemIds: fillIds });
          }
          if (refreshIds.length > 0) {
            await lookupPrices({
              supabase,
              userId: ownerId,
              itemIds: refreshIds,
              force: true,
            });
          }
        } catch {
          // best-effort: a failed lookup just leaves the price unset/stale
        }
      });
    } catch {
      // outside a request scope (e.g. tests) — skip the auto-lookup
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

// ---------- task edits ----------

export async function proposeUpdateTaskFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateUpdateTask((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  const { data: task } = await supabase
    .from("tasks")
    .select("id, title")
    .eq("id", v.taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!task) return { ok: false, error: "task not found" };

  let groupName: string | null = null;
  if (v.groupId) {
    const { data } = await supabase
      .from("groups")
      .select("name")
      .eq("id", v.groupId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return { ok: false, error: "group not found" };
    groupName = (data as { name: string }).name;
  }

  const summary = summarizeUpdateTask(v, (task as { title: string }).title, groupName);
  const proposalId = await recordProposal(
    supabase,
    userId,
    "update_task",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeUpdateTask(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeUpdateTaskFor(createServiceClient(), userId, raw);
}

function addMinutesToClock(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:00`;
}

async function ownerTimezone(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<string> {
  const { data } = await supabase
    .from("user_settings")
    .select("timezone")
    .eq("user_id", ownerId)
    .maybeSingle();
  return (data?.timezone as string | null) ?? "UTC";
}

async function executeUpdateTask(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateUpdateTask(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  if (v.groupId && !(await ownsRow(supabase, "groups", v.groupId, ownerId))) {
    return { ok: false, error: "group not found" };
  }

  const updates: Record<string, unknown> = {};
  if (v.title !== undefined) updates.title = v.title;
  if (v.dueDate !== undefined) {
    updates.due_date = v.dueDate;
    // A task without a date cannot hold a time-block.
    if (v.dueDate === null && v.dueTime === undefined) updates.due_time = null;
  }
  if (v.dueTime !== undefined) {
    updates.due_time = v.dueTime ? `${v.dueTime}:00` : null;
  }
  if (v.durationMin !== undefined) updates.duration_min = v.durationMin;
  if (v.groupId !== undefined) updates.group_id = v.groupId;
  if (v.notes !== undefined) updates.notes = v.notes;
  if (v.priority !== undefined) updates.priority = v.priority;
  if (v.aiState !== undefined) updates.ai_state = v.aiState;

  if (Object.keys(updates).length === 0 && !v.pushToCalendar) {
    return { ok: false, error: "nothing to change" };
  }

  const { data: updated, error } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", v.taskId)
    .eq("user_id", ownerId)
    .select(
      "id, title, due_date, due_time, duration_min, gcal_event_id, gcal_calendar_id, group_id, groups(google_calendar_id)",
    )
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: "task not found" };

  const task = updated as {
    id: string;
    title: string;
    due_date: string | null;
    due_time: string | null;
    duration_min: number | null;
    gcal_event_id: string | null;
    gcal_calendar_id: string | null;
    groups:
      | { google_calendar_id: string | null }
      | { google_calendar_id: string | null }[]
      | null;
  };

  const result: Record<string, unknown> = { task: { id: task.id, title: task.title } };

  const scheduleTouched =
    v.dueDate !== undefined || v.dueTime !== undefined || v.durationMin !== undefined;

  // Mirror a pushed task's block to its Google event; fail soft like the
  // in-app action (the local block is the source of truth).
  if (
    scheduleTouched &&
    task.gcal_event_id &&
    task.gcal_calendar_id &&
    task.due_date &&
    task.due_time
  ) {
    try {
      const timeZone = await ownerTimezone(supabase, ownerId);
      const start = task.due_time.length === 5 ? `${task.due_time}:00` : task.due_time;
      const end = addMinutesToClock(start.slice(0, 5), task.duration_min ?? 30);
      await updateEvent(ownerId, task.gcal_calendar_id, task.gcal_event_id, {
        start: { dateTime: `${task.due_date}T${start}`, timeZone },
        end: { dateTime: `${task.due_date}T${end}`, timeZone },
      });
      result.calendarSynced = true;
    } catch {
      result.calendarSynced = false;
    }
  }

  if (v.pushToCalendar) {
    if (task.gcal_event_id) {
      result.calendarPush = "already on the calendar";
    } else if (!task.due_date || !task.due_time) {
      result.calendarPush = "needs a date and time first";
    } else {
      const groupRel = task.groups;
      const group = Array.isArray(groupRel) ? (groupRel[0] ?? null) : groupRel;
      const calendarId = group?.google_calendar_id ?? "primary";
      try {
        const timeZone = await ownerTimezone(supabase, ownerId);
        const start = task.due_time.length === 5 ? `${task.due_time}:00` : task.due_time;
        const end = addMinutesToClock(start.slice(0, 5), task.duration_min ?? 30);
        const eventId = await createEvent(ownerId, calendarId, {
          summary: task.title,
          start: { dateTime: `${task.due_date}T${start}`, timeZone },
          end: { dateTime: `${task.due_date}T${end}`, timeZone },
          description: "from mindboard",
        });
        const { error: saveError } = await supabase
          .from("tasks")
          .update({ gcal_event_id: eventId, gcal_calendar_id: calendarId })
          .eq("id", task.id)
          .eq("user_id", ownerId);
        result.calendarPush = saveError ? `event created but not linked: ${saveError.message}` : "pushed";
      } catch (pushError) {
        result.calendarPush =
          pushError instanceof Error ? pushError.message : "calendar push failed";
      }
    }
  }

  return { ok: true, value: result };
}

export async function proposeDeleteTaskFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const taskId = (raw as { taskId?: unknown })?.taskId;
  if (typeof taskId !== "string" || !taskId) {
    return { ok: false, error: "taskId is required" };
  }
  const { data } = await supabase
    .from("tasks")
    .select("id, title, status")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, error: "task not found" };
  const task = data as { title: string; status: string };

  const summary = `Delete task "${task.title}"${task.status === "done" ? " (already done)" : ""} — this cannot be undone.`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "delete_task",
    { taskId },
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeDeleteTask(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeDeleteTaskFor(createServiceClient(), userId, raw);
}

async function executeDeleteTask(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const taskId = input.taskId;
  if (typeof taskId !== "string") return { ok: false, error: "taskId is required" };
  const { data, error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", taskId)
    .eq("user_id", ownerId)
    .select("id, title");
  if (error) return { ok: false, error: error.message };
  if ((data ?? []).length === 0) return { ok: false, error: "task not found" };
  return { ok: true, value: { deleted: (data as { title: string }[])[0].title } };
}

// ---------- recurring-task edits ----------

export async function proposeUpdateRecurringTaskFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateUpdateRecurringTask((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  const { data } = await supabase
    .from("recurring_tasks")
    .select("id, title, archived")
    .eq("id", v.ruleId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, error: "repeating task not found" };
  const rule = data as { title: string; archived: boolean };
  if (rule.archived) return { ok: false, error: `"${rule.title}" is stopped — nothing to edit` };

  if (v.groupId && !(await ownsRow(supabase, "groups", v.groupId, userId))) {
    return { ok: false, error: "group not found" };
  }

  const bits: string[] = [];
  if (v.title !== undefined) bits.push(`rename to "${v.title}"`);
  if (v.recurrence !== undefined) bits.push(`repeat ${formatRecurrence(v.recurrence)}`);
  if (v.dueTime !== undefined) bits.push(v.dueTime === null ? "clear the time" : `at ${v.dueTime}`);
  if (v.durationMin !== undefined && v.durationMin !== null) bits.push(`${v.durationMin}min`);
  if (v.groupId !== undefined) bits.push(v.groupId === null ? "move to no group" : "move group");
  if (v.notes !== undefined) bits.push(v.notes === null ? "clear notes" : "update notes");
  if (v.priority !== undefined) bits.push(`priority ${v.priority}`);
  const summary = `Update repeating task "${rule.title}": ${bits.join(", ")}.`;

  const proposalId = await recordProposal(
    supabase,
    userId,
    "update_recurring_task",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeUpdateRecurringTask(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeUpdateRecurringTaskFor(createServiceClient(), userId, raw);
}

async function executeUpdateRecurringTask(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateUpdateRecurringTask(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  if (v.groupId && !(await ownsRow(supabase, "groups", v.groupId, ownerId))) {
    return { ok: false, error: "group not found" };
  }

  const updates: Record<string, unknown> = {};
  if (v.title !== undefined) updates.title = v.title;
  if (v.groupId !== undefined) updates.group_id = v.groupId;
  if (v.notes !== undefined) updates.notes = v.notes;
  if (v.priority !== undefined) updates.priority = v.priority;
  if (v.recurrence !== undefined) {
    updates.frequency = v.recurrence.frequency;
    updates.weekdays = v.recurrence.weekdays;
    updates.day_of_month = v.recurrence.day_of_month;
    updates.interval_days = v.recurrence.interval_days;
    updates.start_date =
      v.recurrence.frequency === "custom"
        ? (v.recurrence.start_date ?? (await todayKey(supabase, ownerId)))
        : v.recurrence.start_date;
  }
  if (v.dueTime !== undefined) {
    updates.due_time = v.dueTime === null ? null : `${v.dueTime}:00`;
    if (v.dueTime === null) updates.duration_min = null;
  }
  if (v.durationMin !== undefined && updates.duration_min === undefined) {
    updates.duration_min = v.durationMin;
  }

  const { data, error } = await supabase
    .from("recurring_tasks")
    .update(updates)
    .eq("id", v.ruleId)
    .eq("user_id", ownerId)
    .select("id, title")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "repeating task not found" };
  return { ok: true, value: { rule: data } };
}

export async function proposeCompleteRecurringFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const ruleId = (raw as { ruleId?: unknown })?.ruleId;
  const undo = (raw as { undo?: unknown })?.undo === true;
  if (typeof ruleId !== "string" || !ruleId) {
    return { ok: false, error: "ruleId is required" };
  }

  const { data } = await supabase
    .from("recurring_tasks")
    .select("id, title, archived")
    .eq("id", ruleId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { ok: false, error: "repeating task not found" };
  const rule = data as { title: string };

  const summary = undo
    ? `Un-check today's "${rule.title}".`
    : `Check off today's "${rule.title}".`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "complete_recurring",
    { ruleId, undo },
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeCompleteRecurring(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeCompleteRecurringFor(createServiceClient(), userId, raw);
}

// Only today is completable — occurrences skip silently, so there is no
// yesterday to check off (mirrors completeRecurringOccurrence in actions).
async function executeCompleteRecurring(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const ruleId = input.ruleId;
  if (typeof ruleId !== "string") return { ok: false, error: "ruleId is required" };
  if (!(await ownsRow(supabase, "recurring_tasks", ruleId, ownerId))) {
    return { ok: false, error: "repeating task not found" };
  }
  const today = await todayKey(supabase, ownerId);
  if (input.undo === true) {
    const { error } = await supabase
      .from("recurring_task_completions")
      .delete()
      .eq("rule_id", ruleId)
      .eq("occurred_on", today)
      .eq("user_id", ownerId);
    if (error) return { ok: false, error: error.message };
    return { ok: true, value: { unchecked: today } };
  }
  const { error } = await supabase
    .from("recurring_task_completions")
    .upsert(
      { user_id: ownerId, rule_id: ruleId, occurred_on: today },
      { onConflict: "rule_id,occurred_on", ignoreDuplicates: true },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: { completed: today } };
}

// ---------- groups ----------

export async function proposeManageGroupFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateManageGroup((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  let summary: string;
  if (v.action === "create") {
    summary = `Create group "${v.name}" (${v.type}, ${v.color}).`;
  } else {
    const { data } = await supabase
      .from("groups")
      .select("id, name")
      .eq("id", v.groupId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return { ok: false, error: "group not found" };
    const current = (data as { name: string }).name;
    if (v.action === "archive") {
      summary = `Archive group "${current}" (its tasks stay, hidden from the group list).`;
    } else {
      const bits: string[] = [];
      if (v.name !== undefined) bits.push(`rename to "${v.name}"`);
      if (v.type !== undefined) bits.push(`type ${v.type}`);
      if (v.color !== undefined) bits.push(`color ${v.color}`);
      if (v.googleCalendarId !== undefined) {
        bits.push(v.googleCalendarId === null ? "unlink calendar" : "link a Google Calendar");
      }
      summary = `Update group "${current}": ${bits.join(", ")}.`;
    }
  }

  const proposalId = await recordProposal(
    supabase,
    userId,
    "manage_group",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeManageGroup(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeManageGroupFor(createServiceClient(), userId, raw);
}

async function executeManageGroup(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateManageGroup(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  if (v.action === "create") {
    const { data, error } = await supabase
      .from("groups")
      .insert({ user_id: ownerId, name: v.name, type: v.type, color: v.color })
      .select("id, name, type, color")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "insert failed" };
    return { ok: true, value: { group: data } };
  }

  const updates: Record<string, unknown> =
    v.action === "archive" ? { archived: true } : {};
  if (v.action === "update") {
    if (v.name !== undefined) updates.name = v.name;
    if (v.type !== undefined) updates.type = v.type;
    if (v.color !== undefined) updates.color = v.color;
    if (v.googleCalendarId !== undefined) updates.google_calendar_id = v.googleCalendarId;
  }

  const { data, error } = await supabase
    .from("groups")
    .update(updates)
    .eq("id", v.groupId)
    .eq("user_id", ownerId)
    .select("id, name")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "group not found" };
  return { ok: true, value: { group: data } };
}

// ---------- goals ----------

export async function proposeUpsertGoalFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateUpsertGoal((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  let existingTitle: string | null = null;
  if (v.goalId) {
    const { data } = await supabase
      .from("goals")
      .select("id, title")
      .eq("id", v.goalId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return { ok: false, error: "goal not found" };
    existingTitle = (data as { title: string }).title;
  }

  const summary = v.goalId
    ? `Update goal "${existingTitle}"${v.status ? ` → ${v.status}` : ""}${v.title ? ` (retitle: "${v.title}")` : ""}.`
    : `Create goal "${v.title}"${v.horizon ? ` (${v.horizon})` : ""}${v.targetDate ? ` targeting ${v.targetDate}` : ""}.`;

  const proposalId = await recordProposal(
    supabase,
    userId,
    "upsert_goal",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeUpsertGoal(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeUpsertGoalFor(createServiceClient(), userId, raw);
}

// Shared executor for goal upserts (formerly assistant-only in
// app/actions/assistant.ts; MCP and the assistant now confirm through here).
async function executeUpsertGoal(
  supabase: SupabaseClient,
  ownerId: string,
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
      updates.completed_at = input.status === "done" ? new Date().toISOString() : null;
    }
    if (typeof input.targetDate === "string") updates.target_date = input.targetDate;
    const { data, error } = await supabase
      .from("goals")
      .update(updates)
      .eq("id", goalId)
      .eq("user_id", ownerId)
      .select("id, title, status")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "goal not found" };
    return { ok: true, value: { goal: data } };
  }

  const { data, error } = await supabase
    .from("goals")
    .insert({
      user_id: ownerId,
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

// ---------- google calendar events ----------

export async function proposeRescheduleEventFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateRescheduleEvent((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  const summary = v.allDay
    ? `Move event ${v.eventId} to ${v.start} (all-day).`
    : `Move event ${v.eventId} to ${v.start} – ${v.end}.`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "reschedule_event",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeRescheduleEvent(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeRescheduleEventFor(createServiceClient(), userId, raw);
}

async function executeRescheduleEvent(
  _supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateRescheduleEvent(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  try {
    await updateEvent(ownerId, v.calendarId, v.eventId, {
      start: v.allDay
        ? { date: v.start }
        : { dateTime: v.start, ...(v.timeZone ? { timeZone: v.timeZone } : {}) },
      end: v.allDay
        ? { date: v.end }
        : { dateTime: v.end, ...(v.timeZone ? { timeZone: v.timeZone } : {}) },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "update failed" };
  }
  return { ok: true, value: { rescheduled: v.eventId } };
}

export async function proposeCreateEventFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateCreateEvent((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  const when = v.startTime
    ? `${v.date} at ${v.startTime} (${v.durationMin}min)`
    : `${v.date} (all-day)`;
  const where = v.calendarId === "primary" ? "" : ` on calendar ${v.calendarId}`;
  const summary = `Create Google Calendar event "${v.summary}" — ${when}${where}.`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "create_event",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeCreateEvent(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeCreateEventFor(createServiceClient(), userId, raw);
}

async function executeCreateEvent(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateCreateEvent(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  try {
    let eventId: string;
    if (v.startTime) {
      const timeZone = await ownerTimezone(supabase, ownerId);
      const start = `${v.startTime}:00`;
      const end = addMinutesToClock(v.startTime, v.durationMin);
      eventId = await createEvent(ownerId, v.calendarId, {
        summary: v.summary,
        start: { dateTime: `${v.date}T${start}`, timeZone },
        end: { dateTime: `${v.date}T${end}`, timeZone },
        ...(v.description ? { description: v.description } : {}),
      });
    } else {
      const [y, m, d] = v.date.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      const endDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
      eventId = await createEvent(ownerId, v.calendarId, {
        summary: v.summary,
        start: { date: v.date },
        end: { date: endDate },
        ...(v.description ? { description: v.description } : {}),
      });
    }
    return { ok: true, value: { eventId } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "event create failed" };
  }
}

// ---------- daily log + settings ----------

export async function proposeLogDailyFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateDailyLog((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const sleep = v.sleepHours === null ? "" : `, slept ${v.sleepHours}h`;
  const summary = `Log today: mood ${v.mood}/5, energy ${v.energy}/5${sleep}.`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "log_daily",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeLogDaily(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeLogDailyFor(createServiceClient(), userId, raw);
}

async function executeLogDaily(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateDailyLog(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const today = await todayKey(supabase, ownerId);
  const { error } = await supabase.from("daily_logs").upsert(
    {
      user_id: ownerId,
      log_date: today,
      mood: v.mood,
      energy: v.energy,
      sleep_hours: v.sleepHours,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,log_date" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: { logged: today } };
}

export async function proposeUpdateSettingsFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateUpdateSettings((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  const bits: string[] = [];
  if (v.timezone !== undefined) bits.push(`timezone → ${v.timezone}`);
  if (v.wakeStartHour !== undefined) bits.push(`wake start → ${v.wakeStartHour}:00`);
  if (v.wakeEndHour !== undefined) bits.push(`wake end → ${v.wakeEndHour}:00`);
  if (v.shoppingStore !== undefined) {
    bits.push(
      v.shoppingStore === null
        ? "grocery store cleared"
        : `grocery store → ${v.shoppingStore}`,
    );
  }
  if (v.shoppingDay !== undefined) {
    const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    bits.push(
      v.shoppingDay === null
        ? "shopping day cleared"
        : `shopping day → ${DAY_NAMES[v.shoppingDay]}`,
    );
  }
  const summary = `Update preferences: ${bits.join(", ")}.`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "update_settings",
    v as unknown as Record<string, unknown>,
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function proposeUpdateSettings(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeUpdateSettingsFor(createServiceClient(), userId, raw);
}

async function executeUpdateSettings(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateUpdateSettings(input);
  if (!parsed.ok) return parsed;
  const v = parsed.value;

  // Cross-check the merged wake window against what's stored, since the patch
  // may set only one edge.
  const { data: current } = await supabase
    .from("user_settings")
    .select("wake_start_hour, wake_end_hour")
    .eq("user_id", ownerId)
    .maybeSingle();
  const start = v.wakeStartHour ?? (current?.wake_start_hour as number | undefined) ?? 8;
  const end = v.wakeEndHour ?? (current?.wake_end_hour as number | undefined) ?? 22;
  if (end <= start) {
    return { ok: false, error: `wake end (${end}) must be after wake start (${start})` };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (v.timezone !== undefined) patch.timezone = v.timezone;
  if (v.wakeStartHour !== undefined) patch.wake_start_hour = v.wakeStartHour;
  if (v.wakeEndHour !== undefined) patch.wake_end_hour = v.wakeEndHour;
  if (v.shoppingStore !== undefined) patch.shopping_store = v.shoppingStore;
  if (v.shoppingDay !== undefined) patch.shopping_day = v.shoppingDay;

  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: ownerId, ...patch }, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: { updated: Object.keys(patch).filter((k) => k !== "updated_at") } };
}

// ---------- finance configuration (manage_finance) ----------

export async function proposeManageFinanceFor(
  supabase: SupabaseClient,
  userId: string,
  raw: unknown,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal>> {
  const parsed = validateAdminOps(raw);
  if (!parsed.ok) return parsed;

  const [accountsRes, categoriesRes, recurringRes, incomeRes] = await Promise.all([
    supabase.from("accounts").select("id, name").eq("user_id", userId),
    supabase.from("spending_categories").select("id, name").eq("user_id", userId),
    supabase.from("recurring_expenses").select("id, name").eq("user_id", userId),
    supabase.from("income_sources").select("id, name").eq("user_id", userId),
  ]);

  const resolved = resolveAdminOps(parsed.value, {
    accounts: (accountsRes.data ?? []) as ResolvableRef[],
    categories: (categoriesRes.data ?? []) as ResolvableRef[],
    recurring: (recurringRes.data ?? []) as ResolvableRef[],
    incomeSources: (incomeRes.data ?? []) as ResolvableRef[],
    today: await todayKey(supabase, userId),
  });
  if (!resolved.ok) return resolved;

  const preview = renderAdminReceipt(resolved.value);
  const proposalId = await recordProposal(
    supabase,
    userId,
    "manage_finance",
    { operations: resolved.value } as unknown as Record<string, unknown>,
    preview,
    options,
  );
  return { ok: true, value: { proposalId, preview } };
}

export async function proposeManageFinance(userId: string, raw: unknown): Promise<Result<Proposal>> {
  return proposeManageFinanceFor(createServiceClient(), userId, raw);
}

async function executeManageFinance(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const parsed = validateResolvedAdminOps(input);
  if (!parsed.ok) return parsed;
  const ops = parsed.value;
  const today = await todayKey(supabase, ownerId);

  const applied: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const fail = (message: string): Result<Record<string, unknown>> => ({
      ok: false,
      error: `${message} (applied ${i} of ${ops.length} operations)`,
    });

    switch (op.kind) {
      case "create_account": {
        const { data: account, error } = await supabase
          .from("accounts")
          .insert({
            user_id: ownerId,
            name: op.name,
            type: op.type,
            color: op.color,
            currency: op.currency,
            balance: op.balance,
          })
          .select("id")
          .single();
        if (error || !account) return fail(error?.message ?? "account insert failed");
        // Seed an opening row + anchor so the derived balance starts coherent
        // (mirrors createAccount in app/actions/finance.ts).
        if (op.balance > 0) {
          const { error: rowError } = await supabase.from("balance_changes").insert({
            user_id: ownerId,
            account_id: account.id,
            direction: "in",
            amount: op.balance,
            note: "opening balance",
            occurred_at: today,
            source: "assistant",
            fingerprint: changeFingerprint(today, "in", op.balance),
          });
          if (rowError) return fail(rowError.message);
        }
        const { error: anchorError } = await supabase
          .from("account_reconciliations")
          .insert({
            user_id: ownerId,
            account_id: account.id,
            balance: op.balance,
            as_of: today,
            source: "assistant",
            note: "opening balance",
          });
        if (anchorError) return fail(anchorError.message);
        applied.push(adminReceiptLine(op));
        break;
      }
      case "update_account": {
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (op.name !== null) updates.name = op.name;
        if (op.type !== null) updates.type = op.type;
        if (op.color !== null) updates.color = op.color;
        if (op.archived !== null) updates.archived = op.archived;
        const { data, error } = await supabase
          .from("accounts")
          .update(updates)
          .eq("id", op.accountId)
          .eq("user_id", ownerId)
          .select("id");
        if (error) return fail(error.message);
        if ((data ?? []).length === 0) return fail("account no longer exists");
        applied.push(adminReceiptLine(op));
        break;
      }
      case "update_category": {
        const updates: Record<string, unknown> = {};
        if (op.name !== null) updates.name = op.name;
        if (op.color !== null) updates.color = op.color;
        if (op.archived !== null) updates.archived = op.archived;
        const { data, error } = await supabase
          .from("spending_categories")
          .update(updates)
          .eq("id", op.categoryId)
          .eq("user_id", ownerId)
          .select("id");
        if (error) return fail(error.message);
        if ((data ?? []).length === 0) return fail("category no longer exists");
        applied.push(adminReceiptLine(op));
        break;
      }
      case "update_recurring": {
        if (op.categoryId && !(await ownsRow(supabase, "spending_categories", op.categoryId, ownerId))) {
          return fail("category no longer exists");
        }
        const updates: Record<string, unknown> = {};
        if (op.name !== null) updates.name = op.name;
        if (op.amount !== null) updates.amount = op.amount;
        if (op.clearCategory) updates.category_id = null;
        else if (op.categoryId !== null) updates.category_id = op.categoryId;
        if (op.frequency !== null) {
          updates.frequency = op.frequency;
          updates.day_of_month = op.dayOfMonth;
          updates.weekday = op.weekday;
          updates.interval_days = op.intervalDays;
          updates.start_date = op.startDate;
        }
        if (op.archived !== null) updates.archived = op.archived;
        const { data, error } = await supabase
          .from("recurring_expenses")
          .update(updates)
          .eq("id", op.ruleId)
          .eq("user_id", ownerId)
          .select("id");
        if (error) return fail(error.message);
        if ((data ?? []).length === 0) return fail("recurring expense no longer exists");
        applied.push(adminReceiptLine(op));
        break;
      }
      case "create_income": {
        const { error } = await supabase.from("income_sources").insert({
          user_id: ownerId,
          name: op.name,
          hourly_wage: op.hourlyWage,
          tax_rate: op.taxRate,
          calendar_id: op.calendarId,
          color: op.color,
          pay_frequency: op.payFrequency,
          anchor_payday: op.anchorPayday,
          period_start: op.periodStart,
          period_end: op.periodEnd,
        });
        if (error) return fail(error.message);
        applied.push(adminReceiptLine(op));
        break;
      }
      case "update_income": {
        const updates: Record<string, unknown> = {};
        if (op.name !== null) updates.name = op.name;
        if (op.hourlyWage !== null) updates.hourly_wage = op.hourlyWage;
        if (op.taxRate !== null) updates.tax_rate = op.taxRate;
        if (op.clearCalendar) updates.calendar_id = null;
        else if (op.calendarId !== null) updates.calendar_id = op.calendarId;
        if (op.color !== null) updates.color = op.color;
        if (op.archived !== null) updates.archived = op.archived;
        if (op.schedule === "clear") {
          updates.pay_frequency = null;
          updates.anchor_payday = null;
          updates.period_start = null;
          updates.period_end = null;
        } else if (op.schedule !== null) {
          updates.pay_frequency = op.schedule.payFrequency;
          updates.anchor_payday = op.schedule.anchorPayday;
          updates.period_start = op.schedule.periodStart;
          updates.period_end = op.schedule.periodEnd;
        }
        const { data, error } = await supabase
          .from("income_sources")
          .update(updates)
          .eq("id", op.sourceId)
          .eq("user_id", ownerId)
          .select("id");
        if (error) return fail(error.message);
        if ((data ?? []).length === 0) return fail("income source no longer exists");
        applied.push(adminReceiptLine(op));
        break;
      }
      case "set_spend_override": {
        if (op.date <= today) {
          return fail(`${op.date} is no longer a future day`);
        }
        if (op.amount === null) {
          const { error } = await supabase
            .from("spend_overrides")
            .delete()
            .eq("user_id", ownerId)
            .eq("date", op.date);
          if (error) return fail(error.message);
        } else {
          const { error } = await supabase.from("spend_overrides").upsert(
            {
              user_id: ownerId,
              date: op.date,
              amount: op.amount,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,date" },
          );
          if (error) return fail(error.message);
        }
        applied.push(adminReceiptLine(op));
        break;
      }
      case "set_daily_spend_estimate": {
        const { error } = await supabase.from("user_settings").upsert(
          {
            user_id: ownerId,
            daily_spend_estimate: op.amount,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
        if (error) return fail(error.message);
        applied.push(adminReceiptLine(op));
        break;
      }
    }
  }

  return { ok: true, value: { applied } };
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
  update_task: executeUpdateTask,
  delete_task: executeDeleteTask,
  create_recurring_task: executeCreateRecurringTask,
  update_recurring_task: executeUpdateRecurringTask,
  archive_recurring_task: executeArchiveRecurringTask,
  complete_recurring: executeCompleteRecurring,
  complete_task: executeCompleteTask,
  manage_group: executeManageGroup,
  upsert_goal: executeUpsertGoal,
  reschedule_event: executeRescheduleEvent,
  create_event: executeCreateEvent,
  log_daily: executeLogDaily,
  update_settings: executeUpdateSettings,
  log_spend: executeLogSpend,
  update_stock: executeUpdateStock,
  update_finance: executeUpdateFinance,
  manage_finance: executeManageFinance,
  set_spend_limit: executeSetSpendLimit,
  delete_spend_limit: executeDeleteSpendLimit,
  generate_audio_overview: executeGenerateAudioOverview,
};

// ---------- confirm / cancel ----------

export async function confirmAction(
  userId: string,
  proposalId: unknown,
): Promise<Result<{ preview: string; result: Record<string, unknown> }>> {
  if (typeof proposalId !== "string" || !proposalId) {
    return { ok: false, error: "proposalId is required" };
  }

  const supabase = createServiceClient();
  const ownerId = userId;

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

  // Claim BEFORE executing so a concurrent confirm (double-tap / client retry)
  // can't also run the executor and double-apply the write. The loser gets
  // no rows and bails without touching anything.
  const claimed = await claimProposal(supabase, ownerId, proposalId);
  if (!claimed) {
    return { ok: false, error: "proposal is already being confirmed or resolved" };
  }

  let outcome: Result<Record<string, unknown>>;
  try {
    outcome = await executor(supabase, ownerId, proposal.input);
  } catch (err) {
    await finalizeClaimedProposal(supabase, ownerId, proposalId, "error", {
      error: err instanceof Error ? err.message : "executor threw",
    });
    return { ok: false, error: err instanceof Error ? err.message : "executor threw" };
  }

  if (!outcome.ok) {
    await finalizeClaimedProposal(supabase, ownerId, proposalId, "error", {
      error: outcome.error,
    });
    return outcome;
  }

  await finalizeClaimedProposal(supabase, ownerId, proposalId, "executed", outcome.value);
  await revalidateWeb();
  return { ok: true, value: { preview: proposal.summary, result: outcome.value } };
}

export async function cancelAction(
  userId: string,
  proposalId: unknown,
): Promise<Result<{ cancelled: true }>> {
  if (typeof proposalId !== "string" || !proposalId) {
    return { ok: false, error: "proposalId is required" };
  }
  const supabase = createServiceClient();
  const ownerId = userId;
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
