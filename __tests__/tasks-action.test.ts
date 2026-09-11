import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  from: vi.fn(),
  revalidatePath: vi.fn(),
  after: vi.fn(),
  assignEnergyIfUnset: vi.fn(async () => ({ assigned: null })),
  completeTaskCascade: vi.fn(),
  reopenTaskCascade: vi.fn(),
  missTaskCascade: vi.fn(),
}));

vi.mock("@/app/lib/tasks/lifecycle", () => ({
  completeTaskCascade: mocks.completeTaskCascade,
  reopenTaskCascade: mocks.reopenTaskCascade,
  missTaskCascade: mocks.missTaskCascade,
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/app/lib/tasks/energy", () => ({
  assignEnergyIfUnset: mocks.assignEnergyIfUnset,
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

  test("createTask without an energy cost schedules the AI default after the response", async () => {
    const single = vi.fn(async () => ({ data: { id: "task-9" }, error: null }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ insert });

    await createTask({ title: "call the bank", groupId: null, dueDate: null });

    expect((insert.mock.calls[0] as unknown[])[0]).not.toHaveProperty("energy_cost");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    // Run the deferred callback: it rates exactly this task for this user.
    await (mocks.after.mock.calls[0][0] as () => Promise<void>)();
    expect(mocks.assignEnergyIfUnset).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "task-9",
    );
  });

  test("createTask with a user-picked energy cost stores it as 'user' and skips the AI", async () => {
    const single = vi.fn(async () => ({ data: { id: "task-10" }, error: null }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    mocks.from.mockReturnValue({ insert });

    await createTask({ title: "x", groupId: null, dueDate: null, energyCost: 4 });

    expect((insert.mock.calls[0] as unknown[])[0]).toMatchObject({
      energy_cost: 4,
      energy_source: "user",
    });
    expect(mocks.after).not.toHaveBeenCalled();
    await expect(
      createTask({ title: "x", groupId: null, dueDate: null, energyCost: 7 }),
    ).resolves.toEqual({ error: "energy must be 1-5" });
  });

  test("updateTask energy edits flip the source to 'user'; null clears both", async () => {
    const single = vi.fn(async () => ({ data: {}, error: null }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ update });

    await updateTask({ id: "task-1", energyCost: 2 });
    expect(update).toHaveBeenLastCalledWith({ energy_cost: 2, energy_source: "user" });

    await updateTask({ id: "task-1", energyCost: null });
    expect(update).toHaveBeenLastCalledWith({ energy_cost: null, energy_source: null });

    await updateTask({ id: "task-1", notBefore: "2026-09-18" });
    expect(update).toHaveBeenLastCalledWith({ not_before: "2026-09-18" });
    await expect(updateTask({ id: "task-1", notBefore: "soon" })).resolves.toEqual({
      error: "invalid not-before date",
    });
  });

  test("updateTask pulls a subtask's not_before along when the due date moves earlier", async () => {
    const gt = vi.fn(async () => ({ error: null }));
    const clampEq = vi.fn(() => ({ gt }));
    const clampUpdate = vi.fn(() => ({ eq: clampEq }));
    const single = vi.fn(async () => ({ data: {}, error: null }));
    const select = vi.fn(() => ({ single }));
    const mainEq = vi.fn(() => ({ select }));
    const mainUpdate = vi.fn(() => ({ eq: mainEq }));
    mocks.from
      .mockReturnValueOnce({ update: clampUpdate })
      .mockReturnValueOnce({ update: mainUpdate });

    await expect(updateTask({ id: "c1", dueDate: "2026-09-18" })).resolves.toEqual({
      error: null,
    });

    // The guard runs first and only touches a not_before past the new date.
    expect(clampUpdate).toHaveBeenCalledWith({ not_before: "2026-09-18" });
    expect(clampEq).toHaveBeenCalledWith("id", "c1");
    expect(gt).toHaveBeenCalledWith("not_before", "2026-09-18");
    expect(mainUpdate).toHaveBeenCalledWith({ due_date: "2026-09-18" });
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

  test("toggleTaskStatus completes through the cascade for the current user", async () => {
    mocks.completeTaskCascade.mockResolvedValue({
      ok: true,
      value: { parentCompleted: false, childrenCompleted: 0 },
    });

    await expect(toggleTaskStatus("task-1", "todo")).resolves.toEqual({
      error: null,
      nextStatus: "done",
    });

    expect(mocks.completeTaskCascade).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "task-1",
    );
    expect(mocks.reopenTaskCascade).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("toggleTaskStatus on a done task reopens through the cascade", async () => {
    mocks.reopenTaskCascade.mockResolvedValue({ ok: true, value: { parentReopened: false } });

    await expect(toggleTaskStatus("task-1", "done")).resolves.toEqual({
      error: null,
      nextStatus: "todo",
    });
    expect(mocks.reopenTaskCascade).toHaveBeenCalledWith(expect.anything(), "user-1", "task-1");
    expect(mocks.completeTaskCascade).not.toHaveBeenCalled();
  });

  test("toggleTaskStatus surfaces a cascade error and skips revalidation", async () => {
    mocks.completeTaskCascade.mockResolvedValue({ ok: false, error: "task not found" });
    await expect(toggleTaskStatus("task-1", "todo")).resolves.toEqual({ error: "task not found" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
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

  test("markTaskMissed runs the cascade on the user's day and reports a slid subtask", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T10:00:00.000Z"));
    mocks.missTaskCascade.mockResolvedValue({
      ok: true,
      value: { kind: "slid", notBefore: "2026-07-23", task: {} },
    });

    await expect(markTaskMissed("task-1")).resolves.toEqual({
      error: null,
      slidTo: "2026-07-23",
    });

    expect(mocks.missTaskCascade).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "task-1",
      "2026-07-22",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("markTaskMissed on a parent reports no slide", async () => {
    mocks.missTaskCascade.mockResolvedValue({
      ok: true,
      value: { kind: "missed", childrenMissed: 2, task: {} },
    });
    await expect(markTaskMissed("task-1")).resolves.toEqual({ error: null, slidTo: undefined });
  });

  test("markTaskMissed refuses a task that is already done", async () => {
    mocks.missTaskCascade.mockResolvedValue({ ok: false, error: "already done" });

    await expect(markTaskMissed("task-1")).resolves.toEqual({ error: "already done" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  test("reopenTask returns a task to todo through the cascade", async () => {
    mocks.reopenTaskCascade.mockResolvedValue({ ok: true, value: { parentReopened: true } });

    await expect(reopenTask("task-1")).resolves.toEqual({ error: null });

    expect(mocks.reopenTaskCascade).toHaveBeenCalledWith(expect.anything(), "user-1", "task-1");
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
