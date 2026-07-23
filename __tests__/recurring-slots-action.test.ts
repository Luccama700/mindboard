import { beforeEach, describe, expect, test, vi } from "vitest";

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

import {
  approveRecurringSlot,
  clearRecurringSlot,
} from "@/app/actions/recurring-tasks";

type UpsertCall = { payload: Record<string, unknown>; opts: unknown };
type DeleteCall = { filters: [string, unknown][] };

function mockClient() {
  const upsertCalls: UpsertCall[] = [];
  const deleteCalls: DeleteCall[] = [];

  const upsert = vi.fn(async (payload: Record<string, unknown>, opts: unknown) => {
    upsertCalls.push({ payload, opts });
    return { error: null };
  });

  const del = vi.fn(() => {
    const filters: [string, unknown][] = [];
    deleteCalls.push({ filters });
    const chain = {
      eq: vi.fn((col: string, val: unknown) => {
        filters.push([col, val]);
        return filters.length >= 3 ? Promise.resolve({ error: null }) : chain;
      }),
    };
    return chain;
  });

  mocks.from.mockReturnValue({ upsert, delete: del });
  return { upsert, del, upsertCalls, deleteCalls };
}

describe("approveRecurringSlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  test("upserts onConflict rule_id,occurred_on with NO ignoreDuplicates and normalizes the time", async () => {
    const { upsert, upsertCalls } = mockClient();

    await expect(
      approveRecurringSlot({
        ruleId: "r1",
        dateKey: "2026-07-25",
        start: "16:15",
        durationMin: 45,
      }),
    ).resolves.toEqual({ error: null });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsertCalls[0].payload).toEqual({
      user_id: "user-1",
      rule_id: "r1",
      occurred_on: "2026-07-25",
      start_time: "16:15:00",
      duration_min: 45,
    });
    expect(upsertCalls[0].opts).toEqual({ onConflict: "rule_id,occurred_on" });
    expect(upsertCalls[0].opts).not.toHaveProperty("ignoreDuplicates");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("allows a future dateKey (no today-guard) and defaults duration to null", async () => {
    const { upsertCalls } = mockClient();

    await expect(
      approveRecurringSlot({ ruleId: "r1", dateKey: "2099-01-01", start: "09:00" }),
    ).resolves.toEqual({ error: null });
    expect(upsertCalls[0].payload.duration_min).toBeNull();
    expect(upsertCalls[0].payload.start_time).toBe("09:00:00");
  });

  test("rejects a bad time and a bad date without writing", async () => {
    const { upsert } = mockClient();

    await expect(
      approveRecurringSlot({ ruleId: "r1", dateKey: "2026-07-25", start: "25:61" }),
    ).resolves.toEqual({ error: "invalid time" });
    await expect(
      approveRecurringSlot({ ruleId: "r1", dateKey: "2026-7-5", start: "09:00" }),
    ).resolves.toEqual({ error: "invalid date" });
    expect(upsert).not.toHaveBeenCalled();
  });

  test("a cross-day move (fromDateKey !== dateKey) deletes the origin row", async () => {
    const { del, deleteCalls } = mockClient();

    await expect(
      approveRecurringSlot({
        ruleId: "r1",
        dateKey: "2026-07-26",
        start: "10:00",
        fromDateKey: "2026-07-25",
      }),
    ).resolves.toEqual({ error: null });

    expect(del).toHaveBeenCalledTimes(1);
    expect(deleteCalls[0].filters).toEqual([
      ["rule_id", "r1"],
      ["occurred_on", "2026-07-25"],
      ["user_id", "user-1"],
    ]);
  });

  test("a same-day 'move' (fromDateKey === dateKey) does not delete", async () => {
    const { del } = mockClient();

    await approveRecurringSlot({
      ruleId: "r1",
      dateKey: "2026-07-25",
      start: "10:00",
      fromDateKey: "2026-07-25",
    });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("clearRecurringSlot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  test("deletes the row scoped by rule_id/occurred_on/user_id and revalidates", async () => {
    const { del, deleteCalls } = mockClient();

    await expect(clearRecurringSlot("r1", "2026-07-25")).resolves.toEqual({
      error: null,
    });
    expect(del).toHaveBeenCalledTimes(1);
    expect(deleteCalls[0].filters).toEqual([
      ["rule_id", "r1"],
      ["occurred_on", "2026-07-25"],
      ["user_id", "user-1"],
    ]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
