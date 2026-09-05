import { describe, expect, test } from "vitest";

import {
  composeWatchToday,
  WATCH_NOTES_MAX,
  WATCH_SECTION_LIMIT,
  type WatchTodayInput,
} from "@/app/lib/watch/today";

const TODAY = "2026-09-04"; // a Friday
const NOW = new Date("2026-09-04T17:30:00.000Z");

function task(
  id: string,
  due: string,
  extra: Partial<WatchTodayInput["tasks"][number]> = {},
): WatchTodayInput["tasks"][number] {
  return {
    id,
    title: id,
    due_date: due,
    due_time: null,
    status: "todo",
    priority: "med",
    notes: null,
    created_at: "2026-09-01T00:00:00Z",
    group_name: null,
    ...extra,
  };
}

function base(overrides: Partial<WatchTodayInput> = {}): WatchTodayInput {
  return {
    tasks: [],
    doneTodayCount: 0,
    rules: [],
    completedRuleIds: new Set(),
    slotStartByRule: new Map(),
    events: null,
    schedule: null,
    today: TODAY,
    now: NOW,
    timeZone: "America/Vancouver",
    ...overrides,
  };
}

describe("composeWatchToday", () => {
  test("buckets overdue vs due today and orders by date, time, priority", () => {
    const out = composeWatchToday(
      base({
        tasks: [
          task("later", "2026-09-10"),
          task("old-low", "2026-09-01", { priority: "low" }),
          task("old-high", "2026-09-01", { priority: "high" }),
          task("older", "2026-08-30"),
          task("today-untimed", TODAY),
          task("today-9", TODAY, { due_time: "09:00:00" }),
          task("done", TODAY, { status: "done" }),
        ],
        doneTodayCount: 1,
      }),
    );
    expect(out.overdue.map((t) => t.id)).toEqual(["older", "old-high", "old-low"]);
    expect(out.dueToday.map((t) => t.id)).toEqual(["today-9", "today-untimed"]);
    expect(out.dueToday[0].time).toBe("09:00");
    expect(out.dueToday[0]).toMatchObject({ priority: "med", group: null, notes: null });
    expect(out.counts).toEqual({
      overdue: 3,
      dueToday: 2,
      doneToday: 1,
      routines: 0,
      routinesDone: 0,
    });
    expect(out.meta).toEqual({
      serverTime: NOW.toISOString(),
      timeZone: "America/Vancouver",
      today: TODAY,
    });
  });

  test("routines are the rules landing today, done state from completions, slot time wins", () => {
    const out = composeWatchToday(
      base({
        rules: [
          { id: "daily", title: "stretch", frequency: "daily", weekdays: null, day_of_month: null, interval_days: null, start_date: null, due_time: "07:30:00" },
          { id: "fri", title: "gym", frequency: "weekly", weekdays: [5], day_of_month: null, interval_days: null, start_date: null, due_time: null },
          { id: "mon", title: "laundry", frequency: "weekly", weekdays: [1], day_of_month: null, interval_days: null, start_date: null, due_time: null },
        ],
        completedRuleIds: new Set(["daily"]),
        slotStartByRule: new Map([["fri", "18:00:00"]]),
      }),
    );
    expect(out.routines).toEqual([
      { id: "fri", title: "gym", time: "18:00", done: false },
      { id: "daily", title: "stretch", time: "07:30", done: true },
    ]);
    expect(out.counts.routines).toBe(2);
    expect(out.counts.routinesDone).toBe(1);
  });

  test("schedule maps to nextEvent + freeHours and degrades to nulls", () => {
    const withSchedule = composeWatchToday(
      base({
        schedule: {
          nextEvent: { summary: "standup", start: "2026-09-04T18:00:00.000Z" },
          freeHoursToday: 2.5,
        },
      }),
    );
    expect(withSchedule.nextEvent).toEqual({ title: "standup", start: "2026-09-04T18:00:00.000Z" });
    expect(withSchedule.freeHours).toBe(2.5);
    const without = composeWatchToday(base());
    expect(without.nextEvent).toBeNull();
    expect(without.freeHours).toBeNull();
  });

  test("rows carry group, priority and clipped notes for the detail screen", () => {
    const out = composeWatchToday(
      base({
        tasks: [
          task("t", TODAY, {
            priority: "high",
            group_name: "CPSC 110",
            notes: `  ${"x".repeat(WATCH_NOTES_MAX + 50)}  `,
          }),
          task("blank", TODAY, { notes: "   " }),
        ],
      }),
    );
    expect(out.dueToday[0]).toMatchObject({ priority: "high", group: "CPSC 110" });
    expect(out.dueToday[0].notes).toHaveLength(WATCH_NOTES_MAX);
    expect(out.dueToday[0].notes?.endsWith("…")).toBe(true);
    expect(out.dueToday[1].notes).toBeNull();
  });

  test("events keep what's left of the day: all-day first, ended timed events dropped", () => {
    const out = composeWatchToday(
      base({
        events: [
          { summary: "Later", start: "2026-09-04T19:00:00.000Z", end: "2026-09-04T20:00:00.000Z", allDay: false },
          { summary: "Ended", start: "2026-09-04T16:00:00.000Z", end: "2026-09-04T17:00:00.000Z", allDay: false },
          { summary: "Ongoing", start: "2026-09-04T17:00:00.000Z", end: "2026-09-04T18:00:00.000Z", allDay: false },
          { summary: "Holiday", start: TODAY, end: "2026-09-05", allDay: true },
        ],
      }),
    );
    expect(out.events.map((e) => e.title)).toEqual(["Holiday", "Ongoing", "Later"]);
    expect(out.events[0]).toEqual({ title: "Holiday", start: TODAY, end: "2026-09-05", allDay: true });
    expect(composeWatchToday(base()).events).toEqual([]);
  });

  test("sections are capped but counts stay total", () => {
    const tasks = Array.from({ length: 25 }, (_, i) => task(`t${i}`, TODAY));
    const out = composeWatchToday(base({ tasks }));
    expect(out.dueToday).toHaveLength(WATCH_SECTION_LIMIT);
    expect(out.counts.dueToday).toBe(25);
  });
});
