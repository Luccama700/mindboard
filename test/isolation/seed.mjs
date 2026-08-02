// Seeds one throwaway tenant with identifiable data in every domain the MCP
// surface can reach, and snapshots those rows so the probe can prove the other
// tenant's sweep changed nothing.
//
// Rows go in through the tenant's OWN anon-key session client wherever
// possible, so a seed failure is itself an RLS finding. user_settings is the
// exception: the MCP token hash is provisioned server-side in production, so
// the probe writes it with the admin client the same way /settings does.

import { todayKey } from "./harness.mjs";

// Every table a tenant owns rows in, snapshotted before and after the other
// tenant's attack sweep. Add a table here whenever the MCP surface grows one.
export const OWNED_TABLES = [
  "groups",
  "tasks",
  "recurring_tasks",
  "goals",
  "daily_logs",
  "inventory_groups",
  "inventory_items",
  "inventory_usages",
  "accounts",
  "spending_categories",
  "balance_changes",
  "account_reconciliations",
  "recurring_expenses",
  "income_sources",
  "spend_limits",
  "spend_overrides",
  "courses",
  "course_sources",
  "mindspace_sessions",
  "jobs",
  "ai_audit_log",
  "user_settings",
];

async function insert(client, table, row) {
  const { data, error } = await client.from(table).insert(row).select("id").single();
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return data.id;
}

// `marker` is a per-run, per-tenant literal embedded in every name the probe
// writes. Nothing else in the database can contain it, so finding it in a
// response is unambiguous proof of a cross-tenant read.
export async function seedTenant({
  client,
  admin,
  userId,
  marker,
  timezone,
  patHash,
  patHint,
}) {
  const ids = { marker };

  ids.groupName = `${marker}-group`;
  ids.groupId = await insert(client, "groups", {
    user_id: userId,
    name: ids.groupName,
    type: "project",
    color: "#123456",
  });

  ids.taskTitle = `${marker}-task`;
  ids.taskId = await insert(client, "tasks", {
    user_id: userId,
    group_id: ids.groupId,
    title: ids.taskTitle,
    due_date: todayKey(),
    status: "todo",
    priority: "high",
    notes: `${marker}-task-notes`,
    estimated_minutes: 30,
  });

  ids.secondTaskTitle = `${marker}-task-two`;
  ids.secondTaskId = await insert(client, "tasks", {
    user_id: userId,
    title: ids.secondTaskTitle,
    due_date: todayKey(1),
    status: "todo",
  });

  ids.recurringTaskTitle = `${marker}-habit`;
  ids.recurringTaskId = await insert(client, "recurring_tasks", {
    user_id: userId,
    title: ids.recurringTaskTitle,
    frequency: "daily",
    due_time: "09:00",
    duration_min: 30,
  });

  ids.goalTitle = `${marker}-goal`;
  ids.goalId = await insert(client, "goals", {
    user_id: userId,
    title: ids.goalTitle,
    why: `${marker}-goal-why`,
    horizon: "month",
    status: "active",
  });

  ids.dailyLogId = await insert(client, "daily_logs", {
    user_id: userId,
    log_date: todayKey(),
    mood: 4,
    energy: 3,
    sleep_hours: 7,
    note: `${marker}-daily-note`,
  });

  ids.inventoryGroupName = `${marker}-shelf`;
  ids.inventoryGroupId = await insert(client, "inventory_groups", {
    user_id: userId,
    name: ids.inventoryGroupName,
    color: "#654321",
  });

  // The fuzzy-name surface: update_stock resolves an item by exact name, then
  // by unique substring. The two tenants' item names share no substring, so a
  // cross-tenant name must resolve to nothing at all.
  ids.itemName = `${marker}-widget`;
  ids.itemId = await insert(client, "inventory_items", {
    user_id: userId,
    inventory_group_id: ids.inventoryGroupId,
    name: ids.itemName,
    quantity: 12,
    unit: "packs",
    reorder_threshold: 3,
    shopping_pinned: true,
    est_price: 9.5,
    price_source: "manual",
  });

  ids.usageId = await insert(client, "inventory_usages", {
    user_id: userId,
    inventory_item_id: ids.itemId,
    amount: 1,
    period: "day",
  });

  ids.accountName = `${marker}-account`;
  ids.accountId = await insert(client, "accounts", {
    user_id: userId,
    name: ids.accountName,
    type: "checking",
    balance: 4321,
    currency: "CAD",
  });

  ids.categoryName = `${marker}-category`;
  ids.categoryId = await insert(client, "spending_categories", {
    user_id: userId,
    name: ids.categoryName,
    color: "#abcdef",
  });

  ids.changeId = await insert(client, "balance_changes", {
    user_id: userId,
    account_id: ids.accountId,
    category_id: ids.categoryId,
    direction: "out",
    amount: 17.25,
    occurred_at: todayKey(-2),
    note: `${marker}-ledger-note`,
    source: "manual",
  });

  ids.reconciliationId = await insert(client, "account_reconciliations", {
    user_id: userId,
    account_id: ids.accountId,
    balance: 4321,
    as_of: todayKey(-1),
    source: "manual",
  });

  ids.recurringExpenseName = `${marker}-bill`;
  ids.recurringExpenseId = await insert(client, "recurring_expenses", {
    user_id: userId,
    name: ids.recurringExpenseName,
    amount: 55,
    category_id: ids.categoryId,
    frequency: "monthly",
    day_of_month: 15,
  });

  ids.incomeSourceName = `${marker}-job`;
  ids.incomeSourceId = await insert(client, "income_sources", {
    user_id: userId,
    name: ids.incomeSourceName,
    hourly_wage: 25,
    tax_rate: 20,
  });

  ids.spendLimitId = await insert(client, "spend_limits", {
    user_id: userId,
    scope: "category",
    category_id: ids.categoryId,
    period: "monthly",
    amount: 300,
  });

  ids.spendOverrideId = await insert(client, "spend_overrides", {
    user_id: userId,
    date: todayKey(3),
    amount: 42,
  });

  ids.courseName = `${marker}-course`;
  ids.courseId = await insert(client, "courses", {
    user_id: userId,
    name: ids.courseName,
    code: `${marker}-code`,
    color: "#0f0f0f",
  });

  ids.courseSourceTitle = `${marker}-source`;
  ids.courseSourceId = await insert(client, "course_sources", {
    user_id: userId,
    course_id: ids.courseId,
    title: ids.courseSourceTitle,
    kind: "pdf",
    status: "registered",
  });

  ids.sessionRef = `${marker}-session`;
  ids.sessionId = await insert(client, "mindspace_sessions", {
    user_id: userId,
    provider: "claude_code",
    session_ref: ids.sessionRef,
    title: `${marker}-session-title`,
    started_at: new Date(Date.now() - 3600_000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_min: 60,
    user_text: `${marker}-session-text`,
  });

  // Settings carry the MCP token hash (provisioned server-side in production),
  // a timezone distinct from the other tenant's so a leaked preference row (or
  // a "today" computed in the wrong tenant's zone) is visible, and a pending
  // agent-run request so claim_agent_run has something to steal.
  ids.timezone = timezone;
  ids.shoppingStore = `${marker}-store`;
  const { error: settingsError } = await admin.from("user_settings").upsert(
    {
      user_id: userId,
      timezone: ids.timezone,
      wake_start_hour: 5,
      wake_end_hour: 23,
      daily_spend_estimate: 11,
      shopping_store: ids.shoppingStore,
      shopping_day: 2,
      agent_run_requested_at: new Date().toISOString(),
      mcp_token_hash: patHash,
      mcp_token_hint: patHint,
    },
    { onConflict: "user_id" },
  );
  if (settingsError) throw new Error(`seed user_settings: ${settingsError.message}`);

  return ids;
}

// A stable, order-independent fingerprint of everything a tenant owns.
export async function snapshotTenant(admin, userId) {
  const out = {};
  for (const table of OWNED_TABLES) {
    const { data, error } = await admin.from(table).select("*").eq("user_id", userId);
    if (error) throw new Error(`snapshot ${table}: ${error.message}`);
    const rows = (data ?? [])
      .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort())))
      .sort();
    out[table] = rows;
  }
  return out;
}

export function diffSnapshots(before, after) {
  const changed = [];
  for (const table of OWNED_TABLES) {
    const a = (before[table] ?? []).join("\n");
    const b = (after[table] ?? []).join("\n");
    if (a !== b) {
      changed.push(
        `${table} (${(before[table] ?? []).length} rows → ${(after[table] ?? []).length} rows)`,
      );
    }
  }
  return changed;
}
