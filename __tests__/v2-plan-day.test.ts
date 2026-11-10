// Task 2, the day half: the planning window (behaviour 1), the busy sweep
// (behaviour 2) and the leave-by times. Every local time goes through the
// zoned-time helpers, so the DST rows here are the real guard: a window that
// is computed with Date getters comes out an hour wrong on 2026-03-08.

import { describe, expect, test } from "vitest";

import { zonedIso, zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import { parseRules } from "@/app/lib/v2/rules";
import {
  dayBounds,
  dayWindow,
  freeIntervals,
  leaveByFor,
  planReference,
  planningDate,
} from "@/app/lib/v2/plan/day";
import type { FixedEvent } from "@/app/lib/v2/types";

const HOUR = 3_600_000;

// A Tuesday, well clear of any DST boundary.
const DATE = "2026-03-10";

function event(over: Partial<FixedEvent> & { start: string; end: string }): FixedEvent {
  return {
    id: over.id ?? "fixed-1",
    title: over.title ?? "Class",
    allDay: over.allDay ?? false,
    calendarId: over.calendarId ?? null,
    location: over.location ?? null,
    countsTowardCap: over.countsTowardCap ?? false,
    source: over.source ?? "google",
    start: over.start,
    end: over.end,
  };
}

const utc = (clock: string, date = DATE) => `${date}T${clock}:00+00:00`;
const at = (clock: string, date = DATE) => Date.parse(utc(clock, date));

describe("dayWindow (behaviour 1)", () => {
  test("runs from the later of the weekday wake target and noFocusBefore to lights out", () => {
    const rules = parseRules({});
    expect(dayWindow(DATE, rules)).toEqual({
      startMs: at("09:00"),
      endMs: at("23:00"),
    });
  });

  test("a wake target later than noFocusBefore wins", () => {
    const rules = parseRules({
      wakeByWeekday: [
        "11:30",
        "10:30",
        "11:00",
        "10:30",
        "09:30",
        "10:30",
        "11:30",
      ],
    });
    // 2026-03-10 is a Tuesday, index 2.
    expect(dayWindow(DATE, rules).startMs).toBe(at("11:00"));
  });

  test("lights out after midnight extends the window into the next day", () => {
    const rules = parseRules({ lightsOut: "01:00" });
    const window = dayWindow(DATE, rules);
    expect(window.startMs).toBe(at("09:00"));
    expect(window.endMs).toBe(at("01:00", "2026-03-11"));
    expect(window.endMs - window.startMs).toBe(16 * HOUR);
  });

  test("a spring-forward day in America/New_York has a 23-hour clock and a correct window", () => {
    const zone = "America/New_York";
    const midnightToMidnight = parseRules({
      timeZone: zone,
      noFocusBefore: "00:00",
      lightsOut: "00:00",
      wakeByWeekday: [
        "00:00",
        "00:00",
        "00:00",
        "00:00",
        "00:00",
        "00:00",
        "00:00",
      ],
    });
    const whole = dayWindow("2026-03-08", midnightToMidnight);
    expect(whole.endMs - whole.startMs).toBe(23 * HOUR);

    const rules = parseRules({ timeZone: zone });
    const window = dayWindow("2026-03-08", rules);
    // 09:00 local is already EDT on that Sunday, lights out is 23:00 EDT.
    expect(window.startMs).toBe(Date.parse("2026-03-08T09:00:00-04:00"));
    expect(window.endMs).toBe(Date.parse("2026-03-08T23:00:00-04:00"));
    expect(window.endMs - window.startMs).toBe(14 * HOUR);
    expect(zonedIso(window.startMs, zone)).toBe("2026-03-08T09:00:00-04:00");
  });

  test("works the same way in UTC, America/Phoenix and Asia/Tokyo", () => {
    for (const zone of ["UTC", "America/Phoenix", "Asia/Tokyo"]) {
      const window = dayWindow(DATE, parseRules({ timeZone: zone }));
      expect(window.startMs).toBe(zonedWallTimeToUtcMs(DATE, 9, 0, zone));
      expect(window.endMs - window.startMs).toBe(14 * HOUR);
    }
  });
});

// F3. The tick works on the planning day, not on the calendar day: with lights
// out after midnight the calendar date flips at 00:00 and the day it belongs to
// does not. Before this, the 00:00 tick closed out the blocks the 23:20 tick had
// just planned for 00:10, with the reason "day ended", every night.
describe("planningDate", () => {
  const iso = (clock: string, date: string, zone: string) =>
    new Date(
      zonedWallTimeToUtcMs(
        date,
        Number(clock.slice(0, 2)),
        Number(clock.slice(3, 5)),
        zone,
      ),
    ).toISOString();

  test("with lights out before midnight it is simply the date in the zone", () => {
    const rules = parseRules({ timeZone: "America/Phoenix", lightsOut: "23:00" });
    const at = (clock: string, date = DATE) => iso(clock, date, "America/Phoenix");
    expect(planningDate(at("09:00"), rules)).toBe(DATE);
    expect(planningDate(at("22:59"), rules)).toBe(DATE);
    expect(planningDate(at("23:30"), rules)).toBe(DATE);
    expect(planningDate(at("00:05", "2026-03-11"), rules)).toBe("2026-03-11");
  });

  describe("with lights out at 01:30", () => {
    const zone = "America/Phoenix";
    const rules = parseRules({ timeZone: zone, lightsOut: "01:30" });
    const at = (clock: string, date: string) => iso(clock, date, zone);

    test("00:05 still belongs to the day before", () => {
      expect(planningDate(at("00:05", "2026-03-11"), rules)).toBe(DATE);
    });

    test("01:29 still belongs to the day before", () => {
      expect(planningDate(at("01:29", "2026-03-11"), rules)).toBe(DATE);
    });

    test("01:30 is the new day: the window has ended", () => {
      expect(planningDate(at("01:30", "2026-03-11"), rules)).toBe("2026-03-11");
    });

    test("the wake target is the new day", () => {
      expect(planningDate(at("08:00", "2026-03-11"), rules)).toBe("2026-03-11");
    });

    test("it flips exactly where the previous day's window ends", () => {
      const end = dayWindow(DATE, rules).endMs;
      expect(planningDate(new Date(end - 1).toISOString(), rules)).toBe(DATE);
      expect(planningDate(new Date(end).toISOString(), rules)).toBe("2026-03-11");
    });
  });

  test("a daylight-saving night in America/New_York flips at the window's own end", () => {
    // Fall back: 2026-11-01, 02:00 EDT becomes 01:00 EST, so 01:30 happens
    // twice. The window end resolves to one of the two instants, and the
    // planning day has to flip at THAT instant rather than at either wall
    // clock reading, or the night gets two days or none.
    const rules = parseRules({ timeZone: "America/New_York", lightsOut: "01:30" });
    const end = dayWindow("2026-10-31", rules).endMs;
    expect(end).toBe(Date.parse("2026-11-01T01:30:00-04:00"));
    expect(planningDate("2026-11-01T04:00:00.000Z", rules)).toBe("2026-10-31");
    expect(planningDate(new Date(end - 1).toISOString(), rules)).toBe("2026-10-31");
    expect(planningDate(new Date(end).toISOString(), rules)).toBe("2026-11-01");
    // And the spring-forward night, where 02:30 does not exist at all.
    const spring = dayWindow("2026-03-07", rules).endMs;
    expect(planningDate(new Date(spring - 1).toISOString(), rules)).toBe("2026-03-07");
    expect(planningDate(new Date(spring).toISOString(), rules)).toBe("2026-03-08");
  });
});

// The reference instant, which is the ONE input the ranking reads a date
// against. It used to be computed inside planDay, and the Today screen and the
// planner test helper each computed their own, so the three could drift: a
// screen that ranked against a different instant would call a live item overdue,
// or the other way round. One exported function, three callers.
describe("planReference", () => {
  const rules = parseRules({ timeZone: "UTC" });
  const TOMORROW = "2026-03-11";
  const YESTERDAY = "2026-03-09";

  test("before wake it is the start of the planned day's window", () => {
    expect(planReference(utc("06:00"), DATE, rules)).toEqual({
      ms: at("09:00"),
      instant: "2026-03-10T09:00:00+00:00",
    });
  });

  test("inside the day it is now", () => {
    expect(planReference(utc("14:00"), DATE, rules).ms).toBe(at("14:00"));
  });

  test("after lights out it is still now, not the window", () => {
    // The window has ended, so clamping to it would walk the reference
    // backwards as the clock went forward.
    expect(planReference(utc("23:30"), DATE, rules).ms).toBe(at("23:30"));
  });

  test("for a date ahead it is that day's window start, not now", () => {
    expect(planReference(utc("14:00"), TOMORROW, rules).ms).toBe(
      at("09:00", TOMORROW),
    );
  });

  test("for a date behind it is now, which is past that window already", () => {
    expect(planReference(utc("14:00"), YESTERDAY, rules).ms).toBe(at("14:00"));
  });

  test("rounds now up to the whole minute, as the planner does", () => {
    // A block start is formatted without milliseconds, so a plan fed its own
    // output would read the start back a fraction earlier and report a move
    // that never happened.
    expect(planReference("2026-03-10T14:00:30.400Z", DATE, rules).ms).toBe(
      at("14:01"),
    );
    expect(planReference(utc("14:00"), DATE, rules).ms).toBe(at("14:00"));
  });

  test("the instant is the ms, formatted in the user's zone", () => {
    const zoned = parseRules({ timeZone: "America/Phoenix" });
    const out = planReference("2026-03-10T21:00:00Z", DATE, zoned);
    expect(out.instant).toBe("2026-03-10T14:00:00-07:00");
    expect(Date.parse(out.instant)).toBe(out.ms);
  });
});

// The interval a calendar read covers for a planning day. Wider than the
// window at both ends: an event before wake still has to be seen, and one at
// 00:30 on a day whose lights out is 01:30 is on that day, not the next.
describe("dayBounds", () => {
  test("midnight to midnight when lights out is before midnight", () => {
    const rules = parseRules({ timeZone: "UTC", lightsOut: "23:00" });
    expect(dayBounds(DATE, rules)).toEqual({
      startMs: at("00:00"),
      endMs: at("00:00", "2026-03-11"),
    });
  });

  test("midnight to lights out when lights out is after midnight", () => {
    const rules = parseRules({ timeZone: "UTC", lightsOut: "01:30" });
    expect(dayBounds(DATE, rules)).toEqual({
      startMs: at("00:00"),
      endMs: at("01:30", "2026-03-11"),
    });
  });

  test("it starts at midnight even when the window starts much later", () => {
    const rules = parseRules({
      timeZone: "UTC",
      noFocusBefore: "11:00",
      wakeByWeekday: ["11:00", "11:00", "11:00", "11:00", "11:00", "11:00", "11:00"],
    });
    expect(dayBounds(DATE, rules).startMs).toBe(at("00:00"));
    expect(dayWindow(DATE, rules).startMs).toBe(at("11:00"));
  });
});

describe("freeIntervals (behaviour 2)", () => {
  const rules = parseRules({});

  test("an empty day is one interval, trimmed to fromMs", () => {
    expect(
      freeIntervals(DATE, [], rules, { fromMs: 0, allowProtected: false }),
    ).toEqual([{ startMs: at("09:00"), endMs: at("23:00") }]);

    expect(
      freeIntervals(DATE, [], rules, {
        fromMs: at("14:20"),
        allowProtected: false,
      }),
    ).toEqual([{ startMs: at("14:20"), endMs: at("23:00") }]);
  });

  test("a timed event is busy, widened by travel and by the buffer on both sides", () => {
    const withTravel = parseRules({
      travel: [
        {
          calendarId: null,
          locationIncludes: "campus",
          minutesBefore: 20,
          minutesAfter: 15,
        },
      ],
    });
    const intervals = freeIntervals(
      DATE,
      [
        event({
          start: utc("13:00"),
          end: utc("14:00"),
          location: "Main campus, room 2",
        }),
      ],
      withTravel,
      { fromMs: 0, allowProtected: false },
    );
    expect(intervals).toEqual([
      { startMs: at("09:00"), endMs: at("12:30") },
      { startMs: at("14:25"), endMs: at("23:00") },
    ]);
  });

  test("only the first matching travel rule widens an event", () => {
    const twoRules = parseRules({
      travel: [
        {
          calendarId: "cal-a",
          locationIncludes: null,
          minutesBefore: 60,
          minutesAfter: 60,
        },
        {
          calendarId: null,
          locationIncludes: null,
          minutesBefore: 5,
          minutesAfter: 5,
        },
      ],
    });
    const intervals = freeIntervals(
      DATE,
      [event({ start: utc("13:00"), end: utc("14:00"), calendarId: "cal-a" })],
      twoRules,
      { fromMs: 0, allowProtected: false },
    );
    expect(intervals[0].endMs).toBe(at("11:50"));
    expect(intervals[1].startMs).toBe(at("15:10"));
  });

  test("all-day events are ignored", () => {
    const intervals = freeIntervals(
      DATE,
      [
        event({
          id: "holiday",
          start: `${DATE}T00:00:00+00:00`,
          end: "2026-03-11T00:00:00+00:00",
          allDay: true,
        }),
      ],
      rules,
      { fromMs: 0, allowProtected: false },
    );
    expect(intervals).toEqual([{ startMs: at("09:00"), endMs: at("23:00") }]);
  });

  test("a protected window is busy for everything, unless it may be used by an item closing today", () => {
    const protectedRules = parseRules({
      protectedWindows: [
        // 2026-03-10 is a Tuesday, weekday 2.
        { weekday: 2, from: "18:00", to: "21:00", unlessDueToday: true },
        { weekday: 2, from: "12:00", to: "13:00", unlessDueToday: false },
      ],
    });

    expect(
      freeIntervals(DATE, [], protectedRules, {
        fromMs: 0,
        allowProtected: false,
      }),
    ).toEqual([
      { startMs: at("09:00"), endMs: at("12:00") },
      { startMs: at("13:00"), endMs: at("18:00") },
      { startMs: at("21:00"), endMs: at("23:00") },
    ]);

    expect(
      freeIntervals(DATE, [], protectedRules, {
        fromMs: 0,
        allowProtected: true,
      }),
    ).toEqual([
      { startMs: at("09:00"), endMs: at("12:00") },
      { startMs: at("13:00"), endMs: at("23:00") },
    ]);
  });

  test("a protected window that runs past midnight is clipped to the window", () => {
    const protectedRules = parseRules({
      lightsOut: "01:00",
      protectedWindows: [
        { weekday: 2, from: "22:00", to: "02:00", unlessDueToday: false },
      ],
    });
    expect(
      freeIntervals(DATE, [], protectedRules, {
        fromMs: 0,
        allowProtected: false,
      }),
    ).toEqual([{ startMs: at("09:00"), endMs: at("22:00") }]);
  });

  test("a day that is fully booked has no free interval", () => {
    const intervals = freeIntervals(
      DATE,
      [event({ start: utc("08:00"), end: utc("23:30") })],
      rules,
      { fromMs: 0, allowProtected: false },
    );
    expect(intervals).toEqual([]);
  });
});

describe("leaveByFor", () => {
  test("gives a leave-by instant only for events that carry travel time", () => {
    const rules = parseRules({
      timeZone: "Asia/Tokyo",
      travel: [
        {
          calendarId: null,
          locationIncludes: "lansdowne",
          minutesBefore: 60,
          minutesAfter: 60,
        },
        {
          calendarId: "cal-campus",
          locationIncludes: null,
          minutesBefore: 20,
          minutesAfter: 20,
        },
      ],
    });
    const leaveBy = leaveByFor(
      [
        event({
          id: "lesson",
          start: "2026-03-10T18:00:00+09:00",
          end: "2026-03-10T19:00:00+09:00",
          location: "Lansdowne centre",
        }),
        event({
          id: "class",
          start: "2026-03-10T10:00:00+09:00",
          end: "2026-03-10T11:00:00+09:00",
          calendarId: "cal-campus",
        }),
        event({
          id: "coffee",
          start: "2026-03-10T15:00:00+09:00",
          end: "2026-03-10T15:30:00+09:00",
        }),
      ],
      rules,
    );
    expect(leaveBy).toEqual([
      { fixedId: "class", at: "2026-03-10T09:40:00+09:00" },
      { fixedId: "lesson", at: "2026-03-10T17:00:00+09:00" },
    ]);
  });

  test("ignores all-day events and rules with no lead time", () => {
    const rules = parseRules({
      travel: [
        {
          calendarId: null,
          locationIncludes: null,
          minutesBefore: 0,
          minutesAfter: 30,
        },
      ],
    });
    expect(
      leaveByFor(
        [
          event({ start: utc("13:00"), end: utc("14:00") }),
          event({
            id: "holiday",
            start: `${DATE}T00:00:00+00:00`,
            end: "2026-03-11T00:00:00+00:00",
            allDay: true,
          }),
        ],
        rules,
      ),
    ).toEqual([]);
  });

  test("a buffer of zero leaves the event edges exactly as they are", () => {
    const rules = parseRules({ bufferMinutes: 0 });
    const intervals = freeIntervals(
      DATE,
      [event({ start: utc("13:00"), end: utc("14:00") })],
      rules,
      { fromMs: 0, allowProtected: false },
    );
    expect(intervals[0].endMs).toBe(at("13:00"));
    expect(intervals[1].startMs).toBe(at("14:00"));
    expect(intervals[1].endMs - intervals[1].startMs).toBe(9 * HOUR);
  });
});
