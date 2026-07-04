// Pure validation + preview helpers for the MCP write tools. No server imports,
// so they unit-test directly (mirrors how app/lib/snapshots/* stays pure). The
// DB-touching propose/confirm code in writes.ts composes these.

import { formatMoney } from "@/app/_components/money";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const PRIORITIES = ["low", "med", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export function roundCents(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export type CreateTaskInput = {
  title: string;
  groupId: string | null;
  dueDate: string | null;
  notes: string | null;
  priority: Priority;
};

export function validateCreateTask(raw: {
  title?: unknown;
  groupId?: unknown;
  dueDate?: unknown;
  notes?: unknown;
  priority?: unknown;
}): Result<CreateTaskInput> {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };

  if (raw.dueDate != null && !(typeof raw.dueDate === "string" && ISO_DATE.test(raw.dueDate))) {
    return { ok: false, error: "dueDate must be YYYY-MM-DD" };
  }
  if (raw.groupId != null && typeof raw.groupId !== "string") {
    return { ok: false, error: "groupId must be a string or null" };
  }
  const priority = raw.priority == null ? "med" : (raw.priority as Priority);
  if (!PRIORITIES.includes(priority)) {
    return { ok: false, error: "priority must be low, med, or high" };
  }

  return {
    ok: true,
    value: {
      title,
      groupId: (raw.groupId as string | null) ?? null,
      dueDate: (raw.dueDate as string | null) ?? null,
      notes: typeof raw.notes === "string" ? raw.notes.trim() || null : null,
      priority,
    },
  };
}

export function summarizeCreateTask(
  value: CreateTaskInput,
  groupName: string | null,
): string {
  const where = value.groupId ? `group "${groupName ?? value.groupId}"` : "inbox";
  const due = value.dueDate ? `, due ${value.dueDate}` : "";
  return `Create task "${value.title}" in ${where}${due}.`;
}

export type LogSpendInput = {
  accountId: string;
  amount: number;
  categoryId: string | null;
  note: string | null;
};

export function validateLogSpend(raw: {
  accountId?: unknown;
  amount?: unknown;
  categoryId?: unknown;
  note?: unknown;
}): Result<LogSpendInput> {
  if (typeof raw.accountId !== "string" || !raw.accountId) {
    return { ok: false, error: "accountId is required" };
  }
  const amount = roundCents(Number(raw.amount));
  if (amount === null || amount <= 0) {
    return { ok: false, error: "amount must be a positive number" };
  }
  if (raw.categoryId != null && typeof raw.categoryId !== "string") {
    return { ok: false, error: "categoryId must be a string or null" };
  }
  return {
    ok: true,
    value: {
      accountId: raw.accountId,
      amount,
      categoryId: (raw.categoryId as string | null) ?? null,
      note: typeof raw.note === "string" ? raw.note.trim() || null : null,
    },
  };
}

// newBalance after a spend, rounded to the cent (mirrors recordBalanceChange).
export function computeSpendBalance(currentBalance: number, amount: number): number {
  return roundCents(currentBalance - amount) ?? currentBalance;
}

export function summarizeLogSpend(
  value: LogSpendInput,
  ctx: { accountName: string; currency: string; categoryName: string | null },
): string {
  const category = value.categoryId ? ` on ${ctx.categoryName ?? "a category"}` : "";
  return `Log ${formatMoney(value.amount, ctx.currency)} spent from "${ctx.accountName}"${category}.`;
}
