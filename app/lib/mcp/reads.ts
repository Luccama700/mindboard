import "server-only";
import { createServiceClient } from "@/utils/supabase/service";
import { ownerUserId, todayKey } from "./config";
import { formatRecurrence } from "@/app/lib/recurrence";
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
  "id, account_id, category_id, direction, amount, note, occurred_at, created_at, source, is_transfer";
const ITEM_COLUMNS =
  "id, name, quantity, unit, notes, image_url, inventory_group_id, reorder_threshold, archived, archived_at, last_restocked_at, created_at";
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
      .eq("archived", false)
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

// Repeating-task rules with a readable schedule label. The ids feed
// archive_recurring_task; occurrences themselves are virtual.
export async function listRecurringTasks(filter?: { includeArchived?: boolean }) {
  const { supabase, ownerId } = scoped();

  let query = supabase
    .from("recurring_tasks")
    .select(
      "id, title, priority, frequency, weekdays, day_of_month, interval_days, start_date, due_time, duration_min, group_id, archived, groups(name)",
    )
    .eq("user_id", ownerId)
    .order("created_at", { ascending: true });
  if (!filter?.includeArchived) query = query.eq("archived", false);

  const { data } = await query;

  type Row = {
    id: string;
    title: string;
    priority: "low" | "med" | "high";
    frequency: "daily" | "weekly" | "monthly" | "custom";
    weekdays: number[] | null;
    day_of_month: number | null;
    interval_days: number | null;
    start_date: string | null;
    due_time: string | null;
    duration_min: number | null;
    group_id: string | null;
    archived: boolean;
    groups: { name: string } | { name: string }[] | null;
  };

  return ((data ?? []) as unknown as Row[]).map((row) => {
    const group = Array.isArray(row.groups) ? (row.groups[0] ?? null) : row.groups;
    return {
      id: row.id,
      title: row.title,
      priority: row.priority,
      schedule: formatRecurrence(row),
      frequency: row.frequency,
      weekdays: row.weekdays,
      dayOfMonth: row.day_of_month,
      intervalDays: row.interval_days,
      startDate: row.start_date,
      dueTime: row.due_time ? row.due_time.slice(0, 5) : null,
      durationMin: row.duration_min,
      group: group?.name ?? null,
      archived: row.archived,
    };
  });
}

// Items + groups in one payload: the ids feed update_stock, the group list lets
// a create op target a group by name.
export async function listInventory(filter?: { includeArchived?: boolean }) {
  const { supabase, ownerId } = scoped();

  let itemQuery = supabase
    .from("inventory_items")
    .select(
      "id, name, quantity, unit, reorder_threshold, priority, archived, archived_at, inventory_group_id, created_at",
    )
    .eq("user_id", ownerId)
    .order("name", { ascending: true });
  if (!filter?.includeArchived) itemQuery = itemQuery.eq("archived", false);

  const [itemsRes, groupsRes] = await Promise.all([
    itemQuery,
    supabase
      .from("inventory_groups")
      .select("id, name, color")
      .eq("user_id", ownerId)
      .order("name", { ascending: true }),
  ]);

  const groups = (groupsRes.data ?? []) as { id: string; name: string; color: string }[];
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));

  type ItemRow = {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    reorder_threshold: number | null;
    priority: "low" | "med" | "high";
    archived: boolean;
    archived_at: string | null;
    inventory_group_id: string | null;
    created_at: string;
  };

  return {
    items: ((itemsRes.data ?? []) as ItemRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      quantity: Number(row.quantity),
      unit: row.unit,
      reorderThreshold: row.reorder_threshold,
      priority: row.priority,
      archived: row.archived,
      group: row.inventory_group_id
        ? (groupNames.get(row.inventory_group_id) ?? null)
        : null,
    })),
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
  };
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

// Recurring-expense rules with a readable schedule. Feeds update_finance's
// create_recurring dedup (Claude checks here before proposing a new rule).
export async function listRecurringExpenses() {
  const { supabase, ownerId } = scoped();
  const { data } = await supabase
    .from("recurring_expenses")
    .select(RECURRING_COLUMNS)
    .eq("user_id", ownerId)
    .eq("archived", false)
    .order("created_at", { ascending: true });

  const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return ((data ?? []) as RecurringExpense[]).map((row) => ({
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    categoryId: row.category_id,
    schedule:
      row.frequency === "monthly"
        ? `monthly on day ${row.day_of_month}`
        : row.frequency === "weekly"
          ? `weekly on ${weekdays[row.weekday ?? 0]}`
          : row.frequency === "daily"
            ? "daily"
            : `every ${row.interval_days} days from ${row.start_date}`,
  }));
}

export async function listRecentLedger(limit = 20) {
  const { supabase, ownerId } = scoped();
  const capped = Math.min(Math.max(1, limit), 100);
  const { data } = await supabase
    .from("balance_changes")
    .select(
      `id, direction, amount, note, occurred_at, is_transfer,
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
    note: string | null;
    occurred_at: string;
    is_transfer: boolean;
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
      note: row.note,
      occurredAt: row.occurred_at,
      isTransfer: row.is_transfer,
      account: account?.name ?? "account",
      currency: account?.currency ?? "USD",
      category: row.direction === "out" ? (category?.name ?? "uncategorized") : null,
    };
  });
}
