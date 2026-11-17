// The calendar's view model: a week of events in, positioned chips out.
//
// EVERYTHING HERE IS INVENTED. The weeks, the calendars, the titles and the
// places are made up, and the zones are chosen for what they prove: Phoenix has
// no daylight saving, so every instant in the main week is stable, and New York
// has one, so a week with a clock change in it can be asserted at all.
//
// WHAT THIS FILE IS FOR. The view model does the arithmetic the pane must not:
// which day a chip belongs to, how far down the window it sits, which column it
// takes when things overlap, and which days the source cannot speak for. Each of
// those has a silent failure behind it, so each is pinned on a week built to
// contain it: a pair that overlaps, an event across midnight, one ending exactly
// at midnight, one so late that the fifteen minute floor runs past midnight, an
// all day event over several days, a day the snapshot does not cover, a calendar
// nothing knows about, and a planned block landing on top of an event.
//
// It places nothing itself: `layoutDay` and `layoutAllDay` from the calendar
// engine do that, and these tests are written so that a view model which started
// doing its own placing would fail them.

import { describe, expect, test } from "vitest";

import { MIN_EVENT_MINUTES, type CalEvent } from "@/app/lib/v2/calendar/types";
import { weekOf } from "@/app/lib/v2/calendar/grid";
import { parseRules } from "@/app/lib/v2/rules";
import { timeRangeLabel, weekLabel } from "@/app/lib/v2/view/format";
import {
  CALENDAR_COPY,
  buildCalendarView,
  calendarScreenData,
  eventDays,
  type CalendarDayView,
  type PlannedBlock,
} from "@/app/lib/v2/view/calendar";
import type { CalendarScreenData, ScreenCalendar } from "@/app/lib/v2/view/screen-data";

const ZONE = "America/Phoenix";
const OFFSET = "-07:00";
/** A Wednesday. Monday first, its week is the 13th to the 19th of April. */
const WEDNESDAY = "2026-04-15";
const WEEK = [
  "2026-04-13",
  "2026-04-14",
  WEDNESDAY,
  "2026-04-16",
  "2026-04-17",
  "2026-04-18",
  "2026-04-19",
];
const NOW = `${WEDNESDAY}T10:20:00${OFFSET}`;

const at = (clock: string, date: string = WEDNESDAY) => `${date}T${clock}:00${OFFSET}`;

const CAMPUS = "cal-campus";
const SHOP = "cal-shift";
const QUIET = "cal-quiet";
/** A calendar id no calendar entry knows. The view must not drop its events. */
const NOWHERE = "cal-nowhere";

const CALENDARS: ScreenCalendar[] = [
  { id: CAMPUS, label: "Campus", color: "#7C9BFF", writable: true },
  { id: SHOP, label: "Print shop", color: "#2FD6A3", writable: false },
  { id: QUIET, label: "Nothing on it", color: "#FFB84D", writable: true },
];

/** A timed event, with the fields a snapshot cannot know left as they are. */
function timed(
  id: string,
  calendarId: string,
  start: string,
  end: string,
  extra: Partial<CalEvent> = {},
): CalEvent {
  return {
    id,
    calendarId,
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

function allDay(id: string, calendarId: string, start: string, end: string): CalEvent {
  return {
    id,
    calendarId,
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

function data(over: Partial<CalendarScreenData> = {}): CalendarScreenData {
  return {
    timeZone: ZONE,
    now: NOW,
    today: WEDNESDAY,
    week: [...WEEK],
    covered: [...WEEK],
    calendars: CALENDARS.map((calendar) => ({ ...calendar })),
    events: [],
    dayWindow: { fromMinute: 510, toMinute: 1410 },
    prevWeek: null,
    nextWeek: null,
    thisWeek: null,
    ...over,
  };
}

/** The planned block that lands on top of the afternoon pair. */
const PLANNED: PlannedBlock = {
  id: "pb-notes",
  title: "Field notes writeup",
  start: at("13:30"),
  end: at("14:30"),
};

const SEMINAR = timed("ev-seminar", CAMPUS, at("09:00"), at("10:15"), {
  title: "Morning seminar",
  location: "Hall B",
});
const WORKSHOP = timed("ev-workshop", CAMPUS, at("13:00"), at("15:00"), {
  title: "Ceramics workshop",
});
const SHIFT = timed("ev-shift", SHOP, at("14:00"), at("16:00"), {
  title: "Print shop shift",
  recurring: true,
});

/** A quiet week: nothing in it widens the window the rules asked for. */
const quiet = (over: Partial<CalendarScreenData> = {}) =>
  data({ events: [SEMINAR, WORKSHOP, SHIFT], ...over });

/** The awkward week, with one of every edge on it. */
const awkward = () =>
  data({
    covered: WEEK.slice(0, 6),
    events: [
      SEMINAR,
      WORKSHOP,
      SHIFT,
      // Across midnight: on Tuesday with no bottom edge, on Wednesday with no top.
      timed("ev-night", CAMPUS, at("22:30", "2026-04-14"), at("01:30"), {
        title: "Night firing",
      }),
      // Ends exactly where Friday begins, so it is Thursday's and nothing else.
      timed("ev-closing", CAMPUS, at("22:00", "2026-04-16"), at("00:00", "2026-04-17"), {
        title: "Kiln closing",
      }),
      // Three minutes long, five to midnight: the fifteen minute floor runs the
      // chip past the end of the day, so the window has to make room for it.
      timed("ev-latch", SHOP, at("23:55", "2026-04-18"), at("23:58", "2026-04-18"), {
        title: "Latch the door",
      }),
      // On a calendar nothing knows.
      timed("ev-stranger", NOWHERE, at("09:00", "2026-04-13"), at("10:00", "2026-04-13"), {
        title: "Unknown calendar",
      }),
      // On the Sunday, which this source does not cover.
      timed("ev-beyond", CAMPUS, at("10:00", "2026-04-19"), at("11:00", "2026-04-19"), {
        title: "Beyond the copy",
      }),
      // Thursday to Saturday, Google's end being exclusive.
      allDay("ev-notice", CAMPUS, "2026-04-16", "2026-04-19"),
      // Longer than the week at both ends.
      allDay("ev-term", CAMPUS, "2026-04-06", "2026-04-27"),
    ],
  });

const dayOf = (view: { days: CalendarDayView[] }, date: string): CalendarDayView => {
  const day = view.days.find((entry) => entry.date === date);
  if (day === undefined) throw new Error(`no day ${date} in the view`);
  return day;
};

const chipIds = (day: CalendarDayView) => day.chips.map((chip) => chip.id);

const chipOn = (view: { days: CalendarDayView[] }, date: string, id: string) => {
  const chip = dayOf(view, date).chips.find((entry) => entry.id === id);
  if (chip === undefined) throw new Error(`no chip ${id} on ${date}`);
  return chip;
};

/** Every string anywhere in a value, so the copy rules can be walked. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) strings(item, into);
  }
  return into;
}

describe("weekLabel", () => {
  test("names one month once", () => {
    expect(weekLabel(weekOf("2026-11-10"))).toBe("9 to 15 November");
    expect(weekLabel(weekOf("2026-04-15"))).toBe("13 to 19 April");
  });

  test("names both months when the week crosses one", () => {
    expect(weekLabel(weekOf("2026-12-02"))).toBe("30 November to 6 December");
  });

  test("names both years when the week crosses one", () => {
    expect(weekLabel(weekOf("2026-12-30"))).toBe("28 December 2026 to 3 January 2027");
  });

  test("does not pad the day of the month", () => {
    expect(weekLabel(weekOf("2026-03-04"))).toBe("2 to 8 March");
  });
});

describe("timeRangeLabel", () => {
  test("is two 24 hour clocks in the zone it is given", () => {
    expect(timeRangeLabel(at("13:00"), at("14:00"), ZONE)).toBe("13:00 to 14:00");
    expect(timeRangeLabel(at("07:05"), at("07:30"), ZONE)).toBe("07:05 to 07:30");
  });

  test("reads the instants in that zone and not the process clock", () => {
    expect(timeRangeLabel(at("13:00"), at("14:00"), "UTC")).toBe("20:00 to 21:00");
    expect(timeRangeLabel(at("13:00"), at("14:00"), "Asia/Tokyo")).toBe("05:00 to 06:00");
  });
});

// Which days an event is ON, which is what decides how far a snapshot's derived
// range reaches. Both ends of an event are exclusive in the same way, and the
// day the END falls on is not always a day the event is on: counting it put a
// Friday night shift on the Saturday, and a day covered with nothing on it draws
// as a free day the source never spoke for.
describe("eventDays", () => {
  test("keeps an event that ends at exactly midnight on the day it ran", () => {
    expect(
      eventDays(timed("ev", CAMPUS, at("22:00", "2026-04-17"), at("00:00", "2026-04-18")), ZONE),
    ).toEqual(["2026-04-17", "2026-04-17"]);
  });

  test("gives both days to one that really runs into the second", () => {
    expect(
      eventDays(timed("ev", CAMPUS, at("22:00", "2026-04-17"), at("01:30", "2026-04-18")), ZONE),
    ).toEqual(["2026-04-17", "2026-04-18"]);
  });

  test("gives its one day to an event with no length, or an inverted pair", () => {
    expect(eventDays(timed("ev", CAMPUS, at("09:00"), at("09:00")), ZONE)).toEqual([
      WEDNESDAY,
      WEDNESDAY,
    ]);
    expect(eventDays(timed("ev", CAMPUS, at("09:00"), at("08:00")), ZONE)).toEqual([
      WEDNESDAY,
      WEDNESDAY,
    ]);
  });

  test("reads an instant in the zone it is given", () => {
    // 2026-04-15T23:30-07:00 is already the 16th in UTC.
    expect(eventDays(timed("ev", CAMPUS, at("23:30"), at("23:45")), "UTC")).toEqual([
      "2026-04-16",
      "2026-04-16",
    ]);
  });

  test("takes the day before an all day end, which Google makes exclusive", () => {
    expect(eventDays(allDay("ev", CAMPUS, "2026-04-16", "2026-04-19"), ZONE)).toEqual([
      "2026-04-16",
      "2026-04-18",
    ]);
    expect(eventDays(allDay("ev", CAMPUS, "2026-04-16", "2026-04-17"), ZONE)).toEqual([
      "2026-04-16",
      "2026-04-16",
    ]);
    // An end equal to the start still covers its one day.
    expect(eventDays(allDay("ev", CAMPUS, "2026-04-16", "2026-04-16"), ZONE)).toEqual([
      "2026-04-16",
      "2026-04-16",
    ]);
  });

  test("has nothing to say about a pair it cannot read", () => {
    expect(eventDays(timed("ev", CAMPUS, "soon", "later"), ZONE)).toBeNull();
    // An all day event carries date keys in this window, by contract.
    expect(eventDays(allDay("ev", CAMPUS, at("00:00"), at("00:00", "2026-04-16")), ZONE))
      .toBeNull();
  });
});

describe("the week it draws", () => {
  const view = buildCalendarView(quiet(), []);

  test("is seven days, Monday first, each named twice over", () => {
    expect(view.days.map((day) => day.date)).toEqual(WEEK);
    expect(view.days.map((day) => day.weekday)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    expect(view.days.map((day) => day.dayNumber)).toEqual([
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
    ]);
    expect(dayOf(view, WEDNESDAY).label).toBe("Wednesday 15 April");
  });

  test("says which week it is", () => {
    expect(view.weekLabel).toBe("13 to 19 April");
  });

  test("marks the one day now falls on, in the data's zone", () => {
    expect(view.days.filter((day) => day.isToday).map((day) => day.date)).toEqual([
      WEDNESDAY,
    ]);
  });

  test("marks today and the two days after it as near", () => {
    expect(view.days.filter((day) => day.near).map((day) => day.date)).toEqual([
      WEDNESDAY,
      "2026-04-16",
      "2026-04-17",
    ]);
  });

  test("marks the first three days as near when today is elsewhere", () => {
    const elsewhere = buildCalendarView(
      data({ now: at("10:20", "2026-05-20"), today: "2026-05-20" }),
      [],
    );
    expect(elsewhere.days.some((day) => day.isToday)).toBe(false);
    expect(elsewhere.days.filter((day) => day.near).map((day) => day.date)).toEqual(
      WEEK.slice(0, 3),
    );
  });

  test("carries the three week links as the data gave them", () => {
    const linked = buildCalendarView(
      data({ prevWeek: "2026-04-06", nextWeek: "2026-04-20", thisWeek: "2026-04-13" }),
      [],
    );
    expect(linked.prevWeek).toBe("2026-04-06");
    expect(linked.nextWeek).toBe("2026-04-20");
    expect(linked.thisWeek).toBe("2026-04-13");
    expect(view.prevWeek).toBeNull();
    expect(view.nextWeek).toBeNull();
    expect(view.thisWeek).toBeNull();
  });
});

describe("the window it draws inside", () => {
  test("is the rules' window, widened to whole hours", () => {
    const view = buildCalendarView(quiet(), []);
    // The rules say 08:30 to 23:30, and a grid is drawn in whole hours, so the
    // window is 08:00 to midnight: never narrower than the day it describes.
    expect(view.fromMinute).toBe(480);
    expect(view.toMinute).toBe(1440);
  });

  test("widens again for anything the week would otherwise draw outside it", () => {
    const view = buildCalendarView(awkward(), []);
    // Midnight, because of the event that began the night before, and past
    // midnight at the other end, because the fifteen minute floor on the 23:55
    // event ends at 00:10 the next morning.
    expect(view.fromMinute).toBe(0);
    expect(view.toMinute).toBe(1500);
  });

  test("draws one hour line per hour of it, top first", () => {
    const view = buildCalendarView(quiet(), []);
    expect(view.hours).toHaveLength(16);
    expect(view.hours[0]).toEqual({ label: "08:00", top: 0 });
    expect(view.hours.at(-1)?.label).toBe("23:00");
    expect(view.hours.at(-1)?.top).toBeCloseTo((1380 - 480) / 960, 10);
    for (const hour of view.hours) {
      expect(hour.top).toBeGreaterThanOrEqual(0);
      expect(hour.top).toBeLessThan(1);
    }
  });

  test("counts the hours past midnight rather than starting again at zero", () => {
    const view = buildCalendarView(awkward(), []);
    expect(view.hours).toHaveLength(25);
    expect(view.hours.map((hour) => hour.label).slice(0, 2)).toEqual(["00:00", "01:00"]);
    expect(view.hours.at(-1)?.label).toBe("24:00");
  });

  test("puts the now line where now is, and only on a week that holds it", () => {
    const view = buildCalendarView(quiet(), []);
    expect(view.nowTop).toBeCloseTo((620 - 480) / 960, 10);
    expect(view.nowLabel).toBe("10:20");

    const elsewhere = buildCalendarView(
      data({ now: at("10:20", "2026-05-20"), today: "2026-05-20" }),
      [],
    );
    expect(elsewhere.nowTop).toBeNull();
  });

  test("leaves the now line off when now is outside the window", () => {
    const early = buildCalendarView(data({ now: at("02:00") }), []);
    expect(early.nowTop).toBeNull();
    expect(early.nowLabel).toBe("02:00");
  });

  // A now line across a column that reads "Not in this copy" would be answering
  // a question the column has just said it cannot answer.
  test("leaves it off when today is in the week but not covered", () => {
    const view = buildCalendarView(
      quiet({ covered: WEEK.filter((date) => date !== WEDNESDAY) }),
      [],
    );
    expect(dayOf(view, WEDNESDAY).isToday).toBe(true);
    expect(dayOf(view, WEDNESDAY).covered).toBe(false);
    expect(view.nowTop).toBeNull();
    expect(view.nowLabel).toBe("10:20");
  });
});

// The day the screen is living is the PLANNING date, which runs on past
// midnight until lights out, and the calendar has to mark that day as today.
// Read off the instant instead, at 00:30 the pane marked the next morning, the
// three near days started there and hid the day still being lived, and on a
// Sunday night the default week did not hold "today" at all.
describe("the day it marks as today", () => {
  /** Lights out at 01:30, so 00:30 still belongs to the day before. */
  const LATE_RULES = parseRules({
    timeZone: ZONE,
    wakeByWeekday: ["07:30", "07:30", "07:30", "07:30", "07:30", "07:30", "07:30"],
    lightsOut: "01:30",
    noFocusBefore: "08:30",
  });

  /** What a source hands over: the planning date as the day it wants. */
  const screenOn = (wanted: string, now: string) =>
    calendarScreenData({
      timeZone: ZONE,
      now,
      rules: LATE_RULES,
      events: [SEMINAR, WORKSHOP, SHIFT],
      calendars: CALENDARS,
      range: { from: "2026-04-06", to: "2026-04-26" },
      wanted,
      weekParam: null,
    });

  const todays = (view: { days: CalendarDayView[] }) =>
    view.days.filter((day) => day.isToday).map((day) => day.date);
  const nears = (view: { days: CalendarDayView[] }) =>
    view.days.filter((day) => day.near).map((day) => day.date);

  test("is the day being lived at 00:30 on a weekday night, not the calendar date", () => {
    const data = screenOn(WEDNESDAY, at("00:30", "2026-04-16"));
    expect(data.today).toBe(WEDNESDAY);
    const view = buildCalendarView(data, []);
    expect(todays(view)).toEqual([WEDNESDAY]);
    expect(nears(view)).toEqual([WEDNESDAY, "2026-04-16", "2026-04-17"]);
  });

  test("keeps a Sunday in its own week at 00:30 on the Monday, and marks it", () => {
    const data = screenOn("2026-04-19", at("00:30", "2026-04-20"));
    expect(data.week).toEqual(WEEK);
    expect(data.today).toBe("2026-04-19");
    // The week shown holds today, so there is no "This week" to go back to.
    expect(data.thisWeek).toBeNull();
    const view = buildCalendarView(data, []);
    expect(todays(view)).toEqual(["2026-04-19"]);
    expect(nears(view)).toEqual(WEEK.slice(4));
  });

  // Whether the calendar's day should run past midnight is an open question, so
  // the line is only drawn where the instant really is: on the day marked today.
  test("draws no now line after midnight, before lights out", () => {
    expect(buildCalendarView(screenOn(WEDNESDAY, at("00:30", "2026-04-16")), []).nowTop).toBeNull();
    // Even where the window reaches midnight, so 00:30 is inside it: the line
    // would land in the next morning's column, which is not the day marked.
    const view = buildCalendarView(
      data({
        now: at("00:30", "2026-04-16"),
        today: WEDNESDAY,
        events: [timed("ev-late", CAMPUS, at("23:00"), at("01:00", "2026-04-16"))],
      }),
      [],
    );
    expect(view.fromMinute).toBe(0);
    expect(view.nowTop).toBeNull();
  });

  test("is the day it was handed, whatever the instant says", () => {
    const view = buildCalendarView(data({ today: "2026-04-17" }), []);
    expect(todays(view)).toEqual(["2026-04-17"]);
    // Now is on the Wednesday, which is not the day marked, so no line.
    expect(view.nowTop).toBeNull();
  });
});

// Three near days, always three. Starting at today ran off the end of the week
// on a Saturday and a Sunday, so the narrow grid showed two days and then one.
describe("the near days", () => {
  const nears = (today: string) =>
    buildCalendarView(data({ today, now: at("10:20", today) }), [])
      .days.filter((day) => day.near)
      .map((day) => day.date);

  test("are the last three of the week when today is the Saturday", () => {
    expect(nears("2026-04-18")).toEqual(WEEK.slice(4));
  });

  test("are the last three of the week when today is the Sunday", () => {
    expect(nears("2026-04-19")).toEqual(WEEK.slice(4));
  });

  test("are the first three when the week does not hold today", () => {
    expect(nears("2026-05-20")).toEqual(WEEK.slice(0, 3));
  });

  test("start at today everywhere else", () => {
    expect(nears("2026-04-13")).toEqual(WEEK.slice(0, 3));
    expect(nears("2026-04-17")).toEqual(WEEK.slice(4));
  });
});

// The window is the day's own hours and the calendar's events. A block the
// planner placed is drawn inside it, never let to move it: one at 00:10 on the
// morning after pulled the start of all seven columns back to midnight.
describe("a planned block and the window", () => {
  const LATE: PlannedBlock = {
    id: "pb-late",
    title: "Late block",
    start: at("00:10", "2026-04-16"),
    end: at("00:35", "2026-04-16"),
  };

  test("never widens it, and is not drawn when it lies wholly outside it", () => {
    const without = buildCalendarView(quiet(), []);
    const withLate = buildCalendarView(quiet(), [LATE]);
    expect(withLate.fromMinute).toBe(without.fromMinute);
    expect(withLate.toMinute).toBe(without.toMinute);
    expect(withLate.hours).toEqual(without.hours);
    // Every chip where it was, and the block on no day at all.
    expect(withLate.days).toEqual(without.days);
  });

  test("is cut at the edge it runs past, still saying its own times", () => {
    const early: PlannedBlock = {
      id: "pb-early",
      title: "Early block",
      start: at("07:30"),
      end: at("08:20"),
    };
    const view = buildCalendarView(quiet(), [early]);
    expect(view.fromMinute).toBe(480);
    const chip = chipOn(view, WEDNESDAY, "pb-early");
    expect(chip.top).toBe(0);
    // 08:00 to 08:20 is what the window holds of it.
    expect(chip.height).toBeCloseTo(20 / 960, 10);
    expect(chip.continuesBefore).toBe(true);
    expect(chip.continuesAfter).toBe(false);
    expect(chip.time).toBe("07:30 to 08:20");
  });

  test("is cut at the bottom as well", () => {
    const late: PlannedBlock = {
      id: "pb-night",
      title: "Night block",
      start: at("23:30"),
      end: at("00:30", "2026-04-16"),
    };
    const view = buildCalendarView(quiet(), [late]);
    expect(view.toMinute).toBe(1440);
    const chip = chipOn(view, WEDNESDAY, "pb-night");
    expect(chip.top).toBeCloseTo((1410 - 480) / 960, 10);
    expect(chip.height).toBeCloseTo(30 / 960, 10);
    expect(chip.continuesAfter).toBe(true);
    // Thursday's half, 00:00 to 00:30, is outside the window and not drawn.
    expect(chipIds(dayOf(view, "2026-04-16"))).toEqual([]);
  });

  test("still shares a column with an event it overlaps inside the window", () => {
    const view = buildCalendarView(quiet(), [PLANNED, LATE]);
    expect(chipOn(view, WEDNESDAY, "pb-notes").columnCount).toBe(3);
  });
});

// The window starts at the wake target. Starting it at the later of wake and
// "no focus before" left the now line off the grid for the first hour of the
// day, which is exactly when the owner looks at it.
describe("the window's start", () => {
  test("is the wake, so the now line is there between waking and the first focus hour", () => {
    const rules = parseRules({
      timeZone: ZONE,
      wakeByWeekday: ["07:30", "07:30", "07:30", "07:30", "07:30", "07:30", "07:30"],
      lightsOut: "23:30",
      noFocusBefore: "08:30",
    });
    const screen = calendarScreenData({
      timeZone: ZONE,
      now: at("07:45"),
      rules,
      events: [],
      calendars: CALENDARS,
      range: { from: WEEK[0], to: WEEK[6] },
      wanted: WEDNESDAY,
      weekParam: null,
    });
    expect(screen.dayWindow).toEqual({ fromMinute: 450, toMinute: 1410 });
    const view = buildCalendarView(screen, []);
    expect(view.fromMinute).toBe(420);
    expect(view.hours[0].label).toBe("07:00");
    expect(view.nowTop).toBeCloseTo((465 - 420) / (1440 - 420), 10);
  });

  test("is the earliest wake of the week when the weekdays differ", () => {
    const rules = parseRules({
      timeZone: ZONE,
      // Sunday first: a later start at the weekend.
      wakeByWeekday: ["09:15", "06:45", "07:30", "07:30", "07:30", "07:30", "09:15"],
      lightsOut: "23:30",
      noFocusBefore: "10:00",
    });
    const screen = calendarScreenData({
      timeZone: ZONE,
      now: NOW,
      rules,
      events: [],
      calendars: CALENDARS,
      range: { from: WEEK[0], to: WEEK[6] },
      wanted: WEDNESDAY,
      weekParam: null,
    });
    expect(screen.dayWindow.fromMinute).toBe(405);
  });
});

describe("a timed chip", () => {
  const view = buildCalendarView(quiet(), []);

  test("sits where its minutes put it in the window", () => {
    const seminar = chipOn(view, WEDNESDAY, "ev-seminar");
    expect(seminar.top).toBeCloseTo((540 - 480) / 960, 10);
    expect(seminar.height).toBeCloseTo(75 / 960, 10);
  });

  test("says what it is, when it is, and whose calendar it is on", () => {
    const seminar = chipOn(view, WEDNESDAY, "ev-seminar");
    expect(seminar.kind).toBe("event");
    expect(seminar.title).toBe("Morning seminar");
    expect(seminar.time).toBe("09:00 to 10:15");
    expect(seminar.calendar).toBe("Campus");
    expect(seminar.color).toBe("#7C9BFF");
    expect(seminar.location).toBe("Hall B");
    expect(seminar.recurring).toBe(false);
    expect(seminar.continuesBefore).toBe(false);
    expect(seminar.continuesAfter).toBe(false);
  });

  test("carries the repeating flag through", () => {
    expect(chipOn(view, WEDNESDAY, "ev-shift").recurring).toBe(true);
  });

  test("is never shorter than fifteen minutes of the window", () => {
    const brief = buildCalendarView(
      data({ events: [timed("ev-brief", CAMPUS, at("09:00"), at("09:03"))] }),
      [],
    );
    const chip = chipOn(brief, WEDNESDAY, "ev-brief");
    expect(chip.height).toBeCloseTo(MIN_EVENT_MINUTES / 960, 10);
  });

  test("stays inside the window, top and bottom", () => {
    const days = buildCalendarView(awkward(), [PLANNED]).days;
    let counted = 0;
    for (const day of days) {
      for (const chip of day.chips) {
        counted += 1;
        expect(chip.top).toBeGreaterThanOrEqual(0);
        expect(chip.height).toBeGreaterThan(0);
        // A fraction built by division, so the comparison carries the slack a
        // float needs; without it this passes or fails on the last bit.
        expect(chip.top + chip.height).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    // Without this the loop above would pass on a week with no chips at all,
    // which is exactly what a broken layout would hand it.
    expect(counted).toBe(9);
  });

  test("is listed in start order", () => {
    expect(chipIds(dayOf(view, WEDNESDAY))).toEqual([
      "ev-seminar",
      "ev-workshop",
      "ev-shift",
    ]);
  });
});

describe("things that overlap share the column", () => {
  const view = buildCalendarView(quiet(), [PLANNED]);
  const wednesday = dayOf(view, WEDNESDAY);

  test("a planned block goes through the same layout as the events", () => {
    expect(chipIds(wednesday)).toEqual([
      "ev-seminar",
      "ev-workshop",
      "pb-notes",
      "ev-shift",
    ]);
  });

  test("so the three of them take three columns of one", () => {
    for (const id of ["ev-workshop", "pb-notes", "ev-shift"]) {
      expect(chipOn(view, WEDNESDAY, id).columnCount).toBe(3);
    }
    expect(
      ["ev-workshop", "pb-notes", "ev-shift"].map(
        (id) => chipOn(view, WEDNESDAY, id).column,
      ),
    ).toEqual([0, 1, 2]);
  });

  test("and the morning, which overlaps nothing, keeps the whole width", () => {
    const seminar = chipOn(view, WEDNESDAY, "ev-seminar");
    expect(seminar.column).toBe(0);
    expect(seminar.columnCount).toBe(1);
  });

  test("a planned block is named as one and belongs to no calendar", () => {
    const planned = chipOn(view, WEDNESDAY, "pb-notes");
    expect(planned.kind).toBe("planned");
    expect(planned.title).toBe("Field notes writeup");
    expect(planned.time).toBe("13:30 to 14:30");
    expect(planned.calendar).toBeNull();
    expect(planned.color).toBeNull();
    expect(planned.location).toBeNull();
    expect(planned.recurring).toBe(false);
  });

  test("a planned block on another day is not on this one", () => {
    const thursday = dayOf(view, "2026-04-16");
    expect(chipIds(thursday)).toEqual([]);
  });
});

describe("a day boundary", () => {
  const view = buildCalendarView(awkward(), []);

  test("draws an event across midnight on both days, cut at the line", () => {
    const tuesday = chipOn(view, "2026-04-14", "ev-night");
    expect(tuesday.top).toBeCloseTo(1350 / 1500, 10);
    expect(tuesday.height).toBeCloseTo(90 / 1500, 10);
    expect(tuesday.continuesBefore).toBe(false);
    expect(tuesday.continuesAfter).toBe(true);

    const wednesday = chipOn(view, WEDNESDAY, "ev-night");
    expect(wednesday.top).toBe(0);
    expect(wednesday.height).toBeCloseTo(90 / 1500, 10);
    expect(wednesday.continuesBefore).toBe(true);
    expect(wednesday.continuesAfter).toBe(false);
  });

  test("keeps an event that ends exactly at midnight on the day it ran", () => {
    const thursday = chipOn(view, "2026-04-16", "ev-closing");
    expect(thursday.top).toBeCloseTo(1320 / 1500, 10);
    expect(thursday.height).toBeCloseTo(120 / 1500, 10);
    expect(thursday.continuesAfter).toBe(false);
    expect(chipIds(dayOf(view, "2026-04-17"))).toEqual([]);
  });

  test("gives a three minute event at five to midnight its fifteen minutes", () => {
    const latch = chipOn(view, "2026-04-18", "ev-latch");
    expect(latch.top).toBeCloseTo(1435 / 1500, 10);
    expect(latch.height).toBeCloseTo(MIN_EVENT_MINUTES / 1500, 10);
    expect(latch.top + latch.height).toBeLessThanOrEqual(1);
  });
});

describe("a day the source cannot speak for", () => {
  const view = buildCalendarView(awkward(), []);
  const sunday = dayOf(view, "2026-04-19");

  test("is marked, and the covered days are not", () => {
    expect(sunday.covered).toBe(false);
    expect(view.days.filter((day) => day.covered).map((day) => day.date)).toEqual(
      WEEK.slice(0, 6),
    );
  });

  test("has nothing on it, whatever the events say", () => {
    expect(sunday.chips).toEqual([]);
    expect(sunday.allDay).toEqual([]);
  });

  test("never makes the week read as empty", () => {
    const outside = buildCalendarView(
      data({
        covered: [WEEK[0]],
        events: [timed("ev-beyond", CAMPUS, at("10:00", "2026-04-17"), at("11:00", "2026-04-17"))],
      }),
      [],
    );
    expect(outside.empty).toBe(true);
  });
});

describe("empty", () => {
  test("is a covered week with nothing at all on it", () => {
    expect(buildCalendarView(data(), []).empty).toBe(true);
  });

  test("is false once anything lands on a covered day", () => {
    expect(buildCalendarView(quiet(), []).empty).toBe(false);
    expect(
      buildCalendarView(data({ events: [allDay("ev-notice", CAMPUS, WEDNESDAY, "2026-04-16")] }), [])
        .empty,
    ).toBe(false);
  });

  // It is a statement about the CALENDAR. What the app planned for itself is not
  // something on the calendar, so a day with a block and no event still reads
  // "Nothing on the calendar": the blocks are on the screen in their own right,
  // and saying the calendar has something on it would be a lie about Google.
  test("is not changed by the blocks the app planned", () => {
    expect(buildCalendarView(data(), [PLANNED]).empty).toBe(true);
    expect(buildCalendarView(quiet(), [PLANNED]).empty).toBe(false);
  });

  test("is false when the source covers no day of this week at all", () => {
    expect(buildCalendarView(data({ covered: [] }), []).empty).toBe(false);
  });
});

describe("a planned block", () => {
  test("is dropped on a day the source cannot speak for", () => {
    const view = buildCalendarView(data({ covered: [WEEK[0]] }), [PLANNED]);
    expect(dayOf(view, WEDNESDAY).covered).toBe(false);
    expect(dayOf(view, WEDNESDAY).chips).toEqual([]);
    // The column says the day is unknown and says nothing else: a block drawn
    // on it would be an answer about a day the calendar has no answer for.
    expect(view.days.flatMap((day) => day.chips)).toEqual([]);
  });
});

describe("the all day row", () => {
  const view = buildCalendarView(awkward(), []);

  test("spans the days an all day event covers, Google's end being exclusive", () => {
    const notice = view.allDay.find((span) => span.id === "ev-notice");
    expect(notice).toMatchObject({
      title: "ev-notice",
      color: "#7C9BFF",
      firstIndex: 3,
      lastIndex: 5,
      continuesBefore: false,
      continuesAfter: false,
    });
  });

  test("says when one runs past the week at either end", () => {
    // On a week the source covers whole, so nothing cuts it but the week itself.
    const whole = buildCalendarView(
      data({ events: [allDay("ev-term", CAMPUS, "2026-04-06", "2026-04-27")] }),
      [],
    );
    expect(whole.allDay).toEqual([
      {
        id: "ev-term",
        eventId: "ev-term",
        title: "ev-term",
        color: "#7C9BFF",
        firstIndex: 0,
        lastIndex: 6,
        row: 0,
        continuesBefore: true,
        continuesAfter: true,
      },
    ]);
  });

  test("stacks them so two spans never share a row", () => {
    const rows = new Map<number, Array<[number, number]>>();
    for (const span of view.allDay) {
      const held = rows.get(span.row) ?? [];
      held.push([span.firstIndex, span.lastIndex]);
      rows.set(span.row, held);
    }
    for (const held of rows.values()) {
      held.sort((a, b) => a[0] - b[0]);
      for (let index = 1; index < held.length; index += 1) {
        expect(held[index][0]).toBeGreaterThan(held[index - 1][1]);
      }
    }
    expect(view.allDayRows).toBe(2);
  });

  test("counts no rows when nothing is all day", () => {
    const view = buildCalendarView(quiet(), []);
    expect(view.allDay).toEqual([]);
    expect(view.allDayRows).toBe(0);
  });

  // A span drawn across a column that reads "Not in this copy" says the event
  // covers a day the source has no answer for. It is cut instead, and where an
  // uncovered day interrupts a run it becomes two spans, each flagged on the
  // side it was cut. A day that is not covered carries nothing at all.
  test("is cut at a day the source cannot speak for", () => {
    const term = buildCalendarView(awkward(), []).allDay.find(
      (span) => span.id === "ev-term",
    );
    // The Sunday is not covered, so the span that ran through the whole week now
    // stops on the Saturday, still flagged as running on past it.
    expect(term).toMatchObject({
      firstIndex: 0,
      lastIndex: 5,
      continuesBefore: true,
      continuesAfter: true,
    });
  });

  test("becomes two spans when an uncovered day interrupts it", () => {
    const view = buildCalendarView(
      data({
        covered: WEEK.filter((date) => date !== WEDNESDAY),
        events: [allDay("ev-term", CAMPUS, WEEK[0], "2026-04-18")],
      }),
      [],
    );
    expect(view.allDay).toHaveLength(2);
    expect(view.allDay[0]).toMatchObject({
      firstIndex: 0,
      lastIndex: 1,
      continuesBefore: false,
      continuesAfter: true,
      row: 0,
    });
    expect(view.allDay[1]).toMatchObject({
      firstIndex: 3,
      lastIndex: 4,
      continuesBefore: true,
      continuesAfter: false,
      row: 0,
    });
    // Two rows of one list need two keys, so a cut span's pieces are told apart.
    expect(view.allDay[0].id).not.toBe(view.allDay[1].id);
    for (const span of view.allDay) expect(span.id).toContain("ev-term");
    // The event itself is still one event, and both rows say which one: the key
    // is for drawing, and only `eventId` answers "which event is this".
    expect(view.allDay.map((span) => span.eventId)).toEqual(["ev-term", "ev-term"]);
    expect(view.allDayRows).toBe(1);
    expect(dayOf(view, WEDNESDAY).allDay).toEqual([]);
    expect(dayOf(view, WEEK[1]).allDay).toEqual(["ev-term"]);
  });

  test("keeps its plain id when nothing cuts it", () => {
    const view = buildCalendarView(
      data({ events: [allDay("ev-term", CAMPUS, WEEK[0], "2026-04-18")] }),
      [],
    );
    expect(view.allDay.map((span) => span.id)).toEqual(["ev-term"]);
    expect(view.allDay.map((span) => span.eventId)).toEqual(["ev-term"]);
  });

  test("lists each covered day's all day titles for the agenda", () => {
    expect(dayOf(view, "2026-04-16").allDay).toEqual(["ev-term", "ev-notice"]);
    expect(dayOf(view, WEDNESDAY).allDay).toEqual(["ev-term"]);
    expect(dayOf(view, "2026-04-19").allDay).toEqual([]);
  });

  test("never puts an all day event in the timed chips", () => {
    for (const day of view.days) {
      expect(chipIds(day)).not.toContain("ev-notice");
      expect(chipIds(day)).not.toContain("ev-term");
    }
  });
});

describe("the legend", () => {
  const view = buildCalendarView(awkward(), []);

  test("lists only the calendars with something on this week, in the data's order", () => {
    expect(view.legend.map((entry) => entry.id)).toEqual([CAMPUS, SHOP, NOWHERE]);
    expect(view.legend.slice(0, 2)).toEqual([
      { id: CAMPUS, label: "Campus", color: "#7C9BFF" },
      { id: SHOP, label: "Print shop", color: "#2FD6A3" },
    ]);
  });

  test("keeps a calendar nothing knows, named plainly and with no colour", () => {
    expect(view.legend.at(-1)).toEqual({ id: NOWHERE, label: "Calendar", color: null });
    const stranger = chipOn(view, "2026-04-13", "ev-stranger");
    expect(stranger.calendar).toBe("Calendar");
    expect(stranger.color).toBeNull();
  });

  test("leaves out a calendar whose events are all on a day that is not covered", () => {
    const view = buildCalendarView(
      data({
        covered: WEEK.slice(0, 6),
        events: [timed("ev-beyond", QUIET, at("10:00", "2026-04-19"), at("11:00", "2026-04-19"))],
      }),
      [],
    );
    expect(view.legend).toEqual([]);
  });

  test("is empty on a week with nothing on it", () => {
    expect(buildCalendarView(data(), [PLANNED]).legend).toEqual([]);
  });

  // A folder can list one calendar twice. Two rows for one calendar is noise,
  // and two different labels for one id is worse, so the first entry wins
  // everywhere: in the legend and on the chips.
  test("names a calendar listed twice once, by its first entry", () => {
    const view = buildCalendarView(
      data({
        calendars: [
          { id: CAMPUS, label: "Campus", color: "#7C9BFF", writable: true },
          { id: CAMPUS, label: "Campus again", color: "#FF7A8A", writable: false },
        ],
        events: [SEMINAR],
      }),
      [],
    );
    expect(view.legend).toEqual([{ id: CAMPUS, label: "Campus", color: "#7C9BFF" }]);
    expect(chipOn(view, WEDNESDAY, "ev-seminar").calendar).toBe("Campus");
    expect(chipOn(view, WEDNESDAY, "ev-seminar").color).toBe("#7C9BFF");
  });
});

// A grid of 24 equal rows is a WALL CLOCK grid, so 09:00 is nine hours down it
// on the Sunday the clocks go forward as well as on the Monday before. Drawn by
// elapsed time instead, one of the two would be an hour out, and the week this
// happens in is the one week a year nobody is looking.
describe("a week the clocks change in", () => {
  const NY = "America/New_York";
  /** Monday to Sunday. The clocks go forward on the Sunday, 2026-03-08. */
  const SPRING = weekOf("2026-03-08");

  const spring = (events: CalEvent[], now: string) =>
    buildCalendarView(
      {
        timeZone: NY,
        now,
        today: now.slice(0, 10),
        week: SPRING,
        covered: SPRING,
        calendars: [{ id: CAMPUS, label: "Campus", color: "#7C9BFF", writable: true }],
        events,
        dayWindow: { fromMinute: 480, toMinute: 1380 },
        prevWeek: null,
        nextWeek: null,
        thisWeek: null,
      },
      [],
    );

  test("is the week it says it is", () => {
    expect(SPRING).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
    expect(spring([], "2026-03-04T12:00:00-05:00").weekLabel).toBe("2 to 8 March");
    expect(spring([], "2026-03-04T12:00:00-05:00").days[0].dayNumber).toBe("2");
  });

  test("draws the same wall clock at the same height on both sides of it", () => {
    const before = timed("ev-before", CAMPUS, "2026-03-02T09:00:00-05:00", "2026-03-02T10:00:00-05:00");
    const after = timed("ev-after", CAMPUS, "2026-03-08T09:00:00-04:00", "2026-03-08T10:00:00-04:00");
    const view = spring([before, after], "2026-03-04T12:00:00-05:00");

    const monday = chipOn(view, "2026-03-02", "ev-before");
    const sunday = chipOn(view, "2026-03-08", "ev-after");
    expect(monday.top).toBeCloseTo((540 - 480) / 900, 10);
    expect(sunday.top).toBeCloseTo(monday.top, 10);
    expect(sunday.height).toBeCloseTo(monday.height, 10);
    expect(monday.time).toBe("09:00 to 10:00");
    expect(sunday.time).toBe("09:00 to 10:00");
  });

  test("keeps the short day the same height as the others", () => {
    const view = spring([], "2026-03-04T12:00:00-05:00");
    expect(view.fromMinute).toBe(480);
    expect(view.toMinute).toBe(1380);
  });

  test("puts the now line at the wall clock of the day the clocks changed", () => {
    const view = spring([], "2026-03-08T09:30:00-04:00");
    expect(view.days.filter((day) => day.isToday).map((day) => day.date)).toEqual([
      "2026-03-08",
    ]);
    expect(view.nowTop).toBeCloseTo((570 - 480) / 900, 10);
    expect(view.nowLabel).toBe("09:30");
  });
});

describe("the copy rules", () => {
  const everything = [
    ...strings(CALENDAR_COPY),
    ...strings(buildCalendarView(awkward(), [PLANNED])),
    ...strings(buildCalendarView(data(), [])),
    weekLabel(weekOf("2026-12-30")),
  ];

  test("has something to walk", () => {
    expect(everything.length).toBeGreaterThan(40);
  });

  // Built from code points on purpose, so this file stays pure ASCII: a repo
  // wide grep for U+2014 should find the copy that broke the rule, not the test
  // that guards it.
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

  test("says the same words the pane is built from", () => {
    expect(CALENDAR_COPY.heading).toBe("Calendar");
    expect(CALENDAR_COPY.notCovered).toBe("Not in this copy");
    expect(CALENDAR_COPY.nothing).toBe("Nothing on the calendar");
    expect(CALENDAR_COPY.readOnly).toBe(
      "Read only for now. Change events in Google Calendar.",
    );
  });
});

describe("it is pure", () => {
  test("two calls on the same data are deeply equal", () => {
    expect(buildCalendarView(awkward(), [PLANNED])).toEqual(
      buildCalendarView(awkward(), [PLANNED]),
    );
  });

  test("it changes nothing it was given", () => {
    const given = awkward();
    const copy = JSON.parse(JSON.stringify(given)) as CalendarScreenData;
    buildCalendarView(given, [PLANNED]);
    expect(given).toEqual(copy);
  });
});
