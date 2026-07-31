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
  upsert: { payload: Record<string, unknown>; opts: unknown } | null;
};

// One router for the three tables the action touches, recording the call
// order so the note lands before the task flip before the wake-up stamp.
function mockTables(
  over: {
    task?: { data: unknown; error: unknown };
    dispatch?: { data: unknown; error: unknown };
    taskUpdateError?: unknown;
  } = {},
): Recorded {
  const rec: Recorded = {
    order: [],
    insert: null,
    taskUpdate: null,
    upsert: null,
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
                  data: { id: "task-1", notes: "old notes" },
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
      return {
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
    if (table === "user_settings") {
      return {
        upsert: vi.fn(async (payload: Record<string, unknown>, opts: unknown) => {
          rec.order.push("settings:upsert");
          rec.upsert = { payload, opts };
          return { error: null };
        }),
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

  test("inserts the dispatch, appends the note, approves, and stamps the run request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T10:00:00.000Z"));
    const rec = mockTables();

    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "  book the room  " }),
    ).resolves.toEqual({ error: null, dispatchId: "dispatch-1" });

    expect(rec.order).toEqual([
      "task:load",
      "dispatch:insert",
      "task:update",
      "settings:upsert",
    ]);
    expect(rec.insert).toEqual({
      user_id: "user-1",
      task_id: "task-1",
      note: "book the room",
      status: "requested",
    });
    expect(rec.taskUpdate).toEqual({
      notes:
        "old notes\n\n---\n\n## Operator note (2026-07-31)\n\nbook the room",
      ai_state: "approved",
    });
    expect(rec.upsert).toEqual({
      payload: {
        user_id: "user-1",
        agent_run_requested_at: "2026-07-31T10:00:00.000Z",
      },
      opts: { onConflict: "user_id" },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("stops when the dispatch row cannot be created", async () => {
    const rec = mockTables({
      dispatch: { data: null, error: { message: "relation missing" } },
    });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "could not create dispatch" });
    expect(rec.taskUpdate).toBeNull();
    expect(rec.upsert).toBeNull();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  test("reports a failed task update without stamping the run request", async () => {
    const rec = mockTables({ taskUpdateError: { message: "nope" } });
    await expect(
      requestTaskDispatch({ taskId: "task-1", note: "do it" }),
    ).resolves.toEqual({ error: "could not update task" });
    expect(rec.upsert).toBeNull();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
