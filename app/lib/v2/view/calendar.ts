// The calendar as data: one week of events in, positioned chips out.
//
// TWO RULES THIS FILE EXISTS TO HOLD, the same two as today.ts:
//
//  1. The pane branches on nothing and measures nothing. Every fraction, every
//     column and every word it draws is decided here, where it can be tested
//     without a browser.
//  2. Every static string the calendar prints lives in CALENDAR_COPY, which is
//     what makes the copy rules (no em dash, no en dash) walkable by a test.
//
// IT PLACES NOTHING ITSELF. Which day a thing belongs to, how tall it is and
// which column it takes when things overlap all come from `layoutDay` and
// `layoutAllDay` in the calendar engine, which already hold the hard rules: a
// minute on the grid is a WALL CLOCK minute (so 09:00 is nine hours down a
// daylight saving day as well), membership of a day is decided on instants
// against the day's two midnights (so an event ending at exactly midnight is not
// drawn again at the top of the next morning), and the fifteen minute floor is
// applied before overlap is judged. This file maps their minutes onto the window
// the screen is drawing and adds the words. Nothing below recomputes any of it.
//
// THE WINDOW IS WIDENED, NEVER NARROWED. The rules say which hours a day
// normally spans, and that is where the grid starts; then every chip of the week
// is let into it. An event at 23:55 is fifteen minutes tall by the floor above,
// so it ends at 00:10 the next morning and the window runs to minute 1500: a
// grid of 25 rows, the last of them labelled 24:00. That is on purpose. A window
// that stopped at midnight would have to draw that chip three minutes tall or
// outside itself, and both are worse than one odd looking row.
//
// A DAY THAT IS NOT COVERED IS NOT AN EMPTY DAY. The source says which days its
// calendar can speak for, and a day outside that gets no chips, is flagged, and
// is left out of the count that decides whether the week reads as empty. The
// pane then says so in words. This is the single most important thing in the
// file: a missing day that looked free would be read as "nothing on", and
// something would be planned over the top of it.

import { zonedClockMinutes, zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { layoutAllDay, layoutDay, weekOf } from "@/app/lib/v2/calendar/grid";
import {
  MINUTES_PER_DAY,
  MIN_EVENT_MINUTES,
  type AllDayPlaced,
  type CalEvent,
  type TimedPlaced,
} from "@/app/lib/v2/calendar/types";
import { dayDiff, dayWindow, maybeInstantMs, shiftDateKey } from "@/app/lib/v2/plan/day";
import type { DateKey, Instant, PlannerRules } from "@/app/lib/v2/types";
import { clockLabel, dayLabel, timeRangeLabel, weekLabel } from "@/app/lib/v2/view/format";
import type {
  CalendarScreenData,
  ScreenCalendar,
} from "@/app/lib/v2/view/screen-data";

/** One block the planner put on today, as the calendar draws it. */
export interface PlannedBlock {
  id: string;
  title: string;
  start: Instant;
  end: Instant;
}

export interface CalendarChip {
  id: string;
  kind: "event" | "planned";
  title: string;
  /** "13:00 to 14:00". */
  time: string;
  calendar: string | null; // the calendar's label; null for a planned block
  color: string | null; // the calendar's colour; null takes the accent
  location: string | null;
  /** Fractions of the visible window: 0 is its top, 1 its bottom. */
  top: number;
  height: number;
  column: number;
  columnCount: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  recurring: boolean;
}

export interface CalendarDayView {
  date: DateKey;
  /** "Tuesday 10 November", the label of the day's list. */
  label: string;
  weekday: string; // "Tue"
  dayNumber: string; // "10"
  isToday: boolean;
  covered: boolean;
  /** Today and the two days after it (or the first three days when today is not in the week). */
  near: boolean;
  chips: CalendarChip[]; // timed, in start order
  allDay: string[]; // titles of the all day events on this day, for the agenda
}

export interface CalendarAllDaySpan {
  id: string;
  title: string;
  color: string | null;
  firstIndex: number;
  lastIndex: number;
  row: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface CalendarView {
  weekLabel: string;
  days: CalendarDayView[];
  allDay: CalendarAllDaySpan[];
  allDayRows: number;
  /** The visible window, whole hours. */
  fromMinute: number;
  toMinute: number;
  hours: Array<{ label: string; top: number }>; // one per hour line, "09:00"
  /** Where the now line sits in today's column, or null when it is not on screen. */
  nowTop: number | null;
  nowLabel: string;
  /** Only the calendars with something on this week, in the data's order. */
  legend: Array<{ id: string; label: string; color: string | null }>;
  /** Covered days exist and none of them has anything on it. */
  empty: boolean;
  prevWeek: DateKey | null;
  nextWeek: DateKey | null;
  thisWeek: DateKey | null;
}

/** Every static string the calendar prints. */
export const CALENDAR_COPY = {
  heading: "Calendar",
  planned: "Planned",
  /** A day this source has no calendar data for. Never "nothing on". */
  notCovered: "Not in this copy",
  nothing: "Nothing on the calendar",
  allDay: "All day",
  previous: "Previous week",
  next: "Next week",
  thisWeek: "This week",
  now: "Now",
  readOnly: "Read only for now. Change events in Google Calendar.",
} as const;

/**
 * What an event whose calendar nothing knows about is called.
 *
 * A snapshot folder need not list its calendars, and a list it does carry can
 * be short of one. The event is still real, so it keeps its place and its words
 * and loses only the name and the colour: dropping it would hide something that
 * is on the day, which is the one thing this screen must never do.
 */
const UNKNOWN_CALENDAR = "Calendar";

/** The marker on a planned block's stand-in event. It never reaches the view. */
const PLANNED_CALENDAR = "planned-block";

const MINUTES_PER_HOUR = 60;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** Today and the two days after it. */
const NEAR_DAYS = 3;

// ------------------------------------------------------------------ the week

/**
 * Is this a date key that names a day which exists?
 *
 * The shape is not enough: "2026-13-45" matches it and every piece of date
 * arithmetic downstream would carry it forward as 2027-02-14. The day has to
 * survive the round trip, which is what `shiftDateKey` by nothing does.
 *
 * `isRealDateKey` in app/lib/v2/local/files.ts answers the same question by the
 * same rule and is NOT imported here: that module opens the door to the file
 * system, and this one is reached from a browser bundle.
 */
function isRealDay(value: string): boolean {
  return DATE_KEY.test(value) && shiftDateKey(value, 0) === value;
}

/** The day an instant falls on in the zone, or null when it cannot be read. */
function dayOfInstant(instant: Instant, timeZone: string): DateKey | null {
  const ms = maybeInstantMs(instant);
  return ms === null ? null : zonedDateKey(ms, timeZone);
}

/**
 * The days an event is ON, from the first to the last, or null for a pair that
 * cannot be read.
 *
 * BOTH ENDS ARE EXCLUSIVE IN THE SAME WAY, and that is the whole point of this
 * function. Google's all day end is a date key the event does not reach, so the
 * last day covered is the day before it; a timed event's end is an instant it
 * does not reach either, so an event running to exactly midnight is on the day
 * it ran and NOT on the morning after. Taking the day the end instant falls on
 * put a Friday night shift on the Saturday: that day then went into a snapshot's
 * derived range, which made it covered with nothing on it, which draws as a free
 * Saturday the folder never said a word about. It is the same rule `layoutDay`
 * judges membership by, which is why the two now agree.
 *
 * An end at or before the start still covers its one day, which is not only a
 * fixture's doing: the live reader falls back to the start when Google sends no
 * end at all.
 */
export function eventDays(event: CalEvent, timeZone: string): [DateKey, DateKey] | null {
  if (event.allDay) {
    if (!DATE_KEY.test(event.start)) return null;
    const last =
      DATE_KEY.test(event.end) && dayDiff(event.start, event.end) > 0
        ? shiftDateKey(event.end, -1)
        : event.start;
    return [event.start, last];
  }
  const startMs = maybeInstantMs(event.start);
  if (startMs === null) return null;
  const endMs = maybeInstantMs(event.end) ?? startMs;
  return [
    zonedDateKey(startMs, timeZone),
    // The last moment the event holds, not the first it does not.
    zonedDateKey(Math.max(endMs - 1, startMs), timeZone),
  ];
}

/** Minutes from the start of `date` to an instant, by the wall clock. */
function dayMinutes(ms: number, date: DateKey, timeZone: string): number {
  return (
    dayDiff(date, zonedDateKey(ms, timeZone)) * MINUTES_PER_DAY +
    zonedClockMinutes(ms, timeZone)
  );
}

/**
 * The hours a day of this week normally spans: the earliest wake across its
 * seven days to the latest lights out, both read through the planner's own
 * `dayWindow` so the calendar and the day agree about when the day starts.
 *
 * Capped to one day. A lights out after midnight belongs to the next calendar
 * day (types.ts), which would otherwise ask for a window longer than the grid.
 */
function windowAcross(
  week: readonly DateKey[],
  rules: PlannerRules,
): { fromMinute: number; toMinute: number } {
  let from = MINUTES_PER_DAY;
  let to = 0;
  for (const date of week) {
    const window = dayWindow(date, rules);
    from = Math.min(from, dayMinutes(window.startMs, date, rules.timeZone));
    to = Math.max(to, dayMinutes(window.endMs, date, rules.timeZone));
  }
  const fromMinute = clampMinute(from);
  return { fromMinute, toMinute: Math.max(clampMinute(to), fromMinute) };
}

function clampMinute(minute: number): number {
  return Math.min(MINUTES_PER_DAY, Math.max(0, Math.round(minute)));
}

/** What one source hands over before the week has been chosen. */
export interface CalendarSourceData {
  timeZone: string;
  now: Instant;
  /** The planner's rules, for the hours a day spans. */
  rules: PlannerRules;
  /** Every event the source holds. Narrowed to the week here. */
  events: readonly CalEvent[];
  calendars: readonly ScreenCalendar[];
  /** The days the events can speak for, inclusive. null: none of them. */
  range: { from: DateKey; to: DateKey } | null;
  /** The day whose week is shown when `weekParam` does not pick another. */
  wanted: DateKey;
  /** The `week` search parameter, exactly as it arrived. */
  weekParam: string | null;
}

/**
 * One week of calendar, composed. Both sources go through this, so the rules
 * about which week is shown and which of its days are covered are written once.
 *
 * `weekParam` comes out of a URL, so a bad one is IGNORED rather than refused:
 * it has to be a day that exists, and the source has to cover at least one day
 * of the week it falls in. Anything else falls back to the week of `wanted`,
 * because a mistyped link must not cost the screen.
 */
export function calendarScreenData(source: CalendarSourceData): CalendarScreenData {
  const { range, timeZone } = source;
  const covers = (week: readonly DateKey[]) => week.some((date) => inRange(date, range));

  const asked =
    source.weekParam !== null && isRealDay(source.weekParam)
      ? weekOf(source.weekParam)
      : null;
  const week = asked !== null && covers(asked) ? asked : weekOf(nearestWanted(source));

  const mondayIfCovered = (monday: DateKey): DateKey | null =>
    covers(weekOf(monday)) ? monday : null;
  const today = dayOfInstant(source.now, timeZone);
  const thisMonday = today === null ? null : weekOf(today)[0];

  return {
    timeZone,
    now: source.now,
    week,
    covered: week.filter((date) => inRange(date, range)),
    calendars: withoutRepeats(source.calendars),
    events: source.events
      .filter((event) => overlaps(event, week, timeZone))
      .map((event) => ({ ...event })),
    dayWindow: windowAcross(week, source.rules),
    prevWeek: mondayIfCovered(shiftDateKey(week[0], -7)),
    nextWeek: mondayIfCovered(shiftDateKey(week[0], 7)),
    thisWeek:
      thisMonday === null || thisMonday === week[0] ? null : mondayIfCovered(thisMonday),
  };
}

function inRange(date: DateKey, range: { from: DateKey; to: DateKey } | null): boolean {
  if (range === null) return false;
  return dayDiff(range.from, date) >= 0 && dayDiff(date, range.to) >= 0;
}

/**
 * The day whose week is shown by default: the one asked for, pulled into the
 * days the source can speak for when it falls outside them.
 *
 * A LOCAL SNAPSHOT IS A COPY, AND COPIES GO STALE. The wanted day comes from the
 * clock, so a folder exported last month covers no part of this week: every
 * column read "Not in this copy", and the three week links were all null because
 * none of the neighbouring weeks is covered either, so the weeks the folder DOES
 * hold could not be reached from the screen at all. Opening on the nearest week
 * it has is the difference between a stale copy and a wall of nothing.
 *
 * Only for the DEFAULT week. An explicit week that the source does not cover
 * still falls back here rather than being honoured, which is behaviour 5 and now
 * lands on this same week.
 */
function nearestWanted(source: CalendarSourceData): DateKey {
  const { range, wanted } = source;
  if (range === null) return wanted;
  // A range that ends before it starts covers nothing, and there is no nearest
  // day inside it to move to. It says the same as no range at all, so it is
  // read that way: the week asked for, with every day of it unknown. Moving to
  // one of its two ends would show a week and then call all of it unknown.
  if (dayDiff(range.from, range.to) < 0) return wanted;
  if (dayDiff(range.from, wanted) < 0) return range.from;
  if (dayDiff(wanted, range.to) < 0) return range.to;
  return wanted;
}

/** One entry per id, the first winning. A folder can list a calendar twice. */
function withoutRepeats(calendars: readonly ScreenCalendar[]): ScreenCalendar[] {
  const seen = new Set<string>();
  const out: ScreenCalendar[] = [];
  for (const calendar of calendars) {
    if (seen.has(calendar.id)) continue;
    seen.add(calendar.id);
    out.push({ ...calendar });
  }
  return out;
}

function overlaps(event: CalEvent, week: readonly DateKey[], timeZone: string): boolean {
  const days = eventDays(event, timeZone);
  if (days === null) return false;
  return dayDiff(days[0], week[week.length - 1]) >= 0 && dayDiff(week[0], days[1]) >= 0;
}

// ------------------------------------------------------------------ the view

/** A planned block as the layout sees it: an event on nobody's calendar. */
function asEvent(block: PlannedBlock): CalEvent {
  return {
    id: block.id,
    calendarId: PLANNED_CALENDAR,
    title: block.title,
    allDay: false,
    start: block.start,
    end: block.end,
    location: null,
    etag: null,
    editable: false,
    recurring: false,
  };
}

export function buildCalendarView(
  data: CalendarScreenData,
  planned: readonly PlannedBlock[],
): CalendarView {
  const zone = data.timeZone;
  const covered = new Set(data.covered);
  // The FIRST entry for an id wins, here and in the legend. A folder can list
  // one calendar twice, and `new Map` of the pairs would keep the last, so a
  // chip and its legend row could end up with two different names for one
  // calendar depending on which of them read which.
  const byId = new Map<string, ScreenCalendar>();
  for (const calendar of data.calendars) {
    if (!byId.has(calendar.id)) byId.set(calendar.id, calendar);
  }

  // A planned block goes through the SAME layout as the events of its day, so a
  // block and an event that overlap sit side by side instead of on top of each
  // other. Which of the two a laid out thing is cannot be read off its id (a
  // block and an event may share one), so the stand-ins are recognised by
  // identity, which `layoutDay` preserves.
  const standIns = planned.map(asEvent);
  const isPlanned = new Set<CalEvent>(standIns);
  const timed = [...data.events.filter((event) => !event.allDay), ...standIns];

  // Laid out first, measured second: the window has to make room for every chip
  // before any of them can be turned into a fraction of it.
  const placed = new Map<DateKey, TimedPlaced[]>();
  for (const date of data.week) {
    placed.set(date, covered.has(date) ? layoutDay(timed, date, zone).timed : []);
  }

  let earliest = data.dayWindow.fromMinute;
  let latest = data.dayWindow.toMinute;
  for (const day of placed.values()) {
    for (const item of day) {
      earliest = Math.min(earliest, item.startMinute);
      latest = Math.max(latest, item.endMinute);
    }
  }
  const fromMinute = Math.floor(earliest / MINUTES_PER_HOUR) * MINUTES_PER_HOUR;
  const toMinute = Math.max(
    Math.ceil(latest / MINUTES_PER_HOUR) * MINUTES_PER_HOUR,
    fromMinute + MINUTES_PER_HOUR,
  );
  const span = toMinute - fromMinute;

  // An all day event on no covered day is left out before the rows are stacked,
  // not after: dropping a span afterwards would leave an empty row behind it.
  // What is left is then cut to the covered days it touches (`clipToCovered`).
  const spans = clipToCovered(
    layoutAllDay(
      data.events.filter(
        (event) => event.allDay && touchesCovered(event, data.week, covered, zone),
      ),
      data.week,
    ),
    data.week,
    covered,
  );

  const today = dayOfInstant(data.now, zone);
  const todayIndex = today === null ? -1 : data.week.indexOf(today);
  const nearFrom = todayIndex === -1 ? 0 : todayIndex;

  const titlesByIndex = allDayTitles(spans, data.week.length);
  const days: CalendarDayView[] = data.week.map((date, index) => ({
    date,
    ...dayNames(date),
    isToday: date === today,
    covered: covered.has(date),
    near: index >= nearFrom && index < nearFrom + NEAR_DAYS,
    chips: (placed.get(date) ?? []).map((item) =>
      chipOf(item, isPlanned.has(item.event), byId, { fromMinute, span }, zone),
    ),
    // No guard for an uncovered day: the spans were cut to the covered days
    // above, so a title can only reach a day the source speaks for.
    allDay: titlesByIndex[index],
  }));

  return {
    weekLabel: weekLabel(data.week),
    days,
    allDay: spans.map((item) => ({
      id: item.id,
      title: item.event.title,
      color: byId.get(item.event.calendarId)?.color ?? null,
      firstIndex: item.firstIndex,
      lastIndex: item.lastIndex,
      row: item.row,
      continuesBefore: item.continuesBefore,
      continuesAfter: item.continuesAfter,
    })),
    allDayRows: spans.reduce((rows, span) => Math.max(rows, span.row + 1), 0),
    fromMinute,
    toMinute,
    hours: hourLines(fromMinute, toMinute),
    nowTop:
      today !== null && covered.has(today)
        ? nowTopOf(data.now, today, todayIndex, { fromMinute, span }, zone)
        : null,
    nowLabel: maybeInstantMs(data.now) === null ? "" : clockLabel(data.now, zone),
    legend: legendOf(drawnCalendarIds(data.week, placed, isPlanned, spans), data.calendars),
    // A day the source cannot speak for says so itself and is not counted here:
    // "nothing on this week" has to mean the week, not the part of it that
    // happens to be in the folder.
    //
    // It is a statement about the CALENDAR, so the blocks the app planned for
    // itself are not counted either: they are on the screen in their own right,
    // and a day holding one and no event still has nothing on its calendar.
    empty:
      covered.size > 0 &&
      spans.length === 0 &&
      days.every((day) => day.chips.every((chip) => chip.kind === "planned")),
    prevWeek: data.prevWeek,
    nextWeek: data.nextWeek,
    thisWeek: data.thisWeek,
  };
}

/** A placed all day span after it has been cut to the days the source covers. */
interface ClippedSpan extends AllDayPlaced {
  /**
   * The event's own id, or that id and the day the piece starts on when one
   * event was cut into several. The pane draws these as rows of one list and
   * needs a key per row; a cut event would otherwise give two rows one id.
   */
  id: string;
}

/**
 * Each span cut to the covered days it touches.
 *
 * A span drawn across a column that reads "Not in this copy" claims the event
 * covers a day the source has no answer for. So the run is cut: where an
 * uncovered day interrupts it the span becomes two, each flagged as continuing
 * on the side it was cut, which is the same flag the pane already draws for a
 * span that runs past the edge of the week.
 *
 * The rows are kept as `layoutAllDay` assigned them. Two pieces of one span
 * cannot collide (there is an uncovered day between them), and no row is left
 * empty, because an event that touches no covered day at all was dropped before
 * the rows were stacked.
 */
function clipToCovered(
  spans: readonly AllDayPlaced[],
  week: readonly DateKey[],
  covered: Set<DateKey>,
): ClippedSpan[] {
  const out: ClippedSpan[] = [];
  for (const span of spans) {
    const pieces: Array<{ firstIndex: number; lastIndex: number }> = [];
    let open: { firstIndex: number; lastIndex: number } | null = null;
    for (let index = span.firstIndex; index <= span.lastIndex; index += 1) {
      const date = week[index];
      if (date !== undefined && covered.has(date)) {
        if (open === null) open = { firstIndex: index, lastIndex: index };
        else open.lastIndex = index;
      } else if (open !== null) {
        pieces.push(open);
        open = null;
      }
    }
    if (open !== null) pieces.push(open);

    for (const piece of pieces) {
      out.push({
        ...span,
        ...piece,
        id: pieces.length === 1 ? span.event.id : `${span.event.id}#${piece.firstIndex}`,
        continuesBefore: span.continuesBefore || piece.firstIndex > span.firstIndex,
        continuesAfter: span.continuesAfter || piece.lastIndex < span.lastIndex,
      });
    }
  }
  return out;
}

/**
 * Does this all day event cover a day the source can speak for?
 *
 * Judged on the days INSIDE the week, because a term long event covers plenty of
 * days this week is not showing.
 */
function touchesCovered(
  event: CalEvent,
  week: readonly DateKey[],
  covered: Set<DateKey>,
  timeZone: string,
): boolean {
  const days = eventDays(event, timeZone);
  if (days === null) return false;
  return week.some(
    (date) =>
      covered.has(date) && dayDiff(days[0], date) >= 0 && dayDiff(date, days[1]) >= 0,
  );
}

/**
 * "Tuesday 10 November", "Tue" and "10", all three taken off the one label.
 *
 * Read out of `dayLabel` rather than written again, because the weekday and
 * month names live in format.ts for a reason: no Intl long format anywhere on
 * these screens, since Node and the browser punctuate them differently and
 * these screens render in both. Two copies of the list is how one of them ends
 * up wrong.
 */
function dayNames(date: DateKey): { label: string; weekday: string; dayNumber: string } {
  const label = dayLabel(date);
  const [weekday, dayNumber] = label.split(" ");
  return { label, weekday: weekday.slice(0, 3), dayNumber };
}

/** The all day titles of each day index, in the order the rows stack. */
function allDayTitles(spans: readonly AllDayPlaced[], days: number): string[][] {
  const titles: string[][] = Array.from({ length: days }, () => []);
  for (const span of spans) {
    for (let index = span.firstIndex; index <= span.lastIndex; index += 1) {
      titles[index]?.push(span.event.title);
    }
  }
  return titles;
}

function chipOf(
  item: TimedPlaced,
  planned: boolean,
  byId: Map<string, ScreenCalendar>,
  window: { fromMinute: number; span: number },
  timeZone: string,
): CalendarChip {
  const { event } = item;
  const calendar = planned ? undefined : byId.get(event.calendarId);
  const top = Math.min(1, Math.max(0, (item.startMinute - window.fromMinute) / window.span));
  const minutes = Math.max(item.endMinute - item.startMinute, MIN_EVENT_MINUTES);
  return {
    id: event.id,
    kind: planned ? "planned" : "event",
    title: event.title,
    // The event's own times, not the minutes it was clipped to: what a chip says
    // is when the thing happens, even where the grid had to cut it off.
    time: timeRangeLabel(event.start, event.end, timeZone),
    calendar: planned ? null : (calendar?.label ?? UNKNOWN_CALENDAR),
    color: planned ? null : (calendar?.color ?? null),
    location: event.location,
    top,
    height: Math.min(minutes / window.span, 1 - top),
    column: item.column,
    columnCount: item.columnCount,
    continuesBefore: item.continuesBefore,
    continuesAfter: item.continuesAfter,
    recurring: event.recurring,
  };
}

/**
 * One line per hour of the window, the last of them at the hour the window's
 * final row BEGINS: a line at the very bottom edge would be the frame.
 *
 * The hours are counted from the top of the day rather than wrapped, so a window
 * widened past midnight ends "23:00", "24:00" rather than printing 00:00 twice.
 */
function hourLines(
  fromMinute: number,
  toMinute: number,
): Array<{ label: string; top: number }> {
  const lines: Array<{ label: string; top: number }> = [];
  const span = toMinute - fromMinute;
  for (let minute = fromMinute; minute < toMinute; minute += MINUTES_PER_HOUR) {
    const hour = Math.floor(minute / MINUTES_PER_HOUR);
    lines.push({
      label: `${String(hour).padStart(2, "0")}:00`,
      top: (minute - fromMinute) / span,
    });
  }
  return lines;
}

/** Where now sits, or null when it is not on this screen at all. */
function nowTopOf(
  now: Instant,
  today: DateKey | null,
  todayIndex: number,
  window: { fromMinute: number; span: number },
  timeZone: string,
): number | null {
  const ms = maybeInstantMs(now);
  if (ms === null || today === null || todayIndex === -1) return null;
  const minute = zonedClockMinutes(ms, timeZone);
  if (minute < window.fromMinute || minute > window.fromMinute + window.span) return null;
  return (minute - window.fromMinute) / window.span;
}

/**
 * The calendars of everything actually DRAWN on this week, in the order their
 * first event appears.
 *
 * Taken from what was laid out rather than from `data.events`, so a calendar
 * whose only event this week falls on a day the source cannot speak for is not
 * listed as being on the week. A planned block belongs to no calendar, so its
 * stand-in's marker never gets this far.
 */
function drawnCalendarIds(
  week: readonly DateKey[],
  placed: Map<DateKey, TimedPlaced[]>,
  isPlanned: Set<CalEvent>,
  spans: readonly AllDayPlaced[],
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const note = (calendarId: string) => {
    if (seen.has(calendarId)) return;
    seen.add(calendarId);
    order.push(calendarId);
  };

  for (const date of week) {
    for (const item of placed.get(date) ?? []) {
      if (!isPlanned.has(item.event)) note(item.event.calendarId);
    }
  }
  for (const span of spans) note(span.event.calendarId);
  return order;
}

/**
 * The legend: the known calendars in the DATA's order, then the ones the data
 * does not know in the order they first appear, each named plainly and with no
 * colour. An event on a calendar nothing knows keeps its place either way.
 */
function legendOf(
  drawn: readonly string[],
  calendars: readonly ScreenCalendar[],
): CalendarView["legend"] {
  const known = new Set(calendars.map((calendar) => calendar.id));
  const listed = new Set<string>();
  return [
    ...calendars
      .filter((calendar) => {
        // One row per calendar, by its first entry: a folder can list one twice.
        if (!drawn.includes(calendar.id) || listed.has(calendar.id)) return false;
        listed.add(calendar.id);
        return true;
      })
      .map(({ id, label, color }) => ({ id, label, color })),
    ...drawn
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: UNKNOWN_CALENDAR, color: null })),
  ];
}
