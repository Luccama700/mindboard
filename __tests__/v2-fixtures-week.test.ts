// The sample week: the calendar the Today screen shows beside the sample day,
// and the only calendar a Vercel preview can show at all.
//
// EVERYTHING HERE IS FICTIONAL, like the sample day it belongs to. No title,
// place, name or time describes anybody, the zone is not the owner's, and the
// clock is a fixed invented instant, so a screenshot taken tomorrow matches one
// taken today.
//
// THE ONE THING THIS FILE REALLY GUARDS. The day and the calendar beside it are
// two views of the same Wednesday, built by two different functions, so they can
// disagree: the seminar can sit at 09:00 on the left of the screen and at some
// other hour on the right. They are pinned against each other here, by id and by
// instant, rather than by eye.

import { describe, expect, test } from "vitest";

import { weekOf } from "@/app/lib/v2/calendar/grid";
import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { buildCalendarView } from "@/app/lib/v2/view/calendar";
import type { CalEvent } from "@/app/lib/v2/calendar/types";

/** The sample day is a Wednesday; Monday first, its week is the 13th to the 19th. */
const WEEK = weekOf("2026-04-15");
const NEXT = weekOf("2026-04-22");

const week = () => sampleWeek(null);

const byId = (events: CalEvent[]) => new Map(events.map((event) => [event.id, event]));

/** Every string anywhere in a value, so the copy rules can be walked. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) strings(item, into);
  }
  return into;
}

describe("the sample week is the sample day's own week", () => {
  test("shows the week the sample day falls in", () => {
    expect(week().week).toEqual(WEEK);
    expect(WEEK).toContain(sampleDay().input.date);
  });

  test("runs on the sample day's zone and its fixed invented clock", () => {
    const { input } = sampleDay();
    expect(week().timeZone).toBe(input.rules.timeZone);
    expect(week().now).toBe(input.now);
  });

  test("spans the hours the sample day's rules span", () => {
    // 07:30 wake, 08:30 before which nothing the planner owns starts, 23:30 out.
    expect(week().dayWindow).toEqual({ fromMinute: 510, toMinute: 1410 });
  });

  test("is what the sample day hands the screen", () => {
    expect(sampleDay().calendar).toEqual(week());
  });

  test("is deterministic, so the screen renders the same every time", () => {
    expect(sampleWeek(null)).toEqual(sampleWeek(null));
    expect(sampleWeek("2026-04-22")).toEqual(sampleWeek("2026-04-22"));
  });

  test("hands back its own objects, so nothing can be mutated into it", () => {
    const first = week();
    first.events.length = 0;
    first.calendars.length = 0;
    expect(week().events.length).toBeGreaterThan(0);
    expect(week().calendars.length).toBeGreaterThan(0);
  });
});

// The day's fixed events and the calendar's events are the same things. If this
// fails, the screen is showing one Wednesday twice and disagreeing with itself.
describe("the day and the calendar agree", () => {
  const events = byId(week().events);
  // Everything on the sample day that came off a calendar. A fixed thing with no
  // calendar is a task's own time block, which belongs to the day and not to
  // anybody's calendar, so the calendar is not expected to hold it.
  const fixed = sampleDay().input.fixed.filter((event) => event.calendarId !== null);

  test("the day's fixed things are all on a calendar at all", () => {
    expect(fixed).toHaveLength(sampleDay().input.fixed.length);
  });

  test("every timed thing on the day is on the calendar, at the same time", () => {
    const timed = fixed.filter((event) => !event.allDay);
    expect(timed.length).toBeGreaterThan(0);
    for (const event of timed) {
      const same = events.get(event.id);
      expect(same, event.id).toBeDefined();
      expect(same?.allDay).toBe(false);
      expect(Date.parse(String(same?.start))).toBe(Date.parse(event.start));
      expect(Date.parse(String(same?.end))).toBe(Date.parse(event.end));
      expect(same?.title).toBe(event.title);
      expect(same?.location).toBe(event.location);
    }
  });

  test("so is the all day notice, as the day it covers", () => {
    const notice = fixed.find((event) => event.allDay);
    expect(notice).toBeDefined();
    const same = events.get(String(notice?.id));
    expect(same?.allDay).toBe(true);
    // An all day event carries date keys, and Google's end is exclusive.
    expect(same?.start).toBe("2026-04-15");
    expect(same?.end).toBe("2026-04-16");
  });

  test("and every one of them is on a calendar the week knows", () => {
    const known = new Set(week().calendars.map((calendar) => calendar.id));
    for (const event of fixed) expect(known, event.id).toContain(event.calendarId);
  });
});

describe("the week is worth looking at", () => {
  const view = buildCalendarView(week(), []);

  test("has something on at least five of the seven days", () => {
    const busy = view.days.filter(
      (day) => day.chips.length > 0 || day.allDay.length > 0,
    );
    expect(busy.length).toBeGreaterThanOrEqual(5);
  });

  test("has something on at least four days besides the sample day", () => {
    const elsewhere = view.days.filter(
      (day) =>
        day.date !== "2026-04-15" && (day.chips.length > 0 || day.allDay.length > 0),
    );
    expect(elsewhere.length).toBeGreaterThanOrEqual(4);
  });

  test("covers every day of its own week, so none of them reads as unknown", () => {
    expect(week().covered).toEqual(WEEK);
    expect(view.days.every((day) => day.covered)).toBe(true);
    expect(view.empty).toBe(false);
  });

  test("has one calendar the account may only read", () => {
    const readOnly = week().calendars.filter((calendar) => !calendar.writable);
    expect(readOnly).toHaveLength(1);
    expect(week().events.some((event) => event.calendarId === readOnly[0].id)).toBe(true);
  });

  test("has one occurrence of something that repeats", () => {
    expect(week().events.filter((event) => event.recurring).length).toBeGreaterThanOrEqual(1);
  });

  test("has an all day event over several days", () => {
    const long = view.allDay.find((span) => span.lastIndex > span.firstIndex);
    expect(long).toBeDefined();
    expect(Number(long?.lastIndex) - Number(long?.firstIndex)).toBeGreaterThanOrEqual(2);
  });

  test("has a pair that overlaps, so the columns are exercised", () => {
    const shared = view.days.flatMap((day) =>
      day.chips.filter((chip) => chip.columnCount > 1),
    );
    expect(shared.length).toBeGreaterThanOrEqual(2);
  });

  test("names every calendar it uses, and gives each a colour", () => {
    for (const entry of view.legend) {
      expect(entry.label).not.toBe("Calendar");
      expect(entry.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(view.legend.length).toBeGreaterThanOrEqual(3);
  });

  test("puts the now line on the sample day", () => {
    expect(view.nowTop).not.toBeNull();
    expect(view.nowLabel).toBe("10:20");
    expect(view.days.filter((day) => day.isToday).map((day) => day.date)).toEqual([
      "2026-04-15",
    ]);
  });
});

describe("which weeks it can show", () => {
  test("offers the week after and not the week before", () => {
    expect(week().nextWeek).toBe(NEXT[0]);
    expect(week().prevWeek).toBeNull();
    expect(week().thisWeek).toBeNull();
  });

  test("shows the week after when it is asked for", () => {
    const after = sampleWeek("2026-04-22");
    expect(after.week).toEqual(NEXT);
    expect(after.covered).toEqual(NEXT);
    expect(after.prevWeek).toBe(WEEK[0]);
    expect(after.nextWeek).toBeNull();
    // Today is in the other week, which is covered, so there is a way back.
    expect(after.thisWeek).toBe(WEEK[0]);
  });

  test("takes any day of a week it covers, not only the Monday", () => {
    for (const day of NEXT) expect(sampleWeek(day).week).toEqual(NEXT);
  });

  test("has nothing on a week it does not cover, so it shows its own", () => {
    for (const asked of ["2026-04-06", "2026-05-11", "2027-01-04"]) {
      expect(sampleWeek(asked).week).toEqual(WEEK);
    }
  });

  test("ignores anything that is not a day that exists", () => {
    for (const asked of [
      "",
      "2026-04-22 ",
      "2026-4-22",
      "22/04/2026",
      "2026-02-30",
      "2026-13-45",
      "tomorrow",
      "../../etc/passwd",
    ]) {
      expect(sampleWeek(asked).week, asked).toEqual(WEEK);
    }
  });

  test("marks nothing as today on a week that does not hold it", () => {
    const after = buildCalendarView(sampleWeek("2026-04-22"), []);
    expect(after.days.some((day) => day.isToday)).toBe(false);
    expect(after.nowTop).toBeNull();
  });
});

describe("the copy rules", () => {
  const everything = [...strings(week()), ...strings(buildCalendarView(week(), []))];

  test("has something to walk", () => {
    expect(everything.length).toBeGreaterThan(40);
  });

  // Built from code points on purpose, so this file stays pure ASCII.
  const EM_DASH = String.fromCodePoint(0x2014);
  const EN_DASH = String.fromCodePoint(0x2013);

  test("uses no em dash and no en dash", () => {
    for (const text of everything) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
    }
  });

  test("never speaks of streaks, points, levels or penalties", () => {
    for (const text of everything) {
      expect(text).not.toMatch(/\b(streaks?|points?|levels?|penalt(y|ies)|xp)\b/i);
    }
  });

  test("is invented, not anybody's", () => {
    const everywhere = everything.join("|");
    expect(week().timeZone).not.toBe("America/Vancouver");
    expect(everywhere).not.toContain("Vancouver");
    expect(everywhere).not.toContain("@");
  });
});
