// Pure finance-batch logic for the update_finance write tool, shared by the
// MCP server and the in-app assistant. One batch = one proposal = one confirm.
// This is the statement-import workhorse: Claude reads a screenshot in the
// chat, then sends dated spends/incomes/transfers, category/recurring
// proposals, corrections, and a closing reconcile as ONE confirmable receipt.
//
// Flow mirrors inventory-ops: validateFinanceOps (shape) → resolveFinanceOps
// (names → ids against live rows, duplicate detection via fingerprints, op
// reordering) → resolved ops are stored on the proposal (ids, not names) →
// renderFinanceReceipt (preview). Execution lives in writes.ts.
//
// Ordering invariant: category creates apply first (so later ops can reference
// them), reconciles apply LAST — an anchor must be created after the
// transactions it accounts for (see app/lib/finance/derive.ts).

import { formatMoney } from "@/app/_components/money";
import { changeFingerprint } from "@/app/lib/finance/derive";
import type { Result } from "./validate";

export const MAX_FINANCE_OPS = 60;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_CATEGORY_COLOR = "#B5FF3C";
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type FinanceOp =
  | {
      op: "spend";
      account: string;
      amount: number;
      date: string;
      category?: string;
      note?: string;
      force?: boolean;
    }
  | {
      op: "income";
      account: string;
      amount: number;
      date: string;
      note?: string;
      force?: boolean;
    }
  | {
      op: "transfer";
      from: string;
      to: string;
      amount: number;
      date: string;
      note?: string;
    }
  | { op: "reconcile"; account: string; balance: number; asOf: string }
  | { op: "create_category"; name: string; color?: string }
  | {
      op: "create_recurring";
      name: string;
      amount: number;
      frequency: "monthly" | "weekly" | "daily" | "custom";
      dayOfMonth?: number;
      weekday?: number;
      intervalDays?: number;
      startDate?: string;
      category?: string;
    }
  | {
      op: "adjust";
      changeId: string;
      amount?: number;
      category?: string;
      date?: string;
      note?: string;
      markTransfer?: boolean;
    }
  | { op: "remove"; changeId: string };

// What gets stored on the proposal and executed on confirm. `pendingCategory`
// names a create_category earlier in the same batch; the executor maps it to
// the freshly created id.
export type ResolvedFinanceOp =
  | {
      kind: "spend";
      accountId: string;
      accountName: string;
      currency: string;
      amount: number;
      date: string;
      categoryId: string | null;
      categoryName: string | null;
      pendingCategory: string | null;
      note: string | null;
    }
  | {
      kind: "income";
      accountId: string;
      accountName: string;
      currency: string;
      amount: number;
      date: string;
      note: string | null;
    }
  | {
      kind: "transfer";
      fromId: string;
      fromName: string;
      toId: string;
      toName: string;
      currency: string;
      amount: number;
      date: string;
      note: string | null;
    }
  | {
      kind: "reconcile";
      accountId: string;
      accountName: string;
      currency: string;
      balance: number;
      asOf: string;
    }
  | { kind: "create_category"; name: string; color: string }
  | {
      kind: "create_recurring";
      name: string;
      amount: number;
      frequency: "monthly" | "weekly" | "daily" | "custom";
      dayOfMonth: number | null;
      weekday: number | null;
      intervalDays: number | null;
      startDate: string | null;
      categoryId: string | null;
      categoryName: string | null;
      pendingCategory: string | null;
    }
  | {
      kind: "adjust";
      changeId: string;
      accountId: string;
      label: string;
      // null = leave unchanged
      amount: number | null;
      categoryId: string | null;
      pendingCategory: string | null;
      date: string | null;
      note: string | null;
      markTransfer: boolean | null;
    }
  | { kind: "remove"; changeId: string; accountId: string; label: string }
  // receipt-only: a spend/income that matched an existing row and was dropped
  | { kind: "skip_duplicate"; label: string };

export type ResolvableAccount = {
  id: string;
  name: string;
  currency: string;
};

export type ResolvableCategory = { id: string; name: string };

export type ResolvableRecurring = { id: string; name: string };

// Existing ledger rows: the dedup pool (rows in the batch's date span) plus the
// direct targets of adjust/remove ops.
export type ExistingChange = {
  id: string;
  account_id: string;
  occurred_at: string;
  direction: "in" | "out";
  amount: number;
  note: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cents(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function positiveCents(v: unknown): number | null {
  const n = cents(v);
  if (n === null || n <= 0) return null;
  return n;
}

function refString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return null;
  return v;
}

function noteString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, 200) : null;
}

// ---------- shape validation ----------

export function validateFinanceOps(raw: unknown): Result<FinanceOp[]> {
  const operations = isRecord(raw) ? raw.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: "operations must be a non-empty array" };
  }
  if (operations.length > MAX_FINANCE_OPS) {
    return { ok: false, error: `too many operations (max ${MAX_FINANCE_OPS})` };
  }

  const ops: FinanceOp[] = [];
  for (let i = 0; i < operations.length; i++) {
    const entry = operations[i];
    if (!isRecord(entry)) {
      return { ok: false, error: `operation ${i + 1} must be an object` };
    }
    const at = (msg: string) => `operation ${i + 1} (${String(entry.op)}): ${msg}`;

    switch (entry.op) {
      case "spend":
      case "income": {
        const account = refString(entry.account);
        if (!account) return { ok: false, error: at("account is required") };
        const amount = positiveCents(entry.amount);
        if (amount === null) {
          return { ok: false, error: at("amount must be a positive number") };
        }
        const date = isoDate(entry.date);
        if (!date) return { ok: false, error: at("date must be YYYY-MM-DD") };
        const base = {
          account,
          amount,
          date,
          note: noteString(entry.note) ?? undefined,
          force: entry.force === true ? true : undefined,
        };
        if (entry.op === "spend") {
          ops.push({
            op: "spend",
            ...base,
            category: refString(entry.category) ?? undefined,
          });
        } else {
          ops.push({ op: "income", ...base });
        }
        break;
      }
      case "transfer": {
        const from = refString(entry.from);
        const to = refString(entry.to);
        if (!from || !to) return { ok: false, error: at("from and to are required") };
        const amount = positiveCents(entry.amount);
        if (amount === null) {
          return { ok: false, error: at("amount must be a positive number") };
        }
        const date = isoDate(entry.date);
        if (!date) return { ok: false, error: at("date must be YYYY-MM-DD") };
        ops.push({
          op: "transfer",
          from,
          to,
          amount,
          date,
          note: noteString(entry.note) ?? undefined,
        });
        break;
      }
      case "reconcile": {
        const account = refString(entry.account);
        if (!account) return { ok: false, error: at("account is required") };
        const balance = cents(entry.balance);
        if (balance === null) {
          return { ok: false, error: at("balance must be a number") };
        }
        const asOf = isoDate(entry.asOf);
        if (!asOf) return { ok: false, error: at("asOf must be YYYY-MM-DD") };
        ops.push({ op: "reconcile", account, balance, asOf });
        break;
      }
      case "create_category": {
        const name = refString(entry.name);
        if (!name) return { ok: false, error: at("name is required") };
        if (name.length > 64) return { ok: false, error: at("name too long") };
        if (entry.color !== undefined && (typeof entry.color !== "string" || !HEX.test(entry.color))) {
          return { ok: false, error: at("color must be #rrggbb") };
        }
        ops.push({
          op: "create_category",
          name,
          color: (entry.color as string | undefined) ?? undefined,
        });
        break;
      }
      case "create_recurring": {
        const name = refString(entry.name);
        if (!name) return { ok: false, error: at("name is required") };
        const amount = positiveCents(entry.amount);
        if (amount === null) {
          return { ok: false, error: at("amount must be a positive number") };
        }
        const frequency = entry.frequency;
        if (
          frequency !== "monthly" &&
          frequency !== "weekly" &&
          frequency !== "daily" &&
          frequency !== "custom"
        ) {
          return {
            ok: false,
            error: at("frequency must be monthly, weekly, daily, or custom"),
          };
        }
        const op: Extract<FinanceOp, { op: "create_recurring" }> = {
          op: "create_recurring",
          name,
          amount,
          frequency,
          category: refString(entry.category) ?? undefined,
        };
        if (frequency === "monthly") {
          const day = Math.trunc(Number(entry.dayOfMonth));
          if (!Number.isFinite(day) || day < 1 || day > 31) {
            return { ok: false, error: at("monthly needs dayOfMonth (1-31)") };
          }
          op.dayOfMonth = day;
        } else if (frequency === "weekly") {
          const weekday = Math.trunc(Number(entry.weekday));
          if (!Number.isFinite(weekday) || weekday < 0 || weekday > 6) {
            return { ok: false, error: at("weekly needs weekday (0=sun … 6=sat)") };
          }
          op.weekday = weekday;
        } else if (frequency === "custom") {
          const interval = Math.trunc(Number(entry.intervalDays));
          if (!Number.isFinite(interval) || interval < 1 || interval > 366) {
            return { ok: false, error: at("custom needs intervalDays (1-366)") };
          }
          const startDate = isoDate(entry.startDate);
          if (!startDate) {
            return { ok: false, error: at("custom needs startDate (YYYY-MM-DD)") };
          }
          op.intervalDays = interval;
          op.startDate = startDate;
        }
        ops.push(op);
        break;
      }
      case "adjust": {
        const changeId = refString(entry.changeId);
        if (!changeId) return { ok: false, error: at("changeId is required") };
        const op: Extract<FinanceOp, { op: "adjust" }> = { op: "adjust", changeId };
        if (entry.amount !== undefined) {
          const amount = positiveCents(entry.amount);
          if (amount === null) {
            return { ok: false, error: at("amount must be a positive number") };
          }
          op.amount = amount;
        }
        if (entry.date !== undefined) {
          const date = isoDate(entry.date);
          if (!date) return { ok: false, error: at("date must be YYYY-MM-DD") };
          op.date = date;
        }
        if (entry.category !== undefined) {
          const category = refString(entry.category);
          if (!category) return { ok: false, error: at("category must be a name or id") };
          op.category = category;
        }
        if (entry.note !== undefined) {
          const note = noteString(entry.note);
          if (note === null) return { ok: false, error: at("note must be text") };
          op.note = note;
        }
        if (entry.markTransfer !== undefined) {
          if (typeof entry.markTransfer !== "boolean") {
            return { ok: false, error: at("markTransfer must be a boolean") };
          }
          op.markTransfer = entry.markTransfer;
        }
        if (
          op.amount === undefined &&
          op.date === undefined &&
          op.category === undefined &&
          op.note === undefined &&
          op.markTransfer === undefined
        ) {
          return { ok: false, error: at("nothing to change") };
        }
        ops.push(op);
        break;
      }
      case "remove": {
        const changeId = refString(entry.changeId);
        if (!changeId) return { ok: false, error: at("changeId is required") };
        ops.push({ op: "remove", changeId });
        break;
      }
      default:
        return {
          ok: false,
          error: `operation ${i + 1}: unknown op "${String(entry.op)}" (expected spend/income/transfer/reconcile/create_category/create_recurring/adjust/remove)`,
        };
    }
  }
  return { ok: true, value: ops };
}

// ---------- reference resolution ----------

function resolveNamed<T extends { id: string; name: string }>(
  ref: string,
  pool: T[],
  what: string,
): Result<T> {
  const byId = pool.find((x) => x.id === ref);
  if (byId) return { ok: true, value: byId };

  const needle = ref.toLowerCase();
  const exact = pool.filter((x) => x.name.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      error: `"${ref}" matches multiple ${what}s: ${exact.map((x) => `${x.name} (${x.id})`).join(", ")} — use an id`,
    };
  }

  const partial = pool.filter((x) => x.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, value: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${ref}" is ambiguous: ${partial.map((x) => `${x.name} (${x.id})`).join(", ")} — use an id`,
    };
  }
  return { ok: false, error: `no ${what} matching "${ref}"` };
}

// Category ref → existing id, or the name of a create_category earlier in the
// batch, or an error listing what exists.
function resolveCategoryRef(
  ref: string,
  categories: ResolvableCategory[],
  batchCreates: Set<string>,
): Result<{ categoryId: string | null; categoryName: string | null; pendingCategory: string | null }> {
  const existing = resolveNamed(ref, categories, "category");
  if (existing.ok) {
    return {
      ok: true,
      value: {
        categoryId: existing.value.id,
        categoryName: existing.value.name,
        pendingCategory: null,
      },
    };
  }
  const needle = ref.toLowerCase();
  for (const created of batchCreates) {
    if (created.toLowerCase() === needle) {
      return {
        ok: true,
        value: { categoryId: null, categoryName: created, pendingCategory: created },
      };
    }
  }
  return existing;
}

function changeLabel(row: ExistingChange, currency: string): string {
  const sign = row.direction === "in" ? "+" : "−";
  const note = row.note ? ` "${row.note}"` : "";
  return `${row.occurred_at} ${sign}${formatMoney(Number(row.amount), currency)}${note}`;
}

// Resolves a whole batch or nothing: any ambiguity or miss fails the proposal.
// Spends/incomes colliding with an existing row's fingerprint (same account +
// date + direction + amount) are downgraded to visible skip_duplicate lines
// unless force is set — a missed duplicate corrupts totals silently, a skipped
// real transaction is recoverable with one follow-up.
export function resolveFinanceOps(
  ops: FinanceOp[],
  input: {
    accounts: ResolvableAccount[];
    categories: ResolvableCategory[];
    recurring: ResolvableRecurring[];
    existingChanges: ExistingChange[];
    today: string;
  },
): Result<ResolvedFinanceOp[]> {
  const { accounts, categories, recurring, existingChanges, today } = input;

  const seenFingerprints = new Set(
    existingChanges.map(
      (row) =>
        `${row.account_id}|${changeFingerprint(row.occurred_at, row.direction, Number(row.amount))}`,
    ),
  );
  const fingerprintNotes = new Map(
    existingChanges.map((row) => [
      `${row.account_id}|${changeFingerprint(row.occurred_at, row.direction, Number(row.amount))}`,
      row.note,
    ]),
  );
  const changeById = new Map(existingChanges.map((row) => [row.id, row]));
  const createdCategories = new Set<string>();
  const removedIds = new Set<string>();

  const body: ResolvedFinanceOp[] = [];
  const categoryCreates: ResolvedFinanceOp[] = [];
  const reconciles: ResolvedFinanceOp[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "spend":
      case "income": {
        const account = resolveNamed(op.account, accounts, "account");
        if (!account.ok) return account;
        const direction = op.op === "spend" ? "out" : "in";
        if (op.date > today) {
          return {
            ok: false,
            error: `${op.op} on ${op.date} is in the future — transactions must be dated today or earlier`,
          };
        }

        const key = `${account.value.id}|${changeFingerprint(op.date, direction, op.amount)}`;
        if (seenFingerprints.has(key) && !op.force) {
          const existingNote = fingerprintNotes.get(key);
          body.push({
            kind: "skip_duplicate",
            label: `${op.date} ${direction === "out" ? "−" : "+"}${formatMoney(op.amount, account.value.currency)} on ${account.value.name}${op.note ? ` "${op.note}"` : ""} — matches an existing entry${existingNote ? ` ("${existingNote}")` : ""}; pass force to import anyway`,
          });
          break;
        }
        seenFingerprints.add(key);

        if (op.op === "spend") {
          let categoryId: string | null = null;
          let categoryName: string | null = null;
          let pendingCategory: string | null = null;
          if (op.category) {
            const cat = resolveCategoryRef(op.category, categories, createdCategories);
            if (!cat.ok) return cat;
            ({ categoryId, categoryName, pendingCategory } = cat.value);
          }
          body.push({
            kind: "spend",
            accountId: account.value.id,
            accountName: account.value.name,
            currency: account.value.currency,
            amount: op.amount,
            date: op.date,
            categoryId,
            categoryName,
            pendingCategory,
            note: op.note ?? null,
          });
        } else {
          body.push({
            kind: "income",
            accountId: account.value.id,
            accountName: account.value.name,
            currency: account.value.currency,
            amount: op.amount,
            date: op.date,
            note: op.note ?? null,
          });
        }
        break;
      }
      case "transfer": {
        const from = resolveNamed(op.from, accounts, "account");
        if (!from.ok) return from;
        const to = resolveNamed(op.to, accounts, "account");
        if (!to.ok) return to;
        if (from.value.id === to.value.id) {
          return { ok: false, error: "transfer from and to must differ" };
        }
        if (op.date > today) {
          return {
            ok: false,
            error: `transfer on ${op.date} is in the future — transactions must be dated today or earlier`,
          };
        }
        // both legs join the fingerprint pool so a later spend/income op in the
        // same batch can't silently double-record the same movement
        seenFingerprints.add(
          `${from.value.id}|${changeFingerprint(op.date, "out", op.amount)}`,
        );
        seenFingerprints.add(
          `${to.value.id}|${changeFingerprint(op.date, "in", op.amount)}`,
        );
        body.push({
          kind: "transfer",
          fromId: from.value.id,
          fromName: from.value.name,
          toId: to.value.id,
          toName: to.value.name,
          currency: from.value.currency,
          amount: op.amount,
          date: op.date,
          note: op.note ?? null,
        });
        break;
      }
      case "reconcile": {
        const account = resolveNamed(op.account, accounts, "account");
        if (!account.ok) return account;
        if (op.asOf > today) {
          return { ok: false, error: `reconcile asOf ${op.asOf} is in the future` };
        }
        reconciles.push({
          kind: "reconcile",
          accountId: account.value.id,
          accountName: account.value.name,
          currency: account.value.currency,
          balance: op.balance,
          asOf: op.asOf,
        });
        break;
      }
      case "create_category": {
        const needle = op.name.toLowerCase();
        if (categories.some((c) => c.name.toLowerCase() === needle)) {
          return {
            ok: false,
            error: `category "${op.name}" already exists — reference it instead of creating it`,
          };
        }
        if (createdCategories.has(op.name)) {
          return { ok: false, error: `duplicate create_category for "${op.name}"` };
        }
        // set stores the canonical name; lookups compare lowercased
        for (const created of createdCategories) {
          if (created.toLowerCase() === needle) {
            return { ok: false, error: `duplicate create_category for "${op.name}"` };
          }
        }
        createdCategories.add(op.name);
        categoryCreates.push({
          kind: "create_category",
          name: op.name,
          color: op.color ?? DEFAULT_CATEGORY_COLOR,
        });
        break;
      }
      case "create_recurring": {
        const needle = op.name.toLowerCase();
        if (recurring.some((r) => r.name.toLowerCase() === needle)) {
          return {
            ok: false,
            error: `recurring expense "${op.name}" already exists — adjust it in the app instead`,
          };
        }
        let categoryId: string | null = null;
        let categoryName: string | null = null;
        let pendingCategory: string | null = null;
        if (op.category) {
          const cat = resolveCategoryRef(op.category, categories, createdCategories);
          if (!cat.ok) return cat;
          ({ categoryId, categoryName, pendingCategory } = cat.value);
        }
        body.push({
          kind: "create_recurring",
          name: op.name,
          amount: op.amount,
          frequency: op.frequency,
          dayOfMonth: op.dayOfMonth ?? null,
          weekday: op.weekday ?? null,
          intervalDays: op.intervalDays ?? null,
          startDate: op.startDate ?? null,
          categoryId,
          categoryName,
          pendingCategory,
        });
        break;
      }
      case "adjust": {
        const row = changeById.get(op.changeId);
        if (!row) {
          return {
            ok: false,
            error: `no ledger row with id ${op.changeId} — find ids via list_recent_ledger`,
          };
        }
        if (removedIds.has(op.changeId)) {
          return { ok: false, error: `row ${op.changeId} is removed earlier in this batch` };
        }
        if (op.date && op.date > today) {
          return { ok: false, error: `adjust date ${op.date} is in the future` };
        }
        const account = accounts.find((a) => a.id === row.account_id);
        const currency = account?.currency ?? "USD";
        let categoryId: string | null = null;
        let pendingCategory: string | null = null;
        if (op.category) {
          const cat = resolveCategoryRef(op.category, categories, createdCategories);
          if (!cat.ok) return cat;
          categoryId = cat.value.categoryId;
          pendingCategory = cat.value.pendingCategory;
        }
        body.push({
          kind: "adjust",
          changeId: op.changeId,
          accountId: row.account_id,
          label: changeLabel(row, currency),
          amount: op.amount ?? null,
          categoryId,
          pendingCategory,
          date: op.date ?? null,
          note: op.note ?? null,
          markTransfer: op.markTransfer ?? null,
        });
        break;
      }
      case "remove": {
        const row = changeById.get(op.changeId);
        if (!row) {
          return {
            ok: false,
            error: `no ledger row with id ${op.changeId} — find ids via list_recent_ledger`,
          };
        }
        if (removedIds.has(op.changeId)) {
          return { ok: false, error: `row ${op.changeId} is removed twice in this batch` };
        }
        removedIds.add(op.changeId);
        const account = accounts.find((a) => a.id === row.account_id);
        body.push({
          kind: "remove",
          changeId: op.changeId,
          accountId: row.account_id,
          label: changeLabel(row, account?.currency ?? "USD"),
        });
        break;
      }
    }
  }

  return { ok: true, value: [...categoryCreates, ...body, ...reconciles] };
}

// ---------- receipt preview ----------

function recurrenceLabel(op: {
  frequency: "monthly" | "weekly" | "daily" | "custom";
  dayOfMonth: number | null;
  weekday: number | null;
  intervalDays: number | null;
  startDate: string | null;
}): string {
  if (op.frequency === "monthly") return `monthly on day ${op.dayOfMonth}`;
  if (op.frequency === "weekly") return `weekly on ${WEEKDAY_NAMES[op.weekday ?? 0]}`;
  if (op.frequency === "daily") return "daily";
  return `every ${op.intervalDays} days from ${op.startDate}`;
}

export function financeReceiptLine(op: ResolvedFinanceOp): string {
  switch (op.kind) {
    case "spend": {
      const category = op.categoryName ?? op.pendingCategory ?? "uncategorized";
      const note = op.note ? ` "${op.note}"` : "";
      return `${op.date}  ${op.accountName}  −${formatMoney(op.amount, op.currency)}  ${category}${note}`;
    }
    case "income": {
      const note = op.note ? ` "${op.note}"` : "";
      return `${op.date}  ${op.accountName}  +${formatMoney(op.amount, op.currency)}  income${note}`;
    }
    case "transfer": {
      const note = op.note ? ` "${op.note}"` : "";
      return `${op.date}  ${op.fromName} → ${op.toName}  ${formatMoney(op.amount, op.currency)}  transfer${note}`;
    }
    case "reconcile":
      return `${op.accountName}  reconcile to ${formatMoney(op.balance, op.currency)} as of ${op.asOf}`;
    case "create_category":
      return `new category "${op.name}"`;
    case "create_recurring":
      return `new recurring "${op.name}"  ${formatMoney(op.amount, "USD")} ${recurrenceLabel(op)}${op.categoryName ?? op.pendingCategory ? `  ${op.categoryName ?? op.pendingCategory}` : ""}`;
    case "adjust": {
      const edits: string[] = [];
      if (op.amount !== null) edits.push(`amount → ${op.amount}`);
      if (op.date !== null) edits.push(`date → ${op.date}`);
      if (op.categoryId !== null || op.pendingCategory !== null) edits.push("recategorized");
      if (op.note !== null) edits.push(`note → "${op.note}"`);
      if (op.markTransfer !== null) {
        edits.push(op.markTransfer ? "→ transfer (not spending)" : "→ regular spending");
      }
      return `edit ${op.label}: ${edits.join(", ")}`;
    }
    case "remove":
      return `delete ${op.label}`;
    case "skip_duplicate":
      return `skipped ${op.label}`;
  }
}

export function renderFinanceReceipt(ops: ResolvedFinanceOp[]): string {
  return ops.map(financeReceiptLine).join("\n");
}

// ---------- structural re-validation at execute time ----------
// The stored shape is ours, but the audit row is data — never trust it blindly.

export function validateResolvedFinanceOps(raw: unknown): Result<ResolvedFinanceOp[]> {
  const operations = isRecord(raw) ? raw.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: "stored proposal has no operations" };
  }
  if (operations.length > MAX_FINANCE_OPS) {
    return { ok: false, error: "stored proposal has too many operations" };
  }

  const ops: ResolvedFinanceOp[] = [];
  for (const entry of operations) {
    if (!isRecord(entry)) return { ok: false, error: "malformed stored operation" };
    switch (entry.kind) {
      case "spend": {
        const amount = positiveCents(entry.amount);
        const date = isoDate(entry.date);
        if (typeof entry.accountId !== "string" || amount === null || !date) {
          return { ok: false, error: "malformed spend operation" };
        }
        ops.push({
          kind: "spend",
          accountId: entry.accountId,
          accountName: String(entry.accountName ?? ""),
          currency: String(entry.currency ?? "USD"),
          amount,
          date,
          categoryId: typeof entry.categoryId === "string" ? entry.categoryId : null,
          categoryName: typeof entry.categoryName === "string" ? entry.categoryName : null,
          pendingCategory:
            typeof entry.pendingCategory === "string" ? entry.pendingCategory : null,
          note: typeof entry.note === "string" ? entry.note : null,
        });
        break;
      }
      case "income": {
        const amount = positiveCents(entry.amount);
        const date = isoDate(entry.date);
        if (typeof entry.accountId !== "string" || amount === null || !date) {
          return { ok: false, error: "malformed income operation" };
        }
        ops.push({
          kind: "income",
          accountId: entry.accountId,
          accountName: String(entry.accountName ?? ""),
          currency: String(entry.currency ?? "USD"),
          amount,
          date,
          note: typeof entry.note === "string" ? entry.note : null,
        });
        break;
      }
      case "transfer": {
        const amount = positiveCents(entry.amount);
        const date = isoDate(entry.date);
        if (
          typeof entry.fromId !== "string" ||
          typeof entry.toId !== "string" ||
          amount === null ||
          !date
        ) {
          return { ok: false, error: "malformed transfer operation" };
        }
        ops.push({
          kind: "transfer",
          fromId: entry.fromId,
          fromName: String(entry.fromName ?? ""),
          toId: entry.toId,
          toName: String(entry.toName ?? ""),
          currency: String(entry.currency ?? "USD"),
          amount,
          date,
          note: typeof entry.note === "string" ? entry.note : null,
        });
        break;
      }
      case "reconcile": {
        const balance = cents(entry.balance);
        const asOf = isoDate(entry.asOf);
        if (typeof entry.accountId !== "string" || balance === null || !asOf) {
          return { ok: false, error: "malformed reconcile operation" };
        }
        ops.push({
          kind: "reconcile",
          accountId: entry.accountId,
          accountName: String(entry.accountName ?? ""),
          currency: String(entry.currency ?? "USD"),
          balance,
          asOf,
        });
        break;
      }
      case "create_category": {
        const name = refString(entry.name);
        if (!name || typeof entry.color !== "string" || !HEX.test(entry.color)) {
          return { ok: false, error: "malformed create_category operation" };
        }
        ops.push({ kind: "create_category", name, color: entry.color });
        break;
      }
      case "create_recurring": {
        const name = refString(entry.name);
        const amount = positiveCents(entry.amount);
        const frequency = entry.frequency;
        if (
          !name ||
          amount === null ||
          (frequency !== "monthly" &&
            frequency !== "weekly" &&
            frequency !== "daily" &&
            frequency !== "custom")
        ) {
          return { ok: false, error: "malformed create_recurring operation" };
        }
        ops.push({
          kind: "create_recurring",
          name,
          amount,
          frequency,
          dayOfMonth: typeof entry.dayOfMonth === "number" ? entry.dayOfMonth : null,
          weekday: typeof entry.weekday === "number" ? entry.weekday : null,
          intervalDays: typeof entry.intervalDays === "number" ? entry.intervalDays : null,
          startDate: typeof entry.startDate === "string" ? entry.startDate : null,
          categoryId: typeof entry.categoryId === "string" ? entry.categoryId : null,
          categoryName: typeof entry.categoryName === "string" ? entry.categoryName : null,
          pendingCategory:
            typeof entry.pendingCategory === "string" ? entry.pendingCategory : null,
        });
        break;
      }
      case "adjust": {
        if (typeof entry.changeId !== "string" || typeof entry.accountId !== "string") {
          return { ok: false, error: "malformed adjust operation" };
        }
        const amount = entry.amount === null || entry.amount === undefined ? null : positiveCents(entry.amount);
        if (entry.amount !== null && entry.amount !== undefined && amount === null) {
          return { ok: false, error: "malformed adjust operation" };
        }
        const date = entry.date === null || entry.date === undefined ? null : isoDate(entry.date);
        if (entry.date !== null && entry.date !== undefined && date === null) {
          return { ok: false, error: "malformed adjust operation" };
        }
        ops.push({
          kind: "adjust",
          changeId: entry.changeId,
          accountId: entry.accountId,
          label: String(entry.label ?? ""),
          amount,
          categoryId: typeof entry.categoryId === "string" ? entry.categoryId : null,
          pendingCategory:
            typeof entry.pendingCategory === "string" ? entry.pendingCategory : null,
          date,
          note: typeof entry.note === "string" ? entry.note : null,
          markTransfer:
            typeof entry.markTransfer === "boolean" ? entry.markTransfer : null,
        });
        break;
      }
      case "remove": {
        if (typeof entry.changeId !== "string" || typeof entry.accountId !== "string") {
          return { ok: false, error: "malformed remove operation" };
        }
        ops.push({
          kind: "remove",
          changeId: entry.changeId,
          accountId: entry.accountId,
          label: String(entry.label ?? ""),
        });
        break;
      }
      case "skip_duplicate": {
        ops.push({ kind: "skip_duplicate", label: String(entry.label ?? "") });
        break;
      }
      default:
        return { ok: false, error: "malformed stored operation kind" };
    }
  }
  return { ok: true, value: ops };
}

// Date span the propose step needs for the dedup pool: [min, max] over every
// dated op, or null when the batch has none (pure edits).
export function financeOpsDateSpan(ops: FinanceOp[]): { min: string; max: string } | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const op of ops) {
    const date =
      op.op === "spend" || op.op === "income" || op.op === "transfer"
        ? op.date
        : null;
    if (!date) continue;
    if (min === null || date < min) min = date;
    if (max === null || date > max) max = date;
  }
  return min && max ? { min, max } : null;
}
