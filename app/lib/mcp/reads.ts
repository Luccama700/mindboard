import "server-only";
import { createServiceClient } from "@/utils/supabase/service";
import { ownerUserId, todayKey } from "./config";
import { financeSnapshot, type FinanceVitals } from "@/app/lib/snapshots/finance";
import { tasksSnapshot, type TaskVitals } from "@/app/lib/snapshots/tasks";
import {
  inventorySnapshot,
  type InventoryVitals,
} from "@/app/lib/snapshots/inventory";
import type {
  Account,
  BalanceChange,
  RecurringExpense,
} from "@/app/_components/finance-types";
import type {
  InventoryItem,
  InventoryUsage,
} from "@/app/_components/inventory-types";
import type { TaskWithGroup } from "@/app/_components/types";

// Read layer for the MCP server. Every query goes through the service-role
// client and is scoped by `.eq("user_id", ownerId)` explicitly (RLS is bypassed
// on that client). The pure snapshots in app/lib/snapshots/* are reused as-is —
// only the fetching differs from the cookie-session dashboard path.

const ACCOUNT_COLUMNS =
  "id, name, type, color, balance, currency, archived, created_at, updated_at";
const RECURRING_COLUMNS =
  "id, name, amount, category_id, frequency, day_of_month, weekday, interval_days, start_date, archived, created_at";
const CHANGE_COLUMNS =
  "id, account_id, category_id, direction, amount, balance_after, note, occurred_at, created_at";
const ITEM_COLUMNS =
  "id, name, quantity, unit, notes, image_url, inventory_group_id, reorder_threshold, created_at";
const USAGE_COLUMNS =
  "id, inventory_item_id, amount, period, interval_days, created_at";
const TASK_COLUMNS =
  "id, title, due_date, status, priority, notes, group_id, created_at, completed_at";

function scoped() {
  return { supabase: createServiceClient(), ownerId: ownerUserId() };
}

// Supabase can type an embedded relation as either an object or an array; the
// dashboard normalizes the same way (see app/page.tsx firstRel).
type Rel<T> = T | T[] | null;
function firstRel<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);
}

// ---------- snapshot reads (reuse the pure rollups) ----------

export async function getFinanceSnapshot(): Promise<FinanceVitals> {
  const { supabase, ownerId } = scoped();
  const today = todayKey();

  const [accountsRes, recurringRes, changesRes] = await Promise.all([
    supabase
      .from("accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("user_id", ownerId)
      .eq("archived", false),
    supabase
      .from("recurring_expenses")
      .select(RECURRING_COLUMNS)
      .eq("user_id", ownerId)
      .eq("archived", false),
    supabase
      .from("balance_changes")
      .select(CHANGE_COLUMNS)
      .eq("user_id", ownerId)
      .eq("occurred_at", today),
  ]);

  return financeSnapshot({
    accounts: (accountsRes.data ?? []) as Account[],
    recurringExpenses: (recurringRes.data ?? []) as RecurringExpense[],
    todayChanges: (changesRes.data ?? []) as BalanceChange[],
    today,
  });
}

export async function getTasksSnapshot(): Promise<TaskVitals> {
  const tasks = await listTasks({});
  return tasksSnapshot(tasks, todayKey());
}

export async function getInventorySnapshot(): Promise<InventoryVitals> {
  const { supabase, ownerId } = scoped();

  const [itemsRes, usagesRes] = await Promise.all([
    supabase
      .from("inventory_items")
      .select(ITEM_COLUMNS)
      .eq("user_id", ownerId)
      .order("created_at", { ascending: true }),
    supabase
      .from("inventory_usages")
      .select(USAGE_COLUMNS)
      .eq("user_id", ownerId)
      .order("created_at", { ascending: true }),
  ]);

  return inventorySnapshot({
    items: (itemsRes.data ?? []) as InventoryItem[],
    usages: (usagesRes.data ?? []) as InventoryUsage[],
    today: todayKey(),
  });
}

// ---------- list reads (also give Claude valid ids for the write tools) ----------

export async function listTasks(filter: {
  groupId?: string | null;
  status?: "todo" | "doing" | "done";
}): Promise<TaskWithGroup[]> {
  const { supabase, ownerId } = scoped();

  let query = supabase
    .from("tasks")
    .select(`${TASK_COLUMNS}, groups(name, color)`)
    .eq("user_id", ownerId);

  if (filter.groupId !== undefined) {
    query = filter.groupId === null
      ? query.is("group_id", null)
      : query.eq("group_id", filter.groupId);
  }
  if (filter.status) query = query.eq("status", filter.status);

  const { data } = await query
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(200);

  type Row = Omit<TaskWithGroup, "group_name" | "group_color"> & {
    groups: Rel<{ name: string; color: string }>;
  };

  return ((data ?? []) as Row[]).map(({ groups, ...task }) => {
    const group = firstRel(groups);
    return {
      ...task,
      group_name: group?.name ?? null,
      group_color: group?.color ?? null,
    };
  });
}

export async function listGroups() {
  const { supabase, ownerId } = scoped();
  const { data } = await supabase
    .from("groups")
    .select("id, name, type, color, archived, created_at")
    .eq("user_id", ownerId)
    .eq("archived", false)
    .order("created_at", { ascending: true });
  return data ?? [];
}

export async function listAccounts() {
  const { supabase, ownerId } = scoped();
  const { data } = await supabase
    .from("accounts")
    .select("id, name, type, balance, currency, archived")
    .eq("user_id", ownerId)
    .eq("archived", false)
    .order("created_at", { ascending: true });
  return data ?? [];
}

export async function listCategories() {
  const { supabase, ownerId } = scoped();
  const { data } = await supabase
    .from("spending_categories")
    .select("id, name, color, archived")
    .eq("user_id", ownerId)
    .eq("archived", false)
    .order("name", { ascending: true });
  return data ?? [];
}

export async function listRecentLedger(limit = 20) {
  const { supabase, ownerId } = scoped();
  const capped = Math.min(Math.max(1, limit), 100);
  const { data } = await supabase
    .from("balance_changes")
    .select(
      `id, direction, amount, balance_after, note, occurred_at,
       accounts(name, currency), spending_categories(name)`,
    )
    .eq("user_id", ownerId)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(capped);

  type Row = {
    id: string;
    direction: "in" | "out";
    amount: number;
    balance_after: number;
    note: string | null;
    occurred_at: string;
    accounts: Rel<{ name: string; currency: string }>;
    spending_categories: Rel<{ name: string }>;
  };

  return ((data ?? []) as Row[]).map((row) => {
    const account = firstRel(row.accounts);
    const category = firstRel(row.spending_categories);
    return {
      id: row.id,
      direction: row.direction,
      amount: Number(row.amount),
      balanceAfter: Number(row.balance_after),
      note: row.note,
      occurredAt: row.occurred_at,
      account: account?.name ?? "account",
      currency: account?.currency ?? "USD",
      category: row.direction === "out" ? (category?.name ?? "uncategorized") : null,
    };
  });
}
