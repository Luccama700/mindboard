import { describe, expect, test } from "vitest";

import { freeGaps } from "@/app/lib/snapshots/schedule";

const NOON = new Date(2026, 6, 6, 12, 0, 0); // 2026-07-06 12:00 local

function event(start: string, end: string) {
  return { summary: "e", start, end, allDay: false };
}

describe("freeGaps", () => {
  test("an empty day yields one gap from now to wake end, then full next days", () => {
    const gaps = freeGaps({ events: [], now: NOON, limit: 3 });
    expect(gaps[0]).toEqual({
      dateKey: "2026-07-06",
      start: "12:00",
      end: "22:00",
      minutes: 600,
    });
    expect(gaps[1]).toEqual({
      dateKey: "2026-07-07",
      start: "08:00",
      end: "22:00",
      minutes: 840,
    });
    expect(gaps).toHaveLength(2); // only 2 days scanned by default
  });

  test("events split the day into gaps; short gaps are dropped", () => {
    const gaps = freeGaps({
      events: [
        event("2026-07-06T13:00:00", "2026-07-06T14:00:00"),
        // 30-minute gap — below the 45-minute floor
        event("2026-07-06T14:30:00", "2026-07-06T20:00:00"),
      ],
      now: NOON,
      days: 1,
      limit: 5,
    });
    expect(gaps).toEqual([
      { dateKey: "2026-07-06", start: "12:00", end: "13:00", minutes: 60 },
      { dateKey: "2026-07-06", start: "20:00", end: "22:00", minutes: 120 },
    ]);
  });

  test("the wake window bounds gaps and the limit caps them", () => {
    const gaps = freeGaps({
      events: [],
      now: NOON,
      wakeStartHour: 9,
      wakeEndHour: 18,
      days: 4,
      limit: 3,
    });
    expect(gaps).toHaveLength(3);
    expect(gaps.map((g) => g.dateKey)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
    expect(gaps[1].start).toBe("09:00");
    expect(gaps[1].end).toBe("18:00");
  });

  test("after wake end, today contributes nothing", () => {
    const night = new Date(2026, 6, 6, 22, 30, 0);
    const gaps = freeGaps({ events: [], now: night, limit: 2 });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].dateKey).toBe("2026-07-07");
  });

  test("the cursor rounds up to a quarter hour", () => {
    const oddNow = new Date(2026, 6, 6, 12, 7, 0);
    const gaps = freeGaps({ events: [], now: oddNow, days: 1, limit: 1 });
    expect(gaps[0].start).toBe("12:15");
  });
});
