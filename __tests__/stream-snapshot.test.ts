import { describe, expect, test } from "vitest";

import {
  streamSnapshot,
  type StreamInput,
} from "@/app/lib/snapshots/stream";
import type { TaskWithGroup } from "@/app/_components/types";

const TODAY = "2026-07-06"; // a Monday
const NOON = new Date(2026, 6, 6, 12, 0, 0);

function task(over: Partial<TaskWithGroup> & { id: string }): TaskWithGroup {
  return {
    title: `task ${over.id}`,
    due_date: null,
    due_time: null,
    duration_min: null,
    gcal_event_id: null,
    gcal_calendar_id: null,
    status: "todo",
    priority: "med",
    notes: null,
    group_id: "g1",
    created_at: "2026-07-01T10:00:00.000Z",
    completed_at: null,
    group_name: "life",
    group_color: "#fff",
    ...over,
  };
}

function base(over: Partial<StreamInput> = {}): StreamInput {
  return {
    today: TODAY,
    now: NOON,
    tasks: [],
    events: [],
    bills: [],
    recurringTasks: [],
    completedRecurringToday: new Set(),
    items: [],
    usagesByItem: {},
    goals: [],
    hasDailyLogToday: false,
    moodToday: null,
    pendingProposals: 0,
    wakeEndHour: 22,
    freeHoursToday: 4.2,
    todayDelta: 0,
    currency: "USD",
    ...over,
  };
}

function ids(cards: { id: string }[]): string[] {
  return cards.map((c) => c.id);
}

describe("NOW membership (objective facts only)", () => {
  test("a due-today task with a past due_time is NOW; a future due_time stays NEXT", () => {
    const snap = streamSnapshot(
      base({
        tasks: [
          task({ id: "past", due_date: TODAY, due_time: "11:00:00" }),
          task({ id: "future", due_date: TODAY, due_time: "15:00:00" }),
          task({ id: "untimed", due_date: TODAY }),
        ],
      }),
    );
    expect(ids(snap.now)).toEqual(["task:past"]);
    expect(ids(snap.next)).toEqual(["task:future", "task:untimed"]);
    expect(snap.now[0].meta).toContain("⌚ 11:00");
  });

  test("overdue task is NOW; due-today task is NEXT; priority never promotes", () => {
    const snap = streamSnapshot(
      base({
        tasks: [
          task({ id: "over", due_date: "2026-07-04" }),
          task({ id: "today-high", due_date: TODAY, priority: "high" }),
        ],
      }),
    );
    expect(ids(snap.now)).toEqual(["task:over"]);
    expect(ids(snap.next)).toEqual(["task:today-high"]);
  });

  test("event in progress or starting within 60min is NOW; later today is NEXT", () => {
    const snap = streamSnapshot(
      base({
        events: [
          {
            id: "soon",
            summary: "standup",
            start: "2026-07-06T12:30:00",
            end: "2026-07-06T13:00:00",
            allDay: false,
          },
          {
            id: "running",
            summary: "focus block",
            start: "2026-07-06T11:00:00",
            end: "2026-07-06T12:30:00",
            allDay: false,
          },
          {
            id: "tonight",
            summary: "gym",
            start: "2026-07-06T17:00:00",
            end: "2026-07-06T18:00:00",
            allDay: false,
          },
          {
            id: "ended",
            summary: "breakfast",
            start: "2026-07-06T08:00:00",
            end: "2026-07-06T09:00:00",
            allDay: false,
          },
        ],
      }),
    );
    expect(ids(snap.now)).toEqual(["event:running", "event:soon"]);
    expect(ids(snap.next)).toEqual(["event:tonight"]);
  });

  test("all-day events never enter the stream sections", () => {
    const snap = streamSnapshot(
      base({
        events: [
          {
            id: "allday",
            summary: "conference",
            start: "2026-07-06",
            end: "2026-07-07",
            allDay: true,
          },
        ],
      }),
    );
    expect(snap.now).toEqual([]);
    expect(snap.next).toEqual([]);
  });

  test("bill landing today is NOW; next bill within 7d is LATER", () => {
    const snap = streamSnapshot(
      base({
        bills: [
          {
            id: "rent",
            name: "rent",
            frequency: "monthly",
            day_of_month: 6,
            weekday: null,
            interval_days: null,
            start_date: null,
            amount: 1400,
          },
          {
            id: "phone",
            name: "phone",
            frequency: "monthly",
            day_of_month: 8,
            weekday: null,
            interval_days: null,
            start_date: null,
            amount: 45,
          },
        ],
      }),
    );
    expect(ids(snap.now)).toEqual([`bill:rent:${TODAY}`]);
    expect(ids(snap.later)).toEqual(["bill:phone:2026-07-08"]);
  });

  test("run-out today (or already out) is NOW; low-but-not-out is NEXT; run-out within 7d is LATER", () => {
    const snap = streamSnapshot(
      base({
        items: [
          {
            id: "coffee",
            name: "coffee",
            quantity: 1,
            unit: "bag",
            reorder_threshold: null,
            priority: "med" as const,
          },
          {
            id: "tp",
            name: "toilet paper",
            quantity: 0,
            unit: "rolls",
            reorder_threshold: null,
            priority: "med" as const,
          },
          {
            id: "soap",
            name: "soap",
            quantity: 2,
            unit: "bars",
            reorder_threshold: 3,
            priority: "med" as const,
          },
          {
            id: "rice",
            name: "rice",
            quantity: 3,
            unit: "kg",
            reorder_threshold: null,
            priority: "med" as const,
          },
        ],
        usagesByItem: {
          coffee: [{ amount: 1, period: "day", interval_days: null }],
          rice: [{ amount: 1, period: "day", interval_days: null }],
        },
      }),
    );
    // coffee: 1 bag @ 1/day -> out tomorrow? ceil(1/1)=1 day -> 07-07 (LATER).
    // tp: quantity 0 -> NOW. soap: low (2<=3), no usage -> NEXT.
    // rice: out in 3 days -> LATER.
    expect(ids(snap.now)).toEqual(["item:tp"]);
    expect(ids(snap.next)).toEqual(["item:soap"]);
    expect(ids(snap.later)).toEqual(["item:coffee", "item:rice"]);
  });
});

describe("recurring tasks", () => {
  const rule = (
    over: Partial<import("@/app/lib/snapshots/stream").StreamRecurringTaskInput> & {
      id: string;
    },
  ) => ({
    title: over.id,
    frequency: "daily" as const,
    weekdays: null,
    day_of_month: null,
    interval_days: null,
    start_date: null,
    due_time: null,
    duration_min: null,
    priority: "med" as const,
    group_name: null,
    ...over,
  });

  test("today's occurrences interleave into NEXT by time; non-landing rules are absent", () => {
    const snap = streamSnapshot(
      base({
        tasks: [task({ id: "t1", due_date: TODAY, due_time: "14:00:00" })],
        recurringTasks: [
          rule({ id: "lunch", due_time: "12:30:00" }),
          rule({ id: "teeth" }), // untimed -> after timed
          rule({ id: "sunday", frequency: "weekly", weekdays: [0] }), // not today (Monday)
        ],
      }),
    );
    expect(ids(snap.next)).toEqual([
      `rtask:lunch:${TODAY}`,
      "task:t1",
      `rtask:teeth:${TODAY}`,
    ]);
    expect(snap.next[0].meta).toContain("⌚ 12:30");
    expect(snap.next[0].meta).toContain("every day");
    expect(snap.next[0].glyph).toBe("↻");
  });

  test("a timed occurrence whose time has passed moves to NOW after overdue tasks", () => {
    const snap = streamSnapshot(
      base({
        tasks: [task({ id: "over", due_date: "2026-07-04" })],
        recurringTasks: [rule({ id: "breakfast", due_time: "08:00:00" })],
      }),
    );
    expect(ids(snap.now)).toEqual(["task:over", `rtask:breakfast:${TODAY}`]);
  });

  test("completed occurrences disappear for the rest of today", () => {
    const snap = streamSnapshot(
      base({
        recurringTasks: [
          rule({ id: "breakfast", due_time: "08:00:00" }),
          rule({ id: "lunch", due_time: "13:00:00" }),
        ],
        completedRecurringToday: new Set(["breakfast"]),
      }),
    );
    expect(ids(snap.now)).toEqual([]);
    expect(ids(snap.next)).toEqual([`rtask:lunch:${TODAY}`]);
  });

  test("no recurring cards in LATER — the week view carries the forward picture", () => {
    const snap = streamSnapshot(
      base({
        recurringTasks: [rule({ id: "daily-late", due_time: "20:00:00" })],
      }),
    );
    expect(ids(snap.later)).toEqual([]);
  });
});

describe("stock priority", () => {
  const stockItem = (
    over: Partial<import("@/app/lib/snapshots/stream").StreamItemInput> & {
      id: string;
    },
  ) => ({
    name: over.id,
    quantity: 5,
    unit: "",
    reorder_threshold: null,
    priority: "med" as const,
    ...over,
  });

  test("high-priority stock escalates to NOW while merely running low, above tasks", () => {
    const snap = streamSnapshot(
      base({
        tasks: [task({ id: "over", due_date: "2026-07-04" })],
        items: [
          stockItem({ id: "meds", quantity: 2, reorder_threshold: 3, priority: "high" }),
          stockItem({ id: "soon", quantity: 2, priority: "high" }),
        ],
        usagesByItem: {
          soon: [{ amount: 1, period: "day", interval_days: null }],
        },
      }),
    );
    // meds: below threshold; soon: runs out in 2 days (within the lead window).
    expect(ids(snap.now)).toEqual(["item:soon", "item:meds", "task:over"]);
    expect(snap.now[0].meta).toContain("!!!");
    expect(snap.now[1].meta).toContain("!!!");
    expect(snap.pulse.toClear).toBe(3);
  });

  test("high-priority out sits before high-priority low; med out stays after tasks", () => {
    const snap = streamSnapshot(
      base({
        tasks: [task({ id: "over", due_date: "2026-07-04" })],
        items: [
          stockItem({ id: "low-high", quantity: 1, reorder_threshold: 2, priority: "high" }),
          stockItem({ id: "out-high", quantity: 0, priority: "high" }),
          stockItem({ id: "out-med", quantity: 0 }),
        ],
      }),
    );
    expect(ids(snap.now)).toEqual([
      "item:out-high",
      "item:low-high",
      "task:over",
      "item:out-med",
    ]);
  });

  test("low-priority stock never enters the Stream", () => {
    const snap = streamSnapshot(
      base({
        items: [
          stockItem({ id: "batteries", quantity: 0, priority: "low" }),
          stockItem({ id: "twine", quantity: 1, reorder_threshold: 5, priority: "low" }),
          stockItem({ id: "glue", quantity: 2, priority: "low" }),
        ],
        usagesByItem: {
          glue: [{ amount: 1, period: "day", interval_days: null }],
        },
      }),
    );
    const all = [...snap.now, ...snap.next, ...snap.later].map((c) => c.id);
    expect(all.filter((id) => id.startsWith("item:"))).toEqual([]);
    expect(snap.pulse.toClear).toBe(0);
  });

  test("high-priority stock that is not near running out stays out of NOW", () => {
    const snap = streamSnapshot(
      base({
        items: [
          stockItem({ id: "coffee", quantity: 10, priority: "high" }),
          stockItem({ id: "rice", quantity: 5, priority: "high" }),
        ],
        usagesByItem: {
          rice: [{ amount: 1, period: "day", interval_days: null }],
        },
      }),
    );
    // rice runs out in 5 days: beyond the 2-day lead -> LATER, not NOW.
    expect(ids(snap.now)).toEqual([]);
    expect(ids(snap.later)).toEqual(["item:rice"]);
  });
});

describe("ordering within sections", () => {
  test("NOW: events by start, then tasks by priority desc then days-late desc, then bills, then run-outs", () => {
    const snap = streamSnapshot(
      base({
        tasks: [
          task({ id: "late-med", due_date: "2026-07-01", priority: "med" }),
          task({ id: "late-high", due_date: "2026-07-05", priority: "high" }),
          task({ id: "later-med", due_date: "2026-06-20", priority: "med" }),
        ],
        events: [
          {
            id: "b",
            summary: "b",
            start: "2026-07-06T12:45:00",
            end: "2026-07-06T13:00:00",
            allDay: false,
          },
          {
            id: "a",
            summary: "a",
            start: "2026-07-06T12:15:00",
            end: "2026-07-06T13:00:00",
            allDay: false,
          },
        ],
        bills: [
          {
            id: "rent",
            name: "rent",
            frequency: "monthly",
            day_of_month: 6,
            weekday: null,
            interval_days: null,
            start_date: null,
            amount: 1400,
          },
        ],
        items: [
          {
            id: "tp",
            name: "tp",
            quantity: 0,
            unit: "rolls",
            reorder_threshold: null,
            priority: "med" as const,
          },
        ],
      }),
    );
    expect(ids(snap.now)).toEqual([
      "event:a",
      "event:b",
      "task:late-high",
      "task:later-med",
      "task:late-med",
      `bill:rent:${TODAY}`,
      "item:tp",
    ]);
  });

  test("NOW is never capped", () => {
    const tasks = Array.from({ length: 9 }, (_, i) =>
      task({ id: `t${i}`, due_date: "2026-07-01" }),
    );
    const snap = streamSnapshot(base({ tasks }));
    expect(snap.now).toHaveLength(9);
  });

  test("NEXT caps at 5 with overflow count; time-anchored first", () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      task({ id: `t${i}`, due_date: TODAY }),
    );
    const snap = streamSnapshot(
      base({
        tasks,
        events: [
          {
            id: "tonight",
            summary: "gym",
            start: "2026-07-06T17:00:00",
            end: "2026-07-06T18:00:00",
            allDay: false,
          },
        ],
      }),
    );
    expect(snap.next).toHaveLength(5);
    expect(snap.next[0].id).toBe("event:tonight");
    expect(snap.nextOverflow).toBe(2);
  });

  test("tomorrow's first event (only) appears in NEXT", () => {
    const snap = streamSnapshot(
      base({
        events: [
          {
            id: "tmr2",
            summary: "later tomorrow",
            start: "2026-07-07T15:00:00",
            end: "2026-07-07T16:00:00",
            allDay: false,
          },
          {
            id: "tmr1",
            summary: "early tomorrow",
            start: "2026-07-07T09:00:00",
            end: "2026-07-07T10:00:00",
            allDay: false,
          },
        ],
      }),
    );
    expect(ids(snap.next)).toEqual(["event:tmr1"]);
  });

  test("LATER sorts by date ascending and caps at 5", () => {
    const tasks = [
      task({ id: "d3", due_date: "2026-07-09" }),
      task({ id: "d1", due_date: "2026-07-07" }),
      task({ id: "d2", due_date: "2026-07-08" }),
      task({ id: "d4", due_date: "2026-07-10" }),
      task({ id: "d5", due_date: "2026-07-11" }),
      task({ id: "d6", due_date: "2026-07-12" }),
    ];
    const snap = streamSnapshot(base({ tasks }));
    expect(ids(snap.later)).toEqual([
      "task:d1",
      "task:d2",
      "task:d3",
      "task:d4",
      "task:d5",
    ]);
    expect(snap.laterOverflow).toBe(1);
  });

  test("tasks due beyond 7 days are absent everywhere", () => {
    const snap = streamSnapshot(
      base({ tasks: [task({ id: "far", due_date: "2026-07-20" })] }),
    );
    expect([...snap.now, ...snap.next, ...snap.later]).toEqual([]);
  });
});

describe("LATER daily-log invite", () => {
  test("appears only after wake_end - 2h when today's log is empty", () => {
    const evening = new Date(2026, 6, 6, 20, 30, 0);
    const early = streamSnapshot(base({ now: NOON }));
    expect(ids(early.later)).toEqual([]);

    const late = streamSnapshot(base({ now: evening }));
    expect(ids(late.later)).toEqual(["log:today"]);

    const logged = streamSnapshot(
      base({ now: evening, hasDailyLogToday: true }),
    );
    expect(ids(logged.later)).toEqual([]);
  });

  test("with a timeZone, the gate reads the user's wall clock, not the process clock", () => {
    // 2026-07-07T06:38Z is 11:38pm on July 6 in Vancouver — invite time,
    // even though the process (UTC) clock says 06:38 the next morning.
    const lateEveningVancouver = new Date("2026-07-07T06:38:00Z");
    const snap = streamSnapshot(
      base({ now: lateEveningVancouver, timeZone: "America/Vancouver" }),
    );
    expect(ids(snap.later)).toEqual(["log:today"]);

    // 9am Vancouver the same day is far too early.
    const morning = new Date("2026-07-06T16:00:00Z");
    const early = streamSnapshot(
      base({ now: morning, timeZone: "America/Vancouver" }),
    );
    expect(ids(early.later)).toEqual([]);
  });
});

describe("LOOSE ENDS", () => {
  test("renders nothing when tidy", () => {
    const snap = streamSnapshot(base());
    expect(snap.loose).toEqual([]);
  });

  test("fixed order: inbox, stale tasks, stale goals, proposals", () => {
    const snap = streamSnapshot(
      base({
        tasks: [
          task({ id: "inbox1", group_id: null, group_name: null }),
          task({
            id: "stale1",
            group_id: "g1",
            created_at: "2026-06-01T00:00:00.000Z",
          }),
        ],
        goals: [
          {
            id: "goal1",
            title: "learn spanish",
            status: "active",
            created_at: "2026-06-01T00:00:00.000Z",
          },
          {
            id: "goal2",
            title: "fresh goal",
            status: "active",
            created_at: "2026-07-05T00:00:00.000Z",
          },
          {
            id: "goal3",
            title: "done goal",
            status: "done",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        pendingProposals: 2,
      }),
    );
    expect(ids(snap.loose)).toEqual([
      "loose:inbox",
      "loose:stale-tasks",
      "loose:goal:goal1",
      "loose:proposals",
    ]);
  });

  test("a recent inbox task counts toward inbox, not stale", () => {
    const snap = streamSnapshot(
      base({
        tasks: [
          task({
            id: "inbox-stale",
            group_id: null,
            group_name: null,
            created_at: "2026-06-01T00:00:00.000Z",
          }),
        ],
      }),
    );
    // it is both in the inbox and stale — inbox card and stale card both show
    expect(ids(snap.loose)).toEqual(["loose:inbox", "loose:stale-tasks"]);
  });
});

describe("pulse and empty state", () => {
  test("pulse carries delta, to-clear count, free hours, mood", () => {
    const snap = streamSnapshot(
      base({
        tasks: [task({ id: "over", due_date: "2026-07-05" })],
        todayDelta: 142,
        freeHoursToday: 3.5,
        moodToday: 4,
      }),
    );
    expect(snap.pulse).toEqual({
      todayDelta: 142,
      currency: "USD",
      toClear: 1,
      freeHours: 3.5,
      mood: 4,
    });
  });

  test("nextUp names the first upcoming timed event", () => {
    const snap = streamSnapshot(
      base({
        events: [
          {
            id: "gym",
            summary: "gym w/ Dan",
            start: "2026-07-06T17:00:00",
            end: "2026-07-06T18:00:00",
            allDay: false,
          },
        ],
      }),
    );
    expect(snap.nextUp).toBe("gym w/ Dan, 17:00");
  });

  test("done tasks never appear", () => {
    const snap = streamSnapshot(
      base({
        tasks: [task({ id: "done1", due_date: "2026-07-01", status: "done" })],
      }),
    );
    expect(snap.now).toEqual([]);
    expect(snap.pulse.toClear).toBe(0);
  });
});
