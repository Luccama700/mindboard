import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/utils/supabase/service";
import { todayKey } from "./config";
import { formatRecurrence } from "@/app/lib/recurrence";
import { financeSnapshot, type FinanceVitals } from "@/app/lib/snapshots/finance";
import { tasksSnapshot, type TaskVitals } from "@/app/lib/snapshots/tasks";
import {
  inventorySnapshot,
  type InventoryVitals,
} from "@/app/lib/snapshots/inventory";
import {
  freeGaps,
  scheduleSnapshot,
} from "@/app/lib/snapshots/schedule";
import { listEvents, type CalendarEvent } from "@/utils/google/calendar";
import { addDaysKey } from "@/app/_components/finance-projection";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import { buildFinanceForecast } from "@/app/lib/finance/forecast";
import { buildPlanningSnapshot } from "@/app/lib/snapshots/planning-read";
import {
  effectiveDailyRate,
  daysUntilEmpty,
  runOutDateKey,
  reorderDateKey,
  stockStatus,
  type UsageRule,
} from "@/app/_components/inventory-projection";
import {
  buildShoppingList,
  shoppingTotal,
  type ShoppingListItem,
} from "@/app/_components/shopping-list";
import {
  listVaultNotePaths,
  readVaultCredentials,
  readVaultNoteRaw,
  vaultTag,
} from "@/app/lib/brain/vault";
import {
  extractIntro,
  extractSectionBullets,
  parseFrontmatter,
} from "@/app/lib/brain/parse";
import { daysBetweenKeys } from "@/app/_components/people-recency";
import { resolvePersonRef, type ResolvablePerson } from "./people-ops";
import type {
  Account,
  BalanceChange,
  RecurringExpense,
  SpendLimit,
} from "@/app/_components/finance-types";
import type {
  BillRule,
  SpendHistoryRow,
} from "@/app/_components/spend-baseline";
import {
  computeLimitStatuses,
  type SpendLimitStatus,
} from "@/app/_components/spend-limits";
import type {
  InventoryItem,
  InventoryUsage,
} from "@/app/_components/inventory-types";
import type { TaskWithGroup } from "@/app/_components/types";

// Read layer for the MCP server. Every function takes the authenticated
// caller's user id (resolved by the MCP auth layer) and every query goes
// through the service-role client scoped by `.eq("user_id", userId)` explicitly
// (RLS is bypassed on that client). The pure snapshots in app/lib/snapshots/*
// are reused as-is — only the fetching differs from the cookie-session path.

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
  "id, title, due_date, status, priority, ai_state, notes, group_id, created_at, completed_at, estimated_minutes, missed_at";
const SPEND_LIMIT_COLUMNS =
  "id, scope, category_id, period, amount, archived, created_at";

function scoped(userId: string) {
  return { supabase: createServiceClient(), ownerId: userId };
}

// Supabase can type an embedded relation as either an object or an array; the
// dashboard normalizes the same way (see app/page.tsx firstRel).
type Rel<T> = T | T[] | null;
function firstRel<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);
}

// ---------- snapshot reads (reuse the pure rollups) ----------

export async function getFinanceSnapshot(userId: string): Promise<FinanceVitals> {
  const { supabase, ownerId } = scoped(userId);
  const today = await todayKey(supabase, ownerId);

  const [accountsRes, recurringRes, changesRes] = await Promise.all([
    supabase
      .from("accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("user_id", ownerId)
      .eq("archived", false)
      // financeSnapshot reads the base currency off accounts[0]; unordered,
      // this MCP read could label the user's money differently per request.
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
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

export async function getTasksSnapshot(
  userId: string,
): Promise<TaskVitals & { doneThisWeek: number; missedThisWeek: number }> {
  const { supabase, ownerId } = scoped(userId);
  const today = await todayKey(supabase, ownerId);
  const tasks = await listTasks(userId, {});

  // Monday-start week in the user's zone: `today` is already local.
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0=Sun
  const weekStart = addDaysKey(today, -((dow + 6) % 7));

  const [doneRes, missedRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .gte("completed_at", weekStart),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ownerId)
      .gte("missed_at", weekStart),
  ]);

  return {
    ...tasksSnapshot(tasks, today),
    doneThisWeek: doneRes.count ?? 0,
    missedThisWeek: missedRes.count ?? 0,
  };
}

// ---------- spending limits ----------

export async function listSpendLimits(userId: string): Promise<SpendLimit[]> {
  const { supabase, ownerId } = scoped(userId);
  const { data } = await supabase
    .from("spend_limits")
    .select(SPEND_LIMIT_COLUMNS)
    .eq("user_id", ownerId)
    .eq("archived", false)
    .order("created_at", { ascending: true });
  return (data ?? []) as SpendLimit[];
}

export type SpendLimitStatusRead = SpendLimitStatus & {
  label: string; // "overall" or the category name
};

// Each active limit with actual spend this period, using the same inclusion
// rules as the everyday-spend baseline (out-flows only, transfers and recurring
// bills excluded; category scope respected). Shared by the MCP read (service
// client + owner) and the in-app assistant (session client + RLS).
export async function buildSpendLimitStatus(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<SpendLimitStatusRead[]> {
  const today = await todayKey(supabase, ownerId);
  const windowStart = addDaysKey(today, -40); // covers the current month/week

  const [limitsRes, recurringRes, changesRes, categoriesRes] = await Promise.all(
    [
      supabase
        .from("spend_limits")
        .select(SPEND_LIMIT_COLUMNS)
        .eq("user_id", ownerId)
        .eq("archived", false)
        .order("created_at", { ascending: true }),
      supabase
        .from("recurring_expenses")
        .select("amount, category_id")
        .eq("user_id", ownerId)
        .eq("archived", false),
      // Ordered so the cap truncates the oldest days rather than an arbitrary
      // slice — a spend limit computed from a random subset of the period reads
      // as headroom the user does not have.
      supabase
        .from("balance_changes")
        .select("occurred_at, direction, amount, category_id, is_transfer")
        .eq("user_id", ownerId)
        .gte("occurred_at", windowStart)
        .order("occurred_at", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(2000),
      supabase
        .from("spending_categories")
        .select("id, name")
        .eq("user_id", ownerId),
    ],
  );

  const limits = (limitsRes.data ?? []) as SpendLimit[];
  const rules = ((recurringRes.data ?? []) as BillRule[]).map((r) => ({
    amount: Number(r.amount),
    category_id: r.category_id,
  }));
  const rows = ((changesRes.data ?? []) as SpendHistoryRow[]).map((r) => ({
    ...r,
    amount: Number(r.amount),
  }));
  const categoryNameById = new Map<string, string>(
    ((categoriesRes.data ?? []) as { id: string; name: string }[]).map((c) => [
      c.id,
      c.name,
    ]),
  );

  const statuses = computeLimitStatuses({ limits, rows, rules, today });
  return statuses.map((s) => ({
    ...s,
    label:
      s.scope === "overall"
        ? "overall"
        : (s.categoryId ? categoryNameById.get(s.categoryId) : null) ??
          "category",
  }));
}

export async function getSpendLimitStatus(userId: string): Promise<SpendLimitStatusRead[]> {
  const { supabase, ownerId } = scoped(userId);
  return buildSpendLimitStatus(supabase, ownerId);
}

export async function getInventorySnapshot(userId: string): Promise<InventoryVitals> {
  const { supabase, ownerId } = scoped(userId);

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
    today: await todayKey(supabase, ownerId),
  });
}

// ---------- list reads (also give Claude valid ids for the write tools) ----------

export async function listTasks(userId: string, filter: {
  groupId?: string | null;
  status?: "todo" | "doing" | "done" | "missed";
}): Promise<TaskWithGroup[]> {
  const { supabase, ownerId } = scoped(userId);

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

// Overnight-agent feed (docs/overnight-agent-plan.md): open tasks in the
// user's "mindboard" group — app-improvement ideas the nightly orchestrator
// plans and, once approved, builds. Optional aiState narrows the lifecycle
// stage ("none" = not yet touched by the agent).
export async function listCodeTasks(userId: string, filter?: {
  aiState?: "none" | "planned" | "approved" | "building" | "built" | "failed";
}) {
  const { supabase, ownerId } = scoped(userId);

  // ilike with no wildcards = case-insensitive exact match; if the user has
  // several case variants, the oldest wins rather than erroring out.
  const { data: groups } = await supabase
    .from("groups")
    .select("id, name")
    .eq("user_id", ownerId)
    .eq("archived", false)
    .ilike("name", "mindboard")
    .order("created_at", { ascending: true })
    .limit(1);
  const group = (groups ?? [])[0] as { id: string; name: string } | undefined;
  if (!group) {
    return { group: null, tasks: [], note: "no active group named 'mindboard'" };
  }

  let query = supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("user_id", ownerId)
    .eq("group_id", (group as { id: string }).id)
    .in("status", ["todo", "doing"]);
  if (filter?.aiState === "none") query = query.is("ai_state", null);
  else if (filter?.aiState) query = query.eq("ai_state", filter.aiState);

  const { data } = await query
    .order("created_at", { ascending: true })
    .limit(100);

  return {
    group: { id: group.id, name: group.name },
    tasks: data ?? [],
  };
}

// Repeating-task rules with a readable schedule label. The ids feed
// archive_recurring_task; occurrences themselves are virtual.
export async function listRecurringTasks(userId: string, filter?: { includeArchived?: boolean }) {
  const { supabase, ownerId } = scoped(userId);

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
export async function listInventory(userId: string, filter?: { includeArchived?: boolean }) {
  const { supabase, ownerId } = scoped(userId);

  let itemQuery = supabase
    .from("inventory_items")
    .select(
      "id, name, quantity, unit, reorder_threshold, priority, archived, archived_at, inventory_group_id, shopping_pinned, buy_amount, est_price, price_source, created_at",
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
    shopping_pinned: boolean;
    buy_amount: number | null;
    est_price: number | null;
    price_source: "ai" | "manual" | null;
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
      shoppingPinned: row.shopping_pinned,
      buyAmount: row.buy_amount === null ? null : Number(row.buy_amount),
      estPrice: row.est_price === null ? null : Number(row.est_price),
      priceSource: row.price_source,
      group: row.inventory_group_id
        ? (groupNames.get(row.inventory_group_id) ?? null)
        : null,
    })),
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
  };
}

// The derived shopping list: out / low / running-out-soon items plus manual
// pins, with estimated prices and the projected total. Manage pins and prices
// via update_stock (pin_shopping / unpin_shopping / set_price).
export async function getShoppingList(userId: string) {
  const { supabase, ownerId } = scoped(userId);
  const today = await todayKey(supabase, ownerId);

  const [itemsRes, usagesRes, settingsRes] = await Promise.all([
    supabase
      .from("inventory_items")
      .select(
        "id, name, quantity, unit, reorder_threshold, archived, shopping_pinned, buy_amount, est_price, price_source",
      )
      .eq("user_id", ownerId)
      .eq("archived", false),
    supabase
      .from("inventory_usages")
      .select("inventory_item_id, amount, period, interval_days")
      .eq("user_id", ownerId),
    supabase
      .from("user_settings")
      .select("shopping_store, shopping_day")
      .eq("user_id", ownerId)
      .maybeSingle(),
  ]);

  const rulesByItem = new Map<string, UsageRule[]>();
  for (const row of (usagesRes.data ?? []) as {
    inventory_item_id: string;
    amount: number;
    period: "day" | "week" | "custom";
    interval_days: number | null;
  }[]) {
    const rules = rulesByItem.get(row.inventory_item_id) ?? [];
    rules.push({
      amount: Number(row.amount),
      period: row.period,
      interval_days: row.interval_days,
    });
    rulesByItem.set(row.inventory_item_id, rules);
  }

  const entries = buildShoppingList({
    items: (itemsRes.data ?? []) as ShoppingListItem[],
    rulesByItem,
    today,
  });

  return {
    today,
    store: (settingsRes.data?.shopping_store as string | null) ?? null,
    shoppingDay:
      typeof settingsRes.data?.shopping_day === "number"
        ? settingsRes.data.shopping_day
        : null,
    ...shoppingTotal(entries),
    entries,
  };
}

export async function listGroups(userId: string) {
  const { supabase, ownerId } = scoped(userId);
  const { data } = await supabase
    .from("groups")
    .select("id, name, type, color, archived, created_at")
    .eq("user_id", ownerId)
    .eq("archived", false)
    .order("created_at", { ascending: true });
  return data ?? [];
}

export async function listAccounts(userId: string) {
  const { supabase, ownerId } = scoped(userId);
  const { data } = await supabase
    .from("accounts")
    .select("id, name, type, balance, currency, archived")
    .eq("user_id", ownerId)
    .eq("archived", false)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return data ?? [];
}

export async function listCategories(userId: string) {
  const { supabase, ownerId } = scoped(userId);
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
export async function listRecurringExpenses(userId: string) {
  const { supabase, ownerId } = scoped(userId);
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

export async function listRecentLedger(
  userId: string,
  limit = 20,
  filter?: {
    accountId?: string;
    categoryId?: string;
    direction?: "in" | "out";
    from?: string;
    to?: string;
  },
) {
  const { supabase, ownerId } = scoped(userId);
  const capped = Math.min(Math.max(1, limit), 100);
  let query = supabase
    .from("balance_changes")
    .select(
      `id, direction, amount, note, occurred_at, is_transfer,
       accounts(name, currency), spending_categories(name)`,
    )
    .eq("user_id", ownerId);
  if (filter?.accountId) query = query.eq("account_id", filter.accountId);
  if (filter?.categoryId) query = query.eq("category_id", filter.categoryId);
  if (filter?.direction) query = query.eq("direction", filter.direction);
  if (filter?.from) query = query.gte("occurred_at", filter.from);
  if (filter?.to) query = query.lte("occurred_at", filter.to);
  const { data } = await query
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

// ---------- schedule + calendar reads ----------

async function readPreferencesRow(userId: string) {
  const { supabase, ownerId } = scoped(userId);
  const { data } = await supabase
    .from("user_settings")
    .select(
      "timezone, wake_start_hour, wake_end_hour, daily_spend_estimate, shopping_store, shopping_day, stream_max_tasks, agent_plan_model, agent_build_model",
    )
    .eq("user_id", ownerId)
    .maybeSingle();
  return {
    timezone: (data?.timezone as string | null) ?? null,
    wakeStartHour: typeof data?.wake_start_hour === "number" ? data.wake_start_hour : 8,
    wakeEndHour: typeof data?.wake_end_hour === "number" ? data.wake_end_hour : 22,
    dailySpendEstimate:
      data?.daily_spend_estimate === null || data?.daily_spend_estimate === undefined
        ? null
        : Number(data.daily_spend_estimate),
    shoppingStore: (data?.shopping_store as string | null) ?? null,
    shoppingDay: typeof data?.shopping_day === "number" ? data.shopping_day : null,
    streamMaxTasks: typeof data?.stream_max_tasks === "number" ? data.stream_max_tasks : 5,
    // Overnight-agent model choices (null = orchestrator defaults).
    agentPlanModel: (data?.agent_plan_model as string | null) ?? null,
    agentBuildModel: (data?.agent_build_model as string | null) ?? null,
  };
}

export async function getPreferences(userId: string) {
  return readPreferencesRow(userId);
}

export async function getScheduleSnapshot(userId: string) {
  const ownerId = userId;
  const prefs = await readPreferencesRow(userId);
  const timeZone = safeTimeZone(prefs.timezone);
  const now = new Date();
  // The fetch window and the wake window both have to be the USER'S day: the
  // process clock is UTC on Vercel, so setHours(0,0,0,0) built a Vancouver
  // "today" that started at 17:00 the previous local afternoon.
  const todayIso = todayISO(timeZone);
  const dayStartMs = zonedWallTimeToUtcMs(todayIso, 0, 0, timeZone);
  const horizonMs = zonedWallTimeToUtcMs(addDaysKey(todayIso, 3), 0, 0, timeZone);

  const events = await listEvents(ownerId, {
    timeMin: new Date(dayStartMs).toISOString(),
    timeMax: new Date(horizonMs).toISOString(),
  });

  return {
    ...scheduleSnapshot({
      events,
      now,
      wakeStartHour: prefs.wakeStartHour,
      wakeEndHour: prefs.wakeEndHour,
      timeZone,
    }),
    freeGaps: freeGaps({
      events,
      now,
      wakeStartHour: prefs.wakeStartHour,
      wakeEndHour: prefs.wakeEndHour,
      days: 3,
      limit: 6,
      timeZone,
    }),
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EVENT_RANGE_DAYS = 62;

export async function listCalendarEvents(userId: string, filter?: { from?: string; to?: string }) {
  const { supabase, ownerId } = scoped(userId);
  const today = await todayKey(supabase, ownerId);
  const from = filter?.from && ISO_DATE_RE.test(filter.from) ? filter.from : today;
  const defaultTo = addDaysKey(from, 7);
  let to = filter?.to && ISO_DATE_RE.test(filter.to) ? filter.to : defaultTo;
  if (to < from) to = from;

  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  end.setDate(end.getDate() + 1); // inclusive `to`
  const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
  if (spanDays > MAX_EVENT_RANGE_DAYS) {
    throw new Error(`date range too large (max ${MAX_EVENT_RANGE_DAYS} days)`);
  }

  const [events, groupsRes] = await Promise.all([
    listEvents(ownerId, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
    }),
    supabase
      .from("groups")
      .select("name, google_calendar_id")
      .eq("user_id", ownerId)
      .eq("archived", false)
      .not("google_calendar_id", "is", null),
  ]);

  const linkedGroups = new Map(
    ((groupsRes.data ?? []) as { name: string; google_calendar_id: string }[]).map(
      (g) => [g.google_calendar_id, g.name],
    ),
  );

  return events.map((event: CalendarEvent) => ({
    eventId: event.eventId,
    calendarId: event.calendarId,
    calendar: event.calendarSummary,
    linkedGroup: linkedGroups.get(event.calendarId) ?? null,
    summary: event.summary,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    timeZone: event.startTimeZone,
    writable: event.writable,
  }));
}

// ---------- goals / income / logs / audit ----------

export async function listGoals(userId: string, filter?: { includeClosed?: boolean }) {
  const { supabase, ownerId } = scoped(userId);
  let query = supabase
    .from("goals")
    .select("id, title, why, horizon, status, target_date, created_at, completed_at")
    .eq("user_id", ownerId)
    .order("created_at", { ascending: false });
  if (!filter?.includeClosed) query = query.in("status", ["active", "paused"]);
  const { data } = await query;
  return data ?? [];
}

export async function listIncomeSources(userId: string) {
  const { supabase, ownerId } = scoped(userId);
  const { data } = await supabase
    .from("income_sources")
    .select(
      "id, name, hourly_wage, tax_rate, calendar_id, color, pay_frequency, anchor_payday, period_start, period_end, fixed_amount, fixed_day, archived, created_at",
    )
    .eq("user_id", ownerId)
    .eq("archived", false)
    .order("created_at", { ascending: true });

  type Row = {
    id: string;
    name: string;
    hourly_wage: number;
    tax_rate: number;
    calendar_id: string | null;
    pay_frequency: "weekly" | "biweekly" | "monthly" | null;
    anchor_payday: string | null;
    period_start: string | null;
    period_end: string | null;
    fixed_amount: number | null;
    fixed_day: number | null;
  };

  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    name: row.name,
    hourlyWage: Number(row.hourly_wage),
    taxRatePct: Number(row.tax_rate),
    calendarLinked: row.calendar_id !== null,
    calendarId: row.calendar_id,
    paySchedule: row.pay_frequency
      ? {
          frequency: row.pay_frequency,
          anchorPayday: row.anchor_payday,
          periodStart: row.period_start,
          periodEnd: row.period_end,
        }
      : null,
    // Set = a fixed amount lands on that day each month; the hourly fields
    // above are dormant while this is set.
    fixedMonthly:
      row.fixed_amount !== null && row.fixed_day !== null
        ? { amount: Number(row.fixed_amount), dayOfMonth: row.fixed_day }
        : null,
  }));
}

export async function listDailyLogs(userId: string, limit = 14) {
  const { supabase, ownerId } = scoped(userId);
  const capped = Math.min(Math.max(1, limit), 60);
  const { data } = await supabase
    .from("daily_logs")
    .select("log_date, mood, energy, sleep_hours")
    .eq("user_id", ownerId)
    .order("log_date", { ascending: false })
    .limit(capped);
  return (data ?? []).map((row) => ({
    date: row.log_date as string,
    mood: row.mood as number | null,
    energy: row.energy as number | null,
    sleepHours: row.sleep_hours === null ? null : Number(row.sleep_hours),
  }));
}

export async function listProposals(userId: string, filter?: {
  status?: "proposed" | "executed" | "rejected" | "error";
  limit?: number;
}) {
  const { supabase, ownerId } = scoped(userId);
  const capped = Math.min(Math.max(1, filter?.limit ?? 20), 100);
  let query = supabase
    .from("ai_audit_log")
    .select("id, tool_name, summary, status, source, created_at, resolved_at")
    .eq("user_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(capped);
  if (filter?.status) query = query.eq("status", filter.status);
  const { data } = await query;
  return data ?? [];
}

// ---------- planning snapshot (horizon-aware, cross-domain) ----------

// One-call planning read over today…+horizonDays: schedule (per-day timed items,
// free gaps, committed load), tasks, finance (bills + projected net worth),
// inventory run-out, and check-in/goal signals. The lean single-domain snapshots
// above stay separate; this is the wide planning surface. Delegates to the shared
// assembler with the service client.
export async function getPlanningSnapshot(userId: string, opts?: { horizonDays?: number }) {
  const { supabase, ownerId } = scoped(userId);
  return buildPlanningSnapshot({
    supabase,
    userId: ownerId,
    horizonDays: opts?.horizonDays ?? 7,
  });
}

// ---------- forecasts ----------

// Projected end-of-day net worth for the next N days: delegates to the shared
// cashflow core (app/lib/finance/forecast.ts). `today` and shift-hour bucketing
// resolve in the caller's zone (user_settings.timezone), which also carries the
// manual everyday-spend fallback.
export async function getFinanceForecast(userId: string, days = 30) {
  const { supabase, ownerId } = scoped(userId);
  const prefs = await readPreferencesRow(userId);
  return buildFinanceForecast({
    supabase,
    userId: ownerId,
    today: await todayKey(supabase, ownerId),
    days,
    dailySpendEstimate: prefs.dailySpendEstimate,
    timeZone: safeTimeZone(prefs.timezone),
  });
}

// Per-item depletion forecast: effective daily rate from the usage rules, the
// projected run-out day, and the reorder-by day when a threshold is set.
export async function getInventoryForecast(userId: string) {
  const { supabase, ownerId } = scoped(userId);
  const today = await todayKey(supabase, ownerId);

  const [itemsRes, usagesRes] = await Promise.all([
    supabase
      .from("inventory_items")
      .select("id, name, quantity, unit, reorder_threshold, inventory_group_id")
      .eq("user_id", ownerId)
      .eq("archived", false)
      .order("name", { ascending: true }),
    supabase
      .from("inventory_usages")
      .select("inventory_item_id, amount, period, interval_days")
      .eq("user_id", ownerId),
  ]);

  const usagesByItem = new Map<string, UsageRule[]>();
  for (const row of (usagesRes.data ?? []) as {
    inventory_item_id: string;
    amount: number;
    period: "day" | "week" | "custom";
    interval_days: number | null;
  }[]) {
    const rules = usagesByItem.get(row.inventory_item_id) ?? [];
    rules.push({
      amount: Number(row.amount),
      period: row.period,
      interval_days: row.interval_days,
    });
    usagesByItem.set(row.inventory_item_id, rules);
  }

  type ItemRow = {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    reorder_threshold: number | null;
  };

  const items = ((itemsRes.data ?? []) as ItemRow[]).map((row) => {
    const quantity = Number(row.quantity);
    const threshold =
      row.reorder_threshold === null ? null : Number(row.reorder_threshold);
    const rate = effectiveDailyRate(usagesByItem.get(row.id) ?? []);
    return {
      id: row.id,
      name: row.name,
      quantity,
      unit: row.unit,
      status: stockStatus(quantity, threshold),
      reorderThreshold: threshold,
      dailyRate: Math.round(rate * 1000) / 1000,
      daysLeft: daysUntilEmpty(quantity, rate),
      runOutDate: runOutDateKey(today, quantity, rate),
      reorderBy: reorderDateKey(today, quantity, rate, threshold),
    };
  });

  items.sort((a, b) => {
    if (a.runOutDate === null && b.runOutDate === null) {
      return a.name.localeCompare(b.name);
    }
    if (a.runOutDate === null) return 1;
    if (b.runOutDate === null) return -1;
    return a.runOutDate.localeCompare(b.runOutDate);
  });

  return { today, items };
}

// ---------- people reads ----------

// The vault section whose bullets are the per-person open loops. 17 of 20
// person notes carry one; three do not, and an absent section is normal.
const OPEN_LOOPS_HEADING = "Open questions";
// One person's log is a page, not an archive. The app's own per-person read is
// unbounded; this bound only exists so a tool payload stays a readable size.
const MAX_PERSON_INTERACTIONS = 50;
// Roster-wide interaction scan, for counts and last-talked across everyone.
const MAX_INTERACTION_SCAN = 5000;
// Raw session excerpts are the most sensitive thing this tool carries (§9), so
// only a handful travel — enough to review, never a bulk export.
const MAX_PERSON_MENTIONS = 5;

type PersonRow = {
  id: string;
  name: string;
  vault_path: string | null;
  aliases: string[] | null;
  group_id: string | null;
  checkin_days: number | null;
  attention_snoozed_until: string | null;
  archived: boolean;
  created_at: string;
};

const PERSON_COLUMNS =
  "id, name, vault_path, aliases, group_id, checkin_days, attention_snoozed_until, archived, created_at";

// METADATA ONLY, per docs/people-plan.md §9: names, cadence, recency inputs and
// counts. No note bodies, no interaction summaries, no mention snippets — those
// need an explicit get_person call, which is the privacy bound that stops a
// routine agent call from bulk-exporting a social graph with commentary.
//
// Recency is returned as INPUTS (lastTalked date + precision, daysSinceTalked,
// interactions count), not as a band: band vocabulary belongs to the M3 snapshot
// so one definition serves the UI and the assistant, rather than two drifting.
export async function listPeopleFor(
  supabase: SupabaseClient,
  userId: string,
  args?: { includeArchived?: boolean },
) {
  const includeArchived = args?.includeArchived === true;
  const today = await todayKey(supabase, userId);

  let peopleQuery = supabase
    .from("people")
    .select(PERSON_COLUMNS)
    .eq("user_id", userId)
    .order("name", { ascending: true });
  if (!includeArchived) peopleQuery = peopleQuery.eq("archived", false);

  const [peopleRes, groupsRes, interactionsRes] = await Promise.all([
    peopleQuery,
    // No colour: a group travels to an agent as identity (id + name), which is
    // all a set_group op needs. Colour is a rendering concern.
    supabase.from("people_groups").select("id, name").eq("user_id", userId),
    supabase
      .from("person_interactions")
      .select("person_id, occurred_at, occurred_precision")
      .eq("user_id", userId)
      // Descending + capped: an overflowing log costs the oldest history
      // first, so lastTalked stays correct and only very old counts can
      // undercount. The order ends in id to make the cap boundary total.
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(MAX_INTERACTION_SCAN),
  ]);

  // An agent cannot tell "you have no people" from "the query failed" if both
  // arrive as an empty array, and the second one deserves an error, not a
  // confident report that the roster is empty. guard() in the MCP route turns
  // this into a structured tool error. The interaction scan is exempt: it
  // degrades to "nothing logged", which the shape already expresses.
  if (peopleRes.error) {
    throw new Error(`could not read people: ${peopleRes.error.message}`);
  }
  if (groupsRes.error) {
    throw new Error(`could not read people groups: ${groupsRes.error.message}`);
  }

  const rows = (peopleRes.data ?? []) as PersonRow[];
  const groups = new Map<string, { id: string; name: string }>();
  for (const group of (groupsRes.data ?? []) as { id: string; name: string }[]) {
    groups.set(group.id, group);
  }
  const counts = new Map<string, number>();
  const latest = new Map<string, { date: string; precision: string }>();
  for (const row of (interactionsRes.data ?? []) as {
    person_id: string;
    occurred_at: string;
    occurred_precision: string;
  }[]) {
    counts.set(row.person_id, (counts.get(row.person_id) ?? 0) + 1);
    if (!latest.has(row.person_id)) {
      latest.set(row.person_id, {
        date: row.occurred_at,
        precision: row.occurred_precision,
      });
    }
  }

  return {
    today,
    people: rows.map((row) => {
      const last = latest.get(row.id) ?? null;
      return {
        id: row.id,
        name: row.name,
        vaultPath: row.vault_path,
        aliases: row.aliases ?? [],
        // The person's optional CONTEXT (family / ubc / work), never a
        // closeness tier. null = ungrouped, which is a normal resting state.
        group: (row.group_id && groups.get(row.group_id)) || null,
        checkinDays: row.checkin_days,
        attentionSnoozedUntil: row.attention_snoozed_until,
        archived: row.archived,
        interactions: counts.get(row.id) ?? 0,
        // 'talked' only — vault `updated` never enters this, per the doctrine
        // (§2). null means nothing has been logged, which is a real answer.
        lastTalked: last
          ? {
              date: last.date,
              // 'approx' rows must never be rendered as a firm day.
              precision: last.precision,
              daysSince: daysBetweenKeys(last.date, today),
            }
          : null,
      };
    }),
  };
}

export async function listPeople(
  userId: string,
  args?: { includeArchived?: boolean },
) {
  const { supabase, ownerId } = scoped(userId);
  return listPeopleFor(supabase, ownerId, args);
}

// The dossier for ONE person. Vault cost is bounded to a single note read (one
// tree fetch + one blob) — never getVaultCorpus, which downloads every blob in
// the vault (§7, §9).
//
// Mention candidates ARE carried here (M4) — an explicit per-person call is the
// privacy bound §9 sets for raw session excerpts, and get_snapshot still
// carries none of them. Deliberately absent: the full note body (read_brain_note
// already serves that) and `connected` (backlinks need the corpus's cross-note
// link graph, so it stays an M-later gap rather than a corpus-weight read on
// every call).
export async function getPersonFor(
  supabase: SupabaseClient,
  userId: string,
  args: { person?: unknown },
) {
  const ref = typeof args?.person === "string" ? args.person.trim() : "";
  if (!ref) throw new Error("person is required (id or name)");

  const { data: peopleData } = await supabase
    .from("people")
    .select(PERSON_COLUMNS)
    .eq("user_id", userId);
  const rows = (peopleData ?? []) as PersonRow[];

  // Same id → exact → unique substring contract as update_people's resolver,
  // across the whole roster: reading an archived person is legitimate.
  const found = resolvePersonRef(
    ref,
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      archived: row.archived,
    })) as ResolvablePerson[],
  );
  if (!found.ok) throw new Error(found.error);
  const row = rows.find((r) => r.id === found.value.id);
  if (!row) throw new Error(`no person matching "${ref}"`);

  const today = await todayKey(supabase, userId);
  const { data: interactionData } = await supabase
    .from("person_interactions")
    .select("id, summary, occurred_at, occurred_precision, source, created_at")
    .eq("user_id", userId)
    .eq("person_id", row.id)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(MAX_PERSON_INTERACTIONS);
  const interactions = (interactionData ?? []) as {
    id: string;
    summary: string | null;
    occurred_at: string;
    occurred_precision: string;
    source: string;
    created_at: string;
  }[];

  const [countRes, candidateRes] = await Promise.all([
    supabase
      .from("person_mention_candidates")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("person_id", row.id)
      .eq("status", "new"),
    supabase
      .from("person_mention_candidates")
      .select("id, occurred_at, excerpt, matched_term, source_kind")
      .eq("user_id", userId)
      .eq("person_id", row.id)
      .eq("status", "new")
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(MAX_PERSON_MENTIONS),
  ]);
  const candidateCount = countRes.count ?? 0;
  const candidates = (candidateRes.data ?? []) as {
    id: string;
    occurred_at: string;
    excerpt: string | null;
    matched_term: string | null;
    source_kind: string;
  }[];

  // Best-effort, always: a missing vault, revoked token, renamed-away note or
  // GitHub outage yields no loops and nothing more. An optional context
  // enhancement must never fail the tool (§7).
  let intro: string | null = null;
  let openLoops: string[] = [];
  let noteUpdated: string | null = null;
  let noteMissing = false;
  if (row.vault_path) {
    try {
      const credentials = await readVaultCredentials(supabase, userId);
      const note = credentials
        ? await readVaultNoteRaw(credentials, vaultTag(userId), row.vault_path)
        : null;
      if (note) {
        intro = extractIntro(note.markdown);
        openLoops = extractSectionBullets(note.markdown, OPEN_LOOPS_HEADING);
        noteUpdated = parseFrontmatter(note.markdown).frontmatter.updated ?? null;
      } else {
        noteMissing = true;
      }
    } catch (error) {
      console.warn("person note read failed", error);
    }
  }

  return {
    today,
    person: {
      id: row.id,
      name: row.name,
      vaultPath: row.vault_path,
      aliases: row.aliases ?? [],
      checkinDays: row.checkin_days,
      attentionSnoozedUntil: row.attention_snoozed_until,
      archived: row.archived,
      createdAt: row.created_at,
    },
    intro,
    openLoops,
    // The 'noted' signal: when the note was last revised. NOT contact, and it
    // never advances lastTalked (§2).
    noteUpdated,
    noteMissing,
    lastTalked: interactions[0]
      ? {
          date: interactions[0].occurred_at,
          precision: interactions[0].occurred_precision,
          daysSince: daysBetweenKeys(interactions[0].occurred_at, today),
        }
      : null,
    interactions: interactions.map((row_) => ({
      id: row_.id,
      summary: row_.summary,
      occurredAt: row_.occurred_at,
      precision: row_.occurred_precision,
      source: row_.source,
    })),
    interactionsTruncated: interactions.length === MAX_PERSON_INTERACTIONS,
    // Unreviewed evidence that this person was ON YOUR MIND — never contact.
    // Only the user's explicit confirm turns one into an interaction, so these
    // are strictly reviewable material, not a recency signal.
    mentions: {
      unreviewed: candidateCount,
      recent: candidates.map((c) => ({
        id: c.id,
        occurredAt: c.occurred_at,
        excerpt: c.excerpt,
        matchedTerm: c.matched_term,
        sourceKind: c.source_kind,
      })),
    },
  };
}

export async function getPerson(userId: string, args: { person?: unknown }) {
  const { supabase, ownerId } = scoped(userId);
  return getPersonFor(supabase, ownerId, args);
}

// ---------- second-brain reads ----------

export async function listBrainNotes(userId: string) {
  const { supabase, ownerId } = scoped(userId);
  const credentials = await readVaultCredentials(supabase, ownerId);
  if (!credentials) {
    throw new Error("vault not connected — set it up on /brain first");
  }
  const notes = await listVaultNotePaths(credentials, vaultTag(ownerId));
  return { count: notes.length, notes };
}

export async function readBrainNote(userId: string, path: string) {
  if (typeof path !== "string" || !path.trim()) throw new Error("path is required");
  const { supabase, ownerId } = scoped(userId);
  const credentials = await readVaultCredentials(supabase, ownerId);
  if (!credentials) {
    throw new Error("vault not connected — set it up on /brain first");
  }
  const note = await readVaultNoteRaw(credentials, vaultTag(ownerId), path.trim());
  if (!note) {
    throw new Error(`no note at "${path}" — check list_brain_notes for paths`);
  }
  return note;
}
