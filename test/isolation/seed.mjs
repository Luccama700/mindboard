// Seeds one throwaway tenant with identifiable data in every domain the MCP
// surface can reach, and snapshots those rows so the probe can prove the other
// tenant's sweep changed nothing.
//
// Rows go in through the tenant's OWN anon-key session client wherever
// possible, so a seed failure is itself an RLS finding. user_settings is the
// exception: the MCP token hash is provisioned server-side in production, so
// the probe writes it with the admin client the same way /settings does.

import { createHash } from "node:crypto";

import { todayKey } from "./harness.mjs";

// urc_devices.token_hash is SHA-256 hex of the device token. The probe never
// presents the token anywhere — the row exists so the URC tools have a real
// device and a real session link to refuse the other tenant.
const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");

// Every user-scoped table, snapshotted before and after the other tenant's
// attack sweep. This list is hand-maintained and is the snapshot's weak point:
// a table missing here is a table the "nothing of B's changed" check cannot
// see. Add one whenever a migration creates a user_id-scoped table — especially
// if any MCP tool can reach it (course_source_parts and
// recurring_task_completions are both written by tools the attack table calls).
export const OWNED_TABLES = [
  "groups",
  "tasks",
  "task_dispatches",
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
  "people",
  "people_groups",
  "person_interactions",
  "person_mention_candidates",
  // urc_devices/urc_jobs have RLS on with NO policies (0054): service-role
  // only. The snapshot runs on the admin client, which bypasses RLS, so these
  // read fine here — and they MUST be in this list, because urc_jobs is where a
  // forged spawn_urc would land and session_url is the most sensitive column in
  // the schema.
  "urc_devices",
  "urc_jobs",
  "urc_log",
  "vault_settings",
  "google_tokens",
  "worker_status",
  "jobs",
  "ai_audit_log",
  "ai_conversations",
  "ai_messages",
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
  // Rows that exist on the VICTIM only. See the decoy block near the bottom of
  // this function for why the asymmetry is the whole point.
  decoys = false,
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

  // ---------------- people (0047/0048/0049) ----------------
  // The relationship layer is the newest data the MCP surface can reach, and
  // the one whose leak reads worst: names, cadences and logged conversations.
  ids.peopleGroupName = `${marker}-circle`;
  ids.peopleGroupId = await insert(client, "people_groups", {
    user_id: userId,
    name: ids.peopleGroupName,
    color: "#778899",
  });

  // The name doubles as update_people's and get_person's fuzzy-resolution
  // surface: both resolve id → exact name → unique substring, so a cross-tenant
  // name must match nothing at all.
  ids.personName = `${marker}-person`;
  ids.personId = await insert(client, "people", {
    user_id: userId,
    name: ids.personName,
    group_id: ids.peopleGroupId,
    checkin_days: 30,
  });

  ids.interactionSummary = `${marker}-talked-about`;
  ids.interactionId = await insert(client, "person_interactions", {
    user_id: userId,
    person_id: ids.personId,
    summary: ids.interactionSummary,
    occurred_at: todayKey(-5),
    occurred_precision: "exact",
    source: "logged",
  });

  // A mention candidate is unreviewed inference ABOUT the tenant's private
  // prose; docs/people-plan.md §9 keeps its excerpt off every agent surface, so
  // a needle on it catches both a tenant leak and a §9 regression.
  ids.mentionExcerpt = `${marker}-mention-excerpt`;
  ids.mentionCandidateId = await insert(client, "person_mention_candidates", {
    user_id: userId,
    person_id: ids.personId,
    source_kind: "session",
    source_ref: ids.sessionRef,
    occurred_at: todayKey(-3),
    excerpt: ids.mentionExcerpt,
    matched_term: ids.personName,
    status: "new",
  });

  // ---------------- agent hand-off (0051) ----------------
  // A pending dispatch for claim_task_dispatch to try to steal. It stays
  // 'requested' for the whole run; the attacker claiming it would move it.
  ids.dispatchNote = `${marker}-dispatch-note`;
  ids.dispatchId = await insert(client, "task_dispatches", {
    user_id: userId,
    task_id: ids.taskId,
    note: ids.dispatchNote,
    status: "requested",
  });

  // ---------------- assistant conversation (0014) ----------------
  ids.conversationTitle = `${marker}-conversation`;
  ids.conversationId = await insert(admin, "ai_conversations", {
    user_id: userId,
    title: ids.conversationTitle,
  });
  ids.messageContent = `${marker}-message-content`;
  ids.messageId = await insert(admin, "ai_messages", {
    user_id: userId,
    conversation_id: ids.conversationId,
    role: "user",
    content: ids.messageContent,
  });

  // ---------------- URC (0054/0055) ----------------
  // Admin client on purpose: urc_devices/urc_jobs have RLS enabled with NO
  // policies, so the tenant's own session client cannot write these. That is
  // the property under test, asserted from the app-path section of the runner.
  ids.urcDeviceName = `${marker}-pc`;
  ids.urcFolderKey = "probe";
  ids.urcDeviceId = await insert(admin, "urc_devices", {
    user_id: userId,
    name: ids.urcDeviceName,
    token_hash: sha256Hex(`${marker}-device-token`),
    folder_keys: [ids.urcFolderKey],
    last_seen: new Date().toISOString(),
  });
  // A session link is the single most sensitive string the schema holds (M8):
  // anyone who opens it drives a live Claude Code session on the owner's PC.
  // Giving the victim one makes "did any URC tool hand it to the other tenant"
  // an assertion rather than an assumption.
  ids.urcSessionUrl = `https://claude.ai/code/session_${marker}`;
  ids.urcJobId = await insert(admin, "urc_jobs", {
    user_id: userId,
    device_id: ids.urcDeviceId,
    folder_key: ids.urcFolderKey,
    status: "running",
    session_url: ids.urcSessionUrl,
    confirmed_auth: "pat",
    started_at: new Date().toISOString(),
    // Far enough out that sweepStaleJobs cannot expire it mid-run.
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  ids.urcLogId = await insert(admin, "urc_log", {
    user_id: userId,
    job_id: ids.urcJobId,
    event: "spawn_confirmed",
    folder_key: ids.urcFolderKey,
    confirmed_auth: "pat",
  });

  // ---------------- decoys: rows only the VICTIM has ----------------
  //
  // Ten tools used to pass this probe only because a PRECONDITION was missing
  // for BOTH tenants — no Google token, no vault row, no group named
  // "mindboard". "It failed" is not "isolation held": the code never reached
  // its own scoping check, so a dropped user_id filter inside it would not turn
  // the probe red.
  //
  // The fix is asymmetry, not symmetry. The VICTIM gets the credential; the
  // ATTACKER gets none. Correct behaviour is then a specific, local refusal
  // ("vault not connected", "google calendar connection failed"), while a
  // scoping bug finds the victim's row and fails LATER and DIFFERENTLY — at
  // GitHub, or at Google, with the victim's token in hand. The error text is
  // the tenant signal, so the matrix asserts on it; see BLIND_SPOTS.
  //
  // Both credentials are deliberately junk. If a regression does reach them,
  // the probe must fail a check, not successfully use a real account.
  if (decoys) {
    ids.vaultRepo = `${marker}-owner/${marker}-vault`;
    const { error: vaultError } = await admin.from("vault_settings").upsert(
      {
        user_id: userId,
        repo: ids.vaultRepo,
        branch: "main",
        github_token: `ghp_${marker}_not_a_real_token_000000000000`,
      },
      { onConflict: "user_id" },
    );
    if (vaultError) throw new Error(`seed vault_settings: ${vaultError.message}`);

    // expires_at far in the FUTURE on purpose: getValidAccessToken only
    // refreshes a near-expired token, and a refresh attempt throws the SAME
    // GoogleCalendarConnectionError as "no row at all" — which would erase the
    // very distinction this decoy exists to create. A future expiry means a
    // leaked token is used verbatim and fails Google-side instead.
    ids.googleAccessToken = `ya29.${marker}-not-a-real-token`;
    const { error: googleError } = await admin.from("google_tokens").upsert(
      {
        user_id: userId,
        access_token: ids.googleAccessToken,
        refresh_token: `1//${marker}-not-a-real-refresh-token`,
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString(),
        scopes: "https://www.googleapis.com/auth/calendar.events",
      },
      { onConflict: "user_id" },
    );
    if (googleError) throw new Error(`seed google_tokens: ${googleError.message}`);

    // list_code_tasks resolves a group named exactly "mindboard" (case-
    // insensitive) and returns {group: null, tasks: []} when the CALLER has
    // none. Only the victim gets one, so the attacker's correct answer is
    // `group: null` and a leak is a non-null group plus the victim's task.
    ids.codeGroupId = await insert(client, "groups", {
      user_id: userId,
      name: "mindboard",
      type: "project",
      color: "#00ff00",
    });
    ids.codeTaskTitle = `${marker}-code-task`;
    ids.codeTaskId = await insert(client, "tasks", {
      user_id: userId,
      group_id: ids.codeGroupId,
      title: ids.codeTaskTitle,
      status: "todo",
    });
  }

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
