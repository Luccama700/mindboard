// Pure validation + preview helpers for the spending-limit MCP write tools.
// No server imports, so they unit-test directly (mirrors validate.ts). The
// DB-touching propose/confirm code in writes.ts composes these.

import { formatMoney } from "@/app/_components/money";
import type {
  SpendLimitPeriod,
  SpendLimitScope,
} from "@/app/_components/finance-types";
import type { SpendLimitWarning } from "@/app/_components/spend-limits";
import { roundCents, type Result } from "./validate";

const PERIODS: SpendLimitPeriod[] = ["daily", "weekly", "monthly"];
const SCOPES: SpendLimitScope[] = ["overall", "category"];

export type SetSpendLimitInput = {
  scope: SpendLimitScope;
  categoryId: string | null;
  period: SpendLimitPeriod;
  amount: number;
};

export function validateSetSpendLimit(raw: {
  scope?: unknown;
  categoryId?: unknown;
  period?: unknown;
  amount?: unknown;
}): Result<SetSpendLimitInput> {
  const scope = raw.scope;
  if (scope !== "overall" && scope !== "category") {
    return { ok: false, error: "scope must be 'overall' or 'category'" };
  }
  if (!SCOPES.includes(scope)) {
    return { ok: false, error: "invalid scope" };
  }
  if (typeof raw.period !== "string" || !PERIODS.includes(raw.period as SpendLimitPeriod)) {
    return { ok: false, error: "period must be daily, weekly, or monthly" };
  }
  const amount = roundCents(Number(raw.amount));
  if (amount === null || amount <= 0) {
    return { ok: false, error: "amount must be a positive number" };
  }
  if (scope === "category") {
    if (typeof raw.categoryId !== "string" || !raw.categoryId) {
      return { ok: false, error: "categoryId is required for a category limit" };
    }
  } else if (raw.categoryId != null && typeof raw.categoryId !== "string") {
    return { ok: false, error: "categoryId must be a string or null" };
  }

  return {
    ok: true,
    value: {
      scope,
      categoryId: scope === "category" ? (raw.categoryId as string) : null,
      period: raw.period as SpendLimitPeriod,
      amount,
    },
  };
}

export type DeleteSpendLimitInput = { limitId: string };

export function validateDeleteSpendLimit(raw: {
  limitId?: unknown;
}): Result<DeleteSpendLimitInput> {
  if (typeof raw.limitId !== "string" || !raw.limitId) {
    return { ok: false, error: "limitId is required" };
  }
  return { ok: true, value: { limitId: raw.limitId } };
}

const PERIOD_WORD: Record<SpendLimitPeriod, string> = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};

function scopeLabel(
  scope: SpendLimitScope,
  categoryName: string | null,
): string {
  return scope === "overall" ? "overall" : (categoryName ?? "a category");
}

export function summarizeSetSpendLimit(
  value: SetSpendLimitInput,
  ctx: { categoryName: string | null; currency: string },
): string {
  const label = scopeLabel(value.scope, ctx.categoryName);
  return `Set ${label} ${PERIOD_WORD[value.period]} spending limit to ${formatMoney(value.amount, ctx.currency)}.`;
}

export function summarizeDeleteSpendLimit(ctx: {
  scope: SpendLimitScope;
  categoryName: string | null;
  period: SpendLimitPeriod;
  amount: number;
  currency: string;
}): string {
  const label = scopeLabel(ctx.scope, ctx.categoryName);
  return `Remove the ${label} ${PERIOD_WORD[ctx.period]} spending limit (${formatMoney(ctx.amount, ctx.currency)}).`;
}

// One line per warning, appended to a spend proposal's preview so the user sees
// the limit impact before confirming. `categoryNameById` resolves category
// limits' labels; the overall limit needs none.
export function formatLimitWarnings(
  warnings: SpendLimitWarning[],
  ctx: { categoryNameById: Map<string, string>; currency: string },
): string {
  if (warnings.length === 0) return "";
  const lines = warnings.map((w) => {
    const label =
      w.scope === "overall"
        ? "overall"
        : (w.categoryId ? ctx.categoryNameById.get(w.categoryId) : null) ??
          "category";
    const spent = formatMoney(w.spent, ctx.currency);
    const cap = formatMoney(w.amount, ctx.currency);
    if (w.state === "over") {
      const over = formatMoney(Math.abs(w.remaining), ctx.currency);
      return `⚠ over ${label} ${PERIOD_WORD[w.period]} limit: ${spent} of ${cap} (${over} over)`;
    }
    const pct = w.amount > 0 ? Math.round((w.spent / w.amount) * 100) : 0;
    const left = formatMoney(Math.max(0, w.remaining), ctx.currency);
    return `⚠ ${label} ${PERIOD_WORD[w.period]} limit at ${pct}%: ${spent} of ${cap} (${left} left)`;
  });
  return `\n\nSpending limits:\n${lines.join("\n")}`;
}
