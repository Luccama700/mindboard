import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  from: vi.fn(),
  revalidatePath: vi.fn(),
  ownerUserId: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.authGetUser },
    from: mocks.from,
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/utils/google/calendar", () => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
}));

vi.mock("@/app/lib/data/settings", () => ({
  getUserPreferences: vi.fn(async () => ({ timezone: "UTC" })),
}));

vi.mock("@/app/lib/mcp/config", () => ({ ownerUserId: mocks.ownerUserId }));

import { requestTaskDispatch } from "@/app/actions/tasks";

type Recorded = {
  order: string[];
  insert: Record<string, unknown> | null;
  taskUpdate: Record<string, unknown> | null;
};

// One router for the two tables the action touches, recording the call order:
// the guards run before either write, and the note lands before the queue row
// so a half-done dispatch never needs undoing. user_settings has no branch on
// purpose — writing it would throw, proving the action never stamps it (that
// would drag a full nightly sweep along behind every dispatch).
function mockTables(
  over: {
    task?: { data: unknown; error: unknown };
    openDispatches?: unknown[];
    dispatch?: { data: unknown; error: unknown };
    taskUpdateError?: unknown;
  } = {},
): Recorded {
  const rec: Recorded = {
    order: [],
    insert: null,
    taskUpdate: null,
  };

  mocks.from.mockImplementation((table: string) => {
    if (table === "tasks") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => {
              rec.order.push("task:load");
              return (
                over.task ?? {
                  data: { id: "task-1", notes: "old notes", status: "todo" },
                  error: null,
                }
              );
            }),
          })),
        })),
        update: vi.fn((patch: Record<string, unknown>) => ({
          eq: vi.fn(async () => {
            rec.order.push("task:update");
            rec.taskUpdate = patch;
            return { error: over.taskUpdateError ?? null };
          }),
        })),
      };
    }
    if (table === "task_dispatches") {
      const openQuery = {
        eq: vi.fn(() => openQuery),
        in: vi.fn(() => openQuery),
        limit: vi.fn(async () => {
          rec.order.push("dispatch:open-check");
          return { data: over.openDispatches ?? [], error: null };
        }),
      };
      return {
        select: vi.fn(() => openQuery),
        insert: vi.fn((payload: Record<string, unknown>) => ({
          select: vi.fn(() => ({
            single: vi.fn(async () => {
              rec.order.push("dispatch:insert");
              rec.insert = payload;
              return (
                over.dispatch ?? { data: { id: "dispatch-1" }, error: null }
              );
            }),
          })),
        })),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return rec;
}

describe("requestTaskDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.ownerUserId.mockReturnValue("user-1");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("rejects a blank note before touching Supabase", async () => {
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "   " }),
    ).resolves.toEqual({ error: "note required" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("rejects an unauthenticated caller", async () => {
    mocks.authGetUser.mockResolvedValue({ data: { user: null } });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "not authenticated" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("refuses an account no agent PC serves", async () => {
    mocks.ownerUserId.mockReturnValue("someone-else");
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "no agent PC serves this account" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("refuses when the owner env is unset", async () => {
    mocks.ownerUserId.mockImplementation(() => {
      throw new Error("MINDBOARD_OWNER_USER_ID is not set");
    });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "no agent PC serves this account" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("reports a missing task", async () => {
    mockTables({ task: { data: null, error: { message: "no rows" } } });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "task not found" });
  });

  test("inserts the dispatch and appends the note, without waking the sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T10:00:00.000Z"));
    const rec = mockTables();

    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "  book the room  " }),
    ).resolves.toEqual({ error: null, dispatchId: "dispatch-1" });

    // user_settings is never touched: the poll drains this queue on its own,
    // and agent_run_requested_at would also kick off a full nightly sweep.
    expect(mocks.from).not.toHaveBeenCalledWith("user_settings");
    // The note is committed BEFORE the queue row exists, so nothing ever
    // needs rolling back.
    expect(rec.order).toEqual([
      "task:load",
      "dispatch:open-check",
      "task:update",
      "dispatch:insert",
    ]);
    expect(rec.insert).toEqual({
      user_id: "user-1",
      task_id: "task-1",
      note: "book the room",
      status: "requested",
    });
    // ai_state null, never 'approved': that is the nightly sweep's queue, and
    // clearing it drops a stale ✦ done/✦ failed badge from the card.
    expect(rec.taskUpdate).toEqual({
      notes:
        "old notes\n\n---\n\n## Operator note (2026-07-31)\n\nbook the room",
      ai_state: null,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  // A failed insert leaves only the note section behind — no queue row, no
  // ai_state, and nothing that makes the button refuse the next attempt.
  test("a failed insert errors without locking the task out", async () => {
    const rec = mockTables({
      dispatch: { data: null, error: { message: "relation missing" } },
    });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "could not create dispatch" });
    expect(rec.taskUpdate).not.toBeNull();
    expect(rec.taskUpdate?.ai_state).toBeNull();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();

    // Same task, second try: the open-check sees no row, so it goes through.
    const retry = mockTables();
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: null, dispatchId: "dispatch-1" });
    expect(retry.insert).not.toBeNull();
  });

  test("a failed task update never reaches the queue", async () => {
    const rec = mockTables({ taskUpdateError: { message: "nope" } });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "could not update task" });
    expect(rec.insert).toBeNull();
    expect(rec.order).toEqual(["task:load", "dispatch:open-check", "task:update"]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  test.each(["done", "missed"])("refuses a %s task", async (status) => {
    const rec = mockTables({
      task: { data: { id: "task-1", notes: null, status }, error: null },
    });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: `task is already ${status}` });
    expect(rec.insert).toBeNull();
  });

  test("refuses a second dispatch while one is still in flight", async () => {
    const rec = mockTables({ openDispatches: [{ id: "dispatch-0" }] });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it again" }),
    ).resolves.toEqual({ error: "already dispatched" });
    expect(rec.insert).toBeNull();
    expect(rec.taskUpdate).toBeNull();
  });

  // Losing the double-tap race leaves the note behind (the in-flight dispatch
  // will answer it) but never a second queue row.
  test("a unique-violation on insert reads as already dispatched", async () => {
    const rec = mockTables({
      dispatch: { data: null, error: { code: "23505", message: "duplicate" } },
    });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "already dispatched" });
    expect(rec.insert).not.toBeNull();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
