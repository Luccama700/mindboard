// Pure batch logic for manage_finance — finance CONFIGURATION edits (accounts,
// categories, recurring-expense rules, income sources, spend overrides), as
// opposed to update_finance which owns ledger rows. Same shape as
// inventory-ops.ts: validate (shape) → resolve (names → ids against live rows)
// → the resolved ops are stored on the proposal → renderAdminReceipt (preview).
// Execution lives in writes.ts.

import { formatMoney } from "@/app/_components/money";
import type { Result } from "./validate";

export const MAX_ADMIN_OPS = 20;

const HEX = /^#[0-9a-fA-F]{6}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ADMIN_ACCOUNT_TYPES = [
  "checking",
  "savings",
  "cash",
  "credit",
  "investment",
  "other",
] as const;
export type AdminAccountType = (typeof ADMIN_ACCOUNT_TYPES)[number];

const FREQUENCIES = ["monthly", "weekly", "daily", "custom"] as const;
type Frequency = (typeof FREQUENCIES)[number];

const PAY_FREQUENCIES = ["weekly", "biweekly", "monthly"] as const;
type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export type FinanceAdminOp =
  | {
      op: "create_account";
      name: string;
      type: AdminAccountType;
      color?: string;
      currency?: string;
      balance: number;
    }
  | {
      op: "update_account";
      account: string;
      name?: string;
      type?: AdminAccountType;
      color?: string;
      archived?: boolean;
    }
  | {
      op: "update_category";
      category: string;
      name?: string;
      color?: string;
      archived?: boolean;
    }
  | {
      op: "update_recurring";
      rule: string;
      name?: string;
      amount?: number;
      category?: string | null;
      frequency?: Frequency;
      dayOfMonth?: number;
      weekday?: number;
      intervalDays?: number;
      startDate?: string;
      archived?: boolean;
    }
  | {
      op: "create_income";
      name: string;
      hourlyWage: number;
      taxRate: number;
      calendarId?: string;
      color?: string;
      payFrequency?: PayFrequency;
      anchorPayday?: string;
      periodStart?: string;
      periodEnd?: string;
    }
  | {
      op: "update_income";
      source: string;
      name?: string;
      hourlyWage?: number;
      taxRate?: number;
      calendarId?: string | null;
      color?: string;
      archived?: boolean;
      payFrequency?: PayFrequency | null;
      anchorPayday?: string;
      periodStart?: string;
      periodEnd?: string;
    }
  | { op: "set_spend_override"; date: string; amount: number | null }
  | { op: "set_daily_spend_estimate"; amount: number | null };

export type ResolvedAdminOp =
  | {
      kind: "create_account";
      name: string;
      type: AdminAccountType;
      color: string;
      currency: string;
      balance: number;
    }
  | {
      kind: "update_account";
      accountId: string;
      accountName: string;
      name: string | null;
      type: AdminAccountType | null;
      color: string | null;
      archived: boolean | null;
    }
  | {
      kind: "update_category";
      categoryId: string;
      categoryName: string;
      name: string | null;
      color: string | null;
      archived: boolean | null;
    }
  | {
      kind: "update_recurring";
      ruleId: string;
      ruleName: string;
      name: string | null;
      amount: number | null;
      categoryId: string | null;
      categoryName: string | null;
      clearCategory: boolean;
      frequency: Frequency | null;
      dayOfMonth: number | null;
      weekday: number | null;
      intervalDays: number | null;
      startDate: string | null;
      archived: boolean | null;
    }
  | {
      kind: "create_income";
      name: string;
      hourlyWage: number;
      taxRate: number;
      calendarId: string | null;
      color: string;
      payFrequency: PayFrequency | null;
      anchorPayday: string | null;
      periodStart: string | null;
      periodEnd: string | null;
    }
  | {
      kind: "update_income";
      sourceId: string;
      sourceName: string;
      name: string | null;
      hourlyWage: number | null;
      taxRate: number | null;
      calendarId: string | null;
      clearCalendar: boolean;
      color: string | null;
      archived: boolean | null;
      schedule:
        | { payFrequency: PayFrequency; anchorPayday: string; periodStart: string; periodEnd: string }
        | "clear"
        | null;
    }
  | { kind: "set_spend_override"; date: string; amount: number | null }
  | { kind: "set_daily_spend_estimate"; amount: number | null };

export type ResolvableRef = { id: string; name: string };

export type AdminResolveContext = {
  accounts: ResolvableRef[];
  categories: ResolvableRef[];
  recurring: ResolvableRef[];
  incomeSources: ResolvableRef[];
  today: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cents(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function refString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function matchRef(
  ref: string,
  pool: ResolvableRef[],
  what: string,
): Result<ResolvableRef> {
  const byId = pool.find((r) => r.id === ref);
  if (byId) return { ok: true, value: byId };
  const needle = ref.toLowerCase();
  const exact = pool.filter((r) => r.name.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      error: `"${ref}" matches multiple ${what}s: ${exact.map((r) => `${r.name} (${r.id})`).join(", ")} — use an id`,
    };
  }
  const partial = pool.filter((r) => r.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, value: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${ref}" is ambiguous: ${partial.map((r) => `${r.name} (${r.id})`).join(", ")} — use an id`,
    };
  }
  return { ok: false, error: `no ${what} matching "${ref}"` };
}

// A recurrence patch must be all-or-nothing: frequency plus the fields that
// frequency needs. Mirrors updateRecurringExpense in app/actions/finance.ts.
function recurrencePatch(
  entry: Record<string, unknown>,
  label: string,
): Result<{
  frequency: Frequency;
  dayOfMonth: number | null;
  weekday: number | null;
  intervalDays: number | null;
  startDate: string | null;
}> {
  const frequency = entry.frequency;
  if (!FREQUENCIES.includes(frequency as Frequency)) {
    return { ok: false, error: `${label}: frequency must be monthly, weekly, daily, or custom` };
  }
  let dayOfMonth: number | null = null;
  let weekday: number | null = null;
  let intervalDays: number | null = null;
  let startDate: string | null = null;
  if (frequency === "monthly") {
    const d = Math.trunc(Number(entry.dayOfMonth));
    if (!Number.isInteger(d) || d < 1 || d > 31) {
      return { ok: false, error: `${label}: monthly needs dayOfMonth (1-31)` };
    }
    dayOfMonth = d;
  } else if (frequency === "weekly") {
    const w = Math.trunc(Number(entry.weekday));
    if (!Number.isInteger(w) || w < 0 || w > 6) {
      return { ok: false, error: `${label}: weekly needs weekday (0=sun … 6=sat)` };
    }
    weekday = w;
  } else if (frequency === "custom") {
    const n = Math.trunc(Number(entry.intervalDays));
    if (!Number.isInteger(n) || n < 1 || n > 366) {
      return { ok: false, error: `${label}: custom needs intervalDays (1-366)` };
    }
    intervalDays = n;
    const start = refString(entry.startDate);
    if (!start || !ISO_DATE.test(start)) {
      return { ok: false, error: `${label}: custom needs startDate (YYYY-MM-DD)` };
    }
    startDate = start;
  }
  return {
    ok: true,
    value: { frequency: frequency as Frequency, dayOfMonth, weekday, intervalDays, startDate },
  };
}

// A pay schedule is all-or-nothing (mirrors normalizeSchedule in actions).
function payShedulePatch(
  entry: Record<string, unknown>,
  label: string,
): Result<
  | { payFrequency: PayFrequency; anchorPayday: string; periodStart: string; periodEnd: string }
  | "clear"
> {
  if (entry.payFrequency === null) return { ok: true, value: "clear" };
  const frequency = entry.payFrequency;
  if (!PAY_FREQUENCIES.includes(frequency as PayFrequency)) {
    return { ok: false, error: `${label}: payFrequency must be weekly, biweekly, or monthly (or null to clear)` };
  }
  const anchorPayday = refString(entry.anchorPayday);
  const periodStart = refString(entry.periodStart);
  const periodEnd = refString(entry.periodEnd);
  for (const v of [anchorPayday, periodStart, periodEnd]) {
    if (!v || !ISO_DATE.test(v)) {
      return {
        ok: false,
        error: `${label}: a pay schedule needs anchorPayday, periodStart, and periodEnd (YYYY-MM-DD)`,
      };
    }
  }
  return {
    ok: true,
    value: {
      payFrequency: frequency as PayFrequency,
      anchorPayday: anchorPayday as string,
      periodStart: periodStart as string,
      periodEnd: periodEnd as string,
    },
  };
}

// ---------- shape validation ----------

export function validateAdminOps(raw: unknown): Result<FinanceAdminOp[]> {
  const operations = isRecord(raw) ? raw.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: "operations must be a non-empty array" };
  }
  if (operations.length > MAX_ADMIN_OPS) {
    return { ok: false, error: `too many operations (max ${MAX_ADMIN_OPS})` };
  }

  const ops: FinanceAdminOp[] = [];
  for (let i = 0; i < operations.length; i++) {
    const entry = operations[i];
    if (!isRecord(entry)) {
      return { ok: false, error: `operation ${i + 1} must be an object` };
    }
    const label = `operation ${i + 1} (${String(entry.op)})`;
    switch (entry.op) {
      case "create_account": {
        const name = refString(entry.name);
        if (!name) return { ok: false, error: `${label}: name is required` };
        if (!ADMIN_ACCOUNT_TYPES.includes(entry.type as AdminAccountType)) {
          return { ok: false, error: `${label}: type must be one of ${ADMIN_ACCOUNT_TYPES.join("/")}` };
        }
        if (entry.color !== undefined && (typeof entry.color !== "string" || !HEX.test(entry.color))) {
          return { ok: false, error: `${label}: color must be #rrggbb` };
        }
        const balance = cents(entry.balance);
        if (balance === null) return { ok: false, error: `${label}: balance is required (negative for credit debt)` };
        ops.push({
          op: "create_account",
          name,
          type: entry.type as AdminAccountType,
          color: entry.color as string | undefined,
          currency: refString(entry.currency) ?? undefined,
          balance,
        });
        break;
      }
      case "update_account": {
        const account = refString(entry.account);
        if (!account) return { ok: false, error: `${label}: account is required` };
        const patch: Extract<FinanceAdminOp, { op: "update_account" }> = {
          op: "update_account",
          account,
        };
        if (entry.name !== undefined) {
          const name = refString(entry.name);
          if (!name) return { ok: false, error: `${label}: name cannot be empty` };
          patch.name = name;
        }
        if (entry.type !== undefined) {
          if (!ADMIN_ACCOUNT_TYPES.includes(entry.type as AdminAccountType)) {
            return { ok: false, error: `${label}: invalid type` };
          }
          patch.type = entry.type as AdminAccountType;
        }
        if (entry.color !== undefined) {
          if (typeof entry.color !== "string" || !HEX.test(entry.color)) {
            return { ok: false, error: `${label}: color must be #rrggbb` };
          }
          patch.color = entry.color;
        }
        if (entry.archived !== undefined) {
          if (typeof entry.archived !== "boolean") {
            return { ok: false, error: `${label}: archived must be true or false` };
          }
          patch.archived = entry.archived;
        }
        if (patch.name === undefined && patch.type === undefined && patch.color === undefined && patch.archived === undefined) {
          return { ok: false, error: `${label}: nothing to change` };
        }
        ops.push(patch);
        break;
      }
      case "update_category": {
        const category = refString(entry.category);
        if (!category) return { ok: false, error: `${label}: category is required` };
        const patch: Extract<FinanceAdminOp, { op: "update_category" }> = {
          op: "update_category",
          category,
        };
        if (entry.name !== undefined) {
          const name = refString(entry.name);
          if (!name) return { ok: false, error: `${label}: name cannot be empty` };
          patch.name = name;
        }
        if (entry.color !== undefined) {
          if (typeof entry.color !== "string" || !HEX.test(entry.color)) {
            return { ok: false, error: `${label}: color must be #rrggbb` };
          }
          patch.color = entry.color;
        }
        if (entry.archived !== undefined) {
          if (typeof entry.archived !== "boolean") {
            return { ok: false, error: `${label}: archived must be true or false` };
          }
          patch.archived = entry.archived;
        }
        if (patch.name === undefined && patch.color === undefined && patch.archived === undefined) {
          return { ok: false, error: `${label}: nothing to change` };
        }
        ops.push(patch);
        break;
      }
      case "update_recurring": {
        const rule = refString(entry.rule);
        if (!rule) return { ok: false, error: `${label}: rule is required` };
        const patch: Extract<FinanceAdminOp, { op: "update_recurring" }> = {
          op: "update_recurring",
          rule,
        };
        if (entry.name !== undefined) {
          const name = refString(entry.name);
          if (!name) return { ok: false, error: `${label}: name cannot be empty` };
          patch.name = name;
        }
        if (entry.amount !== undefined) {
          const amount = cents(entry.amount);
          if (amount === null || amount <= 0) {
            return { ok: false, error: `${label}: amount must be a positive number` };
          }
          patch.amount = amount;
        }
        if (entry.category !== undefined) {
          patch.category = entry.category === null ? null : refString(entry.category);
          if (patch.category === undefined) {
            return { ok: false, error: `${label}: category must be an id/name or null` };
          }
        }
        if (entry.frequency !== undefined) {
          const rec = recurrencePatch(entry, label);
          if (!rec.ok) return rec;
          patch.frequency = rec.value.frequency;
          patch.dayOfMonth = rec.value.dayOfMonth ?? undefined;
          patch.weekday = rec.value.weekday ?? undefined;
          patch.intervalDays = rec.value.intervalDays ?? undefined;
          patch.startDate = rec.value.startDate ?? undefined;
        }
        if (entry.archived !== undefined) {
          if (typeof entry.archived !== "boolean") {
            return { ok: false, error: `${label}: archived must be true or false` };
          }
          patch.archived = entry.archived;
        }
        if (
          patch.name === undefined &&
          patch.amount === undefined &&
          patch.category === undefined &&
          patch.frequency === undefined &&
          patch.archived === undefined
        ) {
          return { ok: false, error: `${label}: nothing to change` };
        }
        ops.push(patch);
        break;
      }
      case "create_income": {
        const name = refString(entry.name);
        if (!name) return { ok: false, error: `${label}: name is required` };
        const wage = cents(entry.hourlyWage);
        if (wage === null || wage < 0) return { ok: false, error: `${label}: hourlyWage must be 0+` };
        const tax = Number(entry.taxRate ?? 0);
        if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
          return { ok: false, error: `${label}: taxRate must be 0-100` };
        }
        if (entry.color !== undefined && (typeof entry.color !== "string" || !HEX.test(entry.color))) {
          return { ok: false, error: `${label}: color must be #rrggbb` };
        }
        const op: Extract<FinanceAdminOp, { op: "create_income" }> = {
          op: "create_income",
          name,
          hourlyWage: wage,
          taxRate: tax,
          calendarId: refString(entry.calendarId) ?? undefined,
          color: entry.color as string | undefined,
        };
        if (entry.payFrequency !== undefined && entry.payFrequency !== null) {
          const sched = payShedulePatch(entry, label);
          if (!sched.ok) return sched;
          if (sched.value !== "clear") {
            op.payFrequency = sched.value.payFrequency;
            op.anchorPayday = sched.value.anchorPayday;
            op.periodStart = sched.value.periodStart;
            op.periodEnd = sched.value.periodEnd;
          }
        }
        ops.push(op);
        break;
      }
      case "update_income": {
        const source = refString(entry.source);
        if (!source) return { ok: false, error: `${label}: source is required` };
        const patch: Extract<FinanceAdminOp, { op: "update_income" }> = {
          op: "update_income",
          source,
        };
        if (entry.name !== undefined) {
          const name = refString(entry.name);
          if (!name) return { ok: false, error: `${label}: name cannot be empty` };
          patch.name = name;
        }
        if (entry.hourlyWage !== undefined) {
          const wage = cents(entry.hourlyWage);
          if (wage === null || wage < 0) return { ok: false, error: `${label}: hourlyWage must be 0+` };
          patch.hourlyWage = wage;
        }
        if (entry.taxRate !== undefined) {
          const tax = Number(entry.taxRate);
          if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
            return { ok: false, error: `${label}: taxRate must be 0-100` };
          }
          patch.taxRate = tax;
        }
        if (entry.calendarId !== undefined) {
          patch.calendarId = entry.calendarId === null ? null : refString(entry.calendarId);
          if (patch.calendarId === undefined) {
            return { ok: false, error: `${label}: calendarId must be a string or null` };
          }
        }
        if (entry.color !== undefined) {
          if (typeof entry.color !== "string" || !HEX.test(entry.color)) {
            return { ok: false, error: `${label}: color must be #rrggbb` };
          }
          patch.color = entry.color;
        }
        if (entry.archived !== undefined) {
          if (typeof entry.archived !== "boolean") {
            return { ok: false, error: `${label}: archived must be true or false` };
          }
          patch.archived = entry.archived;
        }
        if (entry.payFrequency !== undefined) {
          const sched = payShedulePatch(entry, label);
          if (!sched.ok) return sched;
          if (sched.value === "clear") {
            patch.payFrequency = null;
          } else {
            patch.payFrequency = sched.value.payFrequency;
            patch.anchorPayday = sched.value.anchorPayday;
            patch.periodStart = sched.value.periodStart;
            patch.periodEnd = sched.value.periodEnd;
          }
        }
        if (
          patch.name === undefined &&
          patch.hourlyWage === undefined &&
          patch.taxRate === undefined &&
          patch.calendarId === undefined &&
          patch.color === undefined &&
          patch.archived === undefined &&
          patch.payFrequency === undefined
        ) {
          return { ok: false, error: `${label}: nothing to change` };
        }
        ops.push(patch);
        break;
      }
      case "set_spend_override": {
        const date = refString(entry.date);
        if (!date || !ISO_DATE.test(date)) {
          return { ok: false, error: `${label}: date must be YYYY-MM-DD` };
        }
        let amount: number | null = null;
        if (entry.amount !== null && entry.amount !== undefined) {
          amount = cents(entry.amount);
          if (amount === null || amount < 0 || amount > 100000) {
            return { ok: false, error: `${label}: amount must be 0-100000 (null clears the pin)` };
          }
        }
        ops.push({ op: "set_spend_override", date, amount });
        break;
      }
      case "set_daily_spend_estimate": {
        let amount: number | null = null;
        if (entry.amount !== null && entry.amount !== undefined) {
          amount = cents(entry.amount);
          if (amount === null || amount < 0 || amount > 100000) {
            return { ok: false, error: `${label}: amount must be 0-100000 (null clears it)` };
          }
        }
        ops.push({ op: "set_daily_spend_estimate", amount });
        break;
      }
      default:
        return {
          ok: false,
          error: `operation ${i + 1}: unknown op "${String(entry.op)}" (expected create_account/update_account/update_category/update_recurring/create_income/update_income/set_spend_override/set_daily_spend_estimate)`,
        };
    }
  }
  return { ok: true, value: ops };
}

// ---------- resolution ----------

export function resolveAdminOps(
  ops: FinanceAdminOp[],
  ctx: AdminResolveContext,
): Result<ResolvedAdminOp[]> {
  const resolved: ResolvedAdminOp[] = [];
  const createdAccountNames = new Set<string>();
  const createdIncomeNames = new Set<string>();

  for (const op of ops) {
    switch (op.op) {
      case "create_account": {
        const needle = op.name.toLowerCase();
        if (
          ctx.accounts.some((a) => a.name.toLowerCase() === needle) ||
          createdAccountNames.has(needle)
        ) {
          return { ok: false, error: `an account named "${op.name}" already exists` };
        }
        createdAccountNames.add(needle);
        resolved.push({
          kind: "create_account",
          name: op.name,
          type: op.type,
          color: op.color ?? "#6b6b6b",
          currency: op.currency ?? "USD",
          balance: op.balance,
        });
        break;
      }
      case "update_account": {
        const found = matchRef(op.account, ctx.accounts, "account");
        if (!found.ok) return found;
        resolved.push({
          kind: "update_account",
          accountId: found.value.id,
          accountName: found.value.name,
          name: op.name ?? null,
          type: op.type ?? null,
          color: op.color ?? null,
          archived: op.archived ?? null,
        });
        break;
      }
      case "update_category": {
        const found = matchRef(op.category, ctx.categories, "category");
        if (!found.ok) return found;
        resolved.push({
          kind: "update_category",
          categoryId: found.value.id,
          categoryName: found.value.name,
          name: op.name ?? null,
          color: op.color ?? null,
          archived: op.archived ?? null,
        });
        break;
      }
      case "update_recurring": {
        const found = matchRef(op.rule, ctx.recurring, "recurring expense");
        if (!found.ok) return found;
        let categoryId: string | null = null;
        let categoryName: string | null = null;
        let clearCategory = false;
        if (op.category === null) {
          clearCategory = true;
        } else if (op.category !== undefined) {
          const cat = matchRef(op.category, ctx.categories, "category");
          if (!cat.ok) return cat;
          categoryId = cat.value.id;
          categoryName = cat.value.name;
        }
        resolved.push({
          kind: "update_recurring",
          ruleId: found.value.id,
          ruleName: found.value.name,
          name: op.name ?? null,
          amount: op.amount ?? null,
          categoryId,
          categoryName,
          clearCategory,
          frequency: op.frequency ?? null,
          dayOfMonth: op.dayOfMonth ?? null,
          weekday: op.weekday ?? null,
          intervalDays: op.intervalDays ?? null,
          startDate: op.startDate ?? null,
          archived: op.archived ?? null,
        });
        break;
      }
      case "create_income": {
        const needle = op.name.toLowerCase();
        if (
          ctx.incomeSources.some((s) => s.name.toLowerCase() === needle) ||
          createdIncomeNames.has(needle)
        ) {
          return { ok: false, error: `an income source named "${op.name}" already exists` };
        }
        createdIncomeNames.add(needle);
        resolved.push({
          kind: "create_income",
          name: op.name,
          hourlyWage: op.hourlyWage,
          taxRate: op.taxRate,
          calendarId: op.calendarId ?? null,
          color: op.color ?? "#b5ff3c",
          payFrequency: op.payFrequency ?? null,
          anchorPayday: op.anchorPayday ?? null,
          periodStart: op.periodStart ?? null,
          periodEnd: op.periodEnd ?? null,
        });
        break;
      }
      case "update_income": {
        const found = matchRef(op.source, ctx.incomeSources, "income source");
        if (!found.ok) return found;
        resolved.push({
          kind: "update_income",
          sourceId: found.value.id,
          sourceName: found.value.name,
          name: op.name ?? null,
          hourlyWage: op.hourlyWage ?? null,
          taxRate: op.taxRate ?? null,
          calendarId: op.calendarId ?? null,
          clearCalendar: op.calendarId === null,
          color: op.color ?? null,
          archived: op.archived ?? null,
          schedule:
            op.payFrequency === undefined
              ? null
              : op.payFrequency === null
                ? "clear"
                : {
                    payFrequency: op.payFrequency,
                    anchorPayday: op.anchorPayday as string,
                    periodStart: op.periodStart as string,
                    periodEnd: op.periodEnd as string,
                  },
        });
        break;
      }
      case "set_spend_override": {
        if (op.date <= ctx.today) {
          return { ok: false, error: `spend overrides only apply to future days (${op.date} is not after ${ctx.today})` };
        }
        resolved.push({ kind: "set_spend_override", date: op.date, amount: op.amount });
        break;
      }
      case "set_daily_spend_estimate": {
        resolved.push({ kind: "set_daily_spend_estimate", amount: op.amount });
        break;
      }
    }
  }
  return { ok: true, value: resolved };
}

// ---------- receipt preview ----------

function patchBits(bits: (string | null)[]): string {
  return bits.filter(Boolean).join(", ");
}

export function adminReceiptLine(op: ResolvedAdminOp): string {
  switch (op.kind) {
    case "create_account":
      return `${op.name}  new ${op.type} account · ${formatMoney(op.balance, op.currency)}`;
    case "update_account":
      return `${op.accountName}  ${patchBits([
        op.name ? `rename → "${op.name}"` : null,
        op.type ? `type → ${op.type}` : null,
        op.color ? `color → ${op.color}` : null,
        op.archived === null ? null : op.archived ? "archive" : "restore",
      ])}`;
    case "update_category":
      return `${op.categoryName}  ${patchBits([
        op.name ? `rename → "${op.name}"` : null,
        op.color ? `color → ${op.color}` : null,
        op.archived === null ? null : op.archived ? "archive" : "restore",
      ])}`;
    case "update_recurring": {
      const schedule =
        op.frequency === null
          ? null
          : op.frequency === "monthly"
            ? `monthly on day ${op.dayOfMonth}`
            : op.frequency === "weekly"
              ? `weekly (weekday ${op.weekday})`
              : op.frequency === "daily"
                ? "daily"
                : `every ${op.intervalDays} days from ${op.startDate}`;
      return `${op.ruleName}  ${patchBits([
        op.name ? `rename → "${op.name}"` : null,
        op.amount === null ? null : `amount → ${formatMoney(op.amount)}`,
        op.clearCategory ? "category cleared" : op.categoryName ? `category → ${op.categoryName}` : null,
        schedule ? `schedule → ${schedule}` : null,
        op.archived === null ? null : op.archived ? "archive" : "restore",
      ])}`;
    }
    case "create_income": {
      const sched = op.payFrequency ? ` · paid ${op.payFrequency}` : "";
      return `${op.name}  new income source · ${formatMoney(op.hourlyWage)}/h, ${op.taxRate}% tax${sched}${op.calendarId ? " · calendar-linked" : ""}`;
    }
    case "update_income":
      return `${op.sourceName}  ${patchBits([
        op.name ? `rename → "${op.name}"` : null,
        op.hourlyWage === null ? null : `wage → ${formatMoney(op.hourlyWage)}/h`,
        op.taxRate === null ? null : `tax → ${op.taxRate}%`,
        op.clearCalendar ? "calendar unlinked" : op.calendarId ? "calendar → linked" : null,
        op.schedule === null ? null : op.schedule === "clear" ? "pay schedule cleared" : `paid ${op.schedule.payFrequency}`,
        op.archived === null ? null : op.archived ? "archive" : "restore",
      ])}`;
    case "set_spend_override":
      return op.amount === null
        ? `${op.date}  everyday-spend pin cleared`
        : `${op.date}  everyday spend pinned at ${formatMoney(op.amount)}`;
    case "set_daily_spend_estimate":
      return op.amount === null
        ? "daily spend estimate cleared"
        : `daily spend estimate → ${formatMoney(op.amount)}`;
  }
}

export function renderAdminReceipt(ops: ResolvedAdminOp[]): string {
  return ops.map(adminReceiptLine).join("\n");
}

// Structural re-validation of the stored proposal at execute time.
export function validateResolvedAdminOps(raw: unknown): Result<ResolvedAdminOp[]> {
  const operations = isRecord(raw) ? raw.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: "stored proposal has no operations" };
  }
  if (operations.length > MAX_ADMIN_OPS) {
    return { ok: false, error: "stored proposal has too many operations" };
  }
  const ops: ResolvedAdminOp[] = [];
  for (const entry of operations) {
    if (!isRecord(entry)) return { ok: false, error: "malformed stored operation" };
    switch (entry.kind) {
      case "create_account": {
        const name = refString(entry.name);
        const balance = cents(entry.balance);
        if (!name || balance === null || !ADMIN_ACCOUNT_TYPES.includes(entry.type as AdminAccountType)) {
          return { ok: false, error: "malformed create_account operation" };
        }
        ops.push({
          kind: "create_account",
          name,
          type: entry.type as AdminAccountType,
          color: typeof entry.color === "string" && HEX.test(entry.color) ? entry.color : "#6b6b6b",
          currency: refString(entry.currency) ?? "USD",
          balance,
        });
        break;
      }
      case "update_account": {
        if (typeof entry.accountId !== "string") {
          return { ok: false, error: "malformed update_account operation" };
        }
        ops.push({
          kind: "update_account",
          accountId: entry.accountId,
          accountName: String(entry.accountName ?? ""),
          name: refString(entry.name),
          type: ADMIN_ACCOUNT_TYPES.includes(entry.type as AdminAccountType)
            ? (entry.type as AdminAccountType)
            : null,
          color: typeof entry.color === "string" && HEX.test(entry.color) ? entry.color : null,
          archived: typeof entry.archived === "boolean" ? entry.archived : null,
        });
        break;
      }
      case "update_category": {
        if (typeof entry.categoryId !== "string") {
          return { ok: false, error: "malformed update_category operation" };
        }
        ops.push({
          kind: "update_category",
          categoryId: entry.categoryId,
          categoryName: String(entry.categoryName ?? ""),
          name: refString(entry.name),
          color: typeof entry.color === "string" && HEX.test(entry.color) ? entry.color : null,
          archived: typeof entry.archived === "boolean" ? entry.archived : null,
        });
        break;
      }
      case "update_recurring": {
        if (typeof entry.ruleId !== "string") {
          return { ok: false, error: "malformed update_recurring operation" };
        }
        const frequency = FREQUENCIES.includes(entry.frequency as Frequency)
          ? (entry.frequency as Frequency)
          : null;
        const amount = entry.amount === null || entry.amount === undefined ? null : cents(entry.amount);
        if (entry.amount !== null && entry.amount !== undefined && (amount === null || amount <= 0)) {
          return { ok: false, error: "malformed update_recurring operation" };
        }
        ops.push({
          kind: "update_recurring",
          ruleId: entry.ruleId,
          ruleName: String(entry.ruleName ?? ""),
          name: refString(entry.name),
          amount,
          categoryId: typeof entry.categoryId === "string" ? entry.categoryId : null,
          categoryName: typeof entry.categoryName === "string" ? entry.categoryName : null,
          clearCategory: entry.clearCategory === true,
          frequency,
          dayOfMonth: Number.isInteger(entry.dayOfMonth) ? (entry.dayOfMonth as number) : null,
          weekday: Number.isInteger(entry.weekday) ? (entry.weekday as number) : null,
          intervalDays: Number.isInteger(entry.intervalDays) ? (entry.intervalDays as number) : null,
          startDate:
            typeof entry.startDate === "string" && ISO_DATE.test(entry.startDate)
              ? entry.startDate
              : null,
          archived: typeof entry.archived === "boolean" ? entry.archived : null,
        });
        break;
      }
      case "create_income": {
        const name = refString(entry.name);
        const wage = cents(entry.hourlyWage);
        const tax = Number(entry.taxRate);
        if (!name || wage === null || wage < 0 || !Number.isFinite(tax) || tax < 0 || tax > 100) {
          return { ok: false, error: "malformed create_income operation" };
        }
        const payFrequency = PAY_FREQUENCIES.includes(entry.payFrequency as PayFrequency)
          ? (entry.payFrequency as PayFrequency)
          : null;
        ops.push({
          kind: "create_income",
          name,
          hourlyWage: wage,
          taxRate: tax,
          calendarId: typeof entry.calendarId === "string" ? entry.calendarId : null,
          color: typeof entry.color === "string" && HEX.test(entry.color) ? entry.color : "#b5ff3c",
          payFrequency,
          anchorPayday:
            payFrequency && typeof entry.anchorPayday === "string" && ISO_DATE.test(entry.anchorPayday)
              ? entry.anchorPayday
              : null,
          periodStart:
            payFrequency && typeof entry.periodStart === "string" && ISO_DATE.test(entry.periodStart)
              ? entry.periodStart
              : null,
          periodEnd:
            payFrequency && typeof entry.periodEnd === "string" && ISO_DATE.test(entry.periodEnd)
              ? entry.periodEnd
              : null,
        });
        break;
      }
      case "update_income": {
        if (typeof entry.sourceId !== "string") {
          return { ok: false, error: "malformed update_income operation" };
        }
        let schedule: Extract<ResolvedAdminOp, { kind: "update_income" }>["schedule"] = null;
        if (entry.schedule === "clear") schedule = "clear";
        else if (isRecord(entry.schedule)) {
          const s = entry.schedule;
          if (
            !PAY_FREQUENCIES.includes(s.payFrequency as PayFrequency) ||
            typeof s.anchorPayday !== "string" ||
            typeof s.periodStart !== "string" ||
            typeof s.periodEnd !== "string"
          ) {
            return { ok: false, error: "malformed update_income schedule" };
          }
          schedule = {
            payFrequency: s.payFrequency as PayFrequency,
            anchorPayday: s.anchorPayday,
            periodStart: s.periodStart,
            periodEnd: s.periodEnd,
          };
        }
        const wage = entry.hourlyWage === null || entry.hourlyWage === undefined ? null : cents(entry.hourlyWage);
        ops.push({
          kind: "update_income",
          sourceId: entry.sourceId,
          sourceName: String(entry.sourceName ?? ""),
          name: refString(entry.name),
          hourlyWage: wage,
          taxRate:
            entry.taxRate === null || entry.taxRate === undefined ? null : Number(entry.taxRate),
          calendarId: typeof entry.calendarId === "string" ? entry.calendarId : null,
          clearCalendar: entry.clearCalendar === true,
          color: typeof entry.color === "string" && HEX.test(entry.color) ? entry.color : null,
          archived: typeof entry.archived === "boolean" ? entry.archived : null,
          schedule,
        });
        break;
      }
      case "set_spend_override": {
        const date = refString(entry.date);
        if (!date || !ISO_DATE.test(date)) {
          return { ok: false, error: "malformed set_spend_override operation" };
        }
        const amount = entry.amount === null || entry.amount === undefined ? null : cents(entry.amount);
        ops.push({ kind: "set_spend_override", date, amount });
        break;
      }
      case "set_daily_spend_estimate": {
        const amount = entry.amount === null || entry.amount === undefined ? null : cents(entry.amount);
        ops.push({ kind: "set_daily_spend_estimate", amount });
        break;
      }
      default:
        return { ok: false, error: "malformed stored operation kind" };
    }
  }
  return { ok: true, value: ops };
}
