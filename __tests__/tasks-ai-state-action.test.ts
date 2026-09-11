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
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/app/lib/tasks/energy", () => ({
  assignEnergyIfUnset: vi.fn(async () => ({ assigned: null })),
}));
vi.mock("@/app/lib/tasks/lifecycle", () => ({
  completeTaskCascade: vi.fn(),
  reopenTaskCascade: vi.fn(),
  missTaskCascade: vi.fn(),
}));
vi.mock("@/utils/google/calendar", () => ({ createEvent: vi.fn(), updateEvent: vi.fn() }));
vi.mock("@/app/lib/data/settings", () => ({
  getUserPreferences: vi.fn(async () => ({ timezone: "UTC" })),
}));
vi.mock("@/app/lib/mcp/config", () => ({
  ownerUserId: mocks.ownerUserId,
  workerAllowedUserIds: vi.fn(() => []),
}));
vi.mock("@/app/lib/watch/followup", () => ({ queueFollowupFromWatch: vi.fn() }));

import { setTaskAiState } from "@/app/actions/tasks";

type Rec = {
  taskUpdate: Record<string, unknown> | null;
  settingsUpsert: Record<string, unknown> | null;
};

function mockTables(upsertError: { message: string } | null = null): Rec {
  const rec: Rec = { taskUpdate: null, settingsUpsert: null };
  mocks.from.mockImplementation((table: string) => {
    if (table === "tasks") {
      return {
        update: vi.fn((patch: Record<string, unknown>) => {
          rec.taskUpdate = patch;
          return { eq: vi.fn(async () => ({ error: null })) };
        }),
      };
    }
    if (table === "user_settings") {
      return {
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          rec.settingsUpsert = row;
          return { error: upsertError };
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return rec;
}

beforeEach(() => {
  mocks.authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
});
afterEach(() => vi.clearAllMocks());

describe("setTaskAiState", () => {
  test("approving as the owner stamps the run request", async () => {
    mocks.ownerUserId.mockReturnValue("user-1");
    const rec = mockTables();
    const result = await setTaskAiState("t1", "approved");
    expect(result).toEqual({ error: null, stamped: true, stampError: null });
    expect(rec.taskUpdate).toEqual({ ai_state: "approved" });
    expect(rec.settingsUpsert?.user_id).toBe("user-1");
    expect(typeof rec.settingsUpsert?.agent_run_requested_at).toBe("string");
  });

  test("approving as someone else changes the state but does not stamp", async () => {
    mocks.ownerUserId.mockReturnValue("owner");
    const rec = mockTables();
    const result = await setTaskAiState("t1", "approved");
    expect(result).toEqual({ error: null, stamped: false, stampError: null });
    expect(rec.taskUpdate).toEqual({ ai_state: "approved" });
    expect(rec.settingsUpsert).toBeNull();
  });

  test("a failed stamp still lands the state and reports the error", async () => {
    mocks.ownerUserId.mockReturnValue("user-1");
    const rec = mockTables({ message: "boom" });
    const result = await setTaskAiState("t1", "approved");
    expect(result).toEqual({ error: null, stamped: false, stampError: "boom" });
    expect(rec.taskUpdate).toEqual({ ai_state: "approved" });
  });

  test("other states never stamp", async () => {
    mocks.ownerUserId.mockReturnValue("user-1");
    const rec = mockTables();
    await setTaskAiState("t1", "planned");
    await setTaskAiState("t1", null);
    expect(rec.settingsUpsert).toBeNull();
  });
});
