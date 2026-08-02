// Seeds one throwaway tenant with identifiable data in every domain the MCP
// surface can reach, and snapshots those rows so the probe can prove the other
// tenant's sweep changed nothing.
//
// Rows go in through the tenant's OWN anon-key session client wherever
// possible, so a seed failure is itself an RLS finding. user_settings is the
// exception: the MCP token hash is provisioned server-side in production, so
// the probe writes it with the admin client the same way /settings does.

import { todayKey } from "./harness.mjs";

// Every user-scoped table, snapshotted before and after the other tenant's
// attack sweep. This list is hand-maintained and is the snapshot's weak point:
// a table missing here is a table the "nothing of B's changed" check cannot
// see. Add one whenever a migration creates a user_id-scoped table — especially
// if any MCP tool can reach it (course_source_parts and
// recurring_task_completions are both written by tools the attack table calls).
export const OWNED_TABLES = [
  "groups",
  "tasks",
  "recurring_tasks",
  "recurring_task_completions",
  "recurring_task_slots",
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
  "course_source_parts",
  "course_cards",
  "audio_episodes",
  "mindspace_topics",
  "mindspace_items",
  "mindspace_labels",
  "mindspace_observations",
  "mindspace_sessions",
  "vault_settings",
  "google_tokens",
  "worker_status",
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
  wakeStartHour,
  wakeEndHour,
  currency,
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
  ids.taskNotes = `${marker}-task-notes`;
  ids.taskId = await insert(client, "tasks", {
    user_id: userId,
    group_id: ids.groupId,
    title: ids.taskTitle,
    due_date: todayKey(),
    status: "todo",
    priority: "high",
    notes: ids.taskNotes,
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
  ids.goalWhy = `${marker}-goal-why`;
  ids.goalId = await insert(client, "goals", {
    user_id: userId,
    title: ids.goalTitle,
    why: ids.goalWhy,
    horizon: "month",
    status: "active",
  });

  ids.dailyNote = `${marker}-daily-note`;
  ids.dailyLogId = await insert(client, "daily_logs", {
    user_id: userId,
    log_date: todayKey(),
    mood: 4,
    energy: 3,
    sleep_hours: 7,
    note: ids.dailyNote,
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

  // Both tenants hold the same balance on purpose: a dropped user_id filter in
  // the forecast's account query produces exactly 2× this number, which is the
  // signature finance_forecast's value assertion looks for. The currency
  // differs so a leaked account row is visible in a field that survives into
  // the otherwise number-only forecast output.
  ids.accountBalance = 4321;
  ids.currency = currency;
  ids.accountName = `${marker}-account`;
  ids.accountId = await insert(client, "accounts", {
    user_id: userId,
    name: ids.accountName,
    type: "checking",
    balance: ids.accountBalance,
    currency: ids.currency,
  });

  ids.categoryName = `${marker}-category`;
  ids.categoryId = await insert(client, "spending_categories", {
    user_id: userId,
    name: ids.categoryName,
    color: "#abcdef",
  });

  ids.ledgerNote = `${marker}-ledger-note`;
  ids.changeId = await insert(client, "balance_changes", {
    user_id: userId,
    account_id: ids.accountId,
    category_id: ids.categoryId,
    direction: "out",
    amount: 17.25,
    occurred_at: todayKey(-2),
    note: ids.ledgerNote,
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
  ids.courseCode = `${marker}-code`;
  ids.courseId = await insert(client, "courses", {
    user_id: userId,
    name: ids.courseName,
    code: ids.courseCode,
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
  ids.sessionTitle = `${marker}-session-title`;
  ids.sessionText = `${marker}-session-text`;
  ids.sessionId = await insert(client, "mindspace_sessions", {
    user_id: userId,
    provider: "claude_code",
    session_ref: ids.sessionRef,
    title: ids.sessionTitle,
    started_at: new Date(Date.now() - 3600_000).toISOString(),
    ended_at: new Date().toISOString(),
    duration_min: 60,
    user_text: ids.sessionText,
  });

  // Settings carry the MCP token hash (provisioned server-side in production),
  // a timezone distinct from the other tenant's so a leaked preference row (or
  // a "today" computed in the wrong tenant's zone) is visible, and a pending
  // agent-run request so claim_agent_run has something to steal.
  //
  // The wake window must differ between tenants: it is the only preference
  // that survives into a tool's output as data (get_snapshot's per-day free
  // gaps span it verbatim when no events exist), so identical windows would
  // make a real preferences-scoping breach produce byte-identical output that
  // nothing could assert on. Do not "tidy" these to match.
  ids.timezone = timezone;
  ids.wakeStartHour = wakeStartHour;
  ids.wakeEndHour = wakeEndHour;
  ids.shoppingStore = `${marker}-store`;
  const { error: settingsError } = await admin.from("user_settings").upsert(
    {
      user_id: userId,
      timezone: ids.timezone,
      wake_start_hour: wakeStartHour,
      wake_end_hour: wakeEndHour,
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

// A stable, order-independent fingerprint of everything a tenant owns. A table
// that cannot be read records the error instead of throwing, so a stale entry
// in OWNED_TABLES surfaces as a visible failure rather than aborting the run
// (or, worse, silently narrowing what the diff can see).
export async function snapshotTenant(admin, userId) {
  const out = {};
  const unreadable = [];
  for (const table of OWNED_TABLES) {
    const { data, error } = await admin.from(table).select("*").eq("user_id", userId);
    if (error) {
      unreadable.push(`${table}: ${error.message}`);
      out[table] = [`UNREADABLE: ${error.message}`];
      continue;
    }
    out[table] = (data ?? [])
      .map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort())))
      .sort();
  }
  Object.defineProperty(out, "__unreadable", { value: unreadable, enumerable: false });
  return out;
}

export function unreadableTables(snapshot) {
  return snapshot.__unreadable ?? [];
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
