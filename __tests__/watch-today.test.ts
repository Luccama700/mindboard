import { describe, expect, test } from "vitest";

import {
  composeWatchToday,
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
    created_at: "2026-09-01T00:00:00Z",
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

  test("sections are capped but counts stay total", () => {
    const tasks = Array.from({ length: 25 }, (_, i) => task(`t${i}`, TODAY));
    const out = composeWatchToday(base({ tasks }));
    expect(out.dueToday).toHaveLength(WATCH_SECTION_LIMIT);
    expect(out.counts.dueToday).toBe(25);
  });
});
