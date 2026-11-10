// What the Today screen is handed, whichever source built it: the sample day,
// a local snapshot of an account's own data, or (later) the live stores.
// Pure types only. The screen codes against this and never against a source.

import type { CalEvent } from "@/app/lib/v2/calendar/types";
import type { Ask, DateKey, FeedStatus, Instant, LaneKey, PlanInput } from "../types";

/** A lane as the screen shows it. Per-user data, never hard-coded. */
export interface ScreenLane {
  key: LaneKey;
  label: string;
  color: string;
}

/**
 * How one task presents itself: the name and colour of the group it lives in.
 * This is the user's own data and their own colour choice, so it can be any
 * colour at all, including one too dark to read as text on a dark scheme.
 * The screen must derive a readable variant instead of using it raw for text.
 */
export interface TaskTag {
  label: string;
  color: string;
}

/**
 * One calendar the source knows about: what to call it, what colour the user
 * gave it, and whether the account may write to it.
 *
 * `color` can be null, and then the screen gives the events on it the accent
 * rather than inventing one. `writable` is carried and ignored for now: this
 * stage of the calendar is read only.
 */
export interface ScreenCalendar {
  id: string;
  label: string;
  color: string | null;
  writable: boolean;
}

/**
 * One week of calendar, as any source hands it over. Nothing here is positioned
 * and nothing is worded: `buildCalendarView` does both.
 */
export interface CalendarScreenData {
  timeZone: string;
  now: Instant;
  /** The seven days shown, Monday first. */
  week: DateKey[];
  /**
   * The days of `week` this source has calendar data for.
   *
   * It is exact, and it is NOT the same question as "is there anything on this
   * day": a day the source cannot speak for must read as unknown rather than as
   * a free day, which is the whole reason this field exists.
   */
  covered: DateKey[];
  calendars: ScreenCalendar[];
  /** Every event that overlaps the week. Read only in this stage. */
  events: CalEvent[];
  /** The hours a day normally spans: earliest wake to lights out, capped at 1440. */
  dayWindow: { fromMinute: number; toMinute: number };
  /** The Monday of the week before and after, when the source covers any day of it. */
  prevWeek: DateKey | null;
  nextWeek: DateKey | null;
  /** The Monday of the week that holds today, when it is not the week shown and is covered. */
  thisWeek: DateKey | null;
}

export interface TodayScreenData {
  /** A real planner input. The screen shows `planDay(input)`, never a hand-written plan. */
  input: PlanInput;
  lanes: ScreenLane[];
  feeds: FeedStatus[];
  feedLabels: Record<string, string>;
  openAsks: Ask[];
  /** Candidate id to its group's name and colour. Empty when the source has no groups. */
  tags: Record<string, TaskTag>;
  /** One plain sentence saying what this data is and whether taps are saved, or null. */
  notice: string | null;
  /**
   * The week of calendar shown beside the day, or null when this source has no
   * calendar at all.
   *
   * REQUIRED, and null is the honest answer rather than an empty week: a
   * snapshot folder without a calendar file knows nothing about anybody's
   * events, and a week of empty columns would read as seven free days.
   */
  calendar: CalendarScreenData | null;
}
