// The attack table: for every tool the MCP server registers, one or more calls
// made with tenant A's token but tenant B's object ids and names.
//
// This is the regression net the 2026-07-28 audit asked for. The MCP layer runs
// on an RLS-BYPASSING service client, so isolation is an INVARIANT held up by
// an explicit `.eq("user_id", …)` on every query — one future miss is a full
// cross-tenant breach, and no static finder catches a class of future misses.
//
// Coverage is checked against the LIVE server's tools/list, so registering a
// tool without adding it here fails the probe instead of silently shrinking
// coverage. Entries may repeat a tool name to cover several attack shapes.
//
// Each entry:
//   tool    — the registered tool name
//   attack  — one line describing the cross-tenant shape being attempted
//   args    — (ctx) => tool arguments, referencing ctx.b (the victim)
//   assert  — (response, ctx, check) => extra assertions; the runner always
//             scans the response for B's secrets first, discounting anything
//             the request itself supplied
//   skip    — set instead of args/assert to declare a tool deliberately not
//             exercised, with the reason printed in the coverage table
//
// Response shape handed to assert: { isError, json, text }.

import { todayKey } from "./harness.mjs";

const isArray = (r) => Array.isArray(r.json);
const emptyArray = (r) => isArray(r) && r.json.length === 0;

// Propose tools return { proposalId, preview } on success. A cross-tenant
// propose must be refused outright — the resolution step is where ownership is
// checked, so a proposalId coming back means the id/name resolved against the
// victim's rows.
function refused(r) {
  return r.isError === true && !(r.json && typeof r.json.proposalId === "string");
}

// Tools whose isolation boundary is a per-user external credential
// (google_tokens, vault_settings). Probe tenants have none, so the only correct
// outcome is a hard failure to reach anything.
function blockedExternally(r) {
  return r.isError === true;
}

export const TOOL_MATRIX = [
  // ---------------- reads: no-argument cross-domain rollups ----------------
  {
    tool: "finance_snapshot",
    attack: "no-arg rollup must aggregate only A's accounts",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "finance_snapshot net worth excludes B's account",
        typeof r.json?.netWorth === "number" && r.json.netWorth !== 8642,
        `netWorth=${r.json?.netWorth}`,
      ),
  },
  {
    tool: "spend_limit_status",
    attack: "no-arg rollup must not evaluate B's limits",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "spend_limit_status returns at most A's own limits",
        isArray(r) && r.json.every((l) => l.categoryId !== ctx.b.categoryId),
      ),
  },
  {
    tool: "list_spend_limits",
    attack: "listing must not include B's limit row",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_spend_limits omits B's limit id",
        isArray(r) && !r.json.some((l) => l.id === ctx.b.spendLimitId),
      ),
  },
  {
    tool: "tasks_snapshot",
    attack: "no-arg rollup must count only A's tasks",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "tasks_snapshot counts only A's two seeded tasks",
        (r.json?.dueToday ?? 0) + (r.json?.dueThisWeek ?? 0) + (r.json?.overdue ?? 0) <= 2,
        JSON.stringify(r.json),
      ),
  },
  {
    tool: "inventory_snapshot",
    attack: "no-arg rollup must not surface B's stock",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "inventory_snapshot's soonest-out item is not B's",
        JSON.stringify(r.json ?? null).includes(ctx.b.itemName) === false,
      ),
  },

  // ---------------- reads: id/name filters pointed at B ----------------
  {
    tool: "list_tasks",
    attack: "filter by B's groupId",
    args: (ctx) => ({ groupId: ctx.b.groupId }),
    assert: (r, ctx, check) =>
      check("list_tasks filtered by B's group returns nothing", emptyArray(r)),
  },
  {
    tool: "list_code_tasks",
    attack: "overnight-agent read must resolve A's own 'mindboard' group, not B's",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_code_tasks resolves the group inside A and returns no B tasks",
        Array.isArray(r.json?.tasks) && r.json.tasks.length === 0 && r.json.group === null,
        r.text.slice(0, 160),
      ),
  },
  {
    tool: "list_groups",
    attack: "unfiltered listing must not include B's group",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_groups returns exactly A's one group",
        isArray(r) && r.json.length === 1 && r.json[0].id === ctx.a.groupId,
      ),
  },
  {
    tool: "list_accounts",
    attack: "unfiltered listing must not include B's account",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_accounts returns exactly A's one account",
        isArray(r) && r.json.length === 1 && r.json[0].id === ctx.a.accountId,
      ),
  },
  {
    tool: "list_categories",
    attack: "unfiltered listing must not include B's category",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_categories returns exactly A's one category",
        isArray(r) && r.json.length === 1 && r.json[0].id === ctx.a.categoryId,
      ),
  },
  {
    tool: "list_inventory",
    attack: "includeArchived listing must not reach B's shelf",
    args: () => ({ includeArchived: true }),
    assert: (r, ctx, check) =>
      check(
        "list_inventory returns only A's item",
        Array.isArray(r.json?.items) &&
          r.json.items.length === 1 &&
          r.json.items[0].id === ctx.a.itemId,
      ),
  },
  {
    tool: "shopping_list",
    attack: "derived list must not price B's pinned item",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "shopping_list omits B's pinned item",
        !JSON.stringify(r.json ?? null).includes(ctx.b.itemId),
      ),
  },
  {
    tool: "list_recurring_tasks",
    attack: "includeArchived listing must not reach B's rules",
    args: () => ({ includeArchived: true }),
    assert: (r, ctx, check) =>
      check(
        "list_recurring_tasks returns exactly A's one rule",
        isArray(r) && r.json.length === 1 && r.json[0].id === ctx.a.recurringTaskId,
      ),
  },
  {
    tool: "list_recent_ledger",
    attack: "filter by B's accountId + categoryId",
    args: (ctx) => ({ accountId: ctx.b.accountId, categoryId: ctx.b.categoryId, limit: 100 }),
    assert: (r, ctx, check) =>
      check("list_recent_ledger filtered by B's ids returns nothing", emptyArray(r)),
  },
  {
    tool: "list_recurring_expenses",
    attack: "unfiltered listing must not include B's bill",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_recurring_expenses returns exactly A's one rule",
        isArray(r) && r.json.length === 1 && r.json[0].id === ctx.a.recurringExpenseId,
      ),
  },
  {
    tool: "schedule_snapshot",
    // getScheduleSnapshot calls listEvents unconditionally, which THROWS for a
    // tenant with no google_tokens row — so this tool never reaches its
    // preferences-scoping code here and is listed in BLIND_SPOTS. The
    // wake-window assertion the isolation of this rollup deserves lives on
    // get_snapshot instead, which survives the missing token and exposes the
    // same wake-window-derived gaps. Seed a google_tokens row per tenant and
    // this entry can be upgraded to the same value check.
    attack: "free-time rollup is unreachable without A's own Google token",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "schedule_snapshot reaches no calendar without A's own Google token",
        blockedExternally(r),
        r.text.slice(0, 120),
      ),
  },
  {
    tool: "get_snapshot",
    attack: "the widest cross-domain read, 30-day horizon",
    args: () => ({ horizonDays: 30 }),
    assert: (r, ctx, check) => {
      const text = JSON.stringify(r.json ?? null);
      check(
        "get_snapshot's planning horizon contains no B ids",
        !text.includes(ctx.b.taskId) &&
          !text.includes(ctx.b.goalId) &&
          !text.includes(ctx.b.itemId) &&
          !text.includes(ctx.b.accountId),
      );
      check(
        "get_snapshot resolves 'today' in A's timezone, not B's",
        r.json?.timeZone === ctx.a.timezone,
        `timeZone=${r.json?.timeZone}`,
      );
      // The preferences row made observable. Free gaps are derived from
      // wake_start_hour/wake_end_hour, and with no calendar events a future
      // day's single gap spans the whole window — so these clock strings ARE
      // A's settings row. Read from the wrong tenant and they change. This is
      // the only reachable assertion on preference scoping: schedule_snapshot,
      // which exists to serve exactly this, dies at the missing Google token.
      const pad = (h) => `${String(h).padStart(2, "0")}:00`;
      const days = r.json?.schedule?.days ?? [];
      const future = days.filter((d) => d.date > todayKey()).flatMap((d) => d.freeGaps ?? []);
      check(
        "get_snapshot returns future free gaps to assert a wake window on",
        future.length > 0,
        `days=${days.length} futureGaps=${future.length}`,
      );
      // The gaps are bounded by, not equal to, the window: A's own seeded
      // recurring task blocks 09:00-09:30, so a future day reads
      // 05:00-09:00 + 09:30-23:00. Assert the envelope — that is the
      // preferences row — rather than a single unbroken gap.
      const earliest = future.map((g) => g.start).sort()[0];
      const latest = future.map((g) => g.end).sort().at(-1);
      check(
        "future free gaps are bounded by A's own wake window",
        earliest === pad(ctx.a.wakeStartHour) && latest === pad(ctx.a.wakeEndHour),
        `envelope ${earliest}-${latest}, expected ${pad(ctx.a.wakeStartHour)}-${pad(ctx.a.wakeEndHour)}`,
      );
      check(
        "no free gap boundary comes from B's wake window",
        !future.some((g) =>
          [g.start, g.end].some(
            (t) => t === pad(ctx.b.wakeStartHour) || t === pad(ctx.b.wakeEndHour),
          ),
        ),
        future
          .slice(0, 4)
          .map((g) => `${g.start}-${g.end}`)
          .join(", "),
      );
    },
  },
  {
    tool: "list_events",
    attack: "Google read with no token for A must reach nothing",
    args: () => ({ from: todayKey(), to: todayKey(7) }),
    assert: (r, ctx, check) =>
      check(
        "list_events reaches no calendar without A's own Google token",
        r.isError === true || emptyArray(r),
        r.text.slice(0, 120),
      ),
  },
  {
    tool: "finance_forecast",
    // buildFinanceForecast returns ONLY derived numbers — no account id, no
    // bill name, breach or not — so a string scan here can never fail. Six
    // queries feed it (accounts, recurring_expenses, income_sources,
    // balance_changes, spend_overrides, inventory); dropping the user_id filter
    // on any of them silently doubles A's financial position with B's. The
    // value check is the only thing that catches that.
    attack: "90-day cashflow must project only A's money (value check)",
    args: () => ({ days: 90 }),
    assert: (r, ctx, check) => {
      const soloNetWorth = ctx.a.accountBalance;
      const bothNetWorth = ctx.a.accountBalance + ctx.b.accountBalance;
      check(
        "finance_forecast anchors on A's balance alone, not A+B",
        typeof r.json?.netWorthToday === "number" &&
          r.json.netWorthToday <= soloNetWorth &&
          r.json.netWorthToday !== bothNetWorth,
        `netWorthToday=${r.json?.netWorthToday} (A alone=${soloNetWorth}, A+B=${bothNetWorth})`,
      );
      const firstDay = (r.json?.days ?? [])[0];
      check(
        "finance_forecast's projection starts from A's position alone",
        typeof firstDay?.projectedNetWorth === "number" &&
          firstDay.projectedNetWorth <= soloNetWorth,
        `day0=${firstDay?.projectedNetWorth}`,
      );
      check(
        "finance_forecast reports A's own currency",
        r.json?.currency === ctx.a.currency,
        `currency=${r.json?.currency}`,
      );
    },
  },
  {
    tool: "inventory_forecast",
    attack: "depletion forecast must cover only A's shelf",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "inventory_forecast covers exactly A's one item",
        Array.isArray(r.json?.items) &&
          r.json.items.length === 1 &&
          r.json.items[0].id === ctx.a.itemId,
        r.text.slice(0, 160),
      ),
  },
  {
    tool: "list_goals",
    attack: "includeClosed listing must not reach B's goals",
    args: () => ({ includeClosed: true }),
    assert: (r, ctx, check) =>
      check(
        "list_goals returns exactly A's one goal",
        isArray(r) && r.json.length === 1 && r.json[0].id === ctx.a.goalId,
      ),
  },
  {
    tool: "list_income_sources",
    attack: "unfiltered listing must not include B's job",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_income_sources returns exactly A's one source",
        isArray(r) && r.json.length === 1 && r.json[0].id === ctx.a.incomeSourceId,
      ),
  },
  {
    tool: "list_daily_logs",
    attack: "60-day check-in history must not include B's log",
    args: () => ({ limit: 60 }),
    assert: (r, ctx, check) =>
      check(
        "list_daily_logs returns exactly A's one check-in",
        isArray(r) && r.json.length === 1,
      ),
  },
  {
    tool: "get_preferences",
    attack: "settings read must return A's row, not B's",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "get_preferences returns A's own settings row",
        r.json?.timezone === ctx.a.timezone && r.json?.shoppingStore === ctx.a.shoppingStore,
        r.text.slice(0, 160),
      ),
  },
  {
    tool: "list_proposals",
    attack: "audit-log read must not show B's pending proposal",
    args: () => ({ limit: 100 }),
    assert: (r, ctx, check) =>
      check(
        "list_proposals never shows B's proposalId",
        isArray(r) && !r.json.some((p) => p.id === ctx.b.proposalId),
      ),
  },
  {
    tool: "list_brain_notes",
    attack: "vault listing must use A's own credentials only",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_brain_notes cannot list a vault A has not connected",
        blockedExternally(r),
        r.text.slice(0, 120),
      ),
  },
  {
    tool: "read_brain_note",
    attack: "read B's vault note path",
    args: (ctx) => ({ path: `Inbox/${ctx.b.marker}-note.md` }),
    assert: (r, ctx, check) =>
      check("read_brain_note on B's path returns nothing", blockedExternally(r), r.text.slice(0, 120)),
  },

  // ---------------- propose writes aimed at B's rows ----------------
  {
    tool: "create_task",
    attack: "create a task inside B's group",
    args: (ctx) => ({ title: "cross-tenant create", groupId: ctx.b.groupId }),
    assert: (r, ctx, check) => check("create_task into B's group is refused", refused(r)),
  },
  {
    tool: "complete_task",
    attack: "complete B's task by id",
    args: (ctx) => ({ taskId: ctx.b.taskId }),
    assert: (r, ctx, check) => check("complete_task on B's task is refused", refused(r)),
  },
  {
    tool: "miss_task",
    attack: "mark B's task missed by id",
    args: (ctx) => ({ taskId: ctx.b.taskId }),
    assert: (r, ctx, check) => check("miss_task on B's task is refused", refused(r)),
  },
  {
    tool: "update_task",
    attack: "rename and re-home B's task",
    args: (ctx) => ({ taskId: ctx.b.taskId, title: "vandalized", groupId: ctx.b.groupId }),
    assert: (r, ctx, check) => check("update_task on B's task is refused", refused(r)),
  },
  {
    tool: "update_task",
    attack: "move A's own task into B's group",
    args: (ctx) => ({ taskId: ctx.a.taskId, groupId: ctx.b.groupId }),
    assert: (r, ctx, check) => check("update_task cannot re-home A's task into B's group", refused(r)),
  },
  {
    tool: "delete_task",
    attack: "delete B's task by id",
    args: (ctx) => ({ taskId: ctx.b.taskId }),
    assert: (r, ctx, check) => check("delete_task on B's task is refused", refused(r)),
  },
  {
    tool: "update_recurring_task",
    attack: "rename B's repeating-task rule",
    args: (ctx) => ({ ruleId: ctx.b.recurringTaskId, title: "vandalized" }),
    assert: (r, ctx, check) => check("update_recurring_task on B's rule is refused", refused(r)),
  },
  {
    tool: "complete_recurring_task",
    attack: "check off today's occurrence of B's habit",
    args: (ctx) => ({ ruleId: ctx.b.recurringTaskId }),
    assert: (r, ctx, check) => check("complete_recurring_task on B's rule is refused", refused(r)),
  },
  {
    tool: "archive_recurring_task",
    attack: "stop B's repeating task",
    args: (ctx) => ({ ruleId: ctx.b.recurringTaskId }),
    assert: (r, ctx, check) => check("archive_recurring_task on B's rule is refused", refused(r)),
  },
  {
    tool: "manage_group",
    attack: "rename B's group",
    args: (ctx) => ({ action: "update", groupId: ctx.b.groupId, name: "vandalized" }),
    assert: (r, ctx, check) => check("manage_group update on B's group is refused", refused(r)),
  },
  {
    tool: "manage_group",
    attack: "archive B's group",
    args: (ctx) => ({ action: "archive", groupId: ctx.b.groupId }),
    assert: (r, ctx, check) => check("manage_group archive on B's group is refused", refused(r)),
  },
  {
    tool: "upsert_goal",
    attack: "close B's goal by id",
    args: (ctx) => ({ goalId: ctx.b.goalId, status: "archived", title: "vandalized" }),
    assert: (r, ctx, check) => check("upsert_goal on B's goal is refused", refused(r)),
  },
  {
    tool: "create_recurring_task",
    attack: "create a repeating task inside B's group",
    args: (ctx) => ({ title: "cross-tenant habit", frequency: "daily", groupId: ctx.b.groupId }),
    assert: (r, ctx, check) =>
      check("create_recurring_task into B's group is refused", refused(r)),
  },
  {
    tool: "log_spend",
    attack: "spend from B's account",
    args: (ctx) => ({ accountId: ctx.b.accountId, amount: 5 }),
    assert: (r, ctx, check) => check("log_spend against B's account is refused", refused(r)),
  },
  {
    tool: "log_spend",
    attack: "spend from A's account but categorized into B's category",
    args: (ctx) => ({ accountId: ctx.a.accountId, amount: 5, categoryId: ctx.b.categoryId }),
    assert: (r, ctx, check) => check("log_spend into B's category is refused", refused(r)),
  },
  {
    tool: "set_spend_limit",
    attack: "cap B's category",
    args: (ctx) => ({
      scope: "category",
      categoryId: ctx.b.categoryId,
      period: "monthly",
      amount: 1,
    }),
    assert: (r, ctx, check) => check("set_spend_limit on B's category is refused", refused(r)),
  },
  {
    tool: "delete_spend_limit",
    attack: "delete B's spending limit by id",
    args: (ctx) => ({ limitId: ctx.b.spendLimitId }),
    assert: (r, ctx, check) => check("delete_spend_limit on B's limit is refused", refused(r)),
  },
  {
    tool: "manage_finance",
    attack: "rename B's account, category, bill and job by id",
    args: (ctx) => ({
      operations: [
        { op: "update_account", account: ctx.b.accountId, name: "vandalized" },
        { op: "update_category", category: ctx.b.categoryId, name: "vandalized" },
        { op: "update_recurring", rule: ctx.b.recurringExpenseId, amount: 1 },
        { op: "update_income", source: ctx.b.incomeSourceId, hourlyWage: 1 },
      ],
    }),
    assert: (r, ctx, check) => check("manage_finance by B's ids is refused", refused(r)),
  },
  {
    tool: "manage_finance",
    attack: "rename B's account by NAME (name refs resolve fuzzily)",
    args: (ctx) => ({
      operations: [{ op: "update_account", account: ctx.b.accountName, name: "vandalized" }],
    }),
    assert: (r, ctx, check) => check("manage_finance by B's account name is refused", refused(r)),
  },
  {
    tool: "update_finance",
    attack: "statement import writing rows into B's account/category",
    args: (ctx) => ({
      operations: [
        {
          op: "spend",
          account: ctx.b.accountId,
          category: ctx.b.categoryId,
          amount: 3,
          date: todayKey(),
          note: "cross-tenant spend",
        },
      ],
    }),
    assert: (r, ctx, check) => check("update_finance spend into B's account is refused", refused(r)),
  },
  {
    tool: "update_finance",
    attack: "adjust and remove B's ledger row by id",
    args: (ctx) => ({
      operations: [
        { op: "adjust", changeId: ctx.b.changeId, amount: 999 },
        { op: "remove", changeId: ctx.b.changeId },
      ],
    }),
    assert: (r, ctx, check) => check("update_finance adjust/remove of B's row is refused", refused(r)),
  },
  {
    tool: "update_finance",
    attack: "reconcile B's account by NAME",
    args: (ctx) => ({
      operations: [
        { op: "reconcile", account: ctx.b.accountName, balance: 0, asOf: todayKey() },
      ],
    }),
    assert: (r, ctx, check) => check("update_finance reconcile by B's account name is refused", refused(r)),
  },
  {
    tool: "update_stock",
    attack: "add/archive B's item by id",
    args: (ctx) => ({
      operations: [
        { op: "add", item: ctx.b.itemId, amount: 5 },
        { op: "archive", item: ctx.b.itemId },
      ],
    }),
    assert: (r, ctx, check) => check("update_stock on B's item id is refused", refused(r)),
  },
  {
    tool: "update_stock",
    attack: "recount B's item by its EXACT name (fuzzy name resolution)",
    args: (ctx) => ({ operations: [{ op: "set", item: ctx.b.itemName, quantity: 0 }] }),
    assert: (r, ctx, check) => check("update_stock by B's exact item name is refused", refused(r)),
  },
  {
    tool: "update_stock",
    attack: "rename B's item by a substring unique to B (fuzzy fallback)",
    args: (ctx) => ({ operations: [{ op: "rename", item: ctx.b.marker, name: "vandalized" }] }),
    assert: (r, ctx, check) =>
      check("update_stock by a B-only name substring is refused", refused(r)),
  },
  {
    tool: "update_stock",
    attack: "set B's shopping price and buy amount by id",
    args: (ctx) => ({
      operations: [
        { op: "set_price", item: ctx.b.itemId, price: 1 },
        { op: "set_buy", item: ctx.b.itemId, buyAmount: 1 },
        { op: "unpin_shopping", item: ctx.b.itemId },
      ],
    }),
    assert: (r, ctx, check) => check("update_stock shopping ops on B's item are refused", refused(r)),
  },
  {
    tool: "update_stock",
    attack: "move A's own item into B's inventory group",
    args: (ctx) => ({
      operations: [{ op: "move", item: ctx.a.itemId, group: ctx.b.inventoryGroupName }],
    }),
    assert: (r, ctx, check) =>
      check("update_stock cannot move A's item into B's group", refused(r)),
  },
  {
    tool: "lookup_prices",
    attack: "price-lookup B's item by id and by name (direct execute, no confirm)",
    args: (ctx) => ({ items: [ctx.b.itemId, ctx.b.itemName] }),
    assert: async (r, ctx, check) => {
      check("lookup_prices refuses B's item refs", r.isError === true, r.text.slice(0, 120));
      const { data } = await ctx.admin
        .from("inventory_items")
        .select("est_price, price_source")
        .eq("id", ctx.b.itemId)
        .maybeSingle();
      check(
        "B's manual price survived the lookup attempt",
        Number(data?.est_price) === 9.5 && data?.price_source === "manual",
        JSON.stringify(data),
      );
    },
  },

  // ---------------- propose writes with no cross-tenant reference ----------------
  // No id to point at B, so the shape under test is "does this land on the
  // caller's own row". Each proposal is cancelled by the runner afterwards.
  {
    tool: "log_daily",
    attack: "check-in must land on A's row, never overwrite B's same-day log",
    args: () => ({ mood: 1, energy: 1, sleepHours: 1 }),
    assert: (r, ctx, check) =>
      check("log_daily proposes against A only", typeof r.json?.proposalId === "string"),
  },
  {
    tool: "update_settings",
    attack: "preference write must land on A's settings row",
    args: () => ({ timezone: "UTC", wakeStartHour: 6 }),
    assert: (r, ctx, check) =>
      check("update_settings proposes against A only", typeof r.json?.proposalId === "string"),
  },
  {
    tool: "create_event",
    attack: "calendar write must be blocked by A's missing Google token at confirm",
    args: () => ({ summary: "cross-tenant event", date: todayKey(1), startTime: "10:00" }),
    confirm: true,
    assert: (r, ctx, check) =>
      check(
        "create_event confirm cannot reach any calendar without A's Google token",
        r.confirmFailed === true,
        r.confirmText?.slice(0, 120),
      ),
  },
  {
    tool: "reschedule_event",
    attack: "move an event id A does not own, then confirm",
    args: (ctx) => ({
      calendarId: "primary",
      eventId: `${ctx.b.marker}-event`,
      start: `${todayKey(1)}T10:00:00Z`,
      end: `${todayKey(1)}T11:00:00Z`,
    }),
    confirm: true,
    assert: (r, ctx, check) =>
      check(
        "reschedule_event confirm cannot reach any calendar without A's Google token",
        r.confirmFailed === true,
        r.confirmText?.slice(0, 120),
      ),
  },

  // ---------------- fenced direct writes ----------------
  {
    tool: "capture_to_brain",
    attack: "vault capture must use A's own vault credentials only",
    args: () => ({
      title: "isolation-probe-capture",
      summary_markdown: "probe capture",
      source: "isolation probe",
    }),
    assert: (r, ctx, check) =>
      check(
        "capture_to_brain cannot write to a vault A has not connected",
        blockedExternally(r),
        r.text.slice(0, 120),
      ),
  },
  {
    tool: "mindspace_ingest_sessions",
    attack: "re-send B's session ref — upsert must not update B's row",
    args: (ctx) => ({
      provider: "claude_code",
      sessions: [
        {
          ref: ctx.b.sessionRef,
          title: "vandalized",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          endedAt: new Date().toISOString(),
          durationMin: 1,
          userText: "cross-tenant ingest",
        },
      ],
    }),
    assert: async (r, ctx, check) => {
      const { data } = await ctx.admin
        .from("mindspace_sessions")
        .select("id, user_id, title")
        .eq("session_ref", ctx.b.sessionRef);
      const rows = data ?? [];
      check(
        "B's session row keeps its own title after A re-sends the ref",
        rows.some((s) => s.user_id === ctx.b.userId && s.title === `${ctx.b.marker}-session-title`),
        JSON.stringify(rows.map((s) => s.title)),
      );
      check(
        "A's ingest created a row owned by A, not a second owner on B's",
        rows.every((s) => s.user_id === ctx.a.userId || s.user_id === ctx.b.userId),
      );
    },
  },
  {
    tool: "process_reel",
    attack: "queue a worker job off B's vault note path",
    args: (ctx) => ({ notePath: `Reels/${ctx.b.marker}-reel.md` }),
    assert: async (r, ctx, check) => {
      check("process_reel is refused for a non-allowlisted tenant", r.isError === true, r.text.slice(0, 120));
      const { data } = await ctx.admin.from("jobs").select("id").eq("user_id", ctx.b.userId);
      check("no worker job was queued against B", (data ?? []).length === 0);
    },
  },
  {
    tool: "claim_agent_run",
    attack: "claim the pending agent-run request — B's must survive",
    args: () => ({}),
    assert: async (r, ctx, check) => {
      const { data } = await ctx.admin
        .from("user_settings")
        .select("agent_run_requested_at")
        .eq("user_id", ctx.b.userId)
        .maybeSingle();
      check(
        "B's pending agent-run request is untouched by A's claim",
        Boolean(data?.agent_run_requested_at),
        JSON.stringify(data),
      );
      check("A's own claim reports A's request", r.json?.requested === true, r.text.slice(0, 120));
    },
  },

  // ---------------- courses ----------------
  {
    tool: "list_courses",
    attack: "course listing must not include B's course",
    args: () => ({}),
    assert: (r, ctx, check) =>
      check(
        "list_courses returns exactly A's one course",
        Array.isArray(r.json?.courses) &&
          r.json.courses.length === 1 &&
          r.json.courses[0].id === ctx.a.courseId,
      ),
  },
  {
    tool: "begin_source_upload",
    attack: "start an upload into B's course by id and into B's source by id",
    args: (ctx) => ({ source_id: ctx.b.courseSourceId }),
    assert: (r, ctx, check) =>
      check("begin_source_upload on B's source id is refused", r.isError === true, r.text.slice(0, 120)),
  },
  {
    tool: "begin_source_upload",
    attack: "start an upload into B's course by NAME",
    args: (ctx) => ({ course: ctx.b.courseName, title: "cross-tenant source" }),
    assert: (r, ctx, check) =>
      check("begin_source_upload on B's course name is refused", r.isError === true, r.text.slice(0, 120)),
  },
  {
    tool: "append_source_markdown",
    attack: "append transcription into B's source",
    args: (ctx) => ({ source_id: ctx.b.courseSourceId, part_index: 1, markdown: "cross-tenant" }),
    assert: (r, ctx, check) =>
      check("append_source_markdown on B's source is refused", r.isError === true, r.text.slice(0, 120)),
  },
  {
    tool: "finalize_source",
    attack: "commit B's source to the vault",
    args: (ctx) => ({ source_id: ctx.b.courseSourceId }),
    assert: (r, ctx, check) =>
      check("finalize_source on B's source is refused", r.isError === true, r.text.slice(0, 120)),
  },
  {
    tool: "generate_audio_overview",
    attack: "propose an episode for B's course (propose only — confirm spends money)",
    args: (ctx) => ({ course: ctx.b.courseId, flavor: "brief" }),
    assert: (r, ctx, check) =>
      check("generate_audio_overview on B's course is refused", refused(r), r.text.slice(0, 120)),
  },

  // ---------------- confirm / cancel across the boundary ----------------
  {
    tool: "confirm_action",
    attack: "confirm B's pending proposalId with A's token",
    args: (ctx) => ({ proposalId: ctx.b.proposalId }),
    assert: async (r, ctx, check) => {
      check("confirm_action on B's proposal is refused", r.isError === true);
      const { data } = await ctx.admin
        .from("ai_audit_log")
        .select("status, user_id")
        .eq("id", ctx.b.proposalId)
        .maybeSingle();
      check(
        "B's proposal is still pending after A's confirm attempt",
        data?.status === "proposed" && data?.user_id === ctx.b.userId,
        JSON.stringify(data),
      );
    },
  },
  {
    tool: "confirm_action",
    attack: "confirm a proposalId that does not exist at all",
    args: () => ({ proposalId: "00000000-0000-0000-0000-000000000000" }),
    assert: (r, ctx, check) =>
      check("confirm_action on an unknown proposalId is refused", r.isError === true),
  },
  {
    tool: "cancel_action",
    attack: "cancel B's pending proposalId with A's token",
    args: (ctx) => ({ proposalId: ctx.b.proposalId }),
    assert: async (r, ctx, check) => {
      check("cancel_action on B's proposal is refused", r.isError === true);
      const { data } = await ctx.admin
        .from("ai_audit_log")
        .select("status")
        .eq("id", ctx.b.proposalId)
        .maybeSingle();
      check(
        "B's proposal is still pending after A's cancel attempt",
        data?.status === "proposed",
        JSON.stringify(data),
      );
    },
  },
];

// Tools registered on the server that this matrix deliberately does not call,
// with the reason printed in the coverage table. Keep this empty unless a tool
// genuinely cannot be exercised — silent partial coverage is the failure mode
// this table exists to prevent.
export const DECLARED_SKIPS = {};

// Tools whose entry above passes because a PRECONDITION is missing, not because
// isolation was demonstrated. Each fails before its code reaches the data path,
// so a scoping bug inside it would not turn this probe red. Printed in the
// coverage table so the number at the bottom is never read as more than it is.
// Making them real tests means seeding per-tenant credentials (a Google token,
// a vault_settings row, an Anthropic key, worker allowlisting).
export const BLIND_SPOTS = {
  list_events: "no google_tokens row for either tenant — fails before the calendar read",
  schedule_snapshot:
    "listEvents throws without a google_tokens row; wake-window scoping is asserted on get_snapshot instead",
  create_event: "confirm fails at the missing Google token, not at a scoping check",
  reschedule_event: "confirm fails at the missing Google token, not at a scoping check",
  list_brain_notes: "no vault_settings row — fails before the vault read",
  read_brain_note: "no vault_settings row — fails before the vault read",
  capture_to_brain: "no vault_settings row — fails before the vault write",
  lookup_prices: "no Anthropic key — refusal is credential-shaped, though the price row IS checked",
  process_reel: "tenant is not worker-allowlisted — fails before the vault/jobs path",
  list_code_tasks: "neither tenant has a group named 'mindboard' — returns the empty shape",
};
