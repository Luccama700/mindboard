// The shape of the calendar window: which seven days a week holds, where a
// timed event sits inside one day, and how the all day spans stack above it.
//
// TIME RULES THIS FILE OBEYS, because every one of them has a silent failure
// behind it:
//   - A minute on the grid is a WALL CLOCK minute, read with
//     `zonedClockMinutes`, never elapsed time since midnight. On a daylight
//     saving day the two differ, and only the wall clock puts 09:00 nine hours
//     down a grid that is drawn as 24 equal rows. It is also what makes a
//     placed minute round-trip: `minutesToMs(date, startMinute, zone)` is the
//     instant the chip was drawn from.
//   - Which day an event belongs to, and whether it continues past this one,
//     is decided by comparing its INSTANTS with the day's two midnights, never
//     by its wall clock: an event ending at exactly midnight reads as minute 0,
//     and judging by that would draw it again at the top of the next day.
//   - A date key is a local calendar date, so its neighbours and the distance
//     between two of them are plain arithmetic on their own fields. No zone is
//     involved and no instant is built (app/lib/v2/plan/day.ts says the same).

import { zonedClockMinutes, zonedDateKey, zonedIso } from "@/app/lib/snapshots/zoned-time";
import {
  MINUTE_MS,
  compareText,
  dayDiff,
  maybeInstantMs,
  minutesToMs,
  shiftDateKey,
  weekdayOf,
} from "@/app/lib/v2/plan/day";
import { MINUTES_PER_DAY, MIN_EVENT_MINUTES } from "@/app/lib/v2/calendar/types";
import type { AllDayPlaced, CalEvent, DayLayout, TimedPlaced } from "@/app/lib/v2/calendar/types";
import type { CalendarRange } from "@/app/lib/v2/calendar/port";
import type { DateKey } from "@/app/lib/v2/types";

const DAYS_PER_WEEK = 7;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const SECOND_MS = 1_000;

/**
 * The instant of a minute of a day, resolved FORWARD when that wall time does
 * not exist, and floored to a whole second.
 *
 * This is the one time helper this folder adds, and it exists because
 * `zonedWallTimeToUtcMs` resolves a daylight saving gap in whichever direction
 * the offsets happen to fall, which west of UTC is backwards. In New York on
 * 2026-03-08 the raw answer for 02:30 is the instant of 01:30, so minute 150
 * came out an hour ABOVE minute 90: a drop landed above where it was dropped,
 * and a drag from 01:45 to 02:15 produced an event that ended before it began.
 * In Havana on 2019-03-10 the raw answer for midnight is 23:00 the day before,
 * so a day began on the previous date and an event at 23:30 on the 9th was
 * drawn on the 10th and on no other day.
 *
 * The answer is shifted on by the size of the gap, which is the difference
 * between the minute asked for and the minute that came back: 02:30 becomes
 * 03:30 rather than the first instant that exists (03:00), so the minutes
 * inside a gap stay in order and keep their spacing. A wall time that exists
 * is returned unchanged, including each of the two instants of a repeated hour.
 */
export function minuteInstant(date: DateKey, minute: number, timeZone: string): number {
  const ms = minutesToMs(date, minute, timeZone);
  const landedKey = zonedDateKey(ms, timeZone);
  const landed =
    dayDiff(date, landedKey) * MINUTES_PER_DAY + zonedClockMinutes(ms, timeZone);
  const forward = minute - landed;
  const resolved = forward > 0 ? ms + forward * MINUTE_MS : ms;
  return Math.floor(resolved / SECOND_MS) * SECOND_MS;
}

/** The first instant of a local day. Not always its midnight: see above. */
function dayStartOf(date: DateKey, timeZone: string): number {
  return minuteInstant(date, 0, timeZone);
}

/**
 * The seven date keys of the week `date` falls in. `weekStartsOn` is a weekday
 * index with 0 = Sunday, so the default of 1 is a Monday start.
 */
export function weekOf(date: DateKey, weekStartsOn = 1): DateKey[] {
  const offset = (((weekdayOf(date) - weekStartsOn) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  const first = shiftDateKey(date, -offset);
  const out: DateKey[] = [];
  for (let index = 0; index < DAYS_PER_WEEK; index += 1) out.push(shiftDateKey(first, index));
  return out;
}

/**
 * The instants a week covers: its first day's local midnight to the local
 * midnight after its last day. This is what the port is asked to list, so a
 * week read in the user's zone is a week on the user's grid.
 */
export function weekRange(week: readonly DateKey[], timeZone: string): CalendarRange {
  const first = week[0];
  const last = week[week.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("a week with no days has no range");
  }
  return {
    timeMin: zonedIso(dayStartOf(first, timeZone), timeZone),
    timeMax: zonedIso(dayStartOf(shiftDateKey(last, 1), timeZone), timeZone),
  };
}

interface Laid {
  event: CalEvent;
  startMinute: number;
  endMinute: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * The timed events on one local day, clipped to it and packed into columns.
 *
 * Overlap is judged on the LAID OUT interval, after the fifteen minute floor,
 * because the floor is what the user sees: two events five minutes apart are
 * drawn fifteen minutes tall and do collide, and clustering on the real
 * instants would draw them on top of each other.
 *
 * The floor is the one thing allowed to push `endMinute` past the end of the
 * day: an event at 23:55 keeps its true start, which is what a grid needs, and
 * a renderer clips the overflow. Pulling the start back instead would draw the
 * event at a time it does not happen.
 */
export function layoutDay(
  events: readonly CalEvent[],
  date: DateKey,
  timeZone: string,
): DayLayout {
  const dayStartMs = dayStartOf(date, timeZone);
  const dayEndMs = dayStartOf(shiftDateKey(date, 1), timeZone);

  const laid: Laid[] = [];
  for (const event of events) {
    if (event.allDay) continue;
    const startMs = maybeInstantMs(event.start);
    const endMs = maybeInstantMs(event.end);
    if (startMs === null || endMs === null) continue;
    // An inverted pair is read as a point in time rather than dropped: it is
    // the floor's job to give it a height.
    const closeMs = Math.max(endMs, startMs);
    const continuesBefore = startMs < dayStartMs;
    if (startMs >= dayEndMs) continue;
    if (continuesBefore && closeMs <= dayStartMs) continue;

    const startMinute = continuesBefore ? 0 : zonedClockMinutes(startMs, timeZone);
    const wallEnd = closeMs >= dayEndMs ? MINUTES_PER_DAY : zonedClockMinutes(closeMs, timeZone);
    // An event that spans a repeated hour ends at a wall clock at or before the
    // one it started at (01:45 can follow 01:30 by an hour and a quarter in New
    // York on the morning the clock goes back), and drawn by the wall clock it
    // would have no height at all. Its elapsed time is drawn instead, which is
    // the only honest answer on a grid of 24 equal rows.
    const visible = Math.min(closeMs, dayEndMs) - Math.max(startMs, dayStartMs);
    const endMinute =
      wallEnd <= startMinute ? startMinute + Math.round(visible / MINUTE_MS) : wallEnd;
    laid.push({
      event,
      startMinute,
      endMinute: Math.max(endMinute, startMinute + MIN_EVENT_MINUTES),
      continuesBefore,
      continuesAfter: closeMs > dayEndMs,
    });
  }

  laid.sort(
    (a, b) =>
      a.startMinute - b.startMinute ||
      b.endMinute - b.startMinute - (a.endMinute - a.startMinute) ||
      compareText(a.event.id, b.event.id),
  );

  const timed: TimedPlaced[] = [];
  let cluster: TimedPlaced[] = [];
  // The end of each column in the cluster being built, so a column can be
  // reused by the next event that starts at or after it.
  let columns: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const closeCluster = () => {
    for (const item of cluster) item.columnCount = columns.length;
    timed.push(...cluster);
    cluster = [];
    columns = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const item of laid) {
    if (item.startMinute >= clusterEnd) closeCluster();
    let column = columns.findIndex((end) => end <= item.startMinute);
    if (column === -1) {
      column = columns.length;
      columns.push(item.endMinute);
    } else {
      columns[column] = item.endMinute;
    }
    cluster.push({ ...item, column, columnCount: 1 });
    clusterEnd = Math.max(clusterEnd, item.endMinute);
  }
  closeCluster();

  return { timed };
}

interface Span {
  event: CalEvent;
  firstIndex: number;
  lastIndex: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * The all day events of a week, as spans across its day indexes.
 *
 * Google's all day end is EXCLUSIVE, so the last day covered is the day before
 * it. An event whose end equals its start still covers its one day, and that
 * is NOT only a fixture's doing: the real read falls back to the start when
 * Google sends no end at all (utils/google/calendar.ts:117).
 *
 * Two spans collide when they share a day INDEX, unlike the timed grid where
 * touching at the edge does not count: a day is a cell, and two spans in the
 * same cell cannot both be drawn on one row.
 */
export function layoutAllDay(events: readonly CalEvent[], week: readonly DateKey[]): AllDayPlaced[] {
  const first = week[0];
  const lastOfWeek = week.length - 1;
  if (first === undefined) return [];

  const spans: Span[] = [];
  for (const event of events) {
    if (!event.allDay) continue;
    if (!DATE_KEY.test(event.start)) continue;
    const rawFirst = dayDiff(first, event.start);
    const rawEnd = DATE_KEY.test(event.end) ? dayDiff(first, event.end) : rawFirst + 1;
    const rawLast = Math.max(rawFirst, rawEnd - 1);
    if (rawLast < 0 || rawFirst > lastOfWeek) continue;
    spans.push({
      event,
      firstIndex: Math.max(0, rawFirst),
      lastIndex: Math.min(lastOfWeek, rawLast),
      continuesBefore: rawFirst < 0,
      continuesAfter: rawLast > lastOfWeek,
    });
  }

  spans.sort(
    (a, b) =>
      a.firstIndex - b.firstIndex ||
      b.lastIndex - b.firstIndex - (a.lastIndex - a.firstIndex) ||
      compareText(a.event.id, b.event.id),
  );

  const rowEnds: number[] = [];
  return spans.map((span) => {
    let row = rowEnds.findIndex((end) => end < span.firstIndex);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(span.lastIndex);
    } else {
      rowEnds[row] = span.lastIndex;
    }
    return { ...span, row };
  });
}
