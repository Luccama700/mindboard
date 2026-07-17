import { timingSafeEqual } from "node:crypto";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { verifyAccessToken } from "@/app/lib/mcp/oauth";
import { looksLikePat, resolvePatUserId } from "@/app/lib/mcp/pat";
import {
  getFinanceForecast,
  getFinanceSnapshot,
  getInventoryForecast,
  getInventorySnapshot,
  getPlanningSnapshot,
  getPreferences,
  getScheduleSnapshot,
  getShoppingList,
  getTasksSnapshot,
  listAccounts,
  listBrainNotes,
  listCalendarEvents,
  listCategories,
  listDailyLogs,
  listGoals,
  listGroups,
  listIncomeSources,
  listInventory,
  listProposals,
  listRecentLedger,
  listRecurringExpenses,
  listRecurringTasks,
  listSpendLimits,
  getSpendLimitStatus,
  listCodeTasks,
  listTasks,
  readBrainNote,
} from "@/app/lib/mcp/reads";
import {
  cancelAction,
  claimAgentRun,
  confirmAction,
  lookupShoppingPrices,
  proposeArchiveRecurringTask,
  proposeCompleteRecurring,
  proposeCompleteTask,
  proposeCreateEvent,
  proposeCreateRecurringTask,
  proposeCreateTask,
  proposeDeleteSpendLimit,
  proposeDeleteTask,
  proposeLogDaily,
  proposeLogSpend,
  proposeManageFinance,
  proposeManageGroup,
  proposeRescheduleEvent,
  proposeSetSpendLimit,
  proposeUpdateFinance,
  proposeUpdateRecurringTask,
  proposeUpdateSettings,
  proposeUpdateStock,
  proposeUpdateTask,
  proposeUpsertGoal,
} from "@/app/lib/mcp/writes";
import { MAX_STOCK_OPS } from "@/app/lib/mcp/inventory-ops";
import { MAX_FINANCE_OPS } from "@/app/lib/mcp/finance-ops";
import { MAX_ADMIN_OPS } from "@/app/lib/mcp/finance-admin-ops";
import { captureToBrain } from "@/app/lib/mcp/brain";
import { CAPTURE_SUMMARY_MAX, CAPTURE_TITLE_MAX } from "@/app/lib/mcp/capture";
import {
  appendSourcePart,
  beginSourceUpload,
  finalizeSource,
  listCourses,
} from "@/app/lib/mcp/courses";
import {
  SOURCE_MAX_PARTS,
  SOURCE_PART_MAX_CHARS,
  SOURCE_TITLE_MAX,
} from "@/app/lib/mcp/course-ops";
import { proposeGenerateAudioOverview } from "@/app/lib/learn/episodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// generate_audio_overview's confirm runs script generation + TTS in one call.
export const maxDuration = 300;

// Remote MCP server exposing Mindboard's data to external Claude clients.
// Reads are safe; writes go through propose → confirm with an ai_audit_log row
// (see app/lib/mcp/writes.ts). Multi-tenant: the auth layer resolves every
// request to a Supabase user id (OAuth token sub, per-user PAT, or the static
// bearer mapped to the configured owner) and every tool scopes its queries to
// that user. Tool names mirror app/lib/agent/registry.ts.

type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolText {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// Wrap a tool body so a thrown error (misconfig, DB failure) becomes a clean
// tool error instead of a 500 — without leaking internals to the client log.
async function guard(run: () => Promise<ToolText>): Promise<ToolText> {
  try {
    return await run();
  } catch (e) {
    const message = e instanceof Error ? e.message : "unexpected error";
    return fail(message);
  }
}

// The authenticated caller's Supabase user id, resolved by verifyToken below
// and delivered to every tool via extra.authInfo. Every data access must go
// through this — there is no default user.
function uid(extra: { authInfo?: AuthInfo }): string {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("unauthorized: request has no resolved user identity");
  }
  return userId;
}

const mcpHandler = createMcpHandler(
  (server) => {
    // ---------- reads ----------
    server.registerTool(
      "finance_snapshot",
      {
        title: "Finance snapshot",
        description:
          "Current net worth (sum of account balances), today's net change, and the next upcoming recurring bill.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await getFinanceSnapshot(uid(extra)))),
    );

    server.registerTool(
      "spend_limit_status",
      {
        title: "Spending limit status",
        description:
          "Every active spending limit with actual spend this period vs the cap: amount, spent, remaining, pctUsed, and state ('under' | 'approaching' at >=80% | 'over'). Spend uses the everyday-spend inclusion rules (out-flows only; transfers and recurring bills excluded; category scope respected).",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await getSpendLimitStatus(uid(extra)))),
    );

    server.registerTool(
      "list_spend_limits",
      {
        title: "List spending limits",
        description:
          "Active spending limits (budget caps) with their ids — use as the id source for delete_spend_limit. For spent-vs-cap figures use spend_limit_status.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await listSpendLimits(uid(extra)))),
    );

    server.registerTool(
      "tasks_snapshot",
      {
        title: "Tasks snapshot",
        description: "Counts of open tasks that are overdue, due today, or due within the next week.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await getTasksSnapshot(uid(extra)))),
    );

    server.registerTool(
      "inventory_snapshot",
      {
        title: "Inventory snapshot",
        description: "How many stock items are low or out, and the item projected to run out soonest.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await getInventorySnapshot(uid(extra)))),
    );

    server.registerTool(
      "list_tasks",
      {
        title: "List tasks",
        description:
          "List tasks with their group, optionally filtered by group id and/or status. Use this to find a task's id before completing it.",
        inputSchema: {
          groupId: z.string().nullish(),
          status: z.enum(["todo", "doing", "done"]).optional(),
        },
      },
      (args, extra) => guard(async () => ok(await listTasks(uid(extra), args))),
    );

    server.registerTool(
      "list_code_tasks",
      {
        title: "List code tasks (overnight agent)",
        description:
          "Open tasks in the user's 'mindboard' group — app-improvement ideas the overnight agent plans and builds. Each carries ai_state (null=untouched, planned=plan in notes awaiting approval, approved=cleared to build, building, built, failed) plus the notes holding the plan. Filter with aiState ('none' = untouched). Advance states via update_task's aiState field.",
        inputSchema: {
          aiState: z
            .enum(["none", "planned", "approved", "building", "built", "failed"])
            .optional(),
        },
      },
      (args, extra) => guard(async () => ok(await listCodeTasks(uid(extra), args))),
    );

    server.registerTool(
      "list_groups",
      { title: "List groups", description: "List active task groups (id, name, color, type).", inputSchema: {} },
      (_args, extra) => guard(async () => ok(await listGroups(uid(extra)))),
    );

    server.registerTool(
      "list_accounts",
      {
        title: "List accounts",
        description: "List active money accounts (id, name, balance, currency). Use to find an account id for log_spend.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await listAccounts(uid(extra)))),
    );

    server.registerTool(
      "list_categories",
      {
        title: "List spending categories",
        description: "List active spending categories (id, name). Use to categorize a log_spend.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await listCategories(uid(extra)))),
    );

    server.registerTool(
      "list_inventory",
      {
        title: "List inventory",
        description:
          "List inventory items (id, name, quantity, unit, group, archived, shoppingPinned, estPrice) plus inventory groups. Use it to find item ids/names before update_stock. Pass includeArchived to also see untracked items (needed before a restore op).",
        inputSchema: { includeArchived: z.boolean().optional() },
      },
      (args, extra) => guard(async () => ok(await listInventory(uid(extra), args))),
    );

    server.registerTool(
      "shopping_list",
      {
        title: "Shopping list",
        description:
          "The derived shopping list: items that are out, at/below their reorder threshold, projected to run out within ~7 days, or manually pinned — each with a reason, estimated price (AI-looked-up or manual), and the projected total. Manage it via update_stock ops pin_shopping / unpin_shopping / set_price; fetch missing prices with lookup_prices. Also returns the configured grocery store and weekly shopping day (set via update_settings).",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await getShoppingList(uid(extra)))),
    );

    server.registerTool(
      "list_recurring_tasks",
      {
        title: "List repeating tasks",
        description:
          "List recurring-task rules (id, title, schedule like \"mon/wed/fri\", time, group). Occurrences are generated automatically — never create N individual tasks for a habit. Use the id for archive_recurring_task.",
        inputSchema: { includeArchived: z.boolean().optional() },
      },
      (args, extra) => guard(async () => ok(await listRecurringTasks(uid(extra), args))),
    );

    server.registerTool(
      "list_recent_ledger",
      {
        title: "List recent ledger rows",
        description:
          "The most recent transactions (spending, income, transfers), newest first, with row ids. Optional filters: accountId, categoryId, direction, and a from/to date range. Before a statement import, read a window covering the statement period: the ids feed update_finance's adjust/remove ops and the notes let you judge whether a flagged duplicate is really the same purchase.",
        inputSchema: {
          limit: z.number().int().positive().max(100).optional(),
          accountId: z.string().optional(),
          categoryId: z.string().optional(),
          direction: z.enum(["in", "out"]).optional(),
          from: z.string().optional().describe("YYYY-MM-DD inclusive lower bound."),
          to: z.string().optional().describe("YYYY-MM-DD inclusive upper bound."),
        },
      },
      (args, extra) =>
        guard(async () => {
          const { limit, ...filter } = args;
          return ok(await listRecentLedger(uid(extra), limit, filter));
        }),
    );

    server.registerTool(
      "list_recurring_expenses",
      {
        title: "List recurring expenses",
        description:
          "Recurring bill/subscription rules (id, name, amount, schedule). Check this before proposing a create_recurring op in update_finance so you never duplicate an existing rule.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await listRecurringExpenses(uid(extra)))),
    );

    server.registerTool(
      "schedule_snapshot",
      {
        title: "Schedule snapshot",
        description:
          "The next timed Google Calendar event, free waking hours left today, and the next free time gaps over the coming 3 days.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await getScheduleSnapshot(uid(extra)))),
    );

    server.registerTool(
      "get_snapshot",
      {
        title: "Planning snapshot",
        description:
          "One-call cross-domain planning read over today…+horizonDays (default 7, max 60). Per-day schedule: timed Google events, Mindboard time-blocks and recurring-task occurrences (source-tagged), free gaps, free-hours-before-5pm, and committed minutes. Plus every open task with due time/duration and a scheduled flag; upcoming recurring bills and projected end-of-day net worth per day; inventory run-out estimates; and the recent check-in trend + active goals. Times are in the user's local timezone with explicit ISO offsets. For one lean domain, use finance_snapshot / tasks_snapshot / inventory_snapshot / schedule_snapshot instead.",
        inputSchema: { horizonDays: z.number().int().min(1).max(60).optional() },
      },
      (args, extra) =>
        guard(async () =>
          ok(await getPlanningSnapshot(uid(extra), { horizonDays: args.horizonDays ?? 7 })),
        ),
    );

    server.registerTool(
      "list_events",
      {
        title: "List calendar events",
        description:
          "Google Calendar events in a date range (default: today through +7 days, max span 62 days), across every readable calendar. Each event carries its calendarId/eventId (needed for reschedule_event), whether it is writable, and the Mindboard group its calendar is linked to, if any.",
        inputSchema: {
          from: z.string().optional().describe("YYYY-MM-DD start (default today)."),
          to: z.string().optional().describe("YYYY-MM-DD end, inclusive (default from+7)."),
        },
      },
      (args, extra) => guard(async () => ok(await listCalendarEvents(uid(extra), args))),
    );

    server.registerTool(
      "finance_forecast",
      {
        title: "Finance forecast",
        description:
          "Projected end-of-day net worth for the next N days (default 30, max 90): wage income from calendar-linked income sources, recurring bills, the estimated everyday-spend layer (predicted-minimum baseline of half the median week, per-day overrides, manual fallback), and projected grocery trips (shopping-list prices snapped to the weekly shopping day, deducted from the baseline to avoid double-counting) — the same math as the finance calendar.",
        inputSchema: {
          days: z.number().int().min(1).max(90).optional(),
        },
      },
      (args, extra) => guard(async () => ok(await getFinanceForecast(uid(extra), args.days ?? 30))),
    );

    server.registerTool(
      "inventory_forecast",
      {
        title: "Inventory forecast",
        description:
          "Per-item depletion forecast: effective daily consumption rate from the usage rules, days left, the projected run-out date, and the reorder-by date where a threshold is set. Sorted soonest-out first.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await getInventoryForecast(uid(extra)))),
    );

    server.registerTool(
      "list_goals",
      {
        title: "List goals",
        description:
          "The user's goals (id, title, why, horizon, status, target date). Active and paused by default; includeClosed adds done/archived. Ids feed upsert_goal.",
        inputSchema: { includeClosed: z.boolean().optional() },
      },
      (args, extra) => guard(async () => ok(await listGoals(uid(extra), args))),
    );

    server.registerTool(
      "list_income_sources",
      {
        title: "List income sources",
        description:
          "Wage jobs (id, name, hourly wage, tax rate, linked calendar, pay schedule). Worked shifts come from the linked Google Calendar. Ids feed manage_finance's update_income op.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await listIncomeSources(uid(extra)))),
    );

    server.registerTool(
      "list_daily_logs",
      {
        title: "List daily logs",
        description:
          "Recent mood/energy/sleep check-ins, newest first (default 14, max 60). Today's entry can be written with log_daily.",
        inputSchema: { limit: z.number().int().positive().max(60).optional() },
      },
      (args, extra) => guard(async () => ok(await listDailyLogs(uid(extra), args.limit ?? 14))),
    );

    server.registerTool(
      "get_preferences",
      {
        title: "Get preferences",
        description:
          "The user's settings: timezone, wake window (start/end hour, drives free-time math), the manual daily-spend estimate fallback, and the grocery store + weekly shopping day behind the shopping list's prices and the finance forecast's grocery layer.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await getPreferences(uid(extra)))),
    );

    server.registerTool(
      "list_proposals",
      {
        title: "List AI proposals / audit log",
        description:
          "Recent ai_audit_log rows (id, tool, summary, status, source, timestamps), newest first. status='proposed' shows writes still awaiting confirm_action; executed/rejected/error show history.",
        inputSchema: {
          status: z.enum(["proposed", "executed", "rejected", "error"]).optional(),
          limit: z.number().int().positive().max(100).optional(),
        },
      },
      (args, extra) => guard(async () => ok(await listProposals(uid(extra), args))),
    );

    server.registerTool(
      "list_brain_notes",
      {
        title: "List second-brain notes",
        description:
          "Every markdown note in the vault (path, folder, title). Use a path with read_brain_note to read one.",
        inputSchema: {},
      },
      (_args, extra) => guard(async () => ok(await listBrainNotes(uid(extra)))),
    );

    server.registerTool(
      "read_brain_note",
      {
        title: "Read a second-brain note",
        description:
          "One vault note's raw markdown by path (case-insensitive; '.md' optional). Paths come from list_brain_notes.",
        inputSchema: { path: z.string() },
      },
      (args, extra) => guard(async () => ok(await readBrainNote(uid(extra), args.path))),
    );

    // ---------- writes (propose step) ----------
    // Each returns a proposalId + preview. Show the preview to the user and only
    // call confirm_action after they approve. Nothing is written until then.
    server.registerTool(
      "create_task",
      {
        title: "Propose: create a task",
        description:
          "Propose creating a task. Returns a preview + proposalId; call confirm_action to apply. Sort as you add: call list_groups and set groupId to the group that clearly fits the task's content (e.g. a course group for its assignments); only leave groupId omitted/null (inbox) when nothing fits. dueDate is YYYY-MM-DD.",
        inputSchema: {
          title: z.string(),
          groupId: z.string().nullish(),
          dueDate: z.string().nullish(),
          notes: z.string().nullish(),
          priority: z.enum(["low", "med", "high"]).optional(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeCreateTask(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "complete_task",
      {
        title: "Propose: complete a task",
        description:
          "Propose marking a task as done. Returns a preview + proposalId; call confirm_action to apply. Find the taskId via list_tasks.",
        inputSchema: { taskId: z.string() },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeCompleteTask(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "update_task",
      {
        title: "Propose: edit a task",
        description:
          "Propose editing a task: rename, set/clear due date (null clears), set/clear a time-block (dueTime HH:MM + durationMin), move between groups (groupId null → inbox), notes, priority — and optionally push a dated+timed task out as a real Google Calendar event (pushToCalendar). Scheduling a task IS this tool (set dueDate + dueTime). Find the taskId via list_tasks. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          taskId: z.string(),
          title: z.string().optional(),
          dueDate: z.string().nullish().describe("YYYY-MM-DD, or null to clear."),
          dueTime: z.string().nullish().describe("HH:MM 24h, or null to clear the block."),
          durationMin: z.number().int().min(15).nullish(),
          groupId: z.string().nullish().describe("Target group id, or null for inbox."),
          notes: z.string().nullish(),
          priority: z.enum(["low", "med", "high"]).optional(),
          pushToCalendar: z.boolean().optional(),
          aiState: z
            .enum(["planned", "building", "built", "failed"])
            .nullish()
            .describe(
              "Overnight-agent lifecycle (see list_code_tasks); null clears it. 'approved' is user-only, set in the app.",
            ),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeUpdateTask(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "delete_task",
      {
        title: "Propose: delete a task",
        description:
          "Propose permanently deleting a task (prefer complete_task for finished work — deletion is for mistakes/duplicates). Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: { taskId: z.string() },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeDeleteTask(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "update_recurring_task",
      {
        title: "Propose: edit a repeating task",
        description:
          "Propose editing a repeating-task rule: rename, reschedule (pass frequency plus its fields — weekly needs weekdays, monthly dayOfMonth, custom intervalDays), change/clear the time block (dueTime null clears), group, notes, priority. Find the ruleId via list_recurring_tasks. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          ruleId: z.string(),
          title: z.string().optional(),
          groupId: z.string().nullish(),
          notes: z.string().nullish(),
          priority: z.enum(["low", "med", "high"]).optional(),
          frequency: z.enum(["daily", "weekly", "monthly", "custom"]).optional(),
          weekdays: z.array(z.number().int().min(0).max(6)).optional(),
          dayOfMonth: z.number().int().min(1).max(31).optional(),
          intervalDays: z.number().int().min(1).optional(),
          startDate: z.string().nullish(),
          dueTime: z.string().nullish(),
          durationMin: z.number().int().min(15).nullish(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeUpdateRecurringTask(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "complete_recurring_task",
      {
        title: "Propose: check off today's habit",
        description:
          "Propose checking off TODAY's occurrence of a repeating task (or un-checking it with undo:true). Only today is completable — missed days skip silently. Find the ruleId via list_recurring_tasks. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: { ruleId: z.string(), undo: z.boolean().optional() },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeCompleteRecurring(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "manage_group",
      {
        title: "Propose: create/edit/archive a task group",
        description:
          "Propose a task-group change. action=create needs name + type (course/project/work/personal; color optional #rrggbb). action=update edits name/type/color and can link a Google Calendar (googleCalendarId; null unlinks) so its events render as that group. action=archive hides the group (its tasks stay). Find groupId via list_groups. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          action: z.enum(["create", "update", "archive"]),
          groupId: z.string().optional().describe("Required for update/archive."),
          name: z.string().optional(),
          type: z.enum(["course", "project", "work", "personal"]).optional(),
          color: z.string().optional().describe("#rrggbb"),
          googleCalendarId: z.string().nullish(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeManageGroup(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "upsert_goal",
      {
        title: "Propose: create or update a goal",
        description:
          "Propose creating a goal, or updating/closing an existing one (pass goalId to update; status done/paused/archived closes or pauses it). Find goalId via list_goals. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          goalId: z.string().optional(),
          title: z.string().optional(),
          why: z.string().optional(),
          horizon: z.enum(["week", "month", "quarter", "year", "life"]).optional(),
          status: z.enum(["active", "done", "paused", "archived"]).optional(),
          targetDate: z.string().optional().describe("YYYY-MM-DD"),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeUpsertGoal(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "reschedule_event",
      {
        title: "Propose: move a Google Calendar event",
        description:
          "Propose moving an existing Google Calendar event to a new start/end. Timed events take ISO datetimes (end after start); all-day events (allDay:true) take YYYY-MM-DD dates with an EXCLUSIVE end. Get calendarId/eventId (and writability) from list_events — read-only calendars cannot be edited. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          calendarId: z.string(),
          eventId: z.string(),
          allDay: z.boolean().optional(),
          start: z.string(),
          end: z.string(),
          timeZone: z.string().optional().describe("IANA zone for timed events."),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeRescheduleEvent(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "create_event",
      {
        title: "Propose: create a Google Calendar event",
        description:
          "Propose creating a Google Calendar event: summary + date, plus startTime (HH:MM) and durationMin (default 60) for a timed block — omit startTime for all-day. calendarId defaults to the primary calendar (list_events shows other writable calendar ids). Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          summary: z.string(),
          date: z.string().describe("YYYY-MM-DD"),
          startTime: z.string().optional().describe("HH:MM 24h; omit for all-day."),
          durationMin: z.number().int().min(15).optional(),
          calendarId: z.string().optional(),
          description: z.string().optional(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeCreateEvent(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "log_daily",
      {
        title: "Propose: log today's check-in",
        description:
          "Propose recording today's daily log: mood 1-5, energy 1-5, optional sleep hours. Re-logging the same day overwrites it. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          mood: z.number().int().min(1).max(5),
          energy: z.number().int().min(1).max(5),
          sleepHours: z.number().min(0).max(24).nullish(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeLogDaily(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "update_settings",
      {
        title: "Propose: update preferences",
        description:
          "Propose changing user preferences: timezone (IANA name), the wake window (wakeStartHour 0-23, wakeEndHour 1-24 — drives free-time math), the grocery store (shoppingStore, free text like \"Save-On-Foods Wesbrook, Vancouver\" — feeds AI price lookups; null clears), and/or the weekly shopping day (shoppingDay 0=Sunday…6=Saturday — anchors projected grocery spend on the finance forecast; null clears). The daily-spend estimate lives in manage_finance instead. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          timezone: z.string().optional(),
          wakeStartHour: z.number().int().min(0).max(23).optional(),
          wakeEndHour: z.number().int().min(1).max(24).optional(),
          shoppingStore: z.string().nullish(),
          shoppingDay: z.number().int().min(0).max(6).nullish(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeUpdateSettings(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "manage_finance",
      {
        title: "Propose: finance configuration changes",
        description:
          "Propose a batch of finance CONFIGURATION edits in one confirmable receipt (ledger rows belong in update_finance / log_spend instead). Ops: create_account (name, type, balance — negative for credit debt; seeds an opening ledger row + anchor), update_account (rename/type/color/archive by id or name), update_category (rename/color/archive), update_recurring (rename/amount/category/schedule/archive a bill rule — frequency needs its fields: monthly→dayOfMonth, weekly→weekday, custom→intervalDays+startDate), create_income / update_income (wage jobs: hourlyWage, taxRate 0-100, calendarId links worked-shift calendar, payFrequency weekly/biweekly/monthly + anchorPayday + periodStart/periodEnd — payFrequency null clears the schedule), set_spend_override (pin expected everyday spend for a FUTURE date; amount null clears, 0 means no spend), set_daily_spend_estimate (the manual flat fallback; null clears). References accept an id or a unique name. Read list_accounts / list_categories / list_recurring_expenses / list_income_sources first. Returns a receipt preview + proposalId; call confirm_action after the user approves.",
        inputSchema: {
          operations: z
            .array(
              z.object({
                op: z.enum([
                  "create_account",
                  "update_account",
                  "update_category",
                  "update_recurring",
                  "create_income",
                  "update_income",
                  "set_spend_override",
                  "set_daily_spend_estimate",
                ]),
                name: z.string().optional(),
                type: z
                  .enum(["checking", "savings", "cash", "credit", "investment", "other"])
                  .optional(),
                color: z.string().optional().describe("#rrggbb"),
                currency: z.string().optional(),
                balance: z.number().optional().describe("Opening balance (create_account)."),
                account: z.string().optional().describe("Account id or name (update_account)."),
                category: z
                  .string()
                  .nullish()
                  .describe("Category id or name (update_category target, or update_recurring's category; null clears)."),
                rule: z.string().optional().describe("Recurring-expense id or name (update_recurring)."),
                source: z.string().optional().describe("Income-source id or name (update_income)."),
                archived: z.boolean().optional(),
                amount: z
                  .number()
                  .nullish()
                  .describe("update_recurring amount, or set_spend_override / set_daily_spend_estimate value (null clears)."),
                frequency: z.enum(["monthly", "weekly", "daily", "custom"]).optional(),
                dayOfMonth: z.number().int().min(1).max(31).optional(),
                weekday: z.number().int().min(0).max(6).optional(),
                intervalDays: z.number().int().min(1).max(366).optional(),
                startDate: z.string().optional(),
                hourlyWage: z.number().optional(),
                taxRate: z.number().min(0).max(100).optional(),
                calendarId: z.string().nullish(),
                payFrequency: z.enum(["weekly", "biweekly", "monthly"]).nullish(),
                anchorPayday: z.string().optional(),
                periodStart: z.string().optional(),
                periodEnd: z.string().optional(),
                date: z.string().optional().describe("YYYY-MM-DD (set_spend_override)."),
              }),
            )
            .min(1)
            .max(MAX_ADMIN_OPS),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeManageFinance(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "create_recurring_task",
      {
        title: "Propose: create a repeating task",
        description:
          "Propose a repeating task rule for habits like \"lunch every day 12:30\" or \"gym mon/wed/fri 17:00\" — do NOT create N individual tasks. Occurrences appear automatically each day they land; missed days skip silently. weekly needs weekdays (0=sun … 6=sat, several allowed); monthly needs dayOfMonth; custom needs intervalDays (startDate defaults to today). dueTime (HH:MM) makes it a calendar block that counts against free time. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          title: z.string(),
          groupId: z.string().nullish(),
          notes: z.string().nullish(),
          priority: z.enum(["low", "med", "high"]).optional(),
          frequency: z.enum(["daily", "weekly", "monthly", "custom"]),
          weekdays: z.array(z.number().int().min(0).max(6)).optional(),
          dayOfMonth: z.number().int().min(1).max(31).optional(),
          intervalDays: z.number().int().min(1).optional(),
          startDate: z.string().nullish(),
          dueTime: z.string().nullish(),
          durationMin: z.number().int().min(15).optional(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeCreateRecurringTask(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "archive_recurring_task",
      {
        title: "Propose: stop a repeating task",
        description:
          "Propose stopping a repeating task rule (archives it; completion history is kept). Find the ruleId via list_recurring_tasks. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: { ruleId: z.string() },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeArchiveRecurringTask(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "log_spend",
      {
        title: "Propose: log spending",
        description:
          "Propose recording a single spend from an account today (appends a dated ledger row; the balance re-derives). For anything dated, batched, or statement-shaped use update_finance instead. Returns a preview + proposalId; call confirm_action to apply. amount is a positive number; find accountId/categoryId via list_accounts/list_categories.",
        inputSchema: {
          accountId: z.string(),
          amount: z.number().positive(),
          categoryId: z.string().nullish(),
          note: z.string().nullish(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeLogSpend(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "set_spend_limit",
      {
        title: "Propose: set a spending limit",
        description:
          "Propose creating or updating a budget cap the app tracks actual spend against (distinct from the forecast's daily-spend estimate). scope 'overall' caps all discretionary spend; scope 'category' caps one category (pass its categoryId from list_categories). period is daily, weekly (Mon-Sun), or monthly (calendar month). Only one overall limit and one limit per category exist — setting again updates the existing one. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          scope: z.enum(["overall", "category"]),
          categoryId: z
            .string()
            .nullish()
            .describe("Required when scope is 'category'."),
          period: z.enum(["daily", "weekly", "monthly"]),
          amount: z.number().positive(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeSetSpendLimit(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "delete_spend_limit",
      {
        title: "Propose: delete a spending limit",
        description:
          "Propose removing a spending limit (budget cap). Find limitId via list_spend_limits. Returns a preview + proposalId; call confirm_action to apply.",
        inputSchema: {
          limitId: z.string(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeDeleteSpendLimit(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "update_finance",
      {
        title: "Propose: batched finance update (statement import)",
        description:
          "Propose a batch of finance edits in one confirmable receipt — THE tool for importing a bank statement or account screenshot. Ops: spend (dated, categorized outflow), income (dated inflow), transfer (between two accounts, e.g. a credit-card payment — never a spend), reconcile (assert an account's ending balance as of a date; put it last), create_category (when no existing category fits), create_recurring (a repeated charge not yet in list_recurring_expenses), adjust/remove (fix or delete an existing row by id from list_recent_ledger). Accounts and categories accept an id or a name (case-insensitive; unique substrings work — ambiguity fails with candidates). Duplicates (same account+date+direction+amount as an existing row) are skipped and shown in the receipt; set force:true on an op to import it anyway after checking the notes differ. Credit accounts store the owed amount as a NEGATIVE balance: card purchases are spend ops, card payments are transfers. Read list_accounts, list_categories, list_recent_ledger (covering the statement period) and list_recurring_expenses first. Batch the WHOLE statement into ONE call. Returns a receipt preview + proposalId; call confirm_action after the user approves.",
        inputSchema: {
          operations: z
            .array(
              z.object({
                op: z.enum([
                  "spend",
                  "income",
                  "transfer",
                  "reconcile",
                  "create_category",
                  "create_recurring",
                  "adjust",
                  "remove",
                ]),
                account: z
                  .string()
                  .optional()
                  .describe("Account id or name (spend/income/reconcile)."),
                amount: z
                  .number()
                  .positive()
                  .optional()
                  .describe("Positive amount (spend/income/transfer/create_recurring/adjust)."),
                date: z
                  .string()
                  .optional()
                  .describe("YYYY-MM-DD the transaction happened (spend/income/transfer/adjust)."),
                category: z
                  .string()
                  .optional()
                  .describe(
                    "Category id or name (spend/create_recurring/adjust); may name a create_category earlier in this batch.",
                  ),
                note: z.string().optional().describe("Merchant / description."),
                force: z
                  .boolean()
                  .optional()
                  .describe("Import a spend/income even though it matches an existing row."),
                from: z.string().optional().describe("Source account (transfer)."),
                to: z.string().optional().describe("Destination account (transfer)."),
                balance: z
                  .number()
                  .optional()
                  .describe("Ending balance (reconcile); negative for credit accounts."),
                asOf: z
                  .string()
                  .optional()
                  .describe("YYYY-MM-DD the balance was true, e.g. the statement end date (reconcile)."),
                name: z
                  .string()
                  .optional()
                  .describe("New category or recurring-expense name (create_category/create_recurring)."),
                color: z
                  .string()
                  .optional()
                  .describe("Optional #rrggbb for create_category."),
                frequency: z
                  .enum(["monthly", "weekly", "daily", "custom"])
                  .optional()
                  .describe("create_recurring cadence."),
                dayOfMonth: z.number().int().min(1).max(31).optional(),
                weekday: z.number().int().min(0).max(6).optional(),
                intervalDays: z.number().int().min(1).max(366).optional(),
                startDate: z.string().optional(),
                changeId: z
                  .string()
                  .optional()
                  .describe("Ledger row id from list_recent_ledger (adjust/remove)."),
                markTransfer: z
                  .boolean()
                  .optional()
                  .describe(
                    "adjust only: true reclassifies the row as a transfer between own accounts (excluded from spending analytics), false back to regular spending.",
                  ),
              }),
            )
            .min(1)
            .max(MAX_FINANCE_OPS),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeUpdateFinance(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "update_stock",
      {
        title: "Propose: update inventory stock",
        description:
          "Propose a batch of inventory edits in one confirmable receipt: add (got more), remove (used some), set (recount), create (new item; optional price), archive (stop tracking), restore (track again), set_priority (how loudly it nags: high surfaces on home when merely low, med only when out, low never), set_threshold (reorder level; null clears), set_usage (consumption rate driving the depletion forecast — replaces the item's existing usage rules; period day/week/custom, custom needs intervalDays), clear_usage, rename, move (to a group; omit group for none), create_group (new inventory group, usable by later ops in the same batch), pin_shopping (keep an item on the shopping list regardless of stock; optional price if you already know it), unpin_shopping (take it off), set_price (record the expected TOTAL cost of the planned purchase; null clears — stored as a manual price that AI lookups never overwrite), set_buy (how much the user plans to buy, in the item's own unit; the AI price lookup then estimates the total for the realistic package combination covering it — changing it refreshes a stale AI price automatically). A create earlier in the batch can be pinned by name in the same batch. Items pinned without a price get an automatic AI price lookup after confirm (when a store is configured). `item` accepts an id or a name (case-insensitive; unique substrings work — ambiguity fails with candidates). Returns a receipt preview + proposalId; call confirm_action to apply. Batch a whole grocery haul into ONE call.",
        inputSchema: {
          operations: z
            .array(
              z.object({
                op: z.enum([
                  "add",
                  "remove",
                  "set",
                  "create",
                  "archive",
                  "restore",
                  "set_priority",
                  "set_threshold",
                  "set_usage",
                  "clear_usage",
                  "rename",
                  "move",
                  "create_group",
                  "pin_shopping",
                  "unpin_shopping",
                  "set_price",
                  "set_buy",
                ]),
                item: z
                  .string()
                  .optional()
                  .describe(
                    "Item id or name (every op except create/create_group).",
                  ),
                amount: z
                  .number()
                  .positive()
                  .optional()
                  .describe("How much was gained/used (add/remove), or consumed per period (set_usage)."),
                quantity: z
                  .number()
                  .min(0)
                  .optional()
                  .describe("Absolute count (for set/create)."),
                name: z
                  .string()
                  .optional()
                  .describe("New name (create/create_group), or the new item name (rename)."),
                unit: z.string().optional().describe('Optional unit for create, e.g. "rolls".'),
                group: z
                  .string()
                  .optional()
                  .describe("Inventory group id or name (create/move; omit on move to ungroup)."),
                priority: z
                  .enum(["low", "med", "high"])
                  .optional()
                  .describe("Attention priority (for set_priority)."),
                threshold: z
                  .number()
                  .positive()
                  .nullish()
                  .describe("Reorder level (set_threshold); null clears it."),
                period: z
                  .enum(["day", "week", "custom"])
                  .optional()
                  .describe("Usage cadence (set_usage)."),
                intervalDays: z
                  .number()
                  .int()
                  .min(1)
                  .optional()
                  .describe("Every N days, for period=custom (set_usage)."),
                price: z
                  .number()
                  .positive()
                  .nullish()
                  .describe(
                    "Estimated TOTAL cost of the item's planned purchase, in the user's currency (create/pin_shopping optional; set_price required, null clears).",
                  ),
                buyAmount: z
                  .number()
                  .positive()
                  .nullish()
                  .describe(
                    "How much the user plans to buy, in the item's own unit (pin_shopping optional; set_buy required, null clears back to one typical package). est_price should then cover the whole planned purchase — packs don't map 1:1 to units, so it's not price × amount.",
                  ),
              }),
            )
            .min(1)
            .max(MAX_STOCK_OPS),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeUpdateStock(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    // Direct execute (no propose step): price lookups only write source-labeled
    // cache metadata and never overwrite a manual price. Spends cents on the
    // user's stored Anthropic key per item, like free-form capture parsing.
    server.registerTool(
      "lookup_prices",
      {
        title: "Look up shopping prices",
        description:
          "Look up current prices for shopping-list items at the user's configured grocery store (one web-search Claude call per item on the user's stored Anthropic key — cents per item, max 10 per call). With no items given, targets the shopping list's unpriced entries. items accepts ids or names. force re-fetches AI-sourced prices; manually-set prices are never overwritten. Applies immediately (prices are editable cache metadata, not a confirmable write).",
        inputSchema: {
          items: z.array(z.string()).max(10).optional(),
          force: z.boolean().optional(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await lookupShoppingPrices(uid(extra), args);
          return r.ok ? ok({ results: r.results }) : fail(r.error);
        }),
    );

    // ---------- direct write (fenced: create-only, vault Inbox/ only) ----------
    // No propose → confirm step: this cannot touch Mindboard data at all, and
    // the vault's review-and-file flow is the confirmation.
    server.registerTool(
      "capture_to_brain",
      {
        title: "Capture to second brain",
        description:
          "Save a distilled summary of the current conversation into Lucca's second brain for later review and filing. Write a summary, not a transcript: what was discussed, decisions made, new facts about the user's life worth keeping, and open questions. Plain markdown; [[wikilinks]] to vault notes welcome when confident. Mark any AI-concluded (not user-stated) claim with (inferred). The capture lands in a staging Inbox/ and is reviewed before becoming vault knowledge.",
        inputSchema: {
          title: z.string().max(CAPTURE_TITLE_MAX),
          summary_markdown: z.string().max(CAPTURE_SUMMARY_MAX),
          source: z.string().describe('Where this came from, e.g. "claude.ai chat, 2026-07-06".'),
          topics: z.array(z.string()).optional().describe("Optional reviewer hints for filing."),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await captureToBrain(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    // ---------- courses: chunked source ingestion (fenced direct write) ----------
    // Same structural fence as capture_to_brain: the vault write is create-only
    // under Courses/, the metadata rows are low-stakes operational state, and
    // the vault review flow is the confirmation.
    server.registerTool(
      "list_courses",
      {
        title: "List courses",
        description:
          "List the user's courses (/learn) with their sources and conversion status. Use this to find a course or source id before uploading markdown.",
        inputSchema: {},
      },
      (_args, extra) =>
        guard(async () => {
          const r = await listCourses(uid(extra));
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "begin_source_upload",
      {
        title: "Begin course-source upload",
        description:
          "Start uploading a course document's markdown transcription into the user's second brain. Pass course (name or id from list_courses) + title for a new source, OR source_id to fill in an existing uploaded PDF's markdown. Returns the source_id and transcription instructions. Follow with sequential append_source_markdown calls, then finalize_source.",
        inputSchema: {
          course: z
            .string()
            .optional()
            .describe("Course name or id (new source)."),
          source_id: z
            .string()
            .optional()
            .describe("Existing source id to transcribe into (from list_courses)."),
          title: z
            .string()
            .max(SOURCE_TITLE_MAX)
            .optional()
            .describe("Document title, e.g. 'Lecture 12 — Eigenvalues'."),
          page_count: z.number().int().positive().optional(),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await beginSourceUpload(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "append_source_markdown",
      {
        title: "Append source markdown part",
        description:
          `Append one sequential part of the verbatim markdown transcription (part_index 1, 2, …; ≤${SOURCE_PART_MAX_CHARS} chars per part, ≤${SOURCE_MAX_PARTS} parts). Transcribe faithfully — GitHub-flavored markdown, $…$/$$…$$ LaTeX for math, markdown tables, an <!-- p.N --> comment before each page. Never summarize or skip content.`,
        inputSchema: {
          source_id: z.string(),
          part_index: z.number().int().min(1).max(SOURCE_MAX_PARTS),
          markdown: z.string().max(SOURCE_PART_MAX_CHARS),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await appendSourcePart(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "finalize_source",
      {
        title: "Finalize course source",
        description:
          "Assemble the uploaded parts and commit the markdown to the vault under Courses/<course>/Sources/. Fails if parts are missing or non-contiguous. Returns the vault path.",
        inputSchema: { source_id: z.string() },
      },
      (args, extra) =>
        guard(async () => {
          const r = await finalizeSource(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "generate_audio_overview",
      {
        title: "Generate an audio overview",
        description:
          "Propose generating a podcast episode from a course's converted sources (NotebookLM-style audio overview). Spends the user's API credits, so it needs confirm_action. flavor: deep-dive (default, two hosts, ~13 min), brief (~5 min), debate, or solo (single narrator lecture, ~10 min). Confirming runs script + voices and can take a couple of minutes.",
        inputSchema: {
          course: z.string().describe("Course name or id (see list_courses)."),
          source_ids: z
            .array(z.string())
            .optional()
            .describe("Converted source ids to cover; omit for all."),
          flavor: z.enum(["deep-dive", "brief", "debate", "solo"]).optional(),
          engine: z
            .enum(["gemini", "vibevoice"])
            .optional()
            .describe("gemini = instant hosted voices (default); vibevoice = free home-pc render."),
        },
      },
      (args, extra) =>
        guard(async () => {
          const r = await proposeGenerateAudioOverview(uid(extra), args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    // ---------- confirm / cancel ----------
    server.registerTool(
      "confirm_action",
      {
        title: "Confirm a proposed write",
        description:
          "Execute a previously proposed write (any propose-tool: tasks, repeating tasks, groups, goals, calendar events, daily log, settings, stock, finance) by its proposalId. Only call after the user has approved the preview. Pending proposals are visible via list_proposals (status=proposed).",
        inputSchema: { proposalId: z.string() },
      },
      (args, extra) =>
        guard(async () => {
          const r = await confirmAction(uid(extra), args.proposalId);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "claim_agent_run",
      {
        title: "Claim a pending agent-run request",
        description:
          "Operational tool for the overnight orchestrator's poll: atomically clears a pending 'run agent now' request (stamped by the in-app button) and reports whether one existed. Not useful to chat clients.",
        inputSchema: {},
      },
      (_args, extra) =>
        guard(async () => {
          const r = await claimAgentRun(uid(extra));
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "cancel_action",
      {
        title: "Cancel a proposed write",
        description: "Discard a proposed write by its proposalId without executing it.",
        inputSchema: { proposalId: z.string() },
      },
      (args, extra) =>
        guard(async () => {
          const r = await cancelAction(uid(extra), args.proposalId);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );
  },
  { serverInfo: { name: "mindboard", version: "1.0.0" } },
  { basePath: "/api/mcp", maxDuration: 300, disableSse: true, verboseLogs: false },
);

// ---------- auth: OAuth access token, per-user PAT, or static bearer ----------
// claude.ai authenticates via OAuth (see app/api/mcp/oauth/* + the well-known
// metadata); the token's sub is the Supabase user id. Non-OAuth clients (MCP
// inspector, curl, Claude Desktop) use a per-user mbp_ personal access token
// generated on /settings. The legacy static MCP_BEARER_TOKEN keeps working and
// maps to the configured owner (MINDBOARD_OWNER_USER_ID). Every path puts the
// resolved user id in authInfo.extra.userId, which uid() requires per tool call.
// withMcpAuth returns 401 + a WWW-Authenticate that points at the
// protected-resource metadata, which kicks off the OAuth flow.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function verifyToken(_req: Request, bearer?: string) {
  if (!bearer) return undefined;

  const staticToken = process.env.MCP_BEARER_TOKEN;
  const staticOwner = process.env.MINDBOARD_OWNER_USER_ID;
  if (staticToken && staticOwner && safeEqual(bearer, staticToken)) {
    return {
      token: bearer,
      clientId: "static",
      scopes: ["mcp"],
      extra: { userId: staticOwner },
    };
  }

  if (looksLikePat(bearer)) {
    const userId = await resolvePatUserId(bearer);
    if (!userId) return undefined;
    return { token: bearer, clientId: "pat", scopes: ["mcp"], extra: { userId } };
  }

  const parsed = verifyAccessToken(bearer);
  if (parsed) {
    return {
      token: bearer,
      clientId: parsed.clientId,
      scopes: ["mcp"],
      extra: { userId: parsed.ownerId },
    };
  }

  return undefined;
}

const handler = withMcpAuth(mcpHandler, verifyToken, { required: true });

export { handler as GET, handler as POST };
 