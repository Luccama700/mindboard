import { describe, expect, test } from "vitest";

import {
  planningSnapshot,
  type PlanningInput,
  type PlanningRecurringRule,
} from "@/app/lib/snapshots/planning";
import type { TaskWithGroup } from "@/app/_components/types";

// Server clock is UTC; the user is in New York (EDT = UTC-4 in July).
// now = 16:00Z = 12:00 local on Wed 2026-07-08.
const NY = "America/New_York";
const NOW = new Date("2026-07-08T16:00:00Z");

function task(over: Partial<TaskWithGroup>): TaskWithGroup {
  return {
    id: "t",
    title: "task",
    due_date: null,
    due_time: null,
    duration_min: null,
    status: "todo",
    priority: "med",
    notes: null,
    group_id: null,
    gcal_event_id: null,
    gcal_calendar_id: null,
    created_at: "2026-07-01T00:00:00Z",
    completed_at: null,
    group_name: null,
    group_color: null,
    ...over,
  };
}

const recurring: PlanningRecurringRule[] = [
  {
    id: "r1",
    title: "meds",
    frequency: "daily",
    weekdays: null,
    day_of_month: null,
    interval_days: null,
    start_date: null,
    due_time: "20:00",
    duration_min: 15,
    priority: "med",
    group_name: null,
  },
  {
    id: "r2",
    title: "stretch",
    frequency: "daily",
    weekdays: null,
    day_of_month: null,
    interval_days: null,
    start_date: null,
    due_time: null, // untimed habit — lists but never blocks a slot
    duration_min: null,
    priority: "low",
    group_name: "health",
  },
];

function baseInput(): PlanningInput {
  return {
    today: "2026-07-08",
    now: NOW,
    horizonDays: 2, // → 2026-07-08, -09, -10
    timeZone: NY,
    wakeStartHour: 8,
    wakeEndHour: 22,
    beforeHour: 17,
    events: [
      {
        summary: "lunch sync",
        start: "2026-07-08T17:00:00Z", // 13:00 EDT
        end: "2026-07-08T18:00:00Z",
        allDay: false,
      },
      { summary: "Conference", start: "2026-07-09", end: "2026-07-10", allDay: true },
    ],
    recurringTasks: recurring,
    completedRecurring: new Set(["r1|2026-07-08"]),
    tasks: [
      task({ id: "over", title: "overdue", due_date: "2026-07-01" }),
      task({
        id: "today",
        title: "today block",
        due_date: "2026-07-08",
        due_time: "15:00:00",
        duration_min: 60,
        priority: "high",
      }),
      task({ id: "up", title: "upcoming", due_date: "2026-07-09" }),
      task({ id: "undated", title: "someday" }),
      task({ id: "far", title: "far future", due_date: "2026-08-01" }),
    ],
    accounts: [
      { id: "a1", name: "checking", balance: 800, currency: "USD" },
      { id: "a2", name: "savings", balance: 200, currency: "USD" },
    ],
    recurringExpenses: [
      {
        id: "b1",
        name: "rent",
        frequency: "monthly",
        day_of_month: 9,
        weekday: null,
        interval_days: null,
        start_date: null,
        amount: 50,
      },
    ],
    todayDelta: -12,
    forecast: [
      { date: "2026-07-08", inflow: 0, outflow: 0, estimatedEverydaySpend: 0, projectedNetWorth: 1000 },
      { date: "2026-07-09", inflow: 0, outflow: 50, estimatedEverydaySpend: 10, projectedNetWorth: 940 },
      { date: "2026-07-10", inflow: 0, outflow: 0, estimatedEverydaySpend: 10, projectedNetWorth: 930 },
    ],
    everydaySpend: { dailyRate: 10, confident: true, manualFallback: null },
    items: [
      { id: "i1", name: "milk", quantity: 2, unit: "L", reorder_threshold: 1 },
    ],
    usagesByItem: { i1: [{ amount: 1, period: "day", interval_days: null }] },
    checkins: [
      { date: "2026-07-07", mood: 4, energy: 3, sleepHours: 7 },
      { date: "2026-07-06", mood: 3, energy: 3, sleepHours: 6.5 },
    ],
    goals: [
      { id: "g1", title: "ship v1", horizon: "quarter", status: "active", target_date: "2026-09-01" },
    ],
  };
}

describe("planningSnapshot", () => {
  test("frames the horizon and stamps local time with an explicit offset", () => {
    const s = planningSnapshot(baseInput());
    expect(s.today).toBe("2026-07-08");
    expect(s.horizonEnd).toBe("2026-07-10");
    expect(s.generatedAt).toBe("2026-07-08T12:00:00-04:00");
    expect(s.schedule.days.map((d) => d.date)).toEqual([
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
    ]);
  });

  test("materializes timed blocks chronologically with their source, in local ISO", () => {
    const day0 = planningSnapshot(baseInput()).schedule.days[0];
    expect(day0.timed).toEqual([
      { title: "lunch sync", start: "2026-07-08T17:00:00Z", end: "2026-07-08T18:00:00Z", source: "google" },
      { title: "today block", start: "2026-07-08T15:00:00-04:00", end: "2026-07-08T16:00:00-04:00", source: "task" },
      { title: "meds", start: "2026-07-08T20:00:00-04:00", end: "2026-07-08T20:15:00-04:00", source: "recurring" },
    ]);
  });

  test("computes committed load and free-before-hour in the user's zone", () => {
    const day0 = planningSnapshot(baseInput()).schedule.days[0];
    // Busy inside noon–22:00: lunch 60 + block 60 + meds 15 = 135.
    expect(day0.committedMinutes).toBe(135);
    // Free before 17:00: 12–13, 14–15, 16–17 = 3h.
    expect(day0.freeHoursBeforeHour).toBe(3);
    expect(day0.freeGaps[0]).toEqual({ start: "12:00", end: "13:00", minutes: 60 });
  });

  test("free hours today count every blocking source", () => {
    // noon–22:00 = 600 min, minus 135 committed = 465 = 7.75h, rounded to 7.8.
    expect(planningSnapshot(baseInput()).schedule.freeHoursToday).toBe(7.8);
  });

  test("buckets all-day events by floating date, not a shifted instant", () => {
    const days = planningSnapshot(baseInput()).schedule.days;
    expect(days[0].allDay).toEqual([]); // NOT pulled back to 07-08
    expect(days[1].allDay).toEqual(["Conference"]);
  });

  test("materializes recurring occurrences across the whole horizon, timed and untimed", () => {
    const occ = planningSnapshot(baseInput()).tasks.recurringOccurrences;
    expect(occ).toHaveLength(6); // 2 rules × 3 days
    const meds0708 = occ.find((o) => o.ruleId === "r1" && o.date === "2026-07-08");
    expect(meds0708).toMatchObject({ dueTime: "20:00", done: true });
    const stretch = occ.find((o) => o.ruleId === "r2");
    expect(stretch?.dueTime).toBeNull();
    expect(occ.filter((o) => o.done)).toHaveLength(1); // only the known completion
  });

  test("lists open tasks in-horizon with buckets and the scheduled flag", () => {
    const t = planningSnapshot(baseInput()).tasks;
    expect(t.summary).toEqual({ overdue: 1, dueToday: 1, dueSoon: 1 });
    expect(t.items.map((i) => i.id).sort()).toEqual(["over", "today", "undated", "up"]);
    // Far-future task (beyond the horizon) is excluded from the list.
    expect(t.items.find((i) => i.id === "far")).toBeUndefined();
    expect(t.items.find((i) => i.id === "today")?.scheduled).toBe(true);
    expect(t.items.find((i) => i.id === "over")?.scheduled).toBe(false);
  });

  test("surfaces net worth, today delta, upcoming bills, and the projection", () => {
    const f = planningSnapshot(baseInput()).finance;
    expect(f.netWorth).toBe(1000);
    expect(f.todayDelta).toBe(-12);
    expect(f.upcomingBills).toEqual([{ name: "rent", amount: 50, dateKey: "2026-07-09" }]);
    expect(f.projectedNetWorth).toHaveLength(3);
    expect(f.projectedNetWorth[2].projectedNetWorth).toBe(930);
  });

  test("projects inventory run-out where a burn rate is known", () => {
    const inv = planningSnapshot(baseInput()).inventory;
    expect(inv.summary.soonestRunOut).toEqual({ name: "milk", dateKey: "2026-07-10" });
    expect(inv.items[0]).toMatchObject({
      name: "milk",
      status: "ok",
      dailyRate: 1,
      daysLeft: 2,
      runOutDate: "2026-07-10",
      reorderBy: "2026-07-09",
    });
  });

  test("passes through signals: check-in trend and active goals", () => {
    const sig = planningSnapshot(baseInput()).signals;
    expect(sig.checkins).toHaveLength(2);
    expect(sig.goals[0]).toEqual({
      id: "g1",
      title: "ship v1",
      horizon: "quarter",
      status: "active",
      targetDate: "2026-09-01",
    });
  });
});
