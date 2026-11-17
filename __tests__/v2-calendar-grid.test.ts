// @vitest-environment node
// Task 12, the calendar window's grid: which day a thing lands on, where in that
// day it sits, and how overlapping things share the width.
//
// EVERYTHING HERE IS INVENTED. No account, no calendar id and no title below
// belongs to anyone. Phoenix and Tokyo have no daylight saving, so every
// instant written out in full is stable; New York is used only where a
// daylight-saving edge is the point, and then only elapsed time and wall
// minutes are asserted, never an offset string.

import { describe, expect, test } from "vitest";

import { zonedClockMinutes, zonedDateKey, zonedIso } from "@/app/lib/snapshots/zoned-time";
import { minutesToMs } from "@/app/lib/v2/plan/day";
import {
  layoutAllDay,
  layoutDay,
  minuteInstant,
  weekOf,
  weekRange,
} from "@/app/lib/v2/calendar/grid";
import { MINUTES_PER_DAY, fromEngineEvent } from "@/app/lib/v2/calendar/types";
import type { CalEvent } from "@/app/lib/v2/calendar/types";
import type { EngineCalendarEvent } from "@/app/lib/v2/engine/sources";

const PHOENIX = "America/Phoenix";
const OFF = "-07:00";
const TOKYO = "Asia/Tokyo";
/** A Wednesday. Monday to Sunday of its week is the 13th to the 19th. */
const DAY = "2026-04-15";

const at = (clock: string, date: string = DAY) => `${date}T${clock}:00${OFF}`;

function timed(id: string, start: string, end: string, extra: Partial<CalEvent> = {}): CalEvent {
  return {
    id,
    calendarId: "cal-a",
    title: id,
    allDay: false,
    start,
    end,
    location: null,
    etag: null,
    editable: true,
    recurring: false,
    ...extra,
  };
}

function allDay(id: string, start: string, end: string): CalEvent {
  return {
    id,
    calendarId: "cal-a",
    title: id,
    allDay: true,
    start,
    end,
    location: null,
    etag: null,
    editable: true,
    recurring: false,
  };
}

function byId<T extends { event: CalEvent }>(placed: readonly T[], id: string): T {
  const found = placed.find((item) => item.event.id === id);
  if (found === undefined) throw new Error(`not placed: ${id}`);
  return found;
}

describe("weekOf", () => {
  test("a Monday start gives the seven days from that Monday", () => {
    expect(weekOf(DAY)).toEqual([
      "2026-04-13",
      "2026-04-14",
      "2026-04-15",
      "2026-04-16",
      "2026-04-17",
      "2026-04-18",
      "2026-04-19",
    ]);
  });

  test("a Sunday belongs to the week that started the Monday before", () => {
    expect(weekOf("2026-04-19")[0]).toBe("2026-04-13");
    expect(weekOf("2026-04-19")[6]).toBe("2026-04-19");
  });

  test("a Sunday start shifts the whole week", () => {
    expect(weekOf(DAY, 0)[0]).toBe("2026-04-12");
    expect(weekOf(DAY, 0)[6]).toBe("2026-04-18");
  });

  test("it crosses a month and a year", () => {
    expect(weekOf("2027-01-01")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });

  test("the range is the week's own midnights in the zone", () => {
    const range = weekRange(weekOf(DAY), PHOENIX);
    expect(range.timeMin).toBe("2026-04-13T00:00:00-07:00");
    expect(range.timeMax).toBe("2026-04-20T00:00:00-07:00");
  });

  test("the range in UTC carries a zero offset", () => {
    expect(weekRange(weekOf(DAY), "UTC")).toEqual({
      timeMin: "2026-04-13T00:00:00+00:00",
      timeMax: "2026-04-20T00:00:00+00:00",
    });
  });

  test("a week with no days has no range", () => {
    expect(() => weekRange([], PHOENIX)).toThrow();
  });
});

describe("layoutDay places a timed event", () => {
  test("minutes are the wall clock and round-trip back to the instant", () => {
    const event = timed("a", at("09:30"), at("11:00"));
    const placed = byId(layoutDay([event], DAY, PHOENIX).timed, "a");
    expect(placed.startMinute).toBe(9 * 60 + 30);
    expect(placed.endMinute).toBe(11 * 60);
    expect(placed.continuesBefore).toBe(false);
    expect(placed.continuesAfter).toBe(false);
    expect(minutesToMs(DAY, placed.startMinute, PHOENIX)).toBe(Date.parse(event.start));
    expect(minutesToMs(DAY, placed.endMinute, PHOENIX)).toBe(Date.parse(event.end));
  });

  test("an all-day event is not on the timed grid", () => {
    expect(layoutDay([allDay("a", DAY, "2026-04-16")], DAY, PHOENIX).timed).toEqual([]);
  });

  test("an event on another day is left out", () => {
    const event = timed("a", at("09:00", "2026-04-16"), at("10:00", "2026-04-16"));
    expect(layoutDay([event], DAY, PHOENIX).timed).toEqual([]);
  });

  test("an unreadable instant is dropped rather than guessed at", () => {
    const events = [timed("bad", "not a time", at("10:00")), timed("ok", at("09:00"), at("10:00"))];
    const ids = layoutDay(events, DAY, PHOENIX).timed.map((item) => item.event.id);
    expect(ids).toEqual(["ok"]);
  });

  test("the day reads in the zone it is asked about, not the server's", () => {
    // 2026-04-15T23:00 Phoenix is 2026-04-16T15:00 Tokyo.
    const event = timed("a", at("23:00"), at("23:30"));
    expect(layoutDay([event], DAY, TOKYO).timed).toEqual([]);
    const placed = byId(layoutDay([event], "2026-04-16", TOKYO).timed, "a");
    expect(placed.startMinute).toBe(15 * 60);
  });

  test("anything shorter than fifteen minutes is laid out as fifteen", () => {
    const placed = byId(layoutDay([timed("a", at("09:00"), at("09:05"))], DAY, PHOENIX).timed, "a");
    expect(placed.startMinute).toBe(9 * 60);
    expect(placed.endMinute).toBe(9 * 60 + 15);
  });

  test("the minimum height is allowed to run past the end of the day", () => {
    const placed = byId(layoutDay([timed("a", at("23:55"), at("23:59"))], DAY, PHOENIX).timed, "a");
    expect(placed.startMinute).toBe(23 * 60 + 55);
    expect(placed.endMinute).toBe(MINUTES_PER_DAY + 10);
    expect(placed.continuesAfter).toBe(false);
  });

  test("a UTC day puts a Z instant where it reads", () => {
    const event = timed("a", "2026-04-15T09:00:00Z", "2026-04-15T10:00:00Z");
    const placed = byId(layoutDay([event], DAY, "UTC").timed, "a");
    expect(placed.startMinute).toBe(9 * 60);
    expect(placed.endMinute).toBe(10 * 60);
  });

  test("they come back in start order", () => {
    const events = [
      timed("late", at("14:00"), at("15:00")),
      timed("early", at("08:00"), at("09:00")),
    ];
    expect(layoutDay(events, DAY, PHOENIX).timed.map((item) => item.event.id)).toEqual([
      "early",
      "late",
    ]);
  });
});

describe("layoutDay clips at midnight", () => {
  const overnight = timed("night", at("22:00"), at("01:00", "2026-04-16"));

  test("the first day keeps its start and runs to the end of the grid", () => {
    const placed = byId(layoutDay([overnight], DAY, PHOENIX).timed, "night");
    expect(placed.startMinute).toBe(22 * 60);
    expect(placed.endMinute).toBe(MINUTES_PER_DAY);
    expect(placed.continuesBefore).toBe(false);
    expect(placed.continuesAfter).toBe(true);
  });

  test("the second day starts at the top of the grid", () => {
    const placed = byId(layoutDay([overnight], "2026-04-16", PHOENIX).timed, "night");
    expect(placed.startMinute).toBe(0);
    expect(placed.endMinute).toBe(60);
    expect(placed.continuesBefore).toBe(true);
    expect(placed.continuesAfter).toBe(false);
  });

  test("a whole day in the middle is covered end to end", () => {
    const long = timed("long", at("22:00", "2026-04-14"), at("01:00", "2026-04-16"));
    const placed = byId(layoutDay([long], DAY, PHOENIX).timed, "long");
    expect(placed.startMinute).toBe(0);
    expect(placed.endMinute).toBe(MINUTES_PER_DAY);
    expect(placed.continuesBefore).toBe(true);
    expect(placed.continuesAfter).toBe(true);
  });

  test("an event that ends exactly at midnight does not reach the next day", () => {
    const event = timed("a", at("23:00"), at("00:00", "2026-04-16"));
    const first = byId(layoutDay([event], DAY, PHOENIX).timed, "a");
    expect(first.endMinute).toBe(MINUTES_PER_DAY);
    expect(first.continuesAfter).toBe(false);
    expect(layoutDay([event], "2026-04-16", PHOENIX).timed).toEqual([]);
  });

  test("an event that starts exactly at midnight belongs to the day it starts", () => {
    const event = timed("a", at("00:00"), at("01:00"));
    const placed = byId(layoutDay([event], DAY, PHOENIX).timed, "a");
    expect(placed.startMinute).toBe(0);
    expect(placed.continuesBefore).toBe(false);
    expect(layoutDay([event], "2026-04-14", PHOENIX).timed).toEqual([]);
  });
});

describe("layoutDay shares the width", () => {
  test("one event alone has the whole width", () => {
    const placed = byId(layoutDay([timed("a", at("09:00"), at("10:00"))], DAY, PHOENIX).timed, "a");
    expect(placed.column).toBe(0);
    expect(placed.columnCount).toBe(1);
  });

  test("a nested event takes the second column and both share the count", () => {
    const events = [timed("outer", at("09:00"), at("12:00")), timed("inner", at("10:00"), at("11:00"))];
    const { timed: placed } = layoutDay(events, DAY, PHOENIX);
    expect(byId(placed, "outer").column).toBe(0);
    expect(byId(placed, "inner").column).toBe(1);
    expect(byId(placed, "outer").columnCount).toBe(2);
    expect(byId(placed, "inner").columnCount).toBe(2);
  });

  test("a chain overlaps transitively and reuses a freed column", () => {
    const events = [
      timed("a", at("09:00"), at("10:00")),
      timed("b", at("09:30"), at("10:30")),
      timed("c", at("10:15"), at("11:00")),
    ];
    const { timed: placed } = layoutDay(events, DAY, PHOENIX);
    expect(byId(placed, "a").column).toBe(0);
    expect(byId(placed, "b").column).toBe(1);
    expect(byId(placed, "c").column).toBe(0);
    for (const id of ["a", "b", "c"]) {
      expect(byId(placed, id).columnCount).toBe(2);
    }
  });

  test("touching at the edge is not overlapping", () => {
    const events = [timed("a", at("09:00"), at("10:00")), timed("b", at("10:00"), at("11:00"))];
    const { timed: placed } = layoutDay(events, DAY, PHOENIX);
    for (const id of ["a", "b"]) {
      expect(byId(placed, id).column).toBe(0);
      expect(byId(placed, id).columnCount).toBe(1);
    }
  });

  test("the longer of two events that start together comes first", () => {
    const events = [
      timed("short", at("09:00"), at("09:30")),
      timed("long", at("09:00"), at("11:00")),
    ];
    const { timed: placed } = layoutDay(events, DAY, PHOENIX);
    expect(byId(placed, "long").column).toBe(0);
    expect(byId(placed, "short").column).toBe(1);
  });

  test("two events identical but for their id keep a stable order", () => {
    const events = [timed("b", at("09:00"), at("10:00")), timed("a", at("09:00"), at("10:00"))];
    const { timed: placed } = layoutDay(events, DAY, PHOENIX);
    expect(placed.map((item) => item.event.id)).toEqual(["a", "b"]);
    expect(byId(placed, "a").column).toBe(0);
    expect(byId(placed, "b").column).toBe(1);
  });

  test("the fifteen minute floor is what decides a collision", () => {
    // Five real minutes apart and would not overlap; as laid out they do.
    const events = [timed("tiny", at("09:00"), at("09:05")), timed("after", at("09:10"), at("10:00"))];
    const { timed: placed } = layoutDay(events, DAY, PHOENIX);
    expect(byId(placed, "tiny").columnCount).toBe(2);
    expect(byId(placed, "after").column).toBe(1);
  });

  test("three at once need three columns and a fourth after them needs none", () => {
    const events = [
      timed("a", at("09:00"), at("10:00")),
      timed("b", at("09:00"), at("10:00")),
      timed("c", at("09:00"), at("10:00")),
      timed("d", at("11:00"), at("12:00")),
    ];
    const { timed: placed } = layoutDay(events, DAY, PHOENIX);
    expect(byId(placed, "c").columnCount).toBe(3);
    expect(byId(placed, "d").columnCount).toBe(1);
    expect(new Set([byId(placed, "a").column, byId(placed, "b").column, byId(placed, "c").column]))
      .toEqual(new Set([0, 1, 2]));
  });

  test("two events an hour apart over the fall back share the same minutes", () => {
    // The hour the clock repeats. Both events are built from elapsed time after
    // local midnight, so no offset is written out: the first is an hour in, the
    // second two hours in, and in New York on this morning both of those are
    // 01:00 on the wall. They do not overlap in time and they do on the grid,
    // which is what a grid drawn in minutes has to mean.
    const ny = "America/New_York";
    const date = "2026-11-01";
    const midnight = minutesToMs(date, 0, ny);
    const span = (id: string, fromHours: number, minutes: number) =>
      timed(
        id,
        zonedIso(midnight + fromHours * 3_600_000, ny),
        zonedIso(midnight + fromHours * 3_600_000 + minutes * 60_000, ny),
      );
    const first = span("first", 1, 45);
    const second = span("second", 2, 45);
    expect(Date.parse(second.start)).toBeGreaterThanOrEqual(Date.parse(first.end));

    const { timed: placed } = layoutDay([first, second], date, ny);
    for (const id of ["first", "second"]) {
      expect(byId(placed, id).startMinute).toBe(60);
      expect(byId(placed, id).endMinute).toBe(105);
      expect(byId(placed, id).columnCount).toBe(2);
    }
    expect(new Set([byId(placed, "first").column, byId(placed, "second").column])).toEqual(
      new Set([0, 1]),
    );
  });

  test("a clipped overnight event still shares the width", () => {
    const events = [
      timed("night", at("22:00", "2026-04-14"), at("09:30")),
      timed("morning", at("09:00"), at("10:00")),
    ];
    const { timed: placed } = layoutDay(events, DAY, PHOENIX);
    expect(byId(placed, "night").columnCount).toBe(2);
    expect(byId(placed, "morning").columnCount).toBe(2);
  });
});

describe("layoutAllDay", () => {
  const week = weekOf(DAY);

  test("one day sits on its own index", () => {
    const placed = layoutAllDay([allDay("a", "2026-04-15", "2026-04-16")], week);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      firstIndex: 2,
      lastIndex: 2,
      continuesBefore: false,
      continuesAfter: false,
      row: 0,
    });
  });

  test("a multi day event ends on the last day it covers", () => {
    // 14th to 17th exclusive covers the 14th, 15th and 16th.
    const placed = layoutAllDay([allDay("a", "2026-04-14", "2026-04-17")], week);
    expect(placed[0]).toMatchObject({ firstIndex: 1, lastIndex: 3 });
  });

  test("an event with no end covers its one day", () => {
    const placed = layoutAllDay([allDay("a", "2026-04-14", "2026-04-14")], week);
    expect(placed[0]).toMatchObject({ firstIndex: 1, lastIndex: 1 });
  });

  test("it is clipped at the start of the week", () => {
    const placed = layoutAllDay([allDay("a", "2026-04-10", "2026-04-15")], week);
    expect(placed[0]).toMatchObject({
      firstIndex: 0,
      lastIndex: 1,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  test("it is clipped at the end of the week", () => {
    const placed = layoutAllDay([allDay("a", "2026-04-18", "2026-04-25")], week);
    expect(placed[0]).toMatchObject({
      firstIndex: 5,
      lastIndex: 6,
      continuesBefore: false,
      continuesAfter: true,
    });
  });

  test("an event over the whole week continues at both ends", () => {
    const placed = layoutAllDay([allDay("a", "2026-04-01", "2026-05-01")], week);
    expect(placed[0]).toMatchObject({
      firstIndex: 0,
      lastIndex: 6,
      continuesBefore: true,
      continuesAfter: true,
    });
  });

  test("an event outside the week is left out", () => {
    expect(layoutAllDay([allDay("before", "2026-04-01", "2026-04-13")], week)).toEqual([]);
    expect(layoutAllDay([allDay("after", "2026-04-20", "2026-04-22")], week)).toEqual([]);
  });

  test("a timed event is not on the all day row", () => {
    expect(layoutAllDay([timed("a", at("09:00"), at("10:00"))], week)).toEqual([]);
  });

  test("an unreadable date key is dropped", () => {
    const placed = layoutAllDay(
      [allDay("bad", "whenever", "2026-04-16"), allDay("ok", "2026-04-15", "2026-04-16")],
      week,
    );
    expect(placed.map((item) => item.event.id)).toEqual(["ok"]);
  });

  test("overlapping spans take their own rows and a free row is reused", () => {
    const placed = layoutAllDay(
      [
        allDay("a", "2026-04-13", "2026-04-16"),
        allDay("b", "2026-04-14", "2026-04-18"),
        allDay("c", "2026-04-17", "2026-04-19"),
      ],
      week,
    );
    expect(byId(placed, "a").row).toBe(0);
    expect(byId(placed, "b").row).toBe(1);
    expect(byId(placed, "c").row).toBe(0);
  });

  test("two spans that share only one day still take two rows", () => {
    const placed = layoutAllDay(
      [allDay("a", "2026-04-13", "2026-04-15"), allDay("b", "2026-04-14", "2026-04-16")],
      week,
    );
    expect(byId(placed, "b").row).toBe(1);
  });

  test("the longer span takes the first row when two start together", () => {
    const placed = layoutAllDay(
      [allDay("short", "2026-04-14", "2026-04-15"), allDay("long", "2026-04-14", "2026-04-18")],
      week,
    );
    expect(byId(placed, "long").row).toBe(0);
    expect(byId(placed, "short").row).toBe(1);
  });
});

describe("fromEngineEvent", () => {
  const engineTimed: EngineCalendarEvent = {
    id: "cal-a:ev-1",
    summary: "a thing",
    start: at("09:00"),
    end: at("10:00"),
    allDay: false,
    calendarId: "cal-a",
    location: "somewhere",
  };

  test("a timed event keeps its instants and takes the flags it is given", () => {
    expect(fromEngineEvent(engineTimed, { editable: true, etag: "e1", recurring: true })).toEqual({
      id: "cal-a:ev-1",
      calendarId: "cal-a",
      title: "a thing",
      allDay: false,
      start: at("09:00"),
      end: at("10:00"),
      location: "somewhere",
      etag: "e1",
      editable: true,
      recurring: true,
    });
  });

  test("an all day event keeps the date keys Google gave", () => {
    const mapped = fromEngineEvent(
      { ...engineTimed, allDay: true, start: "2026-04-15", end: "2026-04-17", location: null },
      { editable: false, etag: null, recurring: false },
    );
    expect(mapped.start).toBe("2026-04-15");
    expect(mapped.end).toBe("2026-04-17");
    expect(mapped.location).toBe(null);
    expect(mapped.editable).toBe(false);
  });

  test("a missing location is null rather than absent", () => {
    const { location, ...rest } = engineTimed;
    void location;
    expect(fromEngineEvent(rest, { editable: true, etag: null, recurring: false }).location).toBe(
      null,
    );
  });

  test("what it produces lands where the engine would put it", () => {
    const mapped = fromEngineEvent(engineTimed, { editable: true, etag: null, recurring: false });
    const placed = byId(layoutDay([mapped], DAY, PHOENIX).timed, mapped.id);
    // Written out by hand, in a zone with no daylight saving. Asking the same
    // helper the code asks would only prove the code calls it.
    expect(placed.startMinute).toBe(9 * 60);
    expect(placed.endMinute).toBe(10 * 60);
    expect(placed.column).toBe(0);
    expect(placed.columnCount).toBe(1);
  });
});

describe("the two mornings a year the clock changes", () => {
  const NY = "America/New_York";

  test("an event over the spring forward is drawn by its wall clock", () => {
    // New York loses 02:00 to 02:59 on 2026-03-08. An event from 01:30 to
    // 03:30 lasts one hour and is drawn across two.
    const gapDay = "2026-03-08";
    const start = minuteInstant(gapDay, 90, NY);
    const event = timed("over", zonedIso(start, NY), zonedIso(start + 3_600_000, NY));
    const placed = byId(layoutDay([event], gapDay, NY).timed, "over");
    expect(placed.startMinute).toBe(90);
    expect(placed.endMinute).toBe(210);
    expect(placed.continuesBefore).toBe(false);
    expect(placed.continuesAfter).toBe(false);
  });

  test("the whole of a spring forward day is still one grid", () => {
    const gapDay = "2026-03-08";
    const late = minuteInstant(gapDay, 23 * 60, NY);
    const placed = byId(
      layoutDay([timed("late", zonedIso(late, NY), zonedIso(late + 1_800_000, NY))], gapDay, NY)
        .timed,
      "late",
    );
    expect(placed.startMinute).toBe(23 * 60);
    expect(placed.endMinute).toBe(23 * 60 + 30);
  });

  test("an event over the fall back is drawn by its elapsed time", () => {
    // On 2026-11-01 the hour from 01:00 repeats. An event that starts at the
    // first 01:30 and lasts 45 minutes ends at the second 01:15, so its wall
    // clock end is BELOW its wall clock start and the wall clock cannot draw
    // it. Its elapsed time is drawn instead.
    const backDay = "2026-11-01";
    const start = minuteInstant(backDay, 90, NY);
    const event = timed("over", zonedIso(start, NY), zonedIso(start + 45 * 60_000, NY));
    expect(zonedClockMinutes(Date.parse(event.end), NY)).toBe(75);
    const placed = byId(layoutDay([event], backDay, NY).timed, "over");
    expect(placed.startMinute).toBe(90);
    expect(placed.endMinute).toBe(90 + 45);
  });

  test("a day whose midnight does not exist starts at its first real minute", () => {
    // Havana skipped midnight on 2019-03-10: the clock went from 23:59 on the
    // 9th to 01:00 on the 10th. A past date, so no time zone database
    // disagrees about it. An event late on the 9th used to be drawn on the
    // 10th, at minute 1410, and on no other day at all.
    const havana = "America/Havana";
    const start = minuteInstant("2019-03-09", 23 * 60 + 30, havana);
    const event = timed("late", zonedIso(start, havana), zonedIso(start + 900_000, havana));
    const ninth = byId(layoutDay([event], "2019-03-09", havana).timed, "late");
    expect(ninth.startMinute).toBe(23 * 60 + 30);
    expect(layoutDay([event], "2019-03-10", havana).timed).toEqual([]);
  });

  test("the first minute of a day that has no midnight is an hour in", () => {
    const havana = "America/Havana";
    const dayStart = minuteInstant("2019-03-10", 0, havana);
    expect(zonedClockMinutes(dayStart, havana)).toBe(60);
    expect(zonedDateKey(dayStart, havana)).toBe("2019-03-10");
  });

  test("a wall time inside the gap resolves forward, never backwards", () => {
    const gapDay = "2026-03-08";
    const ninety = minuteInstant(gapDay, 90, NY);
    for (const minute of [120, 135, 150, 179]) {
      const landed = minuteInstant(gapDay, minute, NY);
      expect(landed).toBeGreaterThan(ninety);
      expect(zonedClockMinutes(landed, NY)).toBeGreaterThanOrEqual(180);
    }
    expect(zonedClockMinutes(minuteInstant(gapDay, 150, NY), NY)).toBe(210);
  });

  test("a wall time that exists is left exactly where it is", () => {
    expect(minuteInstant(DAY, 9 * 60 + 30, PHOENIX)).toBe(Date.parse(at("09:30")));
    expect(minuteInstant(DAY, 0, PHOENIX)).toBe(Date.parse(at("00:00")));
    expect(minuteInstant(DAY, MINUTES_PER_DAY, PHOENIX)).toBe(
      Date.parse(at("00:00", "2026-04-16")),
    );
  });
});
