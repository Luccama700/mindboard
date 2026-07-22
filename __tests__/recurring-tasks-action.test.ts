import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  from: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.authGetUser },
    from: mocks.from,
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/app/lib/data/recurring-tasks", () => ({
  RECURRING_TASK_COLUMNS: "id",
}));

import { updateRecurringTask } from "@/app/actions/recurring-tasks";

function mockUpdate() {
  let patch: Record<string, unknown> | undefined;
  const eqUser = vi.fn(async () => ({ error: null }));
  const eqId = vi.fn(() => ({ eq: eqUser }));
  const update = vi.fn((p: Record<string, unknown>) => {
    patch = p;
    return { eq: eqId };
  });
  mocks.from.mockReturnValue({ update });
  return { update, getPatch: () => patch };
}

describe("recurring-task actions: due_time / duration_min are decoupled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a durationMin patch writes duration_min and emits no due_time column", async () => {
    const { update, getPatch } = mockUpdate();

    await expect(
      updateRecurringTask({ id: "r1", durationMin: 45 }),
    ).resolves.toEqual({ error: null });

    expect(update).toHaveBeenCalledWith({ duration_min: 45 });
    expect(getPatch()).not.toHaveProperty("due_time");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("clearing dueTime writes only due_time: null and leaves duration_min alone", async () => {
    const { update, getPatch } = mockUpdate();

    await expect(
      updateRecurringTask({ id: "r1", dueTime: null }),
    ).resolves.toEqual({ error: null });

    expect(update).toHaveBeenCalledWith({ due_time: null });
    expect(getPatch()).not.toHaveProperty("duration_min");
  });
});
