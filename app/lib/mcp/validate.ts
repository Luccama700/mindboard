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
  estimatedMinutes?: number | null;
};

export function validateCreateTask(raw: {
  title?: unknown;
  groupId?: unknown;
  dueDate?: unknown;
  notes?: unknown;
  priority?: unknown;
  estimatedMinutes?: unknown;
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
  let estimatedMinutes: number | null | undefined;
  if (raw.estimatedMinutes !== undefined) {
    if (
      raw.estimatedMinutes !== null &&
      (!Number.isInteger(raw.estimatedMinutes) || (raw.estimatedMinutes as number) < 1)
    ) {
      return { ok: false, error: "estimatedMinutes must be a whole number of minutes (or null)" };
    }
    estimatedMinutes = raw.estimatedMinutes as number | null;
  }

  return {
    ok: true,
    value: {
      title,
      groupId: (raw.groupId as string | null) ?? null,
      dueDate: (raw.dueDate as string | null) ?? null,
      notes: typeof raw.notes === "string" ? raw.notes.trim() || null : null,
      priority,
      ...(estimatedMinutes !== undefined ? { estimatedMinutes } : {}),
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

// ---------- task edit ----------

export type UpdateTaskInput = {
  taskId: string;
  title?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  durationMin?: number | null;
  estimatedMinutes?: number | null;
  groupId?: string | null;
  notes?: string | null;
  priority?: Priority;
  pushToCalendar?: boolean;
  aiState?: AiState | null;
};

// Overnight-agent lifecycle states (docs/overnight-agent-plan.md).
export const AI_STATES = ["planned", "approved", "building", "built", "failed"] as const;
export type AiState = (typeof AI_STATES)[number];

export function validateUpdateTask(raw: Record<string, unknown>): Result<UpdateTaskInput> {
  if (typeof raw.taskId !== "string" || !raw.taskId) {
    return { ok: false, error: "taskId is required" };
  }
  const out: UpdateTaskInput = { taskId: raw.taskId };

  if (raw.title !== undefined) {
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return { ok: false, error: "title cannot be empty" };
    out.title = title;
  }
  if (raw.dueDate !== undefined) {
    if (raw.dueDate !== null && !(typeof raw.dueDate === "string" && ISO_DATE.test(raw.dueDate))) {
      return { ok: false, error: "dueDate must be YYYY-MM-DD or null" };
    }
    out.dueDate = raw.dueDate as string | null;
  }
  if (raw.dueTime !== undefined) {
    if (raw.dueTime !== null && !(typeof raw.dueTime === "string" && CLOCK_TIME.test(raw.dueTime))) {
      return { ok: false, error: "dueTime must be HH:MM (24h) or null" };
    }
    out.dueTime = raw.dueTime as string | null;
  }
  if (raw.durationMin !== undefined) {
    if (raw.durationMin === null) {
      out.durationMin = null;
    } else {
      const d = Math.trunc(Number(raw.durationMin));
      if (!Number.isFinite(d) || d < 15) {
        return { ok: false, error: "durationMin must be 15 or more" };
      }
      out.durationMin = d;
    }
  }
  if (raw.estimatedMinutes !== undefined) {
    if (raw.estimatedMinutes === null) {
      out.estimatedMinutes = null;
    } else if (
      !Number.isInteger(raw.estimatedMinutes) ||
      (raw.estimatedMinutes as number) < 1
    ) {
      return { ok: false, error: "estimatedMinutes must be a whole number of minutes 1 or more, or null" };
    } else {
      out.estimatedMinutes = raw.estimatedMinutes as number;
    }
  }
  if (raw.groupId !== undefined) {
    if (raw.groupId !== null && typeof raw.groupId !== "string") {
      return { ok: false, error: "groupId must be a string or null" };
    }
    out.groupId = raw.groupId as string | null;
  }
  if (raw.notes !== undefined) {
    if (raw.notes !== null && typeof raw.notes !== "string") {
      return { ok: false, error: "notes must be a string or null" };
    }
    out.notes = typeof raw.notes === "string" ? raw.notes.trim() || null : null;
  }
  if (raw.priority !== undefined) {
    if (!PRIORITIES.includes(raw.priority as Priority)) {
      return { ok: false, error: "priority must be low, med, or high" };
    }
    out.priority = raw.priority as Priority;
  }
  if (raw.pushToCalendar !== undefined) {
    if (typeof raw.pushToCalendar !== "boolean") {
      return { ok: false, error: "pushToCalendar must be true or false" };
    }
    out.pushToCalendar = raw.pushToCalendar;
  }
  if (raw.aiState !== undefined) {
    if (raw.aiState !== null && !AI_STATES.includes(raw.aiState as AiState)) {
      return { ok: false, error: `aiState must be ${AI_STATES.join(", ")}, or null` };
    }
    // The human approval gate: 'approved' is only ever granted by the user in
    // the app (setTaskAiState). An AI client that could set it would be
    // approving its own builds.
    if (raw.aiState === "approved") {
      return {
        ok: false,
        error: "aiState 'approved' can only be set by the user in the app",
      };
    }
    out.aiState = raw.aiState as AiState | null;
  }

  if (Object.keys(out).length === 1) {
    return { ok: false, error: "nothing to change" };
  }
  return { ok: true, value: out };
}

export function summarizeUpdateTask(
  value: UpdateTaskInput,
  currentTitle: string,
  groupName: string | null,
): string {
  const bits: string[] = [];
  if (value.title !== undefined) bits.push(`rename to "${value.title}"`);
  if (value.dueDate !== undefined) {
    bits.push(value.dueDate === null ? "clear the due date" : `due ${value.dueDate}`);
  }
  if (value.dueTime !== undefined) {
    bits.push(value.dueTime === null ? "clear the time" : `at ${value.dueTime}`);
  }
  if (value.durationMin !== undefined && value.durationMin !== null) {
    bits.push(`${value.durationMin}min`);
  }
  if (value.estimatedMinutes !== undefined) {
    bits.push(
      value.estimatedMinutes === null
        ? "clear estimate"
        : `estimate ~${value.estimatedMinutes}m`,
    );
  }
  if (value.groupId !== undefined) {
    bits.push(value.groupId === null ? "move to inbox" : `move to "${groupName ?? value.groupId}"`);
  }
  if (value.notes !== undefined) {
    bits.push(value.notes === null ? "clear notes" : "update notes");
  }
  if (value.priority !== undefined) bits.push(`priority ${value.priority}`);
  if (value.pushToCalendar) bits.push("push to Google Calendar");
  if (value.aiState !== undefined) {
    bits.push(value.aiState === null ? "clear the AI state" : `AI state → ${value.aiState}`);
  }
  return `Update task "${currentTitle}": ${bits.join(", ")}.`;
}

// ---------- recurring-task edit ----------

export type UpdateRecurringTaskInput = {
  ruleId: string;
  title?: string;
  groupId?: string | null;
  notes?: string | null;
  priority?: Priority;
  recurrence?: Pick<
    TaskRecurrence,
    "frequency" | "weekdays" | "day_of_month" | "interval_days" | "start_date"
  >;
  dueTime?: string | null;
  durationMin?: number | null;
};

export function validateUpdateRecurringTask(
  raw: Record<string, unknown>,
): Result<UpdateRecurringTaskInput> {
  if (typeof raw.ruleId !== "string" || !raw.ruleId) {
    return { ok: false, error: "ruleId is required" };
  }
  const out: UpdateRecurringTaskInput = { ruleId: raw.ruleId };

  if (raw.title !== undefined) {
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return { ok: false, error: "title cannot be empty" };
    out.title = title;
  }
  if (raw.groupId !== undefined) {
    if (raw.groupId !== null && typeof raw.groupId !== "string") {
      return { ok: false, error: "groupId must be a string or null" };
    }
    out.groupId = raw.groupId as string | null;
  }
  if (raw.notes !== undefined) {
    out.notes = typeof raw.notes === "string" ? raw.notes.trim() || null : null;
  }
  if (raw.priority !== undefined) {
    if (!PRIORITIES.includes(raw.priority as Priority)) {
      return { ok: false, error: "priority must be low, med, or high" };
    }
    out.priority = raw.priority as Priority;
  }
  if (raw.frequency !== undefined) {
    // Reuse the create validator for the recurrence half by faking a title.
    const parsed = validateCreateRecurringTask({ ...raw, title: "x" });
    if (!parsed.ok) return parsed;
    out.recurrence = {
      frequency: parsed.value.frequency,
      weekdays: parsed.value.weekdays,
      day_of_month: parsed.value.day_of_month,
      interval_days: parsed.value.interval_days,
      start_date: parsed.value.start_date,
    };
    out.dueTime = parsed.value.dueTime ?? out.dueTime;
    out.durationMin = parsed.value.durationMin ?? out.durationMin;
  }
  if (raw.dueTime !== undefined && out.dueTime === undefined) {
    if (raw.dueTime !== null && !(typeof raw.dueTime === "string" && CLOCK_TIME.test(raw.dueTime))) {
      return { ok: false, error: "dueTime must be HH:MM (24h) or null" };
    }
    out.dueTime = raw.dueTime as string | null;
  }
  if (raw.durationMin !== undefined && out.durationMin === undefined) {
    if (raw.durationMin === null) {
      out.durationMin = null;
    } else {
      const d = Math.trunc(Number(raw.durationMin));
      if (!Number.isFinite(d) || d < 15) {
        return { ok: false, error: "durationMin must be 15 or more" };
      }
      out.durationMin = d;
    }
  }

  if (Object.keys(out).length === 1) {
    return { ok: false, error: "nothing to change" };
  }
  return { ok: true, value: out };
}

// ---------- group manage ----------

export const GROUP_TYPES = ["course", "project", "work", "personal"] as const;
export type GroupType = (typeof GROUP_TYPES)[number];
const GROUP_HEX = /^#[0-9a-fA-F]{6}$/;

export type ManageGroupInput =
  | { action: "create"; name: string; type: GroupType; color: string }
  | {
      action: "update";
      groupId: string;
      name?: string;
      type?: GroupType;
      color?: string;
      googleCalendarId?: string | null;
    }
  | { action: "archive"; groupId: string };

export function validateManageGroup(raw: Record<string, unknown>): Result<ManageGroupInput> {
  switch (raw.action) {
    case "create": {
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      if (!name) return { ok: false, error: "name is required" };
      if (!GROUP_TYPES.includes(raw.type as GroupType)) {
        return { ok: false, error: `type must be one of ${GROUP_TYPES.join("/")}` };
      }
      const color = typeof raw.color === "string" && GROUP_HEX.test(raw.color) ? raw.color : "#b5ff3c";
      return { ok: true, value: { action: "create", name, type: raw.type as GroupType, color } };
    }
    case "update": {
      if (typeof raw.groupId !== "string" || !raw.groupId) {
        return { ok: false, error: "groupId is required" };
      }
      const out: Extract<ManageGroupInput, { action: "update" }> = {
        action: "update",
        groupId: raw.groupId,
      };
      if (raw.name !== undefined) {
        const name = typeof raw.name === "string" ? raw.name.trim() : "";
        if (!name) return { ok: false, error: "name cannot be empty" };
        out.name = name;
      }
      if (raw.type !== undefined) {
        if (!GROUP_TYPES.includes(raw.type as GroupType)) {
          return { ok: false, error: `type must be one of ${GROUP_TYPES.join("/")}` };
        }
        out.type = raw.type as GroupType;
      }
      if (raw.color !== undefined) {
        if (typeof raw.color !== "string" || !GROUP_HEX.test(raw.color)) {
          return { ok: false, error: "color must be #rrggbb" };
        }
        out.color = raw.color;
      }
      if (raw.googleCalendarId !== undefined) {
        if (
          raw.googleCalendarId !== null &&
          (typeof raw.googleCalendarId !== "string" || raw.googleCalendarId.length > 256)
        ) {
          return { ok: false, error: "googleCalendarId must be a calendar id or null" };
        }
        out.googleCalendarId = raw.googleCalendarId as string | null;
      }
      if (
        out.name === undefined &&
        out.type === undefined &&
        out.color === undefined &&
        out.googleCalendarId === undefined
      ) {
        return { ok: false, error: "nothing to change" };
      }
      return { ok: true, value: out };
    }
    case "archive": {
      if (typeof raw.groupId !== "string" || !raw.groupId) {
        return { ok: false, error: "groupId is required" };
      }
      return { ok: true, value: { action: "archive", groupId: raw.groupId } };
    }
    default:
      return { ok: false, error: "action must be create, update, or archive" };
  }
}

// ---------- goals ----------

export const GOAL_HORIZONS = ["week", "month", "quarter", "year", "life"] as const;
export const GOAL_STATUSES = ["active", "done", "paused", "archived"] as const;

export type UpsertGoalInput = {
  goalId: string | null;
  title?: string;
  why?: string;
  horizon?: (typeof GOAL_HORIZONS)[number];
  status?: (typeof GOAL_STATUSES)[number];
  targetDate?: string;
};

export function validateUpsertGoal(raw: Record<string, unknown>): Result<UpsertGoalInput> {
  const goalId = typeof raw.goalId === "string" && raw.goalId ? raw.goalId : null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!goalId && !title) return { ok: false, error: "title is required for a new goal" };
  if (
    raw.horizon !== undefined &&
    !GOAL_HORIZONS.includes(raw.horizon as (typeof GOAL_HORIZONS)[number])
  ) {
    return { ok: false, error: "invalid horizon" };
  }
  if (
    raw.status !== undefined &&
    !GOAL_STATUSES.includes(raw.status as (typeof GOAL_STATUSES)[number])
  ) {
    return { ok: false, error: "invalid status" };
  }
  if (raw.targetDate !== undefined && !ISO_DATE.test(String(raw.targetDate))) {
    return { ok: false, error: "targetDate must be YYYY-MM-DD" };
  }
  return {
    ok: true,
    value: {
      goalId,
      title: title || undefined,
      why: typeof raw.why === "string" ? raw.why : undefined,
      horizon: raw.horizon as UpsertGoalInput["horizon"],
      status: raw.status as UpsertGoalInput["status"],
      targetDate: raw.targetDate as string | undefined,
    },
  };
}

// ---------- calendar events ----------

export type RescheduleEventInput = {
  calendarId: string;
  eventId: string;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string | null;
};

export function validateRescheduleEvent(
  raw: Record<string, unknown>,
): Result<RescheduleEventInput> {
  if (typeof raw.calendarId !== "string" || !raw.calendarId) {
    return { ok: false, error: "calendarId is required" };
  }
  if (typeof raw.eventId !== "string" || !raw.eventId) {
    return { ok: false, error: "eventId is required" };
  }
  const allDay = raw.allDay === true;
  const start = typeof raw.start === "string" ? raw.start : "";
  const end = typeof raw.end === "string" ? raw.end : "";
  if (allDay) {
    if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
      return { ok: false, error: "all-day events need start/end as YYYY-MM-DD (end is exclusive)" };
    }
  } else {
    if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) {
      return { ok: false, error: "start/end must be ISO datetimes" };
    }
    if (Date.parse(end) <= Date.parse(start)) {
      return { ok: false, error: "end must be after start" };
    }
  }
  return {
    ok: true,
    value: {
      calendarId: raw.calendarId,
      eventId: raw.eventId,
      allDay,
      start,
      end,
      timeZone: typeof raw.timeZone === "string" && raw.timeZone ? raw.timeZone : null,
    },
  };
}

export type CreateEventInput = {
  summary: string;
  date: string;
  startTime: string | null;
  durationMin: number;
  calendarId: string;
  description: string | null;
};

export function validateCreateEvent(raw: Record<string, unknown>): Result<CreateEventInput> {
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) return { ok: false, error: "summary is required" };
  if (typeof raw.date !== "string" || !ISO_DATE.test(raw.date)) {
    return { ok: false, error: "date must be YYYY-MM-DD" };
  }
  let startTime: string | null = null;
  if (raw.startTime != null) {
    if (typeof raw.startTime !== "string" || !CLOCK_TIME.test(raw.startTime)) {
      return { ok: false, error: "startTime must be HH:MM (24h)" };
    }
    startTime = raw.startTime;
  }
  let durationMin = 60;
  if (raw.durationMin !== undefined) {
    const d = Math.trunc(Number(raw.durationMin));
    if (!Number.isFinite(d) || d < 15) {
      return { ok: false, error: "durationMin must be 15 or more" };
    }
    if (startTime === null) {
      return { ok: false, error: "durationMin needs a startTime" };
    }
    durationMin = d;
  }
  return {
    ok: true,
    value: {
      summary,
      date: raw.date,
      startTime,
      durationMin,
      calendarId:
        typeof raw.calendarId === "string" && raw.calendarId ? raw.calendarId : "primary",
      description: typeof raw.description === "string" ? raw.description.trim() || null : null,
    },
  };
}

// ---------- daily log ----------

export type DailyLogInput = { mood: number; energy: number; sleepHours: number | null };

export function validateDailyLog(raw: Record<string, unknown>): Result<DailyLogInput> {
  const mood = Math.trunc(Number(raw.mood));
  const energy = Math.trunc(Number(raw.energy));
  if (!Number.isFinite(mood) || mood < 1 || mood > 5) {
    return { ok: false, error: "mood must be 1-5" };
  }
  if (!Number.isFinite(energy) || energy < 1 || energy > 5) {
    return { ok: false, error: "energy must be 1-5" };
  }
  let sleepHours: number | null = null;
  if (raw.sleepHours != null) {
    const s = Number(raw.sleepHours);
    if (!Number.isFinite(s) || s < 0 || s > 24) {
      return { ok: false, error: "sleepHours must be 0-24" };
    }
    sleepHours = Math.round(s * 10) / 10;
  }
  return { ok: true, value: { mood, energy, sleepHours } };
}

// ---------- settings ----------

const TIMEZONE_RE = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

export type UpdateSettingsInput = {
  timezone?: string;
  wakeStartHour?: number;
  wakeEndHour?: number;
  shoppingStore?: string | null;
  shoppingDay?: number | null;
  streamMaxTasks?: number;
};

export function validateUpdateSettings(
  raw: Record<string, unknown>,
): Result<UpdateSettingsInput> {
  const out: UpdateSettingsInput = {};
  if (raw.timezone !== undefined) {
    const tz = typeof raw.timezone === "string" ? raw.timezone.trim() : "";
    if (!tz || tz.length > 64 || !TIMEZONE_RE.test(tz)) {
      return { ok: false, error: "invalid timezone (use an IANA name like America/New_York)" };
    }
    out.timezone = tz;
  }
  if (raw.wakeStartHour !== undefined) {
    const h = Math.trunc(Number(raw.wakeStartHour));
    if (!Number.isFinite(h) || h < 0 || h > 23) {
      return { ok: false, error: "wakeStartHour must be 0-23" };
    }
    out.wakeStartHour = h;
  }
  if (raw.wakeEndHour !== undefined) {
    const h = Math.trunc(Number(raw.wakeEndHour));
    if (!Number.isFinite(h) || h < 1 || h > 24) {
      return { ok: false, error: "wakeEndHour must be 1-24" };
    }
    out.wakeEndHour = h;
  }
  if (raw.shoppingStore !== undefined) {
    if (raw.shoppingStore === null) {
      out.shoppingStore = null;
    } else {
      const store =
        typeof raw.shoppingStore === "string" ? raw.shoppingStore.trim() : "";
      if (!store || store.length > 200) {
        return { ok: false, error: "shoppingStore must be 1-200 chars (or null to clear)" };
      }
      out.shoppingStore = store;
    }
  }
  if (raw.shoppingDay !== undefined) {
    if (raw.shoppingDay === null) {
      out.shoppingDay = null;
    } else {
      const d = Math.trunc(Number(raw.shoppingDay));
      if (!Number.isFinite(d) || d < 0 || d > 6) {
        return { ok: false, error: "shoppingDay must be 0 (Sunday) through 6 (Saturday), or null to clear" };
      }
      out.shoppingDay = d;
    }
  }
  if (raw.streamMaxTasks !== undefined) {
    const n = Math.trunc(Number(raw.streamMaxTasks));
    if (!Number.isFinite(n) || n < 3 || n > 15) {
      return { ok: false, error: "streamMaxTasks must be 3-15" };
    }
    out.streamMaxTasks = n;
  }
  if (
    out.wakeStartHour !== undefined &&
    out.wakeEndHour !== undefined &&
    out.wakeEndHour <= out.wakeStartHour
  ) {
    return { ok: false, error: "wakeEndHour must be after wakeStartHour" };
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, error: "nothing to change" };
  }
  return { ok: true, value: out };
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
