// aiState 'approved' is the human build-approval gate: it is what makes the
// overnight harness check out a worktree and run npm/git on the owner's PC
// (audit 2026-10-26, H1.3). No AI client may set it, on either leg of
// propose -> confirm. The validator-level contract lives in
// mcp-validate.test.ts; this suite drives the two real rails.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import { confirmAction, proposeUpdateTaskFor } from "@/app/lib/mcp/writes";
import { makeDb, type FakeDb, type Row } from "./urc-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";

function install(auditRows: Row[] = []): FakeDb {
  const db = makeDb({
    ai_audit_log: auditRows,
    tasks: [
      { id: TASK, user_id: OWNER, title: "ship the approvals inbox", ai_state: "planned" },
    ],
    groups: [],
    user_settings: [{ user_id: OWNER, timezone: "America/Vancouver" }],
  });
  mocks.createServiceClient.mockReturnValue(db);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("propose time", () => {
  test("update_task refuses aiState 'approved' and records no proposal", async () => {
    const db = install();
    const result = await proposeUpdateTaskFor(db as unknown as SupabaseClient, OWNER, {
      taskId: TASK,
      aiState: "approved",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("approve' button");
    expect(db.tables.ai_audit_log).toHaveLength(0);
  });

  test("the other lifecycle states still propose normally", async () => {
    const db = install();
    for (const aiState of ["planned", "building", "built", "failed", "declined"]) {
      const result = await proposeUpdateTaskFor(db as unknown as SupabaseClient, OWNER, {
        taskId: TASK,
        aiState,
      });
      expect(result.ok).toBe(true);
    }
    expect(db.tables.ai_audit_log).toHaveLength(5);
  });
});

describe("confirm time — the forged-row path", () => {
  // ai_audit_log RLS lets a signed-in user insert their own 'proposed' row
  // (M7), so a row can carry an input that never met the propose validator.
  // The executor re-validates, so even a human channel cannot apply it.
  test("a hand-written approved row is refused by the executor on the watch rail", async () => {
    const db = install([
      {
        id: PROPOSAL,
        user_id: OWNER,
        tool_name: "update_task",
        input: { taskId: TASK, aiState: "approved" },
        summary: "AI state → approved",
        status: "proposed",
        result: null,
        created_at: "2026-10-27T00:00:00.000Z",
        resolved_at: null,
      },
    ]);
    const result = await confirmAction(OWNER, PROPOSAL, "watch");
    expect(result.ok).toBe(false);
    expect(db.tables.tasks[0].ai_state).toBe("planned");
    expect(db.tables.ai_audit_log[0].status).toBe("error");
  });
});
