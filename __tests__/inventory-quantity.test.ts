import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  QUANTITY_CONTENTION_ERROR,
  QUANTITY_MISSING_ERROR,
  adjustQuantity,
  itemQuantityStore,
  nextQuantity,
  type QuantityStore,
} from "@/app/lib/inventory/quantity";

// ---------- a fake row the store can compare-and-swap against ----------

type FakeRow = { quantity: number };

// `interfere` runs after the read has captured its value but before the caller
// gets to swap — that is exactly the window another tab, phone, or agent writes
// in, and the window the old absolute write silently lost.
function fakeStore(
  row: FakeRow,
  options?: { interfere?: () => void; onSwap?: () => void },
): QuantityStore & { reads: number; swaps: number } {
  const counters = { reads: 0, swaps: 0 };
  return {
    get reads() {
      return counters.reads;
    },
    get swaps() {
      return counters.swaps;
    },
    async read() {
      counters.reads += 1;
      const quantity = row.quantity;
      options?.interfere?.();
      return { ok: true, quantity };
    },
    async swap(expected, next) {
      counters.swaps += 1;
      options?.onSwap?.();
      if (row.quantity !== expected) return { ok: true, swapped: false };
      row.quantity = next;
      return { ok: true, swapped: true };
    },
  };
}

// The pre-fix write path, kept here as the regression the CAS exists to
// prevent: read, do the arithmetic on the client's snapshot, write the absolute
// result unconditionally.
async function absoluteWrite(
  row: FakeRow,
  delta: number,
  interfere: () => void,
): Promise<void> {
  const seen = row.quantity;
  interfere();
  row.quantity = Math.max(0, Math.round((seen + delta) * 1000) / 1000);
}

describe("nextQuantity", () => {
  it("clamps at zero, rounds to 3 decimals, and survives junk", () => {
    const cases: [number, number, number][] = [
      [10, 1, 11],
      [2, -5, 0],
      [0, -1, 0],
      [1, 0.1, 1.1],
      [1.1, 0.2, 1.3],
      [0.1, 0.2, 0.3],
      [1, 0.00049, 1],
      [Number.NaN, 1, 1],
      [5, Number.NaN, 5],
    ];
    for (const [current, delta, expected] of cases) {
      expect(nextQuantity(current, delta)).toBe(expected);
    }
    expect(nextQuantity(Number.POSITIVE_INFINITY, 1)).toBe(0);
  });
});

describe("adjustQuantity", () => {
  it("applies the delta to the live row", async () => {
    const row: FakeRow = { quantity: 4 };
    const store = fakeStore(row);
    const outcome = await adjustQuantity(store, 2);
    expect(outcome).toMatchObject({ ok: true, before: 4, after: 6, attempts: 1 });
    expect(row.quantity).toBe(6);
  });

  it("does not lose a concurrent write the way an absolute write does", async () => {
    // Another surface consumes 3 in the read→write window.
    const consumeThree = (row: FakeRow) => () => {
      row.quantity = row.quantity - 3;
    };

    const stale: FakeRow = { quantity: 10 };
    await absoluteWrite(stale, 1, consumeThree(stale));
    // 10 + 1 written blind: the other surface's -3 is gone forever.
    expect(stale.quantity).toBe(11);

    const guarded: FakeRow = { quantity: 10 };
    let interfered = false;
    const store = fakeStore(guarded, {
      interfere: () => {
        if (interfered) return;
        interfered = true;
        guarded.quantity -= 3;
      },
    });
    const outcome = await adjustQuantity(store, 1);
    expect(outcome.ok).toBe(true);
    // 10 -> 7 (them) -> 8 (us): both writes survive.
    expect(guarded.quantity).toBe(8);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
    expect(store.reads).toBe(2);
    expect(store.swaps).toBe(2);
  });

  it("a seeded expectation skips the first read but still re-reads on a lost race", async () => {
    const clean: FakeRow = { quantity: 5 };
    const cleanStore = fakeStore(clean);
    const hit = await adjustQuantity(cleanStore, -2, { expected: 5 });
    expect(hit).toMatchObject({ ok: true, before: 5, after: 3, attempts: 1 });
    expect(cleanStore.reads).toBe(0);

    // The seed is stale: something moved the row since it was read.
    const moved: FakeRow = { quantity: 9 };
    const movedStore = fakeStore(moved);
    const miss = await adjustQuantity(movedStore, 1, { expected: 5 });
    expect(miss).toMatchObject({ ok: true, before: 9, after: 10, attempts: 2 });
    expect(movedStore.reads).toBe(1);
    expect(moved.quantity).toBe(10);
  });

  it("gives up after a bounded number of attempts instead of looping", async () => {
    const row: FakeRow = { quantity: 1 };
    // The row moves on every single read, so no swap can ever land.
    const store = fakeStore(row, {
      interfere: () => {
        row.quantity += 1;
      },
    });
    const outcome = await adjustQuantity(store, 1, { maxAttempts: 3 });
    expect(outcome).toEqual({
      ok: false,
      error: QUANTITY_CONTENTION_ERROR,
      attempts: 3,
    });
    expect(store.swaps).toBe(3);
  });

  it("never writes past a clamped floor, even under contention", async () => {
    const row: FakeRow = { quantity: 2 };
    let once = false;
    const store = fakeStore(row, {
      interfere: () => {
        if (once) return;
        once = true;
        row.quantity = 1;
      },
    });
    const outcome = await adjustQuantity(store, -5);
    expect(outcome).toMatchObject({ ok: true, before: 1, after: 0 });
    expect(row.quantity).toBe(0);
  });

  it("surfaces read and swap failures verbatim", async () => {
    const readFails: QuantityStore = {
      read: async () => ({ ok: false, error: QUANTITY_MISSING_ERROR }),
      swap: async () => ({ ok: true, swapped: true }),
    };
    expect(await adjustQuantity(readFails, 1)).toEqual({
      ok: false,
      error: QUANTITY_MISSING_ERROR,
      attempts: 1,
    });

    const swapFails: QuantityStore = {
      read: async () => ({ ok: true, quantity: 1 }),
      swap: async () => ({ ok: false, error: "permission denied" }),
    };
    expect(await adjustQuantity(swapFails, 1)).toEqual({
      ok: false,
      error: "permission denied",
      attempts: 1,
    });
  });
});

// ---------- the Supabase-bound store ----------

type StoredRow = {
  user_id: string;
  quantity: number;
  last_restocked_at: string | null;
};

type RecordedCall = {
  table: string;
  op: "select" | "update";
  filters: Record<string, unknown>;
  updates?: Record<string, unknown>;
};

// A postgrest-shaped stub: `.eq()` chains accumulate filters and the terminal
// call applies them, so a CAS predicate that forgets `quantity` (or `user_id`)
// shows up as a matched row it should not have matched.
function fakeClient(
  rows: Map<string, StoredRow>,
  calls: RecordedCall[],
  hooks?: { beforeUpdate?: () => void },
) {
  const matches = (call: RecordedCall, row: StoredRow | undefined): boolean => {
    if (!row) return false;
    if (call.filters.user_id !== undefined && row.user_id !== call.filters.user_id) {
      return false;
    }
    if (call.filters.quantity !== undefined && row.quantity !== call.filters.quantity) {
      return false;
    }
    return true;
  };

  return {
    from(table: string) {
      return {
        select() {
          const call: RecordedCall = { table, op: "select", filters: {} };
          const builder = {
            eq(column: string, value: unknown) {
              call.filters[column] = value;
              return builder;
            },
            async maybeSingle() {
              calls.push(call);
              const row = rows.get(String(call.filters.id));
              if (!matches(call, row)) return { data: null, error: null };
              return { data: { quantity: row!.quantity }, error: null };
            },
          };
          return builder;
        },
        update(updates: Record<string, unknown>) {
          const call: RecordedCall = { table, op: "update", filters: {}, updates };
          const builder = {
            eq(column: string, value: unknown) {
              call.filters[column] = value;
              return builder;
            },
            select() {
              hooks?.beforeUpdate?.();
              calls.push(call);
              const id = String(call.filters.id);
              const row = rows.get(id);
              if (!matches(call, row)) {
                return Promise.resolve({ data: [], error: null });
              }
              Object.assign(row!, updates);
              return Promise.resolve({ data: [{ id }], error: null });
            },
          };
          return builder;
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("itemQuantityStore", () => {
  const NOW = "2026-08-01T12:00:00.000Z";

  it("swaps on id + user_id + the expected quantity, and stamps a restock", async () => {
    const rows = new Map<string, StoredRow>([
      ["i-rice", { user_id: "u-1", quantity: 2, last_restocked_at: null }],
    ]);
    const calls: RecordedCall[] = [];
    const store = itemQuantityStore(fakeClient(rows, calls), "i-rice", "u-1", NOW);

    const outcome = await adjustQuantity(store, 1);
    expect(outcome).toMatchObject({ ok: true, before: 2, after: 3 });
    expect(rows.get("i-rice")).toEqual({
      user_id: "u-1",
      quantity: 3,
      last_restocked_at: NOW,
    });

    const update = calls.find((c) => c.op === "update");
    expect(update?.filters).toEqual({ id: "i-rice", user_id: "u-1", quantity: 2 });
    expect(calls.every((c) => c.filters.user_id === "u-1")).toBe(true);
  });

  it("a decrease does not stamp last_restocked_at", async () => {
    const rows = new Map<string, StoredRow>([
      ["i-rice", { user_id: "u-1", quantity: 2, last_restocked_at: null }],
    ]);
    const store = itemQuantityStore(fakeClient(rows, []), "i-rice", "u-1", NOW);
    await adjustQuantity(store, -1);
    expect(rows.get("i-rice")?.last_restocked_at).toBeNull();
  });

  it("retries against the real row when another writer lands first", async () => {
    const rows = new Map<string, StoredRow>([
      ["i-milk", { user_id: "u-1", quantity: 6, last_restocked_at: null }],
    ]);
    const calls: RecordedCall[] = [];
    let raced = false;
    const client = fakeClient(rows, calls, {
      beforeUpdate: () => {
        if (raced) return;
        raced = true;
        // Another surface drinks 2 between our read and our update.
        rows.get("i-milk")!.quantity = 4;
      },
    });
    const store = itemQuantityStore(client, "i-milk", "u-1", NOW);

    const outcome = await adjustQuantity(store, -1);
    expect(outcome).toMatchObject({ ok: true, before: 4, after: 3 });
    expect(rows.get("i-milk")?.quantity).toBe(3);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(2);
  });

  it("another tenant's row is invisible, not writable", async () => {
    const rows = new Map<string, StoredRow>([
      ["i-theirs", { user_id: "u-2", quantity: 5, last_restocked_at: null }],
    ]);
    const store = itemQuantityStore(
      fakeClient(rows, []),
      "i-theirs",
      "u-1",
      NOW,
    );
    const outcome = await adjustQuantity(store, 3);
    expect(outcome).toMatchObject({ ok: false, error: QUANTITY_MISSING_ERROR });
    expect(rows.get("i-theirs")?.quantity).toBe(5);
  });

  it("a deleted item fails rather than silently doing nothing", async () => {
    const store = itemQuantityStore(
      fakeClient(new Map(), []),
      "i-gone",
      "u-1",
      NOW,
    );
    expect(await adjustQuantity(store, 1)).toMatchObject({
      ok: false,
      error: QUANTITY_MISSING_ERROR,
    });
  });
});
