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

import {
  createTask,
  deleteTask,
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
