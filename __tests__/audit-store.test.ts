// The ai_audit_log store after audit 2026-10-26 finding M7: proposal rows are
// written by the server only, so RLS is no longer what scopes them — the
// explicit .eq("user_id", …) on every statement is. These drive the real store
// against the in-memory PostgREST with two tenants' rows side by side.
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }));

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: mocks.createServiceClient,
}));

import {
  claimProposal,
  finalizeClaimedProposal,
  loadProposal,
  recordProposal,
  resolveProposal,
} from "@/app/lib/mcp/audit";
import { makeDb, type FakeDb, type Row } from "./urc-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MINE = "55555555-5555-4555-8555-555555555555";
const THEIRS = "77777777-7777-4777-8777-777777777777";

function row(id: string, userId: string, over: Partial<Row> = {}): Row {
  return {
    id,
    user_id: userId,
    tool_name: "delete_task",
    input: { taskId: "t-1" },
    summary: "Delete a task.",
    status: "proposed",
    result: null,
    created_at: "2026-10-27T00:00:00.000Z",
    resolved_at: null,
    ...over,
  };
}

function install(rows: Row[] = [row(MINE, OWNER), row(THEIRS, OTHER)]): FakeDb {
  const db = makeDb({ ai_audit_log: rows });
  mocks.createServiceClient.mockReturnValue(db);
  return db;
}

function find(db: FakeDb, id: string): Row {
  const hit = db.tables.ai_audit_log.find((r) => r.id === id);
  if (!hit) throw new Error(`no row ${id}`);
  return hit;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the store always opens the service client", () => {
  test("recordProposal writes a 'proposed' row for the given owner", async () => {
    const db = install([]);
    const id = await recordProposal(OWNER, "create_task", { title: "milk" }, "Add a task.");
    expect(mocks.createServiceClient).toHaveBeenCalled();
    const stored = find(db, id);
    expect(stored.user_id).toBe(OWNER);
    expect(stored.status).toBe("proposed");
    expect(stored.source).toBe("mcp");
    expect(stored.tool_name).toBe("create_task");
  });

  test("the source/conversation options ride through", async () => {
    const db = install([]);
    const id = await recordProposal(OWNER, "create_task", {}, "x", {
      source: "assistant",
      conversationId: "c-1",
    });
    expect(find(db, id).source).toBe("assistant");
    expect(find(db, id).conversation_id).toBe("c-1");
  });
});

describe("user_id is the scoping, not RLS", () => {
  test("loadProposal will not read another tenant's row", async () => {
    install();
    expect(await loadProposal(OWNER, MINE)).not.toBeNull();
    expect(await loadProposal(OWNER, THEIRS)).toBeNull();
    expect(await loadProposal(OTHER, MINE)).toBeNull();
  });

  test("claimProposal will not claim another tenant's row", async () => {
    const db = install();
    expect(await claimProposal(OWNER, THEIRS)).toBe(false);
    expect(find(db, THEIRS).status).toBe("proposed");
    expect(await claimProposal(OWNER, MINE)).toBe(true);
    expect(find(db, MINE).status).toBe("executing");
  });

  test("resolveProposal will not resolve another tenant's row", async () => {
    const db = install();
    expect(await resolveProposal(OWNER, THEIRS, "rejected", null)).toBe(false);
    expect(find(db, THEIRS).status).toBe("proposed");
    expect(await resolveProposal(OWNER, MINE, "rejected", null)).toBe(true);
    expect(find(db, MINE).status).toBe("rejected");
  });

  test("finalizeClaimedProposal will not finalize another tenant's claim", async () => {
    const db = install([
      row(MINE, OWNER, { status: "executing" }),
      row(THEIRS, OTHER, { status: "executing" }),
    ]);
    await finalizeClaimedProposal(OWNER, THEIRS, "executed", { ok: true });
    expect(find(db, THEIRS).status).toBe("executing");
    await finalizeClaimedProposal(OWNER, MINE, "executed", { ok: true });
    expect(find(db, MINE).status).toBe("executed");
  });
});

describe("the status guards that stop a replay", () => {
  test("only one claim wins", async () => {
    install();
    expect(await claimProposal(OWNER, MINE)).toBe(true);
    expect(await claimProposal(OWNER, MINE)).toBe(false);
  });

  test("an executed row cannot be resolved or claimed again", async () => {
    install([row(MINE, OWNER, { status: "executed" })]);
    expect(await loadProposal(OWNER, MINE)).toBeNull();
    expect(await claimProposal(OWNER, MINE)).toBe(false);
    expect(await resolveProposal(OWNER, MINE, "rejected", null)).toBe(false);
  });

  test("finalize only applies to a row still in flight", async () => {
    const db = install([row(MINE, OWNER, { status: "proposed" })]);
    await finalizeClaimedProposal(OWNER, MINE, "executed", { ok: true });
    expect(find(db, MINE).status).toBe("proposed");
  });
});
