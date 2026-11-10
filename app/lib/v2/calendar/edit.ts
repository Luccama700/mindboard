// Editing an event by hand: the four things a pointer on the grid can do.
//
// All four are pure and return a NEW event, or the one they were given when
// there is nothing to do. They do not talk to the port, so a caller can draw
// the result while the drag is still happening and only commit on release.
//
// TIME RULES THIS FILE OBEYS:
//   - A dropped minute becomes an instant through `minutesToMs`, which goes
//     through the zone helpers. Minutes are clamped to 0..1440 first, because
//     `minutesToMs` divides and takes a remainder and neither is right for a
//     negative number.
//   - A move keeps the ELAPSED time, not the wall clock span. Over a daylight
//     saving change those differ, and elapsed is what an event is: an hour long
//     thing stays an hour long, so its wall clock end may move.
//   - Every instant is floored to a whole second before it is formatted, as the
//     rest of the engine does, so it can round-trip through an ISO string.

import { zonedClockMinutes, zonedDateKey, zonedIso } from "@/app/lib/snapshots/zoned-time";
import { MINUTE_MS, maybeInstantMs, shiftDateKey } from "@/app/lib/v2/plan/day";
import { minuteInstant } from "@/app/lib/v2/calendar/grid";
import {
  MINUTES_PER_DAY,
  MIN_EVENT_MINUTES,
  SNAP_STEP_MINUTES,
} from "@/app/lib/v2/calendar/types";
import type { CalEvent } from "@/app/lib/v2/calendar/types";
import type { DateKey } from "@/app/lib/v2/types";

const SECOND_MS = 1_000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A new event's id until the calendar gives it one. Deterministic from the drag
 * itself, because this module has no clock and no id source: two drags of the
 * same slot are the same draft, which is what an optimistic list wants.
 */
export const DRAFT_ID_PREFIX = "draft:";

/** Has this event never reached the calendar? */
export function isDraftId(id: string): boolean {
  return id.startsWith(DRAFT_ID_PREFIX);
}

function floorSecond(ms: number): number {
  return Math.floor(ms / SECOND_MS) * SECOND_MS;
}

function clampMinute(minute: number): number {
  if (!Number.isFinite(minute)) return 0;
  return Math.min(MINUTES_PER_DAY, Math.max(0, Math.round(minute)));
}

/**
 * The latest minute a new or moved event may START at, so that it still has
 * room for its floor inside the day it was dropped on. Without it, a drag in
 * the last few minutes of a day snapped up to 1440 and the event appeared at
 * midnight the NEXT day, which is not the day the user was looking at.
 */
const LAST_START_MINUTE = MINUTES_PER_DAY - MIN_EVENT_MINUTES;

/** Is this drop the event's own current position, to the minute? */
function isOwnPosition(
  ms: number,
  date: DateKey,
  minute: number,
  timeZone: string,
): boolean {
  return zonedDateKey(ms, timeZone) === date && zonedClockMinutes(ms, timeZone) === minute;
}

/** A pointer minute rounded to the grid and kept inside the day. */
export function snapMinute(minute: number, step: number = SNAP_STEP_MINUTES): number {
  if (!Number.isFinite(minute)) return 0;
  const size = Number.isFinite(step) && step > 0 ? step : 1;
  return clampMinute(Math.round(minute / size) * size);
}

/** The two ends of a timed event as whole seconds, or null when unreadable. */
function endsOf(event: CalEvent): { fromMs: number; toMs: number } | null {
  const startMs = maybeInstantMs(event.start);
  const endMs = maybeInstantMs(event.end);
  if (startMs === null || endMs === null) return null;
  const fromMs = floorSecond(startMs);
  return { fromMs, toMs: Math.max(fromMs, floorSecond(endMs)) };
}

/**
 * The same event, starting at that minute of that day. Its length is kept, so
 * a move over a daylight saving change keeps the elapsed time and may land on
 * a different wall clock end than the one it left.
 *
 * A drop on the event's own position returns it untouched. That is not just an
 * optimisation: on the morning a clock goes back, the second 01:30 is drawn at
 * minute 90 like the first, and resolving minute 90 again would quietly move
 * the event an hour earlier.
 */
export function moveTimed(
  event: CalEvent,
  toDate: DateKey,
  toStartMinute: number,
  timeZone: string,
): CalEvent {
  if (event.allDay) return event;
  const ends = endsOf(event);
  if (ends === null) return event;
  const asked = clampMinute(toStartMinute);
  if (isOwnPosition(ends.fromMs, toDate, asked, timeZone)) return event;
  const startMs = minuteInstant(toDate, Math.min(asked, LAST_START_MINUTE), timeZone);
  return {
    ...event,
    start: zonedIso(startMs, timeZone),
    end: zonedIso(startMs + (ends.toMs - ends.fromMs), timeZone),
  };
}

/**
 * The same event with one edge dragged to that minute of that day. The edge
 * that was not dragged stays where it was.
 *
 * Neither edge may cross the other: a drag that would make the event shorter
 * than `MIN_EVENT_MINUTES`, including one that drags an edge clean past the
 * other, stops exactly there.
 *
 * Both ends come back formatted in `timeZone`. That is the same instant spelled
 * with the window's own offset, never a different time.
 */
export function resizeTimed(
  event: CalEvent,
  edge: "start" | "end",
  toDate: DateKey,
  toMinute: number,
  timeZone: string,
): CalEvent {
  if (event.allDay) return event;
  const ends = endsOf(event);
  if (ends === null) return event;
  const asked = clampMinute(toMinute);
  const held = edge === "end" ? ends.toMs : ends.fromMs;
  if (isOwnPosition(held, toDate, asked, timeZone)) return event;
  const target = minuteInstant(toDate, asked, timeZone);
  const shortest = MIN_EVENT_MINUTES * MINUTE_MS;
  if (edge === "end") {
    return {
      ...event,
      start: zonedIso(ends.fromMs, timeZone),
      end: zonedIso(Math.max(target, ends.fromMs + shortest), timeZone),
    };
  }
  return {
    ...event,
    start: zonedIso(Math.min(target, ends.toMs - shortest), timeZone),
    end: zonedIso(ends.toMs, timeZone),
  };
}

/**
 * The same all day event, that many days later. Both date keys shift, so the
 * span keeps its length; Google's end stays exclusive.
 */
export function moveAllDay(event: CalEvent, byDays: number): CalEvent {
  if (!event.allDay || !Number.isFinite(byDays)) return event;
  // Whole days only, and decided BEFORE the no-op test: half a day used to
  // shift the span by one (shiftDateKey adds half a day of slack to dodge
  // rounding) while minus half a day returned a new object at the same dates.
  const days = Math.round(byDays);
  if (days === 0) return event;
  if (!DATE_KEY.test(event.start)) return event;
  const start = shiftDateKey(event.start, days);
  return {
    ...event,
    start,
    end: DATE_KEY.test(event.end) ? shiftDateKey(event.end, days) : start,
  };
}

/**
 * A new timed event drawn by dragging empty grid. Either direction gives the
 * same event, both ends are snapped, and a tap (or a drag shorter than the
 * floor) becomes one `MIN_EVENT_MINUTES` slot.
 *
 * THE ORDER AND THE FLOOR ARE APPLIED TO THE INSTANTS, not to the minutes.
 * Minutes are not monotonic across a daylight saving gap: in New York on
 * 2026-03-08, 02:30 and 01:30 are the same instant and 02:00 is BELOW 01:45,
 * so ordering the minutes first and converting after produced events that ran
 * backwards (a drag from 01:45 to 02:15 ended half an hour before it began)
 * and events with no length at all.
 *
 * The title is empty on purpose: it is the first thing the user types, and a
 * placeholder belongs to whatever draws the field.
 */
export function draftAt(
  date: DateKey,
  fromMinute: number,
  toMinute: number,
  timeZone: string,
  calendarId: string,
): CalEvent {
  const a = Math.min(snapMinute(fromMinute), snapMinute(toMinute), LAST_START_MINUTE);
  const b = Math.max(snapMinute(fromMinute), snapMinute(toMinute));
  const first = minuteInstant(date, a, timeZone);
  const second = minuteInstant(date, b, timeZone);
  const startMs = Math.min(first, second);
  const endMs = Math.max(first, second, startMs + MIN_EVENT_MINUTES * MINUTE_MS);
  return {
    // The drag in full: two drafts of different lengths, or on different
    // calendars, are different drafts, and one slot can hold more than one.
    id: `${DRAFT_ID_PREFIX}${date}:${a}:${b}:${calendarId}`,
    calendarId,
    title: "",
    allDay: false,
    start: zonedIso(startMs, timeZone),
    end: zonedIso(endMs, timeZone),
    location: null,
    etag: null,
    editable: true,
    recurring: false,
  };
}
