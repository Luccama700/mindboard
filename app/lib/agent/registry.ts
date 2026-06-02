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
    description: "Edit a task's title, due date, group, or notes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id." },
        title: { type: "string" },
        dueDate: { type: "string" },
        groupId: { type: "string" },
        notes: { type: "string" },
      },
      required: ["id"],
    },
    mapsTo: "app/actions/tasks#updateTask",
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
