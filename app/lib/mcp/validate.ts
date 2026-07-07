// Pure validation + preview helpers for the MCP write tools. No server imports,
// so they unit-test directly (mirrors how app/lib/snapshots/* stays pure). The
// DB-touching propose/confirm code in writes.ts composes these.

import { formatMoney } from "@/app/_components/money";
import {
  formatRecurrence,
  nextOccurrenceKey,
  type TaskRecurrence,
} from "@/app/lib/recurrence";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
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

export type CreateRecurringTaskInput = TaskRecurrence & {
  title: string;
  groupId: string | null;
  notes: string | null;
  priority: Priority;
  dueTime: string | null; // "HH:MM"
  durationMin: number | null;
};

export function validateCreateRecurringTask(raw: {
  title?: unknown;
  groupId?: unknown;
  notes?: unknown;
  priority?: unknown;
  frequency?: unknown;
  weekdays?: unknown;
  dayOfMonth?: unknown;
  intervalDays?: unknown;
  startDate?: unknown;
  dueTime?: unknown;
  durationMin?: unknown;
}): Result<CreateRecurringTaskInput> {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  if (raw.groupId != null && typeof raw.groupId !== "string") {
    return { ok: false, error: "groupId must be a string or null" };
  }
  const priority = raw.priority == null ? "med" : (raw.priority as Priority);
  if (!PRIORITIES.includes(priority)) {
    return { ok: false, error: "priority must be low, med, or high" };
  }

  const frequency = raw.frequency;
  if (
    frequency !== "daily" &&
    frequency !== "weekly" &&
    frequency !== "monthly" &&
    frequency !== "custom"
  ) {
    return { ok: false, error: "frequency must be daily, weekly, monthly, or custom" };
  }

  let weekdays: number[] | null = null;
  let dayOfMonth: number | null = null;
  let intervalDays: number | null = null;
  let startDate: string | null = null;

  if (frequency === "weekly") {
    const days = Array.isArray(raw.weekdays)
      ? [...new Set(raw.weekdays.map((d) => Math.trunc(Number(d))))].sort(
          (a, b) => a - b,
        )
      : [];
    if (days.length === 0 || days.some((d) => !Number.isFinite(d) || d < 0 || d > 6)) {
      return {
        ok: false,
        error: "weekly needs weekdays: an array of 0 (sun) through 6 (sat)",
      };
    }
    weekdays = days;
  } else if (frequency === "monthly") {
    const day = Math.trunc(Number(raw.dayOfMonth));
    if (!Number.isFinite(day) || day < 1 || day > 31) {
      return { ok: false, error: "monthly needs dayOfMonth (1-31)" };
    }
    dayOfMonth = day;
  } else if (frequency === "custom") {
    const interval = Math.trunc(Number(raw.intervalDays));
    if (!Number.isFinite(interval) || interval < 1) {
      return { ok: false, error: "custom needs intervalDays of 1 or more" };
    }
    intervalDays = interval;
    if (raw.startDate != null) {
      if (typeof raw.startDate !== "string" || !ISO_DATE.test(raw.startDate)) {
        return { ok: false, error: "startDate must be YYYY-MM-DD" };
      }
      startDate = raw.startDate;
    }
  }

  let dueTime: string | null = null;
  if (raw.dueTime != null) {
    if (typeof raw.dueTime !== "string" || !CLOCK_TIME.test(raw.dueTime)) {
      return { ok: false, error: "dueTime must be HH:MM (24h)" };
    }
    dueTime = raw.dueTime;
  }
  let durationMin: number | null = null;
  if (raw.durationMin != null) {
    const d = Math.trunc(Number(raw.durationMin));
    if (!Number.isFinite(d) || d < 15) {
      return { ok: false, error: "durationMin must be 15 or more" };
    }
    if (dueTime === null) {
      return { ok: false, error: "durationMin needs a dueTime" };
    }
    durationMin = d;
  }

  return {
    ok: true,
    value: {
      title,
      groupId: (raw.groupId as string | null) ?? null,
      notes: typeof raw.notes === "string" ? raw.notes.trim() || null : null,
      priority,
      frequency,
      weekdays,
      day_of_month: dayOfMonth,
      interval_days: intervalDays,
      start_date: startDate,
      dueTime,
      durationMin,
    },
  };
}

export function summarizeCreateRecurringTask(
  value: CreateRecurringTaskInput,
  groupName: string | null,
  todayKey: string,
): string {
  const where = value.groupId ? ` in group "${groupName ?? value.groupId}"` : "";
  const when = value.dueTime
    ? ` at ${value.dueTime}${value.durationMin ? ` (${value.durationMin}min)` : ""}`
    : "";
  const first = nextOccurrenceKey(
    value.start_date === null && value.frequency === "custom"
      ? { ...value, start_date: todayKey }
      : value,
    todayKey,
  );
  const lands = first ? ` First lands ${first}.` : "";
  return `Create repeating task "${value.title}" — ${formatRecurrence(value)}${when}${where}.${lands}`;
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
