import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  from: vi.fn(),
  revalidatePath: vi.fn(),
  createEvent: vi.fn(),
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

vi.mock("@/utils/google/calendar", () => ({
  createEvent: mocks.createEvent,
}));

vi.mock("@/app/lib/data/settings", () => ({
  getUserPreferences: vi.fn(async () => ({ timezone: "America/Vancouver" })),
}));

import {
  approveRecurringSlot,
  clearRecurringSlot,
  promoteRecurringToEvent,
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

describe("promoteRecurringToEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  function mockPromoteClient(
    ruleRow: Record<string, unknown> | null = {
      id: "r1",
      group_id: "g1",
      groups: { google_calendar_id: "cal-group" },
    },
  ) {
    const upserts: { table: string; payload: Record<string, unknown>; opts: unknown }[] = [];
    const single = vi.fn(async () => ({ data: ruleRow, error: null }));
    mocks.from.mockImplementation((table: string) => {
      if (table === "recurring_tasks") {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          single,
        };
        return chain;
      }
      return {
        upsert: vi.fn(async (payload: Record<string, unknown>, opts: unknown) => {
          upserts.push({ table, payload, opts });
          return { error: null };
        }),
      };
    });
    return { upserts, single };
  }

  test("rejects bad input without touching Google or the DB", async () => {
    mockPromoteClient();
    const base = {
      ruleId: "r1",
      occurredOn: "2026-07-31",
      title: "lunch w/ Ana",
      start: "12:30",
      durationMin: 60,
    };

    await expect(
      promoteRecurringToEvent({ ...base, occurredOn: "2026-7-31" }),
    ).resolves.toEqual({ error: "invalid date" });
    await expect(
      promoteRecurringToEvent({ ...base, start: "25:00" }),
    ).resolves.toEqual({ error: "invalid time" });
    await expect(
      promoteRecurringToEvent({ ...base, title: "   " }),
    ).resolves.toEqual({ error: "give the event a title" });
    await expect(
      promoteRecurringToEvent({ ...base, durationMin: 10 }),
    ).resolves.toEqual({ error: "duration must be 15+ minutes" });

    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  test("creates the event on the group's linked calendar and links the slot", async () => {
    const { upserts } = mockPromoteClient();
    mocks.createEvent.mockResolvedValue("evt-1");

    await expect(
      promoteRecurringToEvent({
        ruleId: "r1",
        occurredOn: "2026-07-31",
        title: "lunch w/ Ana",
        start: "12:30",
        durationMin: 60,
      }),
    ).resolves.toEqual({ error: null });

    expect(mocks.createEvent).toHaveBeenCalledWith("user-1", "cal-group", {
      summary: "lunch w/ Ana",
      start: { dateTime: "2026-07-31T12:30:00", timeZone: "America/Vancouver" },
      end: { dateTime: "2026-07-31T13:30:00", timeZone: "America/Vancouver" },
      description: "from mindboard routine",
    });

    const slotUpsert = upserts.find((u) => u.table === "recurring_task_slots");
    expect(slotUpsert?.payload).toEqual({
      user_id: "user-1",
      rule_id: "r1",
      occurred_on: "2026-07-31",
      start_time: "12:30:00",
      duration_min: 60,
      gcal_event_id: "evt-1",
      gcal_calendar_id: "cal-group",
    });
    expect(slotUpsert?.opts).toEqual({ onConflict: "rule_id,occurred_on" });

    const doneUpsert = upserts.find(
      (u) => u.table === "recurring_task_completions",
    );
    expect(doneUpsert?.payload).toEqual({
      user_id: "user-1",
      rule_id: "r1",
      occurred_on: "2026-07-31",
    });
    expect(doneUpsert?.opts).toEqual({
      onConflict: "rule_id,occurred_on",
      ignoreDuplicates: true,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("falls back to the primary calendar when the group has no link", async () => {
    mockPromoteClient({ id: "r1", group_id: null, groups: null });
    mocks.createEvent.mockResolvedValue("evt-2");

    await promoteRecurringToEvent({
      ruleId: "r1",
      occurredOn: "2026-07-31",
      title: "lunch",
      start: "12:00",
      durationMin: 30,
    });
    expect(mocks.createEvent).toHaveBeenCalledWith(
      "user-1",
      "primary",
      expect.anything(),
    );
  });

  test("a Google failure surfaces as the error and writes nothing", async () => {
    const { upserts } = mockPromoteClient();
    mocks.createEvent.mockRejectedValue(new Error("google says no"));

    await expect(
      promoteRecurringToEvent({
        ruleId: "r1",
        occurredOn: "2026-07-31",
        title: "lunch",
        start: "12:00",
        durationMin: 30,
      }),
    ).resolves.toEqual({ error: "google says no" });
    expect(upserts).toEqual([]);
  });
});
