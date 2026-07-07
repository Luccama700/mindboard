import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";

import { todayISO } from "@/app/_components/date-utils";
import {
  getAccounts,
  getActiveRecurringExpenses,
  getBalanceChangesOn,
} from "@/app/lib/data/finance";
import { getInventoryItems, getInventoryUsages } from "@/app/lib/data/inventory";
import { getDashboardData, getOpenTasks, currentMonth } from "@/app/lib/data/dashboard";
import { getUserPreferences } from "@/app/lib/data/settings";
import { financeSnapshot } from "@/app/lib/snapshots/finance";
import { inventorySnapshot } from "@/app/lib/snapshots/inventory";
import { tasksSnapshot } from "@/app/lib/snapshots/tasks";
import { freeGaps, scheduleSnapshot } from "@/app/lib/snapshots/schedule";
import { recordProposal } from "@/app/lib/mcp/audit";
import { proposeUpdateStockFor } from "@/app/lib/mcp/writes";
import { captureToBrainFor } from "@/app/lib/mcp/brain";
import {
  summarizeCreateTask,
  summarizeLogSpend,
  validateCreateTask,
  validateLogSpend,
  type Result,
} from "@/app/lib/mcp/validate";

// The assistant's tool surface: the MCP catalog re-hosted on the caller's
// session (RLS does the scoping) plus two planning writes. Every write is
// propose-only here — execution happens exclusively through the user's
// confirm tap (app/actions/assistant.ts).

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_snapshot",
    description:
      "Read the live cross-domain snapshot: finance (net worth, today delta, next bill), tasks (overdue/due today/due soon counts), inventory (low/out), schedule (next event, free hours today), and the next free time gaps. Call this first in almost every conversation.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tasks",
    description:
      "List open tasks with ids, titles, due dates/times, priority, and group. Use ids for propose_complete_task / propose_schedule_task.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_accounts_and_categories",
    description:
      "List money accounts (id, name, balance, currency) and spending categories (id, name). Needed before propose_log_spend.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_goals",
    description: "List the user's goals (id, title, why, horizon, status, target date).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_create_task",
    description:
      "Propose creating a task. Returns a proposal the user must confirm — never assume it ran.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        dueDate: { type: "string", description: "YYYY-MM-DD" },
        dueTime: { type: "string", description: "HH:MM 24h, optional" },
        priority: { type: "string", enum: ["low", "med", "high"] },
        notes: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_complete_task",
    description: "Propose marking a task done (by id). User must confirm.",
    input_schema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_schedule_task",
    description:
      "Propose placing an existing task at a date and time (a time-block). Optionally push it to Google Calendar. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        dueDate: { type: "string", description: "YYYY-MM-DD" },
        dueTime: { type: "string", description: "HH:MM 24h" },
        durationMin: { type: "integer", minimum: 15 },
        pushToCalendar: { type: "boolean" },
      },
      required: ["taskId", "dueDate", "dueTime"],
      additionalProperties: false,
    },
  },
  {
    name: "list_inventory",
    description:
      "List stock items (id, name, quantity, unit, group, archived) plus inventory groups. Use it to find item ids/names before propose_update_stock. Pass includeArchived to also see untracked items (needed before a restore op).",
    input_schema: {
      type: "object",
      properties: { includeArchived: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "propose_update_stock",
    description:
      "Propose a batch of inventory edits in one confirmable receipt: add (got more), remove (used some), set (recount), create (new item), archive (stop tracking), restore (track again), set_priority (how loudly it nags: high surfaces on home when merely low, med only when out, low never). `item` accepts an id or a name (case-insensitive; unique substrings work — ambiguity fails with candidates). Batch a whole grocery haul into ONE call. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "add",
                  "remove",
                  "set",
                  "create",
                  "archive",
                  "restore",
                  "set_priority",
                ],
              },
              item: {
                type: "string",
                description:
                  "Item id or name (for add/remove/set/archive/restore/set_priority).",
              },
              amount: {
                type: "number",
                exclusiveMinimum: 0,
                description: "How much was gained/used (for add/remove).",
              },
              quantity: {
                type: "number",
                minimum: 0,
                description: "Absolute count (for set/create).",
              },
              name: { type: "string", description: "New item name (for create)." },
              unit: { type: "string", description: 'Optional unit for create, e.g. "rolls".' },
              group: {
                type: "string",
                description: "Optional inventory group id or name (for create).",
              },
              priority: {
                type: "string",
                enum: ["low", "med", "high"],
                description: "Attention priority (for set_priority).",
              },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
      required: ["operations"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_log_spend",
    description:
      "Propose logging a spend against an account (and optional category). Finance is read-safe: this only ever proposes. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        amount: { type: "number", exclusiveMinimum: 0 },
        categoryId: { type: "string" },
        note: { type: "string" },
      },
      required: ["accountId", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "capture_to_brain",
    description:
      "Save a distilled summary of the current conversation into the user's second brain for later review and filing. Write a summary, not a transcript: what was discussed, decisions made, new facts about the user's life worth keeping, and open questions. Plain markdown; [[wikilinks]] to vault notes welcome when confident. Mark any AI-concluded (not user-stated) claim with (inferred). Executes immediately (no confirm): it only creates a new file in the vault's staging Inbox/, reviewed before becoming vault knowledge, and cannot touch Mindboard data.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 80 },
        summary_markdown: { type: "string", maxLength: 20000 },
        source: {
          type: "string",
          description: 'Where this came from, e.g. "Mindboard assistant, 2026-07-06".',
        },
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Optional reviewer hints for filing.",
        },
      },
      required: ["title", "summary_markdown", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_upsert_goal",
    description:
      "Propose creating a goal, or updating/closing an existing one (pass goalId to update). User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        goalId: { type: "string" },
        title: { type: "string" },
        why: { type: "string" },
        horizon: {
          type: "string",
          enum: ["week", "month", "quarter", "year", "life"],
        },
        status: {
          type: "string",
          enum: ["active", "done", "paused", "archived"],
        },
        targetDate: { type: "string", description: "YYYY-MM-DD" },
      },
      additionalProperties: false,
    },
  },
];

export type ToolOutcome =
  | { type: "result"; content: unknown }
  | { type: "proposal"; proposalId: string; preview: string }
  | { type: "error"; error: string };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function proposeScheduleTask(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string | null,
  input: Record<string, unknown>,
): Promise<Result<{ proposalId: string; preview: string }>> {
  const taskId = input.taskId;
  const dueDate = input.dueDate;
  const dueTime = input.dueTime;
  if (typeof taskId !== "string" || !taskId) return { ok: false, error: "taskId is required" };
  if (typeof dueDate !== "string" || !DATE_RE.test(dueDate)) {
    return { ok: false, error: "dueDate must be YYYY-MM-DD" };
  }
  if (typeof dueTime !== "string" || !TIME_RE.test(dueTime)) {
    return { ok: false, error: "dueTime must be HH:MM" };
  }
  const durationMin =
    input.durationMin === undefined ? 30 : Number(input.durationMin);
  if (!Number.isFinite(durationMin) || durationMin < 15) {
    return { ok: false, error: "durationMin must be >= 15" };
  }

  const { data: task } = await supabase
    .from("tasks")
    .select("id, title")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!task) return { ok: false, error: "task not found" };

  const push = input.pushToCalendar === true;
  const summary = `Schedule "${(task as { title: string }).title}" on ${dueDate} at ${dueTime} for ${durationMin}min${push ? " and push it to Google Calendar" : ""}.`;
  const proposalId = await recordProposal(
    supabase,
    userId,
    "schedule_task",
    { taskId, dueDate, dueTime, durationMin, pushToCalendar: push },
    summary,
    { source: "assistant", conversationId },
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

async function proposeUpsertGoal(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string | null,
  input: Record<string, unknown>,
): Promise<Result<{ proposalId: string; preview: string }>> {
  const goalId = typeof input.goalId === "string" && input.goalId ? input.goalId : null;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!goalId && !title) return { ok: false, error: "title is required for a new goal" };
  if (input.horizon !== undefined && !["week", "month", "quarter", "year", "life"].includes(String(input.horizon))) {
    return { ok: false, error: "invalid horizon" };
  }
  if (input.status !== undefined && !["active", "done", "paused", "archived"].includes(String(input.status))) {
    return { ok: false, error: "invalid status" };
  }
  if (input.targetDate !== undefined && !DATE_RE.test(String(input.targetDate))) {
    return { ok: false, error: "targetDate must be YYYY-MM-DD" };
  }

  let existingTitle: string | null = null;
  if (goalId) {
    const { data } = await supabase
      .from("goals")
      .select("id, title")
      .eq("id", goalId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return { ok: false, error: "goal not found" };
    existingTitle = (data as { title: string }).title;
  }

  const summary = goalId
    ? `Update goal "${existingTitle}"${input.status ? ` → ${input.status}` : ""}${title ? ` (retitle: "${title}")` : ""}.`
    : `Create goal "${title}"${input.horizon ? ` (${input.horizon})` : ""}${input.targetDate ? ` targeting ${input.targetDate}` : ""}.`;

  const proposalId = await recordProposal(
    supabase,
    userId,
    "upsert_goal",
    {
      goalId,
      title: title || undefined,
      why: typeof input.why === "string" ? input.why : undefined,
      horizon: input.horizon,
      status: input.status,
      targetDate: input.targetDate,
    } as Record<string, unknown>,
    summary,
    { source: "assistant", conversationId },
  );
  return { ok: true, value: { proposalId, preview: summary } };
}

export async function runAssistantTool(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string | null,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const today = todayISO();
  const now = new Date();

  try {
    switch (name) {
      case "get_snapshot": {
        const [dash, tasks, accounts, recurring, items, usages, todayChanges, prefs] =
          await Promise.all([
            getDashboardData(userId, currentMonth()),
            getOpenTasks(userId),
            getAccounts(userId),
            getActiveRecurringExpenses(userId),
            getInventoryItems(userId),
            getInventoryUsages(userId),
            getBalanceChangesOn(userId, today),
            getUserPreferences(userId),
          ]);
        return {
          type: "result",
          content: {
            today,
            finance: financeSnapshot({
              accounts,
              todayChanges,
              recurringExpenses: recurring,
              today,
            }),
            tasks: tasksSnapshot(tasks, today),
            inventory: inventorySnapshot({ items, usages, today }),
            schedule: scheduleSnapshot({
              events: dash.events,
              now,
              wakeStartHour: prefs.wake_start_hour,
              wakeEndHour: prefs.wake_end_hour,
            }),
            freeGaps: freeGaps({
              events: dash.events,
              now,
              wakeStartHour: prefs.wake_start_hour,
              wakeEndHour: prefs.wake_end_hour,
              days: 3,
              limit: 6,
            }),
          },
        };
      }
      case "list_tasks": {
        const tasks = await getOpenTasks(userId);
        return {
          type: "result",
          content: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            dueDate: t.due_date,
            dueTime: t.due_time,
            priority: t.priority,
            group: t.group_name,
          })),
        };
      }
      case "list_accounts_and_categories": {
        const [accountsResult, categoriesResult] = await Promise.all([
          supabase
            .from("accounts")
            .select("id, name, balance, currency")
            .eq("archived", false),
          supabase.from("spending_categories").select("id, name"),
        ]);
        return {
          type: "result",
          content: {
            accounts: accountsResult.data ?? [],
            categories: categoriesResult.data ?? [],
          },
        };
      }
      case "list_goals": {
        const { data } = await supabase
          .from("goals")
          .select("id, title, why, horizon, status, target_date, created_at")
          .order("created_at", { ascending: false });
        return { type: "result", content: data ?? [] };
      }
      case "propose_create_task": {
        const parsed = validateCreateTask(input);
        if (!parsed.ok) return { type: "error", error: parsed.error };
        const dueTime = input.dueTime;
        if (dueTime !== undefined && (typeof dueTime !== "string" || !TIME_RE.test(dueTime))) {
          return { type: "error", error: "dueTime must be HH:MM" };
        }
        const stored = {
          ...(parsed.value as unknown as Record<string, unknown>),
          ...(dueTime ? { dueTime } : {}),
        };
        const summary =
          summarizeCreateTask(parsed.value, null) +
          (dueTime ? ` at ${dueTime}` : "");
        const proposalId = await recordProposal(
          supabase,
          userId,
          "create_task",
          stored,
          summary,
          { source: "assistant", conversationId },
        );
        return { type: "proposal", proposalId, preview: summary };
      }
      case "propose_complete_task": {
        const taskId = input.taskId;
        if (typeof taskId !== "string" || !taskId) {
          return { type: "error", error: "taskId is required" };
        }
        const { data } = await supabase
          .from("tasks")
          .select("id, title, status")
          .eq("id", taskId)
          .eq("user_id", userId)
          .maybeSingle();
        if (!data) return { type: "error", error: "task not found" };
        const task = data as { title: string; status: string };
        if (task.status === "done") {
          return { type: "error", error: `"${task.title}" is already done` };
        }
        const summary = `Mark task "${task.title}" as done.`;
        const proposalId = await recordProposal(
          supabase,
          userId,
          "complete_task",
          { taskId },
          summary,
          { source: "assistant", conversationId },
        );
        return { type: "proposal", proposalId, preview: summary };
      }
      case "propose_schedule_task": {
        const outcome = await proposeScheduleTask(supabase, userId, conversationId, input);
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "list_inventory": {
        const includeArchived = input.includeArchived === true;
        let itemQuery = supabase
          .from("inventory_items")
          .select(
            "id, name, quantity, unit, reorder_threshold, priority, archived, inventory_group_id",
          )
          .order("name", { ascending: true });
        if (!includeArchived) itemQuery = itemQuery.eq("archived", false);
        const [itemsRes, groupsRes] = await Promise.all([
          itemQuery,
          supabase
            .from("inventory_groups")
            .select("id, name")
            .order("name", { ascending: true }),
        ]);
        const groups = (groupsRes.data ?? []) as { id: string; name: string }[];
        const groupNames = new Map(groups.map((g) => [g.id, g.name]));
        type ItemRow = {
          id: string;
          name: string;
          quantity: number;
          unit: string;
          reorder_threshold: number | null;
          priority: "low" | "med" | "high";
          archived: boolean;
          inventory_group_id: string | null;
        };
        return {
          type: "result",
          content: {
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
            groups,
          },
        };
      }
      case "propose_update_stock": {
        const outcome = await proposeUpdateStockFor(supabase, userId, input, {
          source: "assistant",
          conversationId,
        });
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "propose_log_spend": {
        const parsed = validateLogSpend(input);
        if (!parsed.ok) return { type: "error", error: parsed.error };
        const { data: account } = await supabase
          .from("accounts")
          .select("id, name, currency")
          .eq("id", parsed.value.accountId)
          .eq("user_id", userId)
          .maybeSingle();
        if (!account) return { type: "error", error: "account not found" };
        let categoryName: string | null = null;
        if (parsed.value.categoryId) {
          const { data: category } = await supabase
            .from("spending_categories")
            .select("name")
            .eq("id", parsed.value.categoryId)
            .eq("user_id", userId)
            .maybeSingle();
          if (!category) return { type: "error", error: "category not found" };
          categoryName = (category as { name: string }).name;
        }
        const acct = account as { name: string; currency: string };
        const summary = summarizeLogSpend(parsed.value, {
          accountName: acct.name,
          currency: acct.currency,
          categoryName,
        });
        const proposalId = await recordProposal(
          supabase,
          userId,
          "log_spend",
          parsed.value as unknown as Record<string, unknown>,
          summary,
          { source: "assistant", conversationId },
        );
        return { type: "proposal", proposalId, preview: summary };
      }
      case "propose_upsert_goal": {
        const outcome = await proposeUpsertGoal(supabase, userId, conversationId, input);
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "capture_to_brain": {
        const outcome = await captureToBrainFor(supabase, userId, input);
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "result", content: outcome.value };
      }
      default:
        return { type: "error", error: `unknown tool ${name}` };
    }
  } catch (error) {
    return {
      type: "error",
      error: error instanceof Error ? error.message : "tool failed",
    };
  }
}
