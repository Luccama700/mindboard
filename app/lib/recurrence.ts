// Pure recurrence predicate + helpers for recurring tasks. No React, no server
// imports — unit tested like the finance/inventory projections. Weekly rules
// support multiple weekdays; every other frequency delegates to the tested
// finance `ruleLandsOn` (month-length clamp, interval-from-start math).

import {
  ruleLandsOn,
  type RecurringRule,
} from "@/app/_components/finance-projection";
import type { ScheduleEvent } from "@/app/lib/snapshots/schedule";

export type TaskRecurrence = {
  frequency: "daily" | "weekly" | "monthly" | "custom";
  weekdays: number[] | null; // weekly: 0 (sun) – 6 (sat)
  day_of_month: number | null; // monthly
  interval_days: number | null; // custom
  start_date: string | null; // custom
};

export type RecurringTaskRule = TaskRecurrence & {
  id: string;
  title: string;
  due_time: string | null; // "HH:MM:SS" or "HH:MM"; null = untimed
  duration_min: number | null;
};

export const DEFAULT_OCCURRENCE_MINUTES = 30;

const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

export function taskRuleLandsOn(rule: TaskRecurrence, date: Date): boolean {
  if (rule.frequency === "weekly") {
    return rule.weekdays !== null && rule.weekdays.includes(date.getDay());
  }
  const delegate: RecurringRule = {
    frequency: rule.frequency,
    day_of_month: rule.day_of_month,
    weekday: null,
    interval_days: rule.interval_days,
    start_date: rule.start_date,
    amount: 0,
  };
  return ruleLandsOn(delegate, date);
}

// "every day", "mon/wed/fri", "monthly · day 5", "every 3 days"
export function formatRecurrence(rule: TaskRecurrence): string {
  switch (rule.frequency) {
    case "daily":
      return "every day";
    case "weekly": {
      const days = [...new Set(rule.weekdays ?? [])]
        .filter((d) => d >= 0 && d <= 6)
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_SHORT[d]);
      return days.length === 7 ? "every day" : days.join("/") || "weekly";
    }
    case "monthly":
      return rule.day_of_month === null
        ? "monthly"
        : `monthly · day ${rule.day_of_month}`;
    case "custom":
      return rule.interval_days === 1
        ? "every day"
        : `every ${rule.interval_days ?? "?"} days`;
  }
}

// The first date key >= fromKey the rule lands on, within horizonDays.
export function nextOccurrenceKey(
  rule: TaskRecurrence,
  fromKey: string,
  horizonDays = 62,
): string | null {
  const cursor = parseKey(fromKey);
  for (let i = 0; i < horizonDays; i++) {
    if (taskRuleLandsOn(rule, cursor)) return toKey(cursor);
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

// An approved per-occurrence slot (migration 0042): a committed time that
// overrides the rule's due_time for that day.
export type RecurringSlot = {
  rule_id: string;
  occurred_on: string;
  start_time: string; // "HH:MM:SS" or "HH:MM"
  duration_min: number | null;
};

// Timed occurrences as synthetic busy events, for the free-time math
// (scheduleSnapshot / freeGaps / the week underlay). Untimed rules are
// list-only and contribute nothing.
//
// Slot precedence invariant: an approved slot is a commitment that OVERRIDES the
// rule's due_time for its day, so it must never be double-counted. Callers pass
// a `skip` set of "${ruleId}:${dateKey}" keys that have a slot; those occurrences
// emit nothing here and are supplied instead by slotBusyEvents.
export function occurrenceBusyEvents(
  rules: RecurringTaskRule[],
  dateKeys: string[],
  skip?: Set<string>,
): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];
  for (const key of dateKeys) {
    const date = parseKey(key);
    for (const rule of rules) {
      if (!rule.due_time || !taskRuleLandsOn(rule, date)) continue;
      if (skip?.has(`${rule.id}:${key}`)) continue;
      const [h, m] = rule.due_time.split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      const start = new Date(date);
      start.setHours(h, m, 0, 0);
      const end = new Date(
        start.getTime() +
          (rule.duration_min ?? DEFAULT_OCCURRENCE_MINUTES) * 60_000,
      );
      events.push({
        summary: rule.title,
        start: start.toISOString(),
        end: end.toISOString(),
        allDay: false,
      });
    }
  }
  return events;
}

// Approved slots as synthetic busy events, the commitment counterpart to
// occurrenceBusyEvents. Duration precedence: slot > rule > default. A slot whose
// rule id is unknown (archived/deleted) is skipped.
export function slotBusyEvents(
  slots: RecurringSlot[],
  rules: Pick<RecurringTaskRule, "id" | "title" | "duration_min">[],
): ScheduleEvent[] {
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const events: ScheduleEvent[] = [];
  for (const slot of slots) {
    const rule = ruleById.get(slot.rule_id);
    if (!rule) continue;
    const [h, m] = slot.start_time.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    const minutes =
      slot.duration_min ?? rule.duration_min ?? DEFAULT_OCCURRENCE_MINUTES;
    const start = parseKey(slot.occurred_on);
    start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + minutes * 60_000);
    events.push({
      summary: rule.title,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: false,
    });
  }
  return events;
}
