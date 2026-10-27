// The confirm rail's half of H2: a `mcp:` credential cannot confirm a proposal
// that requiresAppApproval, and the refusal must leave the row pending so the
// user can approve that very one in the app. Driven through the real
// confirmAction against the shared in-memory PostgREST, so the authKind
// plumbing (MCP clientId / watch → the gate) is exercised, not mocked around.
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { confirmAction } from "@/app/lib/mcp/writes";
import { makeDb, type FakeDb, type Row } from "./urc-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";

function proposal(over: Partial<Row> = {}): Row {
  return {
    id: PROPOSAL,
    user_id: OWNER,
    tool_name: "delete_task",
    input: { taskId: TASK },
    summary: 'Delete task "pay rent" — this cannot be undone.',
    status: "proposed",
    result: null,
    created_at: "2026-10-27T00:00:00.000Z",
    resolved_at: null,
    ...over,
  };
}

function install(over: Partial<Row> = {}): FakeDb {
  const db = makeDb({
    ai_audit_log: [proposal(over)],
    tasks: [{ id: TASK, user_id: OWNER, title: "pay rent", status: "todo" }],
  });
  mocks.createServiceClient.mockReturnValue(db);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a chat client cannot confirm a gated proposal", () => {
  test.each(["mcp:client-abc", "mcp:pat", "mcp:static"])(
    "%s is refused and points at /approvals",
    async (authKind) => {
      const db = install();
      const result = await confirmAction(OWNER, PROPOSAL, authKind);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("/approvals");
      // Still pending, still deletable by the user's own tap — and the task
      // itself is untouched.
      expect(db.tables.ai_audit_log[0].status).toBe("proposed");
      expect(db.tables.tasks).toHaveLength(1);
    },
  );

  test("the refusal does not consume the proposal — the same id stays confirmable", async () => {
    const db = install();
    await confirmAction(OWNER, PROPOSAL, "mcp:client-abc");
    const second = await confirmAction(OWNER, PROPOSAL, "watch");
    expect(second.ok).toBe(true);
    expect(db.tables.ai_audit_log[0].status).toBe("executed");
  });

  test("an ungated proposal still self-confirms over MCP", async () => {
    const db = install({ tool_name: "complete_task", input: { taskId: TASK } });
    const result = await confirmAction(OWNER, PROPOSAL, "mcp:client-abc");
    expect(result.ok).toBe(true);
    expect(db.tables.ai_audit_log[0].status).toBe("executed");
    expect(db.tables.tasks[0].status).toBe("done");
  });

  test("a forged aiState:'approved' row cannot be confirmed from chat", async () => {
    const db = install({
      tool_name: "update_task",
      input: { taskId: TASK, aiState: "approved" },
      summary: "AI state → approved",
    });
    const result = await confirmAction(OWNER, PROPOSAL, "mcp:client-abc");
    expect(result.ok).toBe(false);
    expect(db.tables.ai_audit_log[0].status).toBe("proposed");
    expect(db.tables.tasks[0].ai_state).toBeUndefined();
  });
});

describe("the human channels are not gated", () => {
  test("the watch confirms a delete", async () => {
    const db = install();
    const result = await confirmAction(OWNER, PROPOSAL, "watch");
    expect(result.ok).toBe(true);
    expect(db.tables.tasks).toHaveLength(0);
    expect(db.tables.ai_audit_log[0].status).toBe("executed");
  });
});
