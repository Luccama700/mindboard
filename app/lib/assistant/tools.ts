import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";

import { safeTimeZone } from "@/app/_components/date-utils";
import { todayKey } from "@/app/lib/mcp/config";
import {
  getAccounts,
  getActiveRecurringExpenses,
  getBalanceChangesOn,
} from "@/app/lib/data/finance";
import { getInventoryItems, getInventoryUsages } from "@/app/lib/data/inventory";
import { getDashboardData, getOpenTasks } from "@/app/lib/data/dashboard";
import { getUserPreferences } from "@/app/lib/data/settings";
import { financeSnapshot } from "@/app/lib/snapshots/finance";
import { inventorySnapshot } from "@/app/lib/snapshots/inventory";
import { tasksSnapshot } from "@/app/lib/snapshots/tasks";
import { freeGaps, scheduleSnapshot } from "@/app/lib/snapshots/schedule";
import { buildPlanningSnapshot } from "@/app/lib/snapshots/planning-read";
import { recordProposal } from "@/app/lib/mcp/audit";
import {
  proposeArchiveRecurringTaskFor,
  proposeCreateRecurringTaskFor,
  proposeDeleteSpendLimitFor,
  proposeSetSpendLimitFor,
  proposePeopleUpdateFor,
  proposeUpdateFinanceFor,
  proposeUpdateStockFor,
  proposeUpsertGoalFor,
  spendLimitWarningBlock,
} from "@/app/lib/mcp/writes";
import {
  buildSpendLimitStatus,
  getPersonFor,
  listPeopleFor,
} from "@/app/lib/mcp/reads";
import { queueReel } from "@/app/lib/mcp/reels";
import { lookupPricesByRefs } from "@/app/lib/shopping/price-lookup";
import {
  buildShoppingList,
  shoppingTotal,
  type ShoppingListItem,
} from "@/app/_components/shopping-list";
import type { UsageRule } from "@/app/_components/inventory-projection";
import { getActiveRecurringTasks } from "@/app/lib/data/recurring-tasks";
import { formatRecurrence } from "@/app/lib/recurrence";
import { captureToBrainFor } from "@/app/lib/mcp/brain";
import {
  appendSourcePartFor,
  beginSourceUploadFor,
  finalizeSourceFor,
  listCoursesFor,
} from "@/app/lib/mcp/courses";
import { proposeGenerateAudioOverviewFor } from "@/app/lib/learn/episodes";
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
      "Read the live cross-domain snapshot: finance (net worth, today delta, next bill), tasks (overdue/due today/due soon counts), inventory (low/out), schedule (next event, free hours today), and the next free time gaps. Call this first in almost every conversation. For planning across days, pass horizonDays (1–60) or verbose:true to expand into a full horizon read: per-day timed events, time-blocks and recurring occurrences with free gaps + free-hours-before-5pm and committed load; every open task with due time/duration and scheduled flag; upcoming bills and projected net worth per day; inventory run-out estimates; and your recent check-in trend and active goals. Times are in your local timezone with explicit ISO offsets. Omit both for the lean default.",
    input_schema: {
      type: "object",
      properties: {
        horizonDays: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "Days ahead to expand the planning read (default 7 when verbose).",
        },
        verbose: {
          type: "boolean",
          description: "Expand into the full horizon planning read (default false).",
        },
      },
      additionalProperties: false,
    },
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
      "List money accounts (id, name, balance, currency), spending categories (id, name), and recurring-expense rules (id, name, amount, schedule). Needed before propose_log_spend or propose_update_finance.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_recent_ledger",
    description:
      "The most recent transactions (spending, income, transfers) with row ids, newest first. The ids feed propose_update_finance's adjust/remove ops; the notes help judge whether a flagged duplicate is really the same purchase.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "spend_limit_status",
    description:
      "Every active spending limit (budget cap) with actual spend this period vs the cap: limitId, label, scope, period, amount, spent, remaining, pctUsed, and state ('under' | 'approaching' at >=80% | 'over'). Spend uses the everyday-spend rules (out-flows only; transfers and recurring bills excluded; category scope respected). Use limitId for propose_delete_spend_limit.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_goals",
    description: "List the user's goals (id, title, why, horizon, status, target date).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_task_groups",
    description:
      "List the user's task groups (id, name, type). Use the ids for propose_create_task's groupId.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_create_task",
    description:
      "Propose creating a task. Returns a proposal the user must confirm — never assume it ran. Sort as you add: call list_task_groups and set groupId to the group that clearly fits the task's content; only leave it out (inbox) when nothing fits.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        groupId: {
          type: "string",
          description: "group id from list_task_groups; omit for inbox",
        },
        dueDate: { type: "string", description: "YYYY-MM-DD" },
        dueTime: { type: "string", description: "HH:MM 24h, optional" },
        priority: { type: "string", enum: ["low", "med", "high"] },
        notes: { type: "string" },
        estimatedMinutes: {
          type: "integer",
          minimum: 1,
          description: "expected effort in minutes",
        },
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
    name: "propose_miss_task",
    description:
      "Propose marking an overdue/open task as missed (incomplete) — an accountability record, distinct from done. User must confirm.",
    input_schema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recurring_tasks",
    description:
      "List repeating-task rules (id, title, schedule, time, group). Use the id for propose_archive_recurring_task.",
    input_schema: {
      type: "object",
      properties: { includeArchived: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "propose_create_recurring_task",
    description:
      "Propose a repeating task rule for habits like 'lunch every day 12:30' or 'gym mon/wed/fri at 5pm' — do NOT create N individual tasks for a recurring ask. Occurrences appear automatically; missed days skip silently. weekly needs weekdays (0=sun … 6=sat, several allowed); monthly needs dayOfMonth; custom needs intervalDays. dueTime makes it a calendar block that counts against free time; durationMin is independent — set it on an untimed routine and the planner uses it to auto-place the chore into a free gap. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        groupId: { type: "string" },
        notes: { type: "string" },
        priority: { type: "string", enum: ["low", "med", "high"] },
        frequency: {
          type: "string",
          enum: ["daily", "weekly", "monthly", "custom"],
        },
        weekdays: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 6 },
          description: "For weekly: 0=sun … 6=sat, several allowed.",
        },
        dayOfMonth: { type: "integer", minimum: 1, maximum: 31 },
        intervalDays: { type: "integer", minimum: 1 },
        startDate: { type: "string", description: "YYYY-MM-DD, for custom" },
        dueTime: { type: "string", description: "HH:MM 24h, optional" },
        durationMin: { type: "integer", minimum: 15 },
      },
      required: ["title", "frequency"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_archive_recurring_task",
    description:
      "Propose stopping a repeating task rule (by id; completion history is kept). User must confirm.",
    input_schema: {
      type: "object",
      properties: { ruleId: { type: "string" } },
      required: ["ruleId"],
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
      "List inventory items (id, name, quantity, unit, group, archived, shoppingPinned, estPrice) plus inventory groups. Use it to find item ids/names before propose_update_stock. Pass includeArchived to also see untracked items (needed before a restore op).",
    input_schema: {
      type: "object",
      properties: { includeArchived: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "list_people",
    description:
      "The people roster: id, name, vault note path, aliases, check-in cadence, archived flag, how many interactions are logged, and when the user last TALKED to them (date + precision + daysSince, or null when nothing is logged). Metadata only — no note bodies, no interaction summaries. Use it to find person ids/names before propose_update_people or get_person; pass includeArchived to also see untracked people (needed before a restore op). 'Last talked' counts logged conversations ONLY: editing someone's note is being informed, not being in touch, and never advances it.",
    input_schema: {
      type: "object",
      properties: { includeArchived: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "get_person",
    description:
      "One person's dossier: their row, the intro line and OPEN LOOPS pulled from their vault note's `## Open questions` section, their recent logged interactions (newest first, capped), and when the note was last updated. `person` accepts an id or a name (case-insensitive; unique substrings work). Open loops are what make a suggestion concrete — 'you owe Denise an update on his writing practice' rather than 'follow up with Davi'. Does NOT return the full note body (use read_brain_note) and carries no mindspace mention snippets. A missing or unreachable vault yields empty loops rather than an error.",
    input_schema: {
      type: "object",
      properties: { person: { type: "string" } },
      required: ["person"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_update_people",
    description:
      "Propose a batch of people edits in one confirmable receipt: log_interaction (record that the user TALKED to someone), create_person (someone with no vault note yet), set_checkin (how often they want to be in touch, in days; null clears it — there are no default cadences), archive (stop tracking), restore (track again). A create_person earlier in the batch can be logged against or given a cadence by name in the SAME batch. `person` accepts an id or a name (case-insensitive; unique substrings work — ambiguity fails with candidates; get ids from list_people). User must confirm.\n\nlog_interaction records that CONTACT HAPPENED — only ever when the user says so. Talking ABOUT someone is not talking TO them, and a wrong 'you talked to X on Y' is the one error this feature cannot afford, so never infer contact from a mention, a calendar entry, or a note edit. `summary` records what the USER did or said (\"coffee, he's writing again\"), never an inference about the other person's state or wellbeing — write it as though they might read it. Omit `date` for today (resolved in the user's timezone when they confirm). If the user was vague (\"last month\"), give your best-guess date AND set approx:true so the app says \"about a month ago\" instead of inventing a specific day.",
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
                  "log_interaction",
                  "create_person",
                  "set_checkin",
                  "archive",
                  "restore",
                ],
              },
              person: {
                type: "string",
                description:
                  "Person id or name (every op except create_person).",
              },
              name: {
                type: "string",
                description: "New person's name (create_person).",
              },
              summary: {
                type: "string",
                description:
                  "What the user did or said, one line (log_interaction; optional). Never a characterisation of the other person.",
              },
              date: {
                type: "string",
                description:
                  "Day the conversation happened, YYYY-MM-DD (log_interaction). Omit for today.",
              },
              approx: {
                type: "boolean",
                description:
                  "Set with a best-guess date when the user was vague about when. Requires an explicit date.",
              },
              days: {
                type: ["number", "null"],
                description:
                  "Check-in cadence in days (set_checkin; null clears it).",
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
    name: "shopping_list",
    description:
      "The derived shopping list: items that are out, at/below their reorder threshold, projected to run out within ~7 days, or manually pinned — each with a reason, estimated price, and the projected total. Manage it via propose_update_stock ops pin_shopping / unpin_shopping / set_price; fetch missing prices with lookup_prices.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "lookup_prices",
    description:
      "Look up current prices for shopping-list items at the user's configured grocery store (one web-search Claude call per item on the user's stored Anthropic key — cents per item, max 10 per call). With no items given, targets the shopping list's unpriced entries. items accepts ids or names. force re-fetches AI-sourced prices; manually-set prices are never overwritten. Applies immediately (prices are editable cache metadata, not a confirmable write).",
    input_schema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, maxItems: 10 },
        force: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "propose_update_stock",
    description:
      "Propose a batch of inventory edits in one confirmable receipt: add (got more), remove (used some), set (recount), create (new item; optional price), archive (stop tracking), restore (track again), set_priority (how loudly it nags: high surfaces on home when merely low, med only when out, low never), set_threshold (reorder level; null clears), set_usage (consumption rate driving the depletion forecast — replaces existing rules; period day/week/custom, custom needs intervalDays), clear_usage, rename, move (to a group; omit group for none), create_group (usable by later ops in the same batch), pin_shopping (keep an item on the shopping list; optional price if you already know it), unpin_shopping, set_price (expected TOTAL cost of the planned purchase; null clears — stored as a manual price AI lookups never overwrite), set_buy (planned purchase amount in the item's own unit; null clears — a stale AI price refreshes automatically after confirm). A create earlier in the batch can be pinned by name in the same batch; items pinned without a price get an automatic AI price lookup after confirm. `item` accepts an id or a name (case-insensitive; unique substrings work — ambiguity fails with candidates). Batch a whole grocery haul into ONE call. User must confirm.",
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
                ],
              },
              item: {
                type: "string",
                description:
                  "Item id or name (every op except create/create_group).",
              },
              amount: {
                type: "number",
                exclusiveMinimum: 0,
                description:
                  "How much was gained/used (add/remove), or consumed per period (set_usage).",
              },
              quantity: {
                type: "number",
                minimum: 0,
                description: "Absolute count (for set/create).",
              },
              name: {
                type: "string",
                description:
                  "New name (create/create_group), or the new item name (rename).",
              },
              unit: { type: "string", description: 'Optional unit for create, e.g. "rolls".' },
              group: {
                type: "string",
                description:
                  "Inventory group id or name (create/move; omit on move to ungroup).",
              },
              priority: {
                type: "string",
                enum: ["low", "med", "high"],
                description: "Attention priority (for set_priority).",
              },
              threshold: {
                type: ["number", "null"],
                description: "Reorder level (set_threshold); null clears it.",
              },
              period: {
                type: "string",
                enum: ["day", "week", "custom"],
                description: "Usage cadence (set_usage).",
              },
              intervalDays: {
                type: "integer",
                minimum: 1,
                description: "Every N days, for period=custom (set_usage).",
              },
              price: {
                type: ["number", "null"],
                description:
                  "Estimated TOTAL cost of the item's planned purchase (create/pin_shopping optional; set_price required, null clears).",
              },
              buyAmount: {
                type: ["number", "null"],
                description:
                  "How much the user plans to buy, in the item's own unit (pin_shopping optional; set_buy required, null clears). Prices then cover the whole planned purchase — packs don't map 1:1 to units, so it's not price × amount.",
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
      "Propose logging a single spend against an account today (and optional category). For anything dated, batched, or statement-shaped use propose_update_finance instead. Finance writes only ever propose. User must confirm.",
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
    name: "propose_set_spend_limit",
    description:
      "Propose creating or updating a budget cap the app tracks actual spend against (distinct from the forecast's daily-spend estimate). scope 'overall' caps all discretionary spend; scope 'category' caps one category (pass its categoryId from list_accounts_and_categories). period is daily, weekly (Mon-Sun), or monthly (calendar month). Only one overall limit and one per category exist — setting again updates the existing one. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["overall", "category"] },
        categoryId: {
          type: "string",
          description: "Required when scope is 'category'.",
        },
        period: { type: "string", enum: ["daily", "weekly", "monthly"] },
        amount: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["scope", "period", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_delete_spend_limit",
    description:
      "Propose removing a spending limit (budget cap). Find limitId via spend_limit_status. User must confirm.",
    input_schema: {
      type: "object",
      properties: { limitId: { type: "string" } },
      required: ["limitId"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_update_finance",
    description:
      "Propose a batch of finance edits in one confirmable receipt — the statement-import tool. Ops: spend (dated, categorized outflow), income (dated inflow), transfer (between two accounts, e.g. a credit-card payment — never a spend), reconcile (assert an account's ending balance as of a date; put it last), create_category (when nothing fits), create_recurring (a repeated charge not yet tracked), adjust/remove (fix or delete a row by id from list_recent_ledger). Accounts/categories accept an id or name (unique substrings work). Duplicates (same account+date+direction+amount as an existing row) are skipped and shown in the receipt; set force:true after checking the notes differ. Credit accounts store owed as a NEGATIVE balance: card purchases are spends, card payments are transfers. Read list_accounts_and_categories and list_recent_ledger first; batch everything into ONE call. User must confirm.",
    input_schema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 60,
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "spend",
                  "income",
                  "transfer",
                  "reconcile",
                  "create_category",
                  "create_recurring",
                  "adjust",
                  "remove",
                ],
              },
              account: {
                type: "string",
                description: "Account id or name (spend/income/reconcile).",
              },
              amount: {
                type: "number",
                exclusiveMinimum: 0,
                description:
                  "Positive amount (spend/income/transfer/create_recurring/adjust).",
              },
              date: {
                type: "string",
                description:
                  "YYYY-MM-DD the transaction happened (spend/income/transfer/adjust).",
              },
              category: {
                type: "string",
                description:
                  "Category id or name (spend/create_recurring/adjust); may name a create_category earlier in this batch.",
              },
              note: { type: "string", description: "Merchant / description." },
              force: {
                type: "boolean",
                description:
                  "Import a spend/income even though it matches an existing row.",
              },
              from: { type: "string", description: "Source account (transfer)." },
              to: { type: "string", description: "Destination account (transfer)." },
              balance: {
                type: "number",
                description:
                  "Ending balance (reconcile); negative for credit accounts.",
              },
              asOf: {
                type: "string",
                description:
                  "YYYY-MM-DD the balance was true, e.g. the statement end date (reconcile).",
              },
              name: {
                type: "string",
                description:
                  "New category or recurring-expense name (create_category/create_recurring).",
              },
              color: { type: "string", description: "Optional #rrggbb for create_category." },
              frequency: {
                type: "string",
                enum: ["monthly", "weekly", "daily", "custom"],
                description: "create_recurring cadence.",
              },
              dayOfMonth: { type: "integer", minimum: 1, maximum: 31 },
              weekday: { type: "integer", minimum: 0, maximum: 6 },
              intervalDays: { type: "integer", minimum: 1, maximum: 366 },
              startDate: { type: "string" },
              changeId: {
                type: "string",
                description: "Ledger row id from list_recent_ledger (adjust/remove).",
              },
              markTransfer: {
                type: "boolean",
                description:
                  "adjust only: true reclassifies the row as a transfer between own accounts (excluded from spending analytics), false back to regular spending.",
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
    name: "process_reel",
    description:
      "Queue an Instagram reel the user saved into their second brain for the home worker to download, transcribe, and describe/OCR — the record lands as a new Reels/ note. Pass notePath (a vault note whose body holds the reel link) or a direct Instagram url. Requires the home worker. Executes immediately (queues a job; no confirm).",
    input_schema: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Vault note path holding the reel link." },
        url: { type: "string", description: "Instagram reel/post URL, if not via a note." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_courses",
    description:
      "List the user's courses (/learn) with their sources and conversion status. Use before uploading course markdown.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "begin_source_upload",
    description:
      "Start uploading a course document's markdown into the second brain. Pass course (name or id) + title for a new source, OR source_id to fill an existing uploaded PDF's markdown. Executes immediately (no confirm): the vault write is create-only under Courses/. Follow with append_source_markdown parts, then finalize_source.",
    input_schema: {
      type: "object",
      properties: {
        course: { type: "string", description: "Course name or id (new source)." },
        source_id: {
          type: "string",
          description: "Existing source id to transcribe into.",
        },
        title: { type: "string", maxLength: 200 },
        page_count: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "append_source_markdown",
    description:
      "Append one sequential part (part_index 1, 2, …; ≤20000 chars) of the verbatim markdown transcription: GitHub-flavored markdown, $…$/$$…$$ LaTeX, markdown tables, <!-- p.N --> before each page. Never summarize or skip content.",
    input_schema: {
      type: "object",
      properties: {
        source_id: { type: "string" },
        part_index: { type: "integer", minimum: 1, maximum: 60 },
        markdown: { type: "string", maxLength: 20000 },
      },
      required: ["source_id", "part_index", "markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "finalize_source",
    description:
      "Assemble the uploaded parts and commit the markdown to the vault under Courses/<course>/Sources/. Fails if parts are non-contiguous. Returns the vault path.",
    input_schema: {
      type: "object",
      properties: { source_id: { type: "string" } },
      required: ["source_id"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_generate_audio_overview",
    description:
      "Propose generating a podcast episode (audio overview) from a course's converted sources. Spends API credits, so the user must confirm; generation takes a couple of minutes. flavor: deep-dive (default, two hosts), brief, debate, or solo (single narrator).",
    input_schema: {
      type: "object",
      properties: {
        course: { type: "string", description: "Course name or id." },
        source_ids: { type: "array", items: { type: "string" } },
        flavor: {
          type: "string",
          enum: ["deep-dive", "brief", "debate", "solo"],
        },
        engine: { type: "string", enum: ["gemini", "vibevoice"] },
      },
      required: ["course"],
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
  const { data: task } = await supabase
    .from("tasks")
    .select("id, title, estimated_minutes")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!task) return { ok: false, error: "task not found" };

  const estimate = (task as { estimated_minutes: number | null }).estimated_minutes;
  const durationMin =
    input.durationMin === undefined
      ? (estimate ?? 30)
      : Number(input.durationMin);
  if (!Number.isFinite(durationMin) || durationMin < 15) {
    return { ok: false, error: "durationMin must be >= 15" };
  }

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

export async function runAssistantTool(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string | null,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  // Must be the user's local date, not the process clock (UTC on Vercel) —
  // otherwise every evening west of UTC the assistant reports tomorrow: today's
  // tasks read as overdue, today's spend reads as $0, and spend limits check an
  // empty window. Same resolution the MCP twin uses, so both agree with /.
  const today = await todayKey(supabase, userId);
  const now = new Date();

  try {
    switch (name) {
      case "get_snapshot": {
        // Expanded horizon read when the caller asks for it; the bare call keeps
        // the lean, fast default shape.
        const horizonProvided = typeof input.horizonDays === "number";
        if (horizonProvided || input.verbose === true) {
          const horizonDays = horizonProvided ? Number(input.horizonDays) : 7;
          const snapshot = await buildPlanningSnapshot({
            supabase,
            userId,
            horizonDays,
          });
          return { type: "result", content: snapshot };
        }
        const [dash, tasks, accounts, recurring, items, usages, todayChanges, prefs] =
          await Promise.all([
            getDashboardData(userId, today.slice(0, 7)),
            getOpenTasks(userId),
            getAccounts(userId),
            getActiveRecurringExpenses(userId),
            getInventoryItems(userId),
            getInventoryUsages(userId),
            getBalanceChangesOn(userId, today),
            getUserPreferences(userId),
          ]);
        // The wake-window/free-time math must run in the user's zone — the
        // process clock is UTC on Vercel. `prefs.timezone` is already loaded, so
        // this corrects the free-hours values without changing the shape.
        const timeZone = safeTimeZone(prefs.timezone);
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
              timeZone,
            }),
            freeGaps: freeGaps({
              events: dash.events,
              now,
              wakeStartHour: prefs.wake_start_hour,
              wakeEndHour: prefs.wake_end_hour,
              days: 3,
              limit: 6,
              timeZone,
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
            estimatedMinutes: t.estimated_minutes,
          })),
        };
      }
      case "list_task_groups": {
        const { data } = await supabase
          .from("groups")
          .select("id, name, type")
          .eq("archived", false)
          .order("created_at", { ascending: true });
        return { type: "result", content: data ?? [] };
      }
      case "list_accounts_and_categories": {
        const [accountsResult, categoriesResult, recurringResult] =
          await Promise.all([
            supabase
              .from("accounts")
              .select("id, name, type, balance, currency")
              .eq("archived", false),
            supabase.from("spending_categories").select("id, name").eq("archived", false),
            supabase
              .from("recurring_expenses")
              .select("id, name, amount, frequency, day_of_month, weekday, interval_days, start_date")
              .eq("archived", false),
          ]);
        return {
          type: "result",
          content: {
            accounts: accountsResult.data ?? [],
            categories: categoriesResult.data ?? [],
            recurringExpenses: recurringResult.data ?? [],
          },
        };
      }
      case "list_recent_ledger": {
        const limit = Math.min(Math.max(1, Number(input.limit) || 20), 100);
        const { data } = await supabase
          .from("balance_changes")
          .select(
            "id, account_id, direction, amount, note, occurred_at, is_transfer, spending_categories(name), accounts(name, currency)",
          )
          .order("occurred_at", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(limit);
        type Rel<T> = T | T[] | null;
        const first = <T,>(rel: Rel<T>): T | null =>
          Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);
        type Row = {
          id: string;
          direction: "in" | "out";
          amount: number;
          note: string | null;
          occurred_at: string;
          is_transfer: boolean;
          spending_categories: Rel<{ name: string }>;
          accounts: Rel<{ name: string; currency: string }>;
        };
        return {
          type: "result",
          content: ((data ?? []) as unknown as Row[]).map((row) => ({
            id: row.id,
            direction: row.direction,
            amount: Number(row.amount),
            note: row.note,
            occurredAt: row.occurred_at,
            isTransfer: row.is_transfer,
            account: first(row.accounts)?.name ?? "account",
            category:
              row.direction === "out"
                ? (first(row.spending_categories)?.name ?? "uncategorized")
                : null,
          })),
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
        let groupName: string | null = null;
        if (parsed.value.groupId) {
          const { data } = await supabase
            .from("groups")
            .select("name")
            .eq("id", parsed.value.groupId)
            .maybeSingle();
          if (!data) return { type: "error", error: "group not found" };
          groupName = (data as { name: string }).name;
        }
        const stored = {
          ...(parsed.value as unknown as Record<string, unknown>),
          ...(dueTime ? { dueTime } : {}),
        };
        const summary =
          summarizeCreateTask(parsed.value, groupName) +
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
      case "propose_miss_task": {
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
        if (task.status === "missed") {
          return { type: "error", error: `"${task.title}" is already missed` };
        }
        const summary = `Mark task "${task.title}" as missed.`;
        const proposalId = await recordProposal(
          supabase,
          userId,
          "miss_task",
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
            "id, name, quantity, unit, reorder_threshold, priority, archived, inventory_group_id, shopping_pinned, buy_amount, est_price, price_source",
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
          shopping_pinned: boolean;
          buy_amount: number | null;
          est_price: number | null;
          price_source: "ai" | "manual" | null;
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
              shoppingPinned: row.shopping_pinned,
              buyAmount: row.buy_amount === null ? null : Number(row.buy_amount),
              estPrice: row.est_price === null ? null : Number(row.est_price),
              priceSource: row.price_source,
              group: row.inventory_group_id
                ? (groupNames.get(row.inventory_group_id) ?? null)
                : null,
            })),
            groups,
          },
        };
      }
      case "shopping_list": {
        const [itemsRes, usagesRes, settingsRes] = await Promise.all([
          supabase
            .from("inventory_items")
            .select(
              "id, name, quantity, unit, reorder_threshold, archived, shopping_pinned, buy_amount, est_price, price_source",
            )
            .eq("archived", false),
          supabase
            .from("inventory_usages")
            .select("inventory_item_id, amount, period, interval_days"),
          supabase
            .from("user_settings")
            .select("shopping_store, shopping_day")
            .eq("user_id", userId)
            .maybeSingle(),
        ]);
        const rulesByItem = new Map<string, UsageRule[]>();
        for (const row of (usagesRes.data ?? []) as (UsageRule & {
          inventory_item_id: string;
        })[]) {
          const rules = rulesByItem.get(row.inventory_item_id) ?? [];
          rules.push(row);
          rulesByItem.set(row.inventory_item_id, rules);
        }
        const entries = buildShoppingList({
          items: (itemsRes.data ?? []) as ShoppingListItem[],
          rulesByItem,
          today,
        });
        return {
          type: "result",
          content: {
            today,
            store: (settingsRes.data?.shopping_store as string | null) ?? null,
            shoppingDay:
              typeof settingsRes.data?.shopping_day === "number"
                ? settingsRes.data.shopping_day
                : null,
            ...shoppingTotal(entries),
            entries,
          },
        };
      }
      case "lookup_prices": {
        const outcome = await lookupPricesByRefs({
          supabase,
          userId,
          items: Array.isArray(input.items)
            ? (input.items as string[])
            : undefined,
          force: input.force === true,
        });
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "result", content: { results: outcome.results } };
      }
      case "list_recurring_tasks": {
        const rules = await getActiveRecurringTasks(userId);
        return {
          type: "result",
          content: {
            rules: rules.map((r) => ({
              id: r.id,
              title: r.title,
              schedule: formatRecurrence(r),
              dueTime: r.due_time ? r.due_time.slice(0, 5) : null,
              durationMin: r.duration_min,
              priority: r.priority,
              group: r.group_name,
            })),
          },
        };
      }
      case "propose_create_recurring_task": {
        const outcome = await proposeCreateRecurringTaskFor(
          supabase,
          userId,
          input,
          { source: "assistant", conversationId },
        );
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "propose_archive_recurring_task": {
        const outcome = await proposeArchiveRecurringTaskFor(
          supabase,
          userId,
          input,
          { source: "assistant", conversationId },
        );
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "propose_update_stock": {
        const outcome = await proposeUpdateStockFor(supabase, userId, input, {
          source: "assistant",
          conversationId,
        });
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      // The three People tools reuse the MCP reads/writes directly with the
      // SESSION client, so RLS scopes them and one implementation serves both
      // surfaces (docs/people-plan.md §10 M2).
      case "list_people": {
        return {
          type: "result",
          content: await listPeopleFor(supabase, userId, {
            includeArchived: input.includeArchived === true,
          }),
        };
      }
      case "get_person": {
        return {
          type: "result",
          content: await getPersonFor(supabase, userId, input),
        };
      }
      case "propose_update_people": {
        const outcome = await proposePeopleUpdateFor(supabase, userId, input, {
          source: "assistant",
          conversationId,
        });
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "propose_update_finance": {
        const outcome = await proposeUpdateFinanceFor(supabase, userId, input, {
          source: "assistant",
          conversationId,
        });
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "spend_limit_status": {
        return {
          type: "result",
          content: await buildSpendLimitStatus(supabase, userId),
        };
      }
      case "propose_set_spend_limit": {
        const outcome = await proposeSetSpendLimitFor(supabase, userId, input, {
          source: "assistant",
          conversationId,
        });
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "propose_delete_spend_limit": {
        const outcome = await proposeDeleteSpendLimitFor(
          supabase,
          userId,
          input,
          { source: "assistant", conversationId },
        );
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
        const warningBlock = await spendLimitWarningBlock(supabase, userId, [
          {
            amount: parsed.value.amount,
            categoryId: parsed.value.categoryId,
            dateKey: today,
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
          userId,
          "log_spend",
          parsed.value as unknown as Record<string, unknown>,
          summary,
          { source: "assistant", conversationId },
        );
        return { type: "proposal", proposalId, preview: summary };
      }
      case "propose_upsert_goal": {
        const outcome = await proposeUpsertGoalFor(supabase, userId, input, {
          source: "assistant",
          conversationId,
        });
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
      }
      case "capture_to_brain": {
        const outcome = await captureToBrainFor(supabase, userId, input);
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "result", content: outcome.value };
      }
      case "process_reel": {
        const outcome = await queueReel(userId, input as { notePath?: string; url?: string });
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "result", content: outcome.value };
      }
      case "list_courses": {
        const outcome = await listCoursesFor(supabase, userId);
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "result", content: outcome.value };
      }
      case "begin_source_upload": {
        const outcome = await beginSourceUploadFor(supabase, userId, input);
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "result", content: outcome.value };
      }
      case "append_source_markdown": {
        const outcome = await appendSourcePartFor(supabase, userId, input);
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "result", content: outcome.value };
      }
      case "finalize_source": {
        const outcome = await finalizeSourceFor(
          supabase,
          userId,
          input,
          "assistant",
        );
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "result", content: outcome.value };
      }
      case "propose_generate_audio_overview": {
        const outcome = await proposeGenerateAudioOverviewFor(
          supabase,
          userId,
          input,
          { source: "assistant", conversationId },
        );
        if (!outcome.ok) return { type: "error", error: outcome.error };
        return { type: "proposal", ...outcome.value };
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
