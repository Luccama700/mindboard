// Server-side quantity deltas, shared by the /inventory server action and the
// MCP/assistant executor.
//
// The shelf is written concurrently from a phone, a desktop tab, and agents, so
// a "+1" must never travel as an absolute number computed from one surface's
// snapshot — the last writer would silently erase the others. Instead the delta
// is applied against the value that is actually in the row, via a
// compare-and-swap: UPDATE ... WHERE id = ? AND quantity = <expected>. That is
// atomic in one statement (no migration, no RPC). A concurrent write makes the
// predicate match zero rows; we re-read and retry a bounded number of times.
//
// Recounts ("there are 5") stay absolute by design — that is what a recount
// means. Only add/remove go through here.

import type { SupabaseClient } from "@supabase/supabase-js";

export const MAX_QUANTITY_ATTEMPTS = 4;

export const QUANTITY_CONTENTION_ERROR =
  "the quantity kept changing while saving — try again";

export const QUANTITY_MISSING_ERROR = "item not found";

export const QUANTITY_ARCHIVED_ERROR =
  "that item is not being tracked — restore it first";

// What makes the CAS predicate safe is not rounding (nothing enforces a scale;
// `normalizeQuantity` in app/actions/inventory.ts does not round, and a server
// action is directly callable). It is that `expected` always originates from a
// read of this same column through this same JSON encoding, so it round-trips
// by construction, and `numeric` equality is by value — `eq.5` matches a stored
// `5.000`. Rounding here only keeps the *arithmetic* tidy.
//
// The one way to break that: a `numeric` written out of band (SQL editor,
// migration) with more significant digits than a double can hold. It cannot
// round-trip, so every CAS on that row fails with QUANTITY_CONTENTION_ERROR
// forever. Recoverable by typing an absolute quantity, but undiagnosable from
// the UI — worth knowing before writing quantities by hand.
export function nextQuantity(current: number, delta: number): number {
  const sum = (Number(current) || 0) + (Number(delta) || 0);
  if (!Number.isFinite(sum)) return 0;
  return Math.max(0, Math.round(sum * 1000) / 1000);
}

export type QuantityRead =
  | { ok: true; quantity: number }
  | { ok: false; error: string };

export type QuantitySwap =
  | { ok: true; swapped: boolean }
  | { ok: false; error: string };

export type QuantityStore = {
  read: () => Promise<QuantityRead>;
  // swapped:false means the row moved between the read and the write. It is
  // not an error — it is the signal to re-read and retry.
  swap: (expected: number, next: number) => Promise<QuantitySwap>;
};

export type AdjustOutcome =
  | { ok: true; before: number; after: number; attempts: number }
  | { ok: false; error: string; attempts: number };

// `expected` lets a caller that already read the row (the MCP executor reads
// every touched item up front) skip one round-trip on the first attempt; a lost
// race falls back to a fresh read.
export async function adjustQuantity(
  store: QuantityStore,
  delta: number,
  options?: { expected?: number; maxAttempts?: number },
): Promise<AdjustOutcome> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? MAX_QUANTITY_ATTEMPTS);
  let expected = options?.expected;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (expected === undefined) {
      const read = await store.read();
      if (!read.ok) return { ok: false, error: read.error, attempts: attempt };
      expected = read.quantity;
    }

    const next = nextQuantity(expected, delta);
    const swap = await store.swap(expected, next);
    if (!swap.ok) return { ok: false, error: swap.error, attempts: attempt };
    if (swap.swapped) {
      return { ok: true, before: expected, after: next, attempts: attempt };
    }
    expected = undefined;
  }

  return { ok: false, error: QUANTITY_CONTENTION_ERROR, attempts: maxAttempts };
}

// The Supabase-backed store. Works on both the session client (RLS-scoped) and
// the service client (RLS-bypassing, where the user_id filter IS the tenant
// boundary), so the userId filter is always applied on both statements.
export function itemQuantityStore(
  supabase: SupabaseClient,
  itemId: string,
  userId: string,
  restockedAt: string,
): QuantityStore {
  return {
    async read() {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("quantity, archived")
        .eq("id", itemId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!data) return { ok: false, error: QUANTITY_MISSING_ERROR };
      const row = data as { quantity: number; archived: boolean };
      // The MCP adjust op refuses an archived item at propose time; a stale tab
      // whose shelf still shows a row someone else stopped tracking must get
      // the same answer rather than quietly writing to it.
      if (row.archived) return { ok: false, error: QUANTITY_ARCHIVED_ERROR };
      return { ok: true, quantity: Number(row.quantity) || 0 };
    },
    async swap(expected, next) {
      const updates: Record<string, unknown> = { quantity: next };
      if (next > expected) updates.last_restocked_at = restockedAt;
      const { data, error } = await supabase
        .from("inventory_items")
        .update(updates)
        .eq("id", itemId)
        .eq("user_id", userId)
        .eq("archived", false)
        .eq("quantity", expected)
        .select("id");
      if (error) return { ok: false, error: error.message };
      // An archive landing between the read and the swap misses here, and the
      // retry's read turns it into the archived error.
      return { ok: true, swapped: (data ?? []).length > 0 };
    },
  };
}
