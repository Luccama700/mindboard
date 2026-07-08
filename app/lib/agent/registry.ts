// Agent tool registry — the single seam between Mindboard's data and any AI
// surface. This is the catalog of capabilities (name, kind, description, input
// schema) that later phases consume in three places without redefining them:
//   1. the in-app assistant (Messages API tool defs),
//   2. a remote MCP server (same tools, different transport),
//   3. the proactive "next best step" planner.
//
// Phase 0 deliberately ships only the catalog. Live `handler`/`preview`
// functions are wired in Phase 2, when there is an agent loop to call them; the
// existing server actions in app/actions/* and reads in app/lib/data + the
// snapshots in app/lib/snapshots are the implementations they will bind to.
//
// `confirm: true` encodes the agreed autonomy stance — write tools must be
// surfaced to the user for explicit approval before they run, and every run is
// expected to land in an ai_audit_log (Phase 2).

export type ToolKind = "read" | "write";

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
};

export type ToolDescriptor = {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: ToolInputSchema;
  // The module + export this tool will bind to when wired in Phase 2.
  mapsTo: string;
  // Write tools that require explicit user confirmation before executing.
  confirm?: boolean;
};

const EMPTY_INPUT: ToolInputSchema = { type: "object", properties: {} };

export const toolRegistry: ToolDescriptor[] = [
  // ---------- reads (life snapshots) ----------
  {
    name: "life.financeSnapshot",
    kind: "read",
    description:
      "Net worth, today's net change, and the next upcoming recurring bill.",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/snapshots/finance#financeSnapshot",
  },
  {
    name: "life.tasksSnapshot",
    kind: "read",
    description: "Counts of open tasks that are overdue, due today, or due this week.",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/snapshots/tasks#tasksSnapshot",
  },
  {
    name: "life.inventorySnapshot",
    kind: "read",
    description:
      "How many stock items are low or out, and the item projected to run out soonest.",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/snapshots/inventory#inventorySnapshot",
  },
  {
    name: "life.scheduleSnapshot",
    kind: "read",
    description: "The next timed calendar event and how many waking hours are free today.",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/snapshots/schedule#scheduleSnapshot",
  },

  // ---------- writes (cataloged; wired with confirm + audit in Phase 2) ----------
  {
    name: "tasks.create",
    kind: "write",
    description: "Capture a new task with an optional group, due date, and notes.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title." },
        groupId: { type: "string", description: "Target group id, or null for inbox." },
        dueDate: { type: "string", description: "Due date YYYY-MM-DD, or null." },
        notes: { type: "string", description: "Optional Markdown notes." },
      },
      required: ["title"],
    },
    mapsTo: "app/actions/tasks#createTask",
    confirm: true,
  },
  {
    name: "tasks.update",
    kind: "write",
    description:
      "Edit a task: title, due date/time-block, duration, group, notes, priority; optionally push it to Google Calendar.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id." },
        title: { type: "string" },
        dueDate: { type: "string" },
        dueTime: { type: "string" },
        durationMin: { type: "number" },
        groupId: { type: "string" },
        notes: { type: "string" },
        priority: { type: "string" },
        pushToCalendar: { type: "boolean" },
      },
      required: ["taskId"],
    },
    mapsTo: "app/lib/mcp/writes#proposeUpdateTask",
    confirm: true,
  },
  {
    name: "tasks.delete",
    kind: "write",
    description: "Permanently delete a task (for mistakes/duplicates — completion is tasks.complete).",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task id." } },
      required: ["taskId"],
    },
    mapsTo: "app/lib/mcp/writes#proposeDeleteTask",
    confirm: true,
  },
  {
    name: "tasks.complete",
    kind: "write",
    description: "Toggle a task's done status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id." },
        currentStatus: { type: "string", description: "Current status." },
      },
      required: ["id", "currentStatus"],
    },
    mapsTo: "app/actions/tasks#toggleTaskStatus",
    confirm: true,
  },
  {
    name: "tasks.recurring.list",
    kind: "read",
    description:
      "List repeating-task rules (schedule, time, group). Occurrences generate automatically.",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/mcp/reads#listRecurringTasks",
  },
  {
    name: "tasks.recurring.create",
    kind: "write",
    description:
      "Create a repeating task rule (daily / weekly with multiple weekdays / monthly / every N days), optionally time-blocked.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Rule title, e.g. \"gym\"." },
        frequency: { type: "string", description: "daily | weekly | monthly | custom." },
        weekdays: { type: "array", description: "Weekly: 0 (sun) – 6 (sat)." },
        dayOfMonth: { type: "number", description: "Monthly: 1–31." },
        intervalDays: { type: "number", description: "Custom: every N days." },
        dueTime: { type: "string", description: "HH:MM, makes it a calendar block." },
        durationMin: { type: "number" },
        groupId: { type: "string" },
      },
      required: ["title", "frequency"],
    },
    mapsTo: "app/lib/mcp/writes#proposeCreateRecurringTask",
    confirm: true,
  },
  {
    name: "tasks.recurring.archive",
    kind: "write",
    description: "Stop a repeating task rule (archives it; completion history is kept).",
    inputSchema: {
      type: "object",
      properties: { ruleId: { type: "string", description: "Rule id." } },
      required: ["ruleId"],
    },
    mapsTo: "app/lib/mcp/writes#proposeArchiveRecurringTask",
    confirm: true,
  },
  {
    name: "finance.recordSpend",
    kind: "write",
    description:
      "Record a new balance for an account; a decrease is categorized spending, an increase is income.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account id." },
        newBalance: { type: "string", description: "The account's new balance." },
        categoryId: { type: "string", description: "Spending category id for a decrease." },
        note: { type: "string" },
      },
      required: ["accountId", "newBalance"],
    },
    mapsTo: "app/actions/finance#recordBalanceChange",
    confirm: true,
  },
  {
    name: "finance.recurring.list",
    kind: "read",
    description:
      "List recurring-expense rules (id, name, amount, schedule) — checked before proposing a new one during import.",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/mcp/reads#listRecurringExpenses",
  },
  {
    name: "finance.import",
    kind: "write",
    description:
      "Batched finance update in one confirmable receipt (the statement-import tool): dated spends/incomes/transfers with duplicate skipping, an ending-balance reconcile, category and recurring-expense creates, and row-level corrections.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description:
            "spend / income / transfer / reconcile / create_category / create_recurring / adjust / remove ops; accounts and categories by id or name.",
        },
      },
      required: ["operations"],
    },
    mapsTo: "app/lib/mcp/writes#proposeUpdateFinance",
    confirm: true,
  },
  {
    name: "finance.manage",
    kind: "write",
    description:
      "Batched finance CONFIGURATION edits in one confirmable receipt: accounts (create/update/archive), categories, recurring-expense rules, income sources, per-day spend overrides, and the manual daily-spend estimate.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description:
            "create_account / update_account / update_category / update_recurring / create_income / update_income / set_spend_override / set_daily_spend_estimate ops; references by id or name.",
        },
      },
      required: ["operations"],
    },
    mapsTo: "app/lib/mcp/writes#proposeManageFinance",
    confirm: true,
  },
  {
    name: "finance.forecast",
    kind: "read",
    description:
      "Projected end-of-day net worth for the next N days: wage income, recurring bills, and the everyday-spend estimate layer.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "1-90, default 30." } },
    },
    mapsTo: "app/lib/mcp/reads#getFinanceForecast",
  },
  {
    name: "finance.income.list",
    kind: "read",
    description: "List wage income sources (rate, tax, linked shift calendar, pay schedule).",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/mcp/reads#listIncomeSources",
  },
  {
    name: "calendar.listEvents",
    kind: "read",
    description:
      "Google Calendar events in a date range across every readable calendar, with writability and linked Mindboard group.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD, default today." },
        to: { type: "string", description: "YYYY-MM-DD inclusive, default from+7." },
      },
    },
    mapsTo: "app/lib/mcp/reads#listCalendarEvents",
  },
  {
    name: "calendar.rescheduleEvent",
    kind: "write",
    description: "Move a Google Calendar event to a new start/end (timed or all-day).",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
        allDay: { type: "boolean" },
        start: { type: "string" },
        end: { type: "string" },
        timeZone: { type: "string" },
      },
      required: ["calendarId", "eventId", "start", "end"],
    },
    mapsTo: "app/lib/mcp/writes#proposeRescheduleEvent",
    confirm: true,
  },
  {
    name: "calendar.createEvent",
    kind: "write",
    description: "Create a Google Calendar event (timed via startTime+durationMin, else all-day).",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD." },
        startTime: { type: "string", description: "HH:MM; omit for all-day." },
        durationMin: { type: "number" },
        calendarId: { type: "string" },
        description: { type: "string" },
      },
      required: ["summary", "date"],
    },
    mapsTo: "app/lib/mcp/writes#proposeCreateEvent",
    confirm: true,
  },
  {
    name: "tasks.recurring.update",
    kind: "write",
    description: "Edit a repeating-task rule: title, schedule, time-block, group, notes, priority.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string" },
        title: { type: "string" },
        frequency: { type: "string" },
        weekdays: { type: "array" },
        dayOfMonth: { type: "number" },
        intervalDays: { type: "number" },
        dueTime: { type: "string" },
        durationMin: { type: "number" },
        groupId: { type: "string" },
        notes: { type: "string" },
        priority: { type: "string" },
      },
      required: ["ruleId"],
    },
    mapsTo: "app/lib/mcp/writes#proposeUpdateRecurringTask",
    confirm: true,
  },
  {
    name: "tasks.recurring.complete",
    kind: "write",
    description: "Check off (or un-check with undo) today's occurrence of a repeating task.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string" },
        undo: { type: "boolean" },
      },
      required: ["ruleId"],
    },
    mapsTo: "app/lib/mcp/writes#proposeCompleteRecurring",
    confirm: true,
  },
  {
    name: "groups.manage",
    kind: "write",
    description: "Create, edit (rename/type/color/calendar link), or archive a task group.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "create | update | archive." },
        groupId: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        color: { type: "string" },
        googleCalendarId: { type: "string" },
      },
      required: ["action"],
    },
    mapsTo: "app/lib/mcp/writes#proposeManageGroup",
    confirm: true,
  },
  {
    name: "goals.list",
    kind: "read",
    description: "List goals (title, why, horizon, status, target date).",
    inputSchema: {
      type: "object",
      properties: { includeClosed: { type: "boolean" } },
    },
    mapsTo: "app/lib/mcp/reads#listGoals",
  },
  {
    name: "goals.upsert",
    kind: "write",
    description: "Create a goal, or update/close an existing one by id.",
    inputSchema: {
      type: "object",
      properties: {
        goalId: { type: "string" },
        title: { type: "string" },
        why: { type: "string" },
        horizon: { type: "string" },
        status: { type: "string" },
        targetDate: { type: "string" },
      },
    },
    mapsTo: "app/lib/mcp/writes#proposeUpsertGoal",
    confirm: true,
  },
  {
    name: "inventory.forecast",
    kind: "read",
    description:
      "Per-item depletion forecast: daily rate, days left, run-out date, reorder-by date.",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/mcp/reads#getInventoryForecast",
  },
  {
    name: "logs.daily.list",
    kind: "read",
    description: "Recent daily mood/energy/sleep check-ins.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    mapsTo: "app/lib/mcp/reads#listDailyLogs",
  },
  {
    name: "logs.daily.upsert",
    kind: "write",
    description: "Record today's mood/energy/sleep check-in (overwrites the same day).",
    inputSchema: {
      type: "object",
      properties: {
        mood: { type: "number" },
        energy: { type: "number" },
        sleepHours: { type: "number" },
      },
      required: ["mood", "energy"],
    },
    mapsTo: "app/lib/mcp/writes#proposeLogDaily",
    confirm: true,
  },
  {
    name: "settings.get",
    kind: "read",
    description: "Read preferences: timezone, wake window, manual daily-spend estimate.",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/mcp/reads#getPreferences",
  },
  {
    name: "settings.update",
    kind: "write",
    description: "Change timezone and/or the wake window.",
    inputSchema: {
      type: "object",
      properties: {
        timezone: { type: "string" },
        wakeStartHour: { type: "number" },
        wakeEndHour: { type: "number" },
      },
    },
    mapsTo: "app/lib/mcp/writes#proposeUpdateSettings",
    confirm: true,
  },
  {
    name: "ai.proposals.list",
    kind: "read",
    description: "Recent AI write proposals and their outcomes (the ai_audit_log).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "proposed | executed | rejected | error." },
        limit: { type: "number" },
      },
    },
    mapsTo: "app/lib/mcp/reads#listProposals",
  },
  {
    name: "brain.notes.list",
    kind: "read",
    description: "List every note in the second-brain vault (path, folder, title).",
    inputSchema: EMPTY_INPUT,
    mapsTo: "app/lib/mcp/reads#listBrainNotes",
  },
  {
    name: "brain.notes.read",
    kind: "read",
    description: "Read one vault note's raw markdown by path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    mapsTo: "app/lib/mcp/reads#readBrainNote",
  },
];

export function getTool(name: string): ToolDescriptor | undefined {
  return toolRegistry.find((tool) => tool.name === name);
}

export function readTools(): ToolDescriptor[] {
  return toolRegistry.filter((tool) => tool.kind === "read");
}

export function writeTools(): ToolDescriptor[] {
  return toolRegistry.filter((tool) => tool.kind === "write");
}
