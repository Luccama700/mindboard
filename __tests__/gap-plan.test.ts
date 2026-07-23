import { describe, expect, test } from "vitest";

import {
  busyFromDayItems,
  planUntimedOccurrences,
  rtaskEffectiveTiming,
  type PlannedSlot,
} from "@/app/lib/snapshots/gap-plan";
import type { CalendarItem } from "@/app/_components/calendar-types";
import type { FreeInterval } from "@/app/lib/snapshots/schedule";

const DATE = "2026-07-08";

function iv(startMinutes: number, endMinutes: number): FreeInterval {
  return { startMinutes, endMinutes, minutes: endMinutes - startMinutes };
}

type Rule = {
  id: string;
  priority: "low" | "med" | "high";
  duration_min: number | null;
  created_at: string;
};

function rule(over: Partial<Rule> & { id: string }): Rule {
  return {
    priority: "med",
    duration_min: 30,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function plan(rules: Rule[], intervals: FreeInterval[]): PlannedSlot[] {
  return planUntimedOccurrences({ rules, intervals, dateKey: DATE });
}

function summarize(slots: PlannedSlot[]): [string, string, string][] {
  return slots.map((s) => [s.ruleId, s.start, s.end]);
}

describe("planUntimedOccurrences ordering", () => {
  test("priority high>med>low, then duration desc, then created asc, then id", () => {
    const slots = plan(
      [
        rule({ id: "c", priority: "high", duration_min: 30 }),
        rule({ id: "a", priority: "high", duration_min: 60 }),
        rule({ id: "b", priority: "med", duration_min: 120 }),
      ],
      [iv(480, 1320)],
    );
    // high first, longest-of-the-highs (a) before shorter (c), med last.
    expect(summarize(slots)).toEqual([
      ["a", "08:00", "09:00"],
      ["c", "09:00", "09:30"],
      ["b", "09:30", "11:30"],
    ]);
  });

  test("created_at breaks a priority+duration tie, oldest first", () => {
    const slots = plan(
      [
        rule({ id: "younger", created_at: "2026-02-01T00:00:00Z" }),
        rule({ id: "older", created_at: "2026-01-01T00:00:00Z" }),
      ],
      [iv(480, 1320)],
    );
    expect(slots.map((s) => s.ruleId)).toEqual(["older", "younger"]);
  });

  test("id is the final deterministic tiebreak", () => {
    const slots = plan(
      [rule({ id: "b2" }), rule({ id: "a1" })],
      [iv(480, 1320)],
    );
    expect(slots.map((s) => s.ruleId)).toEqual(["a1", "b2"]);
  });
});

describe("planUntimedOccurrences placement", () => {
  test("first-fit picks the earliest interval that fits", () => {
    const slots = plan([rule({ id: "r", duration_min: 30 })], [
      iv(540, 570),
      iv(600, 720),
    ]);
    expect(summarize(slots)).toEqual([["r", "09:00", "09:30"]]);
  });

  test("two rules split the same gap; the remainder stays available", () => {
    const slots = plan(
      [
        rule({ id: "first", duration_min: 30, created_at: "2026-01-01T00:00:00Z" }),
        rule({ id: "second", duration_min: 30, created_at: "2026-01-02T00:00:00Z" }),
      ],
      [iv(480, 600)],
    );
    expect(summarize(slots)).toEqual([
      ["first", "08:00", "08:30"],
      ["second", "08:30", "09:00"],
    ]);
  });

  test("the cursor ceils to the next quarter hour (09:07 -> 09:15)", () => {
    const slots = plan([rule({ id: "r", duration_min: 30 })], [iv(547, 700)]);
    expect(summarize(slots)).toEqual([["r", "09:15", "09:45"]]);
  });

  test("a null duration defaults to 30 minutes", () => {
    const slots = plan([rule({ id: "r", duration_min: null })], [iv(480, 510)]);
    expect(summarize(slots)).toEqual([["r", "08:00", "08:30"]]);
  });

  test("an exact-fit boundary places the slot", () => {
    const slots = plan([rule({ id: "r", duration_min: 60 })], [iv(480, 540)]);
    expect(summarize(slots)).toEqual([["r", "08:00", "09:00"]]);
  });

  test("a rule that fits nowhere is omitted", () => {
    const slots = plan([rule({ id: "r", duration_min: 30 })], [iv(480, 500)]);
    expect(slots).toEqual([]);
  });

  test("a small rule takes the gap a bigger, higher-ranked rule skipped", () => {
    const slots = plan(
      [
        rule({ id: "big", priority: "high", duration_min: 120 }),
        rule({ id: "small", priority: "low", duration_min: 30 }),
      ],
      [iv(480, 540)],
    );
    expect(summarize(slots)).toEqual([["small", "08:00", "08:30"]]);
  });

  test("empty inputs yield no slots and no throw", () => {
    expect(plan([], [iv(480, 1320)])).toEqual([]);
    expect(plan([rule({ id: "r" })], [])).toEqual([]);
  });

  test("placement is deterministic and does not mutate its inputs", () => {
    const rules = [
      rule({ id: "a", priority: "high", duration_min: 45 }),
      rule({ id: "b", duration_min: 30 }),
    ];
    const intervals = [iv(487, 600), iv(700, 900)];
    const first = planUntimedOccurrences({ rules, intervals, dateKey: DATE });
    const second = planUntimedOccurrences({ rules, intervals, dateKey: DATE });
    expect(second).toEqual(first);
    // inputs untouched
    expect(intervals).toEqual([iv(487, 600), iv(700, 900)]);
  });
});

describe("busyFromDayItems", () => {
  const event = (over: Partial<Extract<CalendarItem, { kind: "event" }>>) =>
    ({
      kind: "event",
      id: "e",
      eventId: "ge",
      calendarId: "cal",
      title: "event",
      start: "2026-07-08T09:00:00",
      end: "2026-07-08T10:00:00",
      allDay: false,
      calendar: "cal",
      color: "#fff",
      writable: true,
      startTimeZone: null,
      endTimeZone: null,
      ...over,
    }) as CalendarItem;

  const task = (over: Partial<Extract<CalendarItem, { kind: "task" }>>) =>
    ({
      kind: "task",
      id: "t",
      title: "task",
      color: "#fff",
      group: "g",
      dueTime: null,
      durationMin: null,
      pushed: false,
      ...over,
    }) as CalendarItem;

  const rtask = (over: Partial<Extract<CalendarItem, { kind: "rtask" }>>) =>
    ({
      kind: "rtask",
      id: "r",
      ruleId: "rule",
      title: "rtask",
      color: "#fff",
      dueTime: null,
      durationMin: null,
      plannedStart: null,
      plannedMinutes: null,
      slotStart: null,
      slotMinutes: null,
      scheduleLabel: "every day",
      done: false,
      ...over,
    }) as CalendarItem;

  test("includes timed event + timed task + timed rtask; excludes untimed and planned", () => {
    const busy = busyFromDayItems(DATE, [
      event({ id: "ev", title: "ev", start: "2026-07-08T09:00:00", end: "2026-07-08T10:00:00" }),
      event({ id: "allday", title: "conf", allDay: true }),
      task({ id: "tt", title: "tt", dueTime: "14:00:00", durationMin: 60 }),
      task({ id: "untimed-task", dueTime: null }),
      rtask({ id: "rt", title: "rt", dueTime: "16:00:00" }),
      rtask({ id: "untimed-rtask", dueTime: null }),
      rtask({ id: "ghost", dueTime: null, plannedStart: "11:00:00", plannedMinutes: 30 }),
    ]);
    expect(busy).toEqual([
      { summary: "ev", start: "2026-07-08T09:00:00", end: "2026-07-08T10:00:00", allDay: false },
      { summary: "tt", start: "2026-07-08T14:00:00", end: "2026-07-08T15:00:00", allDay: false },
      { summary: "rt", start: "2026-07-08T16:00:00", end: "2026-07-08T16:30:00", allDay: false },
    ]);
  });

  test("an approved slot on an untimed rtask counts as busy (slotMinutes precedence)", () => {
    const busy = busyFromDayItems(DATE, [
      rtask({
        id: "committed",
        title: "gym",
        dueTime: null,
        durationMin: 30,
        slotStart: "07:00:00",
        slotMinutes: 90,
      }),
      rtask({ id: "untimed-no-slot", dueTime: null }),
    ]);
    expect(busy).toEqual([
      { summary: "gym", start: "2026-07-08T07:00:00", end: "2026-07-08T08:30:00", allDay: false },
    ]);
  });
});

describe("rtaskEffectiveTiming", () => {
  const rtask = (over: Partial<Extract<CalendarItem, { kind: "rtask" }>>) =>
    ({
      kind: "rtask",
      id: "r",
      ruleId: "rule",
      title: "rtask",
      color: "#fff",
      dueTime: null,
      durationMin: null,
      plannedStart: null,
      plannedMinutes: null,
      slotStart: null,
      slotMinutes: null,
      scheduleLabel: "every day",
      done: false,
      ...over,
    }) as Extract<CalendarItem, { kind: "rtask" }>;

  test("a slot overrides due_time and its duration", () => {
    expect(
      rtaskEffectiveTiming(
        rtask({ dueTime: "17:00:00", durationMin: 60, slotStart: "07:00:00", slotMinutes: 90 }),
      ),
    ).toEqual({ time: "07:00:00", minutes: 90 });
  });

  test("falls back to due_time, then rule duration, then the 30-min default", () => {
    expect(rtaskEffectiveTiming(rtask({ dueTime: "12:00:00", durationMin: 45 }))).toEqual({
      time: "12:00:00",
      minutes: 45,
    });
    expect(rtaskEffectiveTiming(rtask({ dueTime: "12:00:00" }))).toEqual({
      time: "12:00:00",
      minutes: 30,
    });
  });

  test("a bare untimed occurrence (no slot, no due_time) has no effective timing", () => {
    expect(rtaskEffectiveTiming(rtask({}))).toBeNull();
  });

  test("a slot's duration falls back to the rule duration when the slot omits it", () => {
    expect(
      rtaskEffectiveTiming(rtask({ durationMin: 45, slotStart: "07:00:00", slotMinutes: null })),
    ).toEqual({ time: "07:00:00", minutes: 45 });
  });
});
