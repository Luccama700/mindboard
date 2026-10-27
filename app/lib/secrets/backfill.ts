import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

// Lazy migration for a column that used to hold a plaintext secret: the first
// read that finds a legacy value re-writes it encrypted.
//
// Best-effort and non-blocking by design. The read that triggered it has
// already succeeded, so a failed backfill costs nothing but a retry on the
// next read — while an awaited one would put a write on the latency path of
// every page that touches the vault or the calendar.
//
// `values` is a thunk, not a record: it is evaluated inside the guarded body
// so that encryption failing (an unconfigured ASSISTANT_KEY_SECRET) cannot
// take down the read it was opportunistically attached to. Nothing here logs,
// because everything it handles is a secret.
//
// `expected` is a compare-and-swap guard: the stored values that were read.
// The update only lands while the row still holds them, so a concurrent write
// (a token refresh between this read and the deferred re-write) is never
// overwritten with the stale value.
export function backfillEncryptedColumns(
  supabase: SupabaseClient,
  table: string,
  userId: string,
  values: () => Record<string, string>,
  expected: Record<string, string> = {},
): void {
  const run = async (): Promise<void> => {
    try {
      let query = supabase.from(table).update(values()).eq("user_id", userId);
      for (const [column, value] of Object.entries(expected)) {
        query = query.eq(column, value);
      }
      await query;
    } catch {
      // Deliberately silent: an opportunistic re-write must never surface.
    }
  };
  try {
    after(() => run());
  } catch {
    // Outside a request scope (a background pass): fire and forget instead.
    void run();
  }
}
