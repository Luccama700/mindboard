import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveBalance,
  type LedgerRow,
  type ReconciliationAnchor,
} from "./derive";

// Refresh an account's cached accounts.balance from the latest reconciliation
// anchor + later transactions (the single source of truth after migration
// 0022). Called after every transaction insert/edit/delete and after recording
// a new anchor. Works on both the session client (RLS) and the service client
// (explicit scoping) — userId is always filtered explicitly.
//
// `today` is the USER'S date key (YYYY-MM-DD) and is required: derived from the
// UTC process clock instead, a UTC+ user's morning spend looked future-dated and
// deriveBalance silently dropped it. Source it only from todayKey(supabase,
// userId) or todayISO(safeTimeZone(tz)).
export async function recomputeAccountBalance(
  supabase: SupabaseClient,
  userId: string,
  accountId: string,
  today: string,
): Promise<{ error: string | null; balance?: number }> {
  const { data: anchorRow, error: anchorError } = await supabase
    .from("account_reconciliations")
    .select("balance, as_of, created_at")
    .eq("user_id", userId)
    .eq("account_id", accountId)
    .order("as_of", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (anchorError) return { error: anchorError.message };

  const anchor: ReconciliationAnchor | null = anchorRow
    ? {
        balance: Number((anchorRow as { balance: number }).balance),
        as_of: (anchorRow as { as_of: string }).as_of,
        created_at: (anchorRow as { created_at: string }).created_at,
      }
    : null;

  let query = supabase
    .from("balance_changes")
    .select("occurred_at, direction, amount, created_at")
    .eq("user_id", userId)
    .eq("account_id", accountId);
  // Rows dated before the anchor can never move the balance; same-day rows are
  // filtered in deriveBalance by created_at.
  if (anchor) query = query.gte("occurred_at", anchor.as_of);

  const { data: rows, error: rowsError } = await query;
  if (rowsError) return { error: rowsError.message };

  // Exclude future-dated rows from the current balance, on the user's calendar
  // day (see the `today` parameter).
  const balance = deriveBalance(anchor, (rows ?? []) as LedgerRow[], today);

  const { error: updateError } = await supabase
    .from("accounts")
    .update({ balance, updated_at: new Date().toISOString() })
    .eq("id", accountId)
    .eq("user_id", userId);
  if (updateError) return { error: updateError.message };

  return { error: null, balance };
}
