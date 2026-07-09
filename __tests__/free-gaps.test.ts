import { describe, expect, test } from "vitest";

import {
  freeGaps,
  freeIntervalsForDay,
  scheduleSnapshot,
} from "@/app/lib/snapshots/schedule";

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

describe("freeIntervalsForDay", () => {
  test("an empty future day is one full wake-window interval", () => {
    const intervals = freeIntervalsForDay({
      events: [],
      dateKey: "2026-07-07",
      now: NOON,
    });
    expect(intervals).toEqual([
      { startMinutes: 8 * 60, endMinutes: 22 * 60, minutes: 840 },
    ]);
  });

  test("today clips past time; other days do not", () => {
    const today = freeIntervalsForDay({
      events: [],
      dateKey: "2026-07-06",
      now: NOON,
    });
    expect(today).toEqual([
      { startMinutes: 12 * 60, endMinutes: 22 * 60, minutes: 600 },
    ]);
  });

  test("sub-45-minute slivers are returned, unlike freeGaps", () => {
    const intervals = freeIntervalsForDay({
      events: [
        event("2026-07-06T13:00:00", "2026-07-06T14:00:00"),
        event("2026-07-06T14:30:00", "2026-07-06T20:00:00"),
      ],
      dateKey: "2026-07-06",
      now: NOON,
    });
    expect(intervals).toEqual([
      { startMinutes: 12 * 60, endMinutes: 13 * 60, minutes: 60 },
      { startMinutes: 14 * 60, endMinutes: 14 * 60 + 30, minutes: 30 },
      { startMinutes: 20 * 60, endMinutes: 22 * 60, minutes: 120 },
    ]);
  });

  test("overlapping events merge and all-day events are ignored", () => {
    const intervals = freeIntervalsForDay({
      events: [
        event("2026-07-07T09:00:00", "2026-07-07T11:00:00"),
        event("2026-07-07T10:00:00", "2026-07-07T12:00:00"),
        { summary: "allday", start: "2026-07-07", end: "2026-07-08", allDay: true },
      ],
      dateKey: "2026-07-07",
      now: NOON,
    });
    expect(intervals).toEqual([
      { startMinutes: 8 * 60, endMinutes: 9 * 60, minutes: 60 },
      { startMinutes: 12 * 60, endMinutes: 22 * 60, minutes: 600 },
    ]);
  });

  test("a busy day past wake end yields nothing", () => {
    const intervals = freeIntervalsForDay({
      events: [event("2026-07-06T08:00:00", "2026-07-06T22:00:00")],
      dateKey: "2026-07-06",
      now: NOON,
    });
    expect(intervals).toEqual([]);
  });

  test("a wake window ending at 24:00 reaches midnight instead of vanishing", () => {
    // 24:00 is next-day midnight; the naive clock reading (0) used to make the
    // last interval negative-length and drop the whole underlay.
    const intervals = freeIntervalsForDay({
      events: [],
      dateKey: "2026-07-07",
      now: NOON,
      wakeStartHour: 6,
      wakeEndHour: 24,
    });
    expect(intervals).toEqual([
      { startMinutes: 6 * 60, endMinutes: 24 * 60, minutes: 18 * 60 },
    ]);
  });

  test("an event before midnight splits a to-24:00 window correctly", () => {
    const intervals = freeIntervalsForDay({
      events: [event("2026-07-06T22:00:00", "2026-07-06T23:00:00")],
      dateKey: "2026-07-06",
      now: NOON,
      wakeEndHour: 24,
    });
    expect(intervals).toEqual([
      { startMinutes: 12 * 60, endMinutes: 22 * 60, minutes: 600 },
      { startMinutes: 23 * 60, endMinutes: 24 * 60, minutes: 60 },
    ]);
  });
});

// On Vercel the process clock is UTC. These drive `now` as a UTC instant and a
// user zone, proving the wake window lands on the user's local day, not the
// server's.
describe("zone-aware wake windows (UTC server, New York user)", () => {
  const NY = "America/New_York"; // EDT = UTC-4 in July
  // 16:00Z = 12:00 local on 2026-07-06.
  const nowUtc = new Date("2026-07-06T16:00:00Z");

  test("freeGaps builds the day from the user's local noon, not UTC", () => {
    const gaps = freeGaps({ events: [], now: nowUtc, timeZone: NY, limit: 3 });
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
  });

  test("scheduleSnapshot counts free hours inside the local wake window", () => {
    // A 13:00–14:00 local meeting = 17:00–18:00Z.
    const busy = {
      summary: "sync",
      start: "2026-07-06T17:00:00Z",
      end: "2026-07-06T18:00:00Z",
      allDay: false,
    };
    const { freeHoursToday } = scheduleSnapshot({
      events: [busy],
      now: nowUtc,
      timeZone: NY,
    });
    // Noon to 22:00 local is 10h, minus the 1h meeting = 9h.
    expect(freeHoursToday).toBe(9);
  });

  test("freeIntervalsForDay clips the local day, not the UTC day", () => {
    const intervals = freeIntervalsForDay({
      events: [],
      dateKey: "2026-07-06",
      now: nowUtc,
      timeZone: NY,
    });
    // Local noon (past-time clip) to local 22:00.
    expect(intervals).toEqual([
      { startMinutes: 12 * 60, endMinutes: 22 * 60, minutes: 600 },
    ]);
  });
});
