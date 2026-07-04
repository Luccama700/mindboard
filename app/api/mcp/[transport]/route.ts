import { timingSafeEqual } from "node:crypto";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verifyAccessToken } from "@/app/lib/mcp/oauth";
import {
  getFinanceSnapshot,
  getInventorySnapshot,
  getTasksSnapshot,
  listAccounts,
  listCategories,
  listGroups,
  listRecentLedger,
  listTasks,
} from "@/app/lib/mcp/reads";
import {
  cancelAction,
  confirmAction,
  proposeCompleteTask,
  proposeCreateTask,
  proposeLogSpend,
} from "@/app/lib/mcp/writes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Remote MCP server exposing Mindboard's data to external Claude clients.
// Reads are safe; writes go through propose → confirm with an ai_audit_log row
// (see app/lib/mcp/writes.ts). Every query is scoped to the single owner via the
// service-role client. Tool names mirror app/lib/agent/registry.ts.

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
      () => guard(async () => ok(await getFinanceSnapshot())),
    );

    server.registerTool(
      "tasks_snapshot",
      {
        title: "Tasks snapshot",
        description: "Counts of open tasks that are overdue, due today, or due within the next week.",
        inputSchema: {},
      },
      () => guard(async () => ok(await getTasksSnapshot())),
    );

    server.registerTool(
      "inventory_snapshot",
      {
        title: "Inventory snapshot",
        description: "How many stock items are low or out, and the item projected to run out soonest.",
        inputSchema: {},
      },
      () => guard(async () => ok(await getInventorySnapshot())),
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
      (args) => guard(async () => ok(await listTasks(args))),
    );

    server.registerTool(
      "list_groups",
      { title: "List groups", description: "List active task groups (id, name, color, type).", inputSchema: {} },
      () => guard(async () => ok(await listGroups())),
    );

    server.registerTool(
      "list_accounts",
      {
        title: "List accounts",
        description: "List active money accounts (id, name, balance, currency). Use to find an account id for log_spend.",
        inputSchema: {},
      },
      () => guard(async () => ok(await listAccounts())),
    );

    server.registerTool(
      "list_categories",
      {
        title: "List spending categories",
        description: "List active spending categories (id, name). Use to categorize a log_spend.",
        inputSchema: {},
      },
      () => guard(async () => ok(await listCategories())),
    );

    server.registerTool(
      "list_recent_ledger",
      {
        title: "List recent ledger rows",
        description: "The most recent balance changes (spending and income), newest first.",
        inputSchema: { limit: z.number().int().positive().max(100).optional() },
      },
      (args) => guard(async () => ok(await listRecentLedger(args.limit))),
    );

    // ---------- writes (propose step) ----------
    // Each returns a proposalId + preview. Show the preview to the user and only
    // call confirm_action after they approve. Nothing is written until then.
    server.registerTool(
      "create_task",
      {
        title: "Propose: create a task",
        description:
          "Propose creating a task. Returns a preview + proposalId; call confirm_action to apply. groupId omitted/null → inbox. dueDate is YYYY-MM-DD.",
        inputSchema: {
          title: z.string(),
          groupId: z.string().nullish(),
          dueDate: z.string().nullish(),
          notes: z.string().nullish(),
          priority: z.enum(["low", "med", "high"]).optional(),
        },
      },
      (args) =>
        guard(async () => {
          const r = await proposeCreateTask(args);
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
      (args) =>
        guard(async () => {
          const r = await proposeCompleteTask(args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    server.registerTool(
      "log_spend",
      {
        title: "Propose: log spending",
        description:
          "Propose recording money spent from an account (decreases its balance, appends a ledger row). Returns a preview + proposalId; call confirm_action to apply. amount is a positive number; find accountId/categoryId via list_accounts/list_categories.",
        inputSchema: {
          accountId: z.string(),
          amount: z.number().positive(),
          categoryId: z.string().nullish(),
          note: z.string().nullish(),
        },
      },
      (args) =>
        guard(async () => {
          const r = await proposeLogSpend(args);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );

    // ---------- confirm / cancel ----------
    server.registerTool(
      "confirm_action",
      {
        title: "Confirm a proposed write",
        description:
          "Execute a previously proposed write (create_task / complete_task / log_spend) by its proposalId. Only call after the user has approved the preview.",
        inputSchema: { proposalId: z.string() },
      },
      (args) =>
        guard(async () => {
          const r = await confirmAction(args.proposalId);
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
      (args) =>
        guard(async () => {
          const r = await cancelAction(args.proposalId);
          return r.ok ? ok(r.value) : fail(r.error);
        }),
    );
  },
  { serverInfo: { name: "mindboard", version: "1.0.0" } },
  { basePath: "/api/mcp", maxDuration: 60, disableSse: true, verboseLogs: false },
);

// ---------- auth: OAuth access token OR static bearer ----------
// claude.ai authenticates via OAuth (see app/api/mcp/oauth/* + the well-known
// metadata). Other clients (MCP inspector, curl, Claude Desktop) can still use
// the static MCP_BEARER_TOKEN. withMcpAuth returns 401 + a WWW-Authenticate that
// points at the protected-resource metadata, which kicks off the OAuth flow.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function verifyToken(_req: Request, bearer?: string) {
  if (!bearer) return undefined;

  const staticToken = process.env.MCP_BEARER_TOKEN;
  if (staticToken && safeEqual(bearer, staticToken)) {
    return { token: bearer, clientId: "static", scopes: ["mcp"] };
  }

  const parsed = verifyAccessToken(bearer);
  if (parsed) {
    return {
      token: bearer,
      clientId: parsed.clientId,
      scopes: ["mcp"],
      extra: { ownerId: parsed.ownerId },
    };
  }

  return undefined;
}

const handler = withMcpAuth(mcpHandler, verifyToken, { required: true });

export { handler as GET, handler as POST };
