import { describe, expect, test } from "vitest";

import {
  formatRecurrence,
  nextOccurrenceKey,
  occurrenceBusyEvents,
  taskRuleLandsOn,
  type RecurringTaskRule,
  type TaskRecurrence,
} from "@/app/lib/recurrence";

const MON = new Date(2026, 6, 6); // 2026-07-06 is a Monday
const TUE = new Date(2026, 6, 7);
const WED = new Date(2026, 6, 8);

function rule(over: Partial<TaskRecurrence>): TaskRecurrence {
  return {
    frequency: "daily",
    weekdays: null,
    day_of_month: null,
    interval_days: null,
    start_date: null,
    ...over,
  };
}

describe("taskRuleLandsOn", () => {
  test("daily lands every day", () => {
    expect(taskRuleLandsOn(rule({}), MON)).toBe(true);
    expect(taskRuleLandsOn(rule({}), TUE)).toBe(true);
  });

  test("weekly lands only on its weekdays (multi-weekday)", () => {
    const mwf = rule({ frequency: "weekly", weekdays: [1, 3, 5] });
    expect(taskRuleLandsOn(mwf, MON)).toBe(true);
    expect(taskRuleLandsOn(mwf, TUE)).toBe(false);
    expect(taskRuleLandsOn(mwf, WED)).toBe(true);
    expect(taskRuleLandsOn(rule({ frequency: "weekly", weekdays: null }), MON)).toBe(false);
  });

  test("monthly clamps day-of-month to the month length (delegated)", () => {
    const eom = rule({ frequency: "monthly", day_of_month: 31 });
    expect(taskRuleLandsOn(eom, new Date(2026, 1, 28))).toBe(true); // Feb 28
    expect(taskRuleLandsOn(eom, new Date(2026, 0, 31))).toBe(true);
    expect(taskRuleLandsOn(eom, new Date(2026, 0, 30))).toBe(false);
  });

  test("custom lands every N days from start_date (delegated)", () => {
    const every3 = rule({
      frequency: "custom",
      interval_days: 3,
      start_date: "2026-07-06",
    });
    expect(taskRuleLandsOn(every3, MON)).toBe(true);
    expect(taskRuleLandsOn(every3, TUE)).toBe(false);
    expect(taskRuleLandsOn(every3, new Date(2026, 6, 9))).toBe(true);
    expect(taskRuleLandsOn(every3, new Date(2026, 6, 3))).toBe(false); // before start
  });
});

describe("formatRecurrence", () => {
  test("labels each frequency", () => {
    expect(formatRecurrence(rule({}))).toBe("every day");
    expect(
      formatRecurrence(rule({ frequency: "weekly", weekdays: [5, 1, 3] })),
    ).toBe("mon/wed/fri");
    expect(
      formatRecurrence(rule({ frequency: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6] })),
    ).toBe("every day");
    expect(
      formatRecurrence(rule({ frequency: "monthly", day_of_month: 5 })),
    ).toBe("monthly · day 5");
    expect(
      formatRecurrence(rule({ frequency: "custom", interval_days: 3 })),
    ).toBe("every 3 days");
    expect(
      formatRecurrence(rule({ frequency: "custom", interval_days: 1 })),
    ).toBe("every day");
  });
});

describe("nextOccurrenceKey", () => {
  test("finds the first landing day at or after fromKey", () => {
    const mwf = rule({ frequency: "weekly", weekdays: [1, 3, 5] });
    expect(nextOccurrenceKey(mwf, "2026-07-06")).toBe("2026-07-06"); // Monday itself
    expect(nextOccurrenceKey(mwf, "2026-07-07")).toBe("2026-07-08"); // Tue -> Wed
  });

  test("returns null when nothing lands inside the horizon", () => {
    const never = rule({ frequency: "weekly", weekdays: [] });
    expect(nextOccurrenceKey(never, "2026-07-06", 14)).toBe(null);
  });
});

describe("occurrenceBusyEvents", () => {
  const timed: RecurringTaskRule = {
    id: "r1",
    title: "lunch",
    due_time: "12:30:00",
    duration_min: null,
    ...rule({}),
  };
  const untimed: RecurringTaskRule = {
    id: "r2",
    title: "brush teeth",
    due_time: null,
    duration_min: null,
    ...rule({}),
  };

  test("timed rules become 30min-default busy events; untimed contribute nothing", () => {
    const events = occurrenceBusyEvents([timed, untimed], ["2026-07-06"]);
    expect(events).toHaveLength(1);
    const start = new Date(events[0].start);
    const end = new Date(events[0].end);
    expect(start.getHours()).toBe(12);
    expect(start.getMinutes()).toBe(30);
    expect((end.getTime() - start.getTime()) / 60_000).toBe(30);
    expect(events[0].allDay).toBe(false);
  });

  test("duration_min is honored and non-landing days are skipped", () => {
    const gym: RecurringTaskRule = {
      id: "r3",
      title: "gym",
      due_time: "17:00",
      duration_min: 60,
      ...rule({ frequency: "weekly", weekdays: [1] }),
    };
    const events = occurrenceBusyEvents([gym], ["2026-07-06", "2026-07-07"]);
    expect(events).toHaveLength(1); // Monday only
    const start = new Date(events[0].start);
    const end = new Date(events[0].end);
    expect((end.getTime() - start.getTime()) / 60_000).toBe(60);
  });
});
