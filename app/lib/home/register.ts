import "server-only";
import type { createMcpHandler } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { homeConfigured } from "./db";
import { getHomeStatus, listHomeChores } from "./reads";
import {
  proposeHomeCompleteChore,
  proposeHomeDeleteChore,
  proposeHomeLogFeeding,
  proposeHomeUpsertChore,
} from "./writes";

// Home-app section of the MCP server (Lucca's household app: Taiga feedings +
// shared chores). Self-contained so it can be dropped from a productized
// Mindboard: delete app/lib/home/, the registerHomeTools call in the MCP route,
// the HOME_EXECUTORS spread in app/lib/mcp/writes.ts, and the two HOME_APP_*
// env vars. Without those env vars the tools aren't registered at all.

type McpServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];
type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean };
type Extra = { authInfo?: AuthInfo };
type Deps = {
  uid: (extra: Extra) => string;
  ok: (data: unknown) => ToolText;
  fail: (message: string) => ToolText;
  guard: (run: () => Promise<ToolText>) => Promise<ToolText>;
};

const CONFIRM = "Returns a proposalId + preview; nothing changes until confirm_action(proposalId).";

export function registerHomeTools(server: McpServer, { uid, ok, fail, guard }: Deps): void {
  if (!homeConfigured()) return;

  server.registerTool(
    "home_status",
    {
      title: "Home: today",
      description:
        "Household home app (only for its members). Today's cat feedings (morning/evening: who fed her and when, and which slot is current) and every chore due today or overdue with who's up next.",
      inputSchema: {},
    },
    (_args, extra) => guard(async () => ok(await getHomeStatus(uid(extra)))),
  );

  server.registerTool(
    "home_list_chores",
    {
      title: "Home: list chores",
      description:
        "All household chores with ids, frequency, who does each one (its own people or the default rotation), who's up next, due date/status, plus members and the last 10 completions. Use it to find a chore id before home_complete_chore / home_upsert_chore / home_delete_chore.",
      inputSchema: {},
    },
    (_args, extra) => guard(async () => ok(await listHomeChores(uid(extra)))),
  );

  server.registerTool(
    "home_complete_chore",
    {
      title: "Home: mark a chore done",
      description: `Mark a household chore done as you; it rotates to the next person on that chore and gets its next due date. ${CONFIRM}`,
      inputSchema: { choreId: z.string().uuid() },
    },
    (args, extra) =>
      guard(async () => {
        const r = await proposeHomeCompleteChore(uid(extra), args.choreId);
        return r.ok ? ok(r.value) : fail(r.error);
      }),
  );

  server.registerTool(
    "home_upsert_chore",
    {
      title: "Home: add or edit a chore",
      description: `Add a household chore (omit choreId) or edit one (pass choreId; omitted fields stay as they are). assignees = member names who do it (one name = always them, several = they take turns, [] = use the default rotation). upNext = member name whose turn it is. ${CONFIRM}`,
      inputSchema: {
        choreId: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(80).optional(),
        frequency: z.enum(["daily", "weekly", "interval"]).optional(),
        intervalDays: z.number().int().min(1).max(365).optional(),
        assignees: z.array(z.string().min(1)).max(10).optional(),
        upNext: z.string().min(1).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      },
    },
    (args, extra) =>
      guard(async () => {
        const r = await proposeHomeUpsertChore(uid(extra), args);
        return r.ok ? ok(r.value) : fail(r.error);
      }),
  );

  server.registerTool(
    "home_delete_chore",
    {
      title: "Home: delete a chore",
      description: `Delete a household chore; its completion history stays. ${CONFIRM}`,
      inputSchema: { choreId: z.string().uuid() },
    },
    (args, extra) =>
      guard(async () => {
        const r = await proposeHomeDeleteChore(uid(extra), args.choreId);
        return r.ok ? ok(r.value) : fail(r.error);
      }),
  );

  server.registerTool(
    "home_log_feeding",
    {
      title: "Home: log a cat feeding",
      description: `Log that you just fed the household cat, in the current morning/evening slot. The preview warns if that slot was already fed; confirm fails if the slot, day, or feedings changed since the proposal. ${CONFIRM}`,
      inputSchema: {},
    },
    (_args, extra) =>
      guard(async () => {
        const r = await proposeHomeLogFeeding(uid(extra));
        return r.ok ? ok(r.value) : fail(r.error);
      }),
  );
}
