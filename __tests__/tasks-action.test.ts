import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  from: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mocks.authGetUser,
    },
    from: mocks.from,
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/utils/google/calendar", () => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
}));

vi.mock("@/app/lib/data/settings", () => ({
  getUserPreferences: vi.fn(async () => ({ timezone: "UTC" })),
}));

import {
  createTask,
  deleteTask,
  markTaskMissed,
  reopenTask,
  toggleTaskStatus,
  updateTask,
} from "@/app/actions/tasks";

describe("task actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("createTask rejects blank titles before touching Supabase", async () => {
    await expect(
      createTask({ title: "   ", groupId: null, dueDate: null }),
    ).resolves.toEqual({ error: "title required" });

    expect(mocks.authGetUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("createTask trims inputs, inserts for the current user, and revalidates the target list", async () => {
    const task = {
      id: "task-1",
      title: "Read notes",
      due_date: "2026-05-23",
      status: "todo",
      priority: "med",
      notes: "chapter 3",
      group_id: "group-1",
      created_at: "2026-05-23T10:00:00.000Z",
      completed_at: null,
      estimated_minutes: null,
      missed_at: null,
    };
    const single = vi.fn(async () => ({ data: task, error: null }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ insert });

    await expect(
      createTask({
        title: "  Read notes  ",
        groupId: "group-1",
        dueDate: "2026-05-23",
        notes: "  chapter 3  ",
      }),
    ).resolves.toEqual({ error: null, task });

    expect(mocks.from).toHaveBeenCalledWith("tasks");
    expect(insert).toHaveBeenCalledWith({
      user_id: "user-1",
      group_id: "group-1",
      title: "Read notes",
      due_date: "2026-05-23",
      due_time: null,
      notes: "chapter 3",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("createTask stores a normalized due time when a date is present", async () => {
    const single = vi.fn(async () => ({ data: { id: "task-2" }, error: null }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ insert });

    await createTask({
      title: "call landlord",
      groupId: null,
      dueDate: "2026-05-23",
      dueTime: "15:00",
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ due_time: "15:00:00" }),
    );
  });

  test("createTask rejects malformed times", async () => {
    await expect(
      createTask({
        title: "x",
        groupId: null,
        dueDate: "2026-05-23",
        dueTime: "25:99",
      }),
    ).resolves.toEqual({ error: "invalid time" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("updateTask rejects empty renamed titles", async () => {
    await expect(
      updateTask({ id: "task-1", title: "   " }),
    ).resolves.toEqual({ error: "title required" });

    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("updateTask writes only provided fields and trims notes", async () => {
    const single = vi.fn(async () => ({
      data: {
        title: "t",
        due_date: null,
        due_time: null,
        duration_min: null,
        gcal_event_id: null,
        gcal_calendar_id: null,
      },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await expect(
      updateTask({
        id: "task-1",
        dueDate: null,
        groupId: "group-2",
        notes: "  remember this  ",
      }),
    ).resolves.toEqual({ error: null });

    expect(update).toHaveBeenCalledWith({
      due_date: null,
      due_time: null,
      group_id: "group-2",
      notes: "remember this",
    });
    expect(eq).toHaveBeenCalledWith("id", "task-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("toggleTaskStatus marks done tasks with a completion timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T10:15:00.000Z"));
    const eq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await expect(toggleTaskStatus("task-1", "todo")).resolves.toEqual({
      error: null,
      nextStatus: "done",
    });

    expect(update).toHaveBeenCalledWith({
      status: "done",
      completed_at: "2026-05-23T10:15:00.000Z",
    });
  });

  test("updateTask maps estimatedMinutes without touching schedule sync", async () => {
    const single = vi.fn(async () => ({
      data: {
        title: "t",
        due_date: null,
        due_time: null,
        duration_min: null,
        estimated_minutes: 45,
        gcal_event_id: null,
        gcal_calendar_id: null,
      },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await expect(
      updateTask({ id: "task-1", estimatedMinutes: 45 }),
    ).resolves.toEqual({ error: null });

    expect(update).toHaveBeenCalledWith({ estimated_minutes: 45 });
  });

  test("updateTask rejects an invalid estimatedMinutes before writing", async () => {
    await expect(
      updateTask({ id: "task-1", estimatedMinutes: 2.5 }),
    ).resolves.toEqual({ error: "invalid estimate" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("updateTask calendar sync falls back to the estimate when duration_min is null", async () => {
    const { updateEvent } = await import("@/utils/google/calendar");
    const single = vi.fn(async () => ({
      data: {
        title: "t",
        due_date: "2026-07-22",
        due_time: "09:00:00",
        duration_min: null,
        estimated_minutes: 45,
        gcal_event_id: "evt-1",
        gcal_calendar_id: "cal-1",
      },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await expect(
      updateTask({ id: "task-1", dueTime: "09:00" }),
    ).resolves.toEqual({ error: null });

    expect(updateEvent).toHaveBeenCalledWith(
      "user-1",
      "cal-1",
      "evt-1",
      expect.objectContaining({
        end: { dateTime: "2026-07-22T09:45:00", timeZone: "UTC" },
      }),
    );
  });

  test("markTaskMissed sets status and timestamp when the task is open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00.000Z"));
    const maybeSingle = vi.fn(async () => ({ data: { status: "todo" }, error: null }));
    const loadEq = vi.fn(() => ({ maybeSingle }));
    const loadSelect = vi.fn(() => ({ eq: loadEq }));
    const updateEq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq: updateEq }));
    mocks.from
      .mockReturnValueOnce({ select: loadSelect })
      .mockReturnValueOnce({ update });

    await expect(markTaskMissed("task-1")).resolves.toEqual({ error: null });

    expect(update).toHaveBeenCalledWith({
      status: "missed",
      missed_at: "2026-07-22T10:00:00.000Z",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("markTaskMissed refuses a task that is already done", async () => {
    const maybeSingle = vi.fn(async () => ({ data: { status: "done" }, error: null }));
    const loadEq = vi.fn(() => ({ maybeSingle }));
    const loadSelect = vi.fn(() => ({ eq: loadEq }));
    const update = vi.fn();
    mocks.from.mockReturnValue({ select: loadSelect, update });

    await expect(markTaskMissed("task-1")).resolves.toEqual({ error: "already done" });

    expect(update).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  test("reopenTask returns a task to todo and clears both timestamps", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await expect(reopenTask("task-1")).resolves.toEqual({ error: null });

    expect(update).toHaveBeenCalledWith({
      status: "todo",
      missed_at: null,
      completed_at: null,
    });
    expect(eq).toHaveBeenCalledWith("id", "task-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("deleteTask deletes by id and revalidates dashboard data", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const deleteQuery = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ delete: deleteQuery });

    await expect(deleteTask("task-1")).resolves.toEqual({ error: null });

    expect(deleteQuery).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith("id", "task-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
