// One invented week of calendar, beside the invented day.
//
// EVERYTHING HERE IS FICTIONAL, like the sample day it belongs to. No title,
// place, name or time describes anybody, the zone is not the owner's, and every
// instant is derived from the sample day's own fixed clock rather than from
// `now`, so the page renders identically every time.
//
// THE DAY'S EVENTS ARE NOT COPIED, THEY ARE CONVERTED. The three timed things on
// the sample day and its all day notice come straight out of `sampleFixed()`, so
// the seminar is at the same hour on the left of the screen as on the right. A
// second hand-written list of them is exactly how the two would come to
// disagree, and nothing on the screen would say which was right.
//
// The week is shaped to exercise the pane: something on six of its seven days
// and nothing at all on the seventh, a pair that overlaps so the columns are
// used, an all day event over three days, one occurrence of something that
// repeats, a calendar the account may only read, and a second week of data after
// this one so Next does something and Previous is correctly dead.
//
// WHY THIS IMPORTS THE DAY IT IS ALSO IMPORTED BY. `sampleDay()` hands the
// screen this week, and this week is built from the day's own fixed events and
// rules. That is a cycle, and it is safe only because NOTHING IN THIS FILE RUNS
// AT IMPORT TIME: every value below is built inside a function, so neither
// module can reach into the other while one is still being evaluated. Do not
// hoist any of these lists to the top level.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { weekOf } from "@/app/lib/v2/calendar/grid";
import type { CalEvent } from "@/app/lib/v2/calendar/types";
import {
  SAMPLE_DATE,
  SAMPLE_NOW,
  sampleFixed,
  sampleInstant,
  sampleRules,
} from "@/app/lib/v2/fixtures/sample-day";
import { instantMs, shiftDateKey } from "@/app/lib/v2/plan/day";
import type { FixedEvent } from "@/app/lib/v2/types";
import { calendarScreenData } from "@/app/lib/v2/view/calendar";
import type { CalendarScreenData, ScreenCalendar } from "@/app/lib/v2/view/screen-data";

/**
 * The three calendars. The ids are the ones the sample day's fixed events carry
 * (`sampleFixed`), and a test pins that they are: a renamed id there would
 * otherwise leave the day's events on a calendar this week cannot name.
 */
const CAMPUS = "campus-sample";
const SHIFT = "shift-sample";
/** Somebody else's calendar, shared. The account may read it and nothing more. */
const TERM = "term-sample";

/** How many days past the shown week's Monday this sample has data for. */
const COVERED_DAYS = 13;

function calendars(): ScreenCalendar[] {
  return [
    { id: CAMPUS, label: "Campus", color: "#7C9BFF", writable: true },
    { id: SHIFT, label: "Print shop", color: "#2FD6A3", writable: true },
    { id: TERM, label: "Term dates", color: "#C58BFF", writable: false },
  ];
}

function event(
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
    editable: calendarId !== TERM,
    recurring: false,
    ...extra,
  };
}

/** A fixed thing that came off a calendar, rather than a task's own slot. */
type OnCalendar = FixedEvent & { calendarId: string };

/**
 * One of the day's fixed things as the calendar window holds it.
 *
 * An all day event carries DATE KEYS here, and its end is exclusive, exactly as
 * Google gives them; the planner's own shape carries instants for the same
 * thing, so the two ends are the one midnight read two ways.
 */
function fromFixed(fixed: OnCalendar, timeZone: string, writable: boolean): CalEvent {
  const asDay = (instant: string) => zonedDateKey(instantMs(instant), timeZone);
  return {
    id: fixed.id,
    calendarId: fixed.calendarId,
    title: fixed.title,
    allDay: fixed.allDay,
    start: fixed.allDay ? asDay(fixed.start) : fixed.start,
    end: fixed.allDay ? asDay(fixed.end) : fixed.end,
    location: fixed.location,
    etag: null,
    editable: writable,
    // Nothing on the sample day is one occurrence of a series. The week has one
    // of its own, below, so the pane's repeating mark has something to sit on.
    recurring: false,
  };
}

function events(timeZone: string): CalEvent[] {
  const week = weekOf(SAMPLE_DATE);
  const [monday, tuesday, , thursday, friday, , sunday] = week;
  const next = weekOf(shiftDateKey(monday, 7));
  const at = (clock: string, date: string) => sampleInstant(clock, date);
  const writable = new Map(calendars().map((calendar) => [calendar.id, calendar.writable]));

  return [
    // The sample day itself, converted rather than written out again. A fixed
    // thing with no calendar at all is a task's own time block, which belongs to
    // the day and not to anybody's calendar, so it is not one of these.
    ...sampleFixed()
      .filter((fixed): fixed is OnCalendar => fixed.calendarId !== null)
      .map((fixed) => fromFixed(fixed, timeZone, writable.get(fixed.calendarId) ?? false)),

    event("sw-induction", CAMPUS, at("11:00", monday), at("12:00", monday), {
      title: "Studio induction",
      location: "Studio 4",
    }),
    // The same shift every week, one occurrence of it.
    event("sw-shift-tue", SHIFT, at("18:30", tuesday), at("21:00", tuesday), {
      title: "Print shop shift",
      location: "Front counter",
      recurring: true,
    }),
    // A pair that overlaps by half an hour, so two chips share a column.
    event("sw-loading", CAMPUS, at("14:00", thursday), at("15:30", thursday), {
      title: "Kiln loading",
      location: "Studio 4",
    }),
    event("sw-glaze", CAMPUS, at("15:00", thursday), at("16:00", thursday), {
      title: "Glaze delivery",
    }),
    event("sw-reading", CAMPUS, at("16:00", friday), at("17:30", friday), {
      title: "Reading group",
      location: "Hall B",
    }),
    // Thursday to Saturday: Google's all day end is the day after the last.
    event("sw-maintenance", TERM, thursday, sunday, {
      title: "Kiln maintenance",
      allDay: true,
    }),

    // The week after, so Next has something behind it.
    event("sw-shift-next", SHIFT, at("09:00", next[0]), at("13:00", next[0]), {
      title: "Print shop shift",
      location: "Front counter",
      recurring: true,
    }),
    event("sw-clean", CAMPUS, at("10:00", next[1]), at("11:30", next[1]), {
      title: "Studio clean up",
      location: "Studio 4",
    }),
    event("sw-break", TERM, next[0], next[3], {
      title: "Workshop closed",
      allDay: true,
    }),
  ];
}

/**
 * The sample's calendar for the week that holds `weekParam`, or the sample day's
 * own week.
 *
 * Two weeks of data: the one the sample day falls in and the one after it, so
 * Next does something, Previous is correctly dead, and both of those states are
 * on the screen to look at.
 */
export function sampleWeek(weekParam: string | null): CalendarScreenData {
  const rules = sampleRules();
  const monday = weekOf(SAMPLE_DATE)[0];
  return calendarScreenData({
    timeZone: rules.timeZone,
    now: SAMPLE_NOW,
    rules,
    events: events(rules.timeZone),
    calendars: calendars(),
    range: { from: monday, to: shiftDateKey(monday, COVERED_DAYS) },
    wanted: SAMPLE_DATE,
    weekParam,
  });
}
