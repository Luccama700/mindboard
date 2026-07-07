// Pure balance derivation for the transactions-first finance model. No React,
// no server imports — unit tested directly (__tests__/finance-derive.test.ts).
//
// Model: an account's balance = its latest reconciliation anchor ("held X at
// end of day D") plus the signed sum of every transaction outside that anchor.
// A transaction is outside the anchor when it is dated after as_of, or dated on
// as_of but recorded after the anchor row was created (so a same-day spend
// logged after a morning balance update still counts). Writers must therefore
// insert transactions BEFORE the anchor that accounts for them.

export type ReconciliationAnchor = {
  balance: number;
  as_of: string; // YYYY-MM-DD, end of day
  created_at: string; // ISO timestamp
};

export type LedgerRow = {
  occurred_at: string; // YYYY-MM-DD
  direction: "in" | "out";
  amount: number;
  created_at: string; // ISO timestamp
};

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function signedAmount(row: Pick<LedgerRow, "direction" | "amount">): number {
  const amount = Number(row.amount) || 0;
  return row.direction === "in" ? amount : -amount;
}

// Whether a row moves the balance relative to the given anchor.
export function rowAfterAnchor(
  anchor: ReconciliationAnchor,
  row: LedgerRow,
): boolean {
  if (row.occurred_at > anchor.as_of) return true;
  if (row.occurred_at < anchor.as_of) return false;
  return row.created_at > anchor.created_at;
}

// Derived balance. With no anchor (should not happen after migration 0022
// seeds one per account) every row counts from a zero base.
export function deriveBalance(
  anchor: ReconciliationAnchor | null,
  rows: LedgerRow[],
): number {
  let balance = anchor ? Number(anchor.balance) || 0 : 0;
  for (const row of rows) {
    if (anchor && !rowAfterAnchor(anchor, row)) continue;
    balance += signedAmount(row);
  }
  return roundCents(balance);
}

// Dedup fingerprint for a transaction. Deliberately excludes the note (merchant
// strings differ between a manual "coffee" log and a statement's card line) and
// the account (scoped by the account_id column in queries). Matches the SQL
// backfill in migration 0022.
export function changeFingerprint(
  occurredAt: string,
  direction: "in" | "out",
  amount: number,
): string {
  return `${occurredAt}|${direction}|${Math.round(amount * 100)}`;
}
