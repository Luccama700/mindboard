// What the calendar window works on: one event, and where a laid out event
// sits on the grid.
//
// This is a WINDOW onto Google, so an event here is deliberately closer to
// Google's own record than to the planner's `FixedEvent`: it carries the etag
// the next write has to match, whether the calendar it came from may be
// written to at all, and whether it is one occurrence of a repeating series.
// The planner never sees any of that, which is why this is its own shape and
// not a widening of the shared contract.
//
// NOTHING IN THIS FOLDER TALKS TO GOOGLE. The only way out is `CalendarPort`
// (port.ts), and the only implementation on this branch is the fake
// (fake-port.ts). That is deliberate: the real adapter waits for the security
// release.

import type { DateKey, Instant } from "@/app/lib/v2/types";
import type { EngineCalendarEvent } from "@/app/lib/v2/engine/sources";

/** The shortest thing the grid will draw, and the shortest an edit may leave. */
export const MIN_EVENT_MINUTES = 15;
/** What a pointer minute is rounded to. */
export const SNAP_STEP_MINUTES = 15;
/** Minutes in a day as the grid draws it. A daylight saving day is drawn too. */
export const MINUTES_PER_DAY = 1_440;

/**
 * One event in the window.
 *
 * `start` and `end` are instants for a timed event. For an all day event they
 * are date keys and `end` is EXCLUSIVE, exactly as Google gives them
 * (utils/google/calendar.ts reads `event.start.date`), so a one day event ends
 * on the next day's key. Nothing here rewrites that, because converting a date
 * key to an instant needs a zone and this shape has none.
 */
export interface CalEvent {
  /** Google's id for the occurrence, scoped by its calendar. */
  id: string;
  calendarId: string;
  title: string;
  allDay: boolean;
  start: Instant | DateKey;
  end: Instant | DateKey;
  location: string | null;
  /** What the next write has to match. null = not known, so write anyway. */
  etag: string | null;
  /** False for a calendar the account may only read. The grid dims those. */
  editable: boolean;
  /** One occurrence of a repeating series. */
  recurring: boolean;
}

/** A timed event as the day grid draws it. */
export interface TimedPlaced {
  event: CalEvent;
  /**
   * Minutes past local midnight of the day it was laid out on, clipped to the
   * day. The WALL clock, not elapsed time, so 09:00 is nine hours down the
   * grid on a daylight saving day as well.
   */
  startMinute: number;
  /**
   * Where it ends on the same scale. `MINUTES_PER_DAY` when it runs past
   * midnight, and at most `MIN_EVENT_MINUTES` after `startMinute`, which is the
   * one case where it may exceed `MINUTES_PER_DAY` (see `layoutDay`).
   */
  endMinute: number;
  /** It began before this day: the chip has no top edge. */
  continuesBefore: boolean;
  /** It ends after this day: the chip has no bottom edge. */
  continuesAfter: boolean;
  /** Which of the overlapping columns this one takes, from zero. */
  column: number;
  /** How many columns everything in this overlapping group shares. */
  columnCount: number;
}

/** An all day event as the week's top row draws it. */
export interface AllDayPlaced {
  event: CalEvent;
  /** First day of the week it covers, 0 to 6, clipped to the week. */
  firstIndex: number;
  /** Last day of the week it covers, inclusive, clipped to the week. */
  lastIndex: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Which stacked row it sits on, from zero, so two spans never collide. */
  row: number;
}

export interface DayLayout {
  timed: TimedPlaced[];
}

/**
 * What the engine already reads from Google, as this window wants it.
 *
 * The three flags are arguments because `EngineCalendarEvent` does not carry
 * them: the planner has no use for them, and the calendar list read is where
 * `editable` (Google's `accessRole`) and the etag come from.
 */
export function fromEngineEvent(
  event: EngineCalendarEvent,
  opts: { editable: boolean; etag: string | null; recurring: boolean },
): CalEvent {
  return {
    id: event.id,
    calendarId: event.calendarId,
    title: event.summary,
    allDay: event.allDay,
    start: event.start,
    end: event.end,
    location: event.location ?? null,
    etag: opts.etag,
    editable: opts.editable,
    recurring: opts.recurring,
  };
}
