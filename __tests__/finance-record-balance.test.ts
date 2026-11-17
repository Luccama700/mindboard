import { beforeEach, describe, expect, test, vi } from "vitest";

// recordBalanceChange against a fake account whose stored balance is the truth.
// The capture surfaces used to send `newBalance = their copy - spent`, and a
// stale copy turned a spend into the wrong amount or even income.

const db = vi.hoisted(() => ({
  balance: 100,
  inserted: [] as Record<string, unknown>[],
  anchors: [] as Record<string, unknown>[],
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/lib/mcp/config", () => ({ todayKey: vi.fn(async () => "2026-11-17") }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      if (table === "accounts") {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: { id: "a1", balance: db.balance }, error: null }) }),
          }),
          update: (row: { balance: number }) => ({
            eq: async () => {
              db.balance = row.balance;
              return { error: null };
            },
          }),
        };
      }
      if (table === "balance_changes") {
        return {
          insert: (row: Record<string, unknown>) => {
            db.inserted.push(row);
            return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
          },
        };
      }
      if (table === "account_reconciliations") {
        return {
          insert: async (row: Record<string, unknown>) => {
            db.anchors.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { recordBalanceChange } from "@/app/actions/finance";

beforeEach(() => {
  db.balance = 100;
  db.inserted = [];
  db.anchors = [];
});

describe("recordBalanceChange by amount spent", () => {
  test("a spend is taken off the STORED balance, whatever the client last saw", async () => {
    // The client thinks the balance is 100, but another device already spent 50.
    db.balance = 50;
    const result = await recordBalanceChange({ accountId: "a1", spent: 12 });
    expect(result.error).toBeNull();
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({ direction: "out", amount: 12 });
    expect(db.balance).toBe(38);
  });

  test("the old absolute path still works", async () => {
    const result = await recordBalanceChange({ accountId: "a1", newBalance: 80 });
    expect(result.error).toBeNull();
    expect(db.inserted[0]).toMatchObject({ direction: "out", amount: 20 });
    expect(db.balance).toBe(80);
  });

  test("needs exactly one of spent and newBalance, and a positive spend", async () => {
    expect((await recordBalanceChange({ accountId: "a1" })).error).toBeTruthy();
    expect((await recordBalanceChange({ accountId: "a1", spent: 5, newBalance: 10 })).error).toBeTruthy();
    expect((await recordBalanceChange({ accountId: "a1", spent: 0 })).error).toBeTruthy();
    expect((await recordBalanceChange({ accountId: "a1", spent: -3 })).error).toBeTruthy();
    expect(db.inserted).toHaveLength(0);
  });
});

describe("recordBalanceChange dates", () => {
  test("a future date is refused, so the anchor can never be subtracted twice", async () => {
    const result = await recordBalanceChange({
      accountId: "a1",
      newBalance: 80,
      occurredAt: "2026-11-18",
    });
    expect(result.error).toMatch(/future/);
    expect(db.inserted).toHaveLength(0);
    expect(db.balance).toBe(100);
  });

  test("today and past dates are still fine", async () => {
    expect((await recordBalanceChange({ accountId: "a1", newBalance: 90, occurredAt: "2026-11-17" })).error).toBeNull();
    expect((await recordBalanceChange({ accountId: "a1", newBalance: 80, occurredAt: "2026-11-01" })).error).toBeNull();
  });
});
