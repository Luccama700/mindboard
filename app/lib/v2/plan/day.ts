// The shape of one planning day: the window it runs in, the time that is
// already busy, and when to leave for the things that need travel.
//
// TIME RULES THIS FILE OBEYS, because the whole class of bug here is silent:
//   - Every wall clock becomes an instant through app/lib/snapshots/zoned-time,
//     never through a Date getter. The process clock is UTC on Vercel, so
//     `new Date(...).getHours()` is not the user's hour.
//   - All arithmetic happens in epoch milliseconds; instants are formatted back
//     only at the edges (leaveByFor here, the blocks in planner.ts).
//   - A date key is already a local calendar date, so its weekday and its
//     neighbours are pure arithmetic on its own fields: no zone is involved and
//     no instant is built.
//   - A wall time earlier than 06:00 at the END of a day belongs to the next
//     calendar day (types.ts says so for lights out). That only applies to
//     end-of-day times, never to a wake target or noFocusBefore, which would
//     otherwise jump a whole day for an early riser.

import {
  zonedDateKey,
  zonedIso,
  zonedWallTimeToUtcMs,
} from "@/app/lib/snapshots/zoned-time";
import type {
  DateKey,
  FixedEvent,
  PlanOutput,
  PlannerRules,
  WallTime,
} from "@/app/lib/v2/types";

export interface MsInterval {
  startMs: number;
  endMs: number;
}

export const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;
const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1_440;
/** An end-of-day wall time earlier than this belongs to the next day. */
const NEXT_DAY_BEFORE = 6 * 60;

/**
 * Code point order, never locale order. Every tie-break in the engine goes
 * through this: the planner runs in the browser and on the server, and their
 * Intl collations differ, so `localeCompare` would let the same input produce
 * two different plans.
 */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a.codePointAt(i) as number;
    const right = b.codePointAt(j) as number;
    if (left !== right) return left < right ? -1 : 1;
    i += left > 0xffff ? 2 : 1;
    j += right > 0xffff ? 2 : 1;
  }
  const restA = a.length - i;
  const restB = b.length - j;
  return restA === restB ? 0 : restA < restB ? -1 : 1;
}

/** Minutes past local midnight of a "HH:MM" wall time. */
export function wallMinutes(time: WallTime): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function dateKeyParts(date: DateKey): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year, month, day];
}

/** Epoch day of a date key, read as a plain calendar date. */
function epochDay(date: DateKey): number {
  const [year, month, day] = dateKeyParts(date);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** Weekday of a date key, 0 = Sunday. 1970-01-01 was a Thursday. */
export function weekdayOf(date: DateKey): number {
  return (((epochDay(date) + 4) % 7) + 7) % 7;
}

/** The date key `days` later (or earlier). Noon dodges any rounding doubt. */
export function shiftDateKey(date: DateKey, days: number): DateKey {
  return zonedDateKey(epochDay(date) * DAY_MS + days * DAY_MS + DAY_MS / 2, "UTC");
}

/** Whole calendar days from one date key to another, signed. */
export function dayDiff(from: DateKey, to: DateKey): number {
  return epochDay(to) - epochDay(from);
}

/** The instant of a minute-of-day in the zone. Minutes may exceed one day. */
export function minutesToMs(
  date: DateKey,
  minutes: number,
  timeZone: string,
): number {
  return zonedWallTimeToUtcMs(
    date,
    Math.floor(minutes / 60),
    minutes % 60,
    timeZone,
  );
}

/** The instant of a wall time on this calendar day. */
export function wallTimeToMs(
  date: DateKey,
  time: WallTime,
  timeZone: string,
): number {
  return minutesToMs(date, wallMinutes(time), timeZone);
}

/** The instant of an END-of-day wall time, rolling past midnight when early. */
export function endWallTimeToMs(
  date: DateKey,
  time: WallTime,
  timeZone: string,
): number {
  const minutes = wallMinutes(time);
  return minutesToMs(
    date,
    minutes < NEXT_DAY_BEFORE ? minutes + MINUTES_PER_DAY : minutes,
    timeZone,
  );
}

/** Milliseconds of an instant, or null when it cannot be read. */
export function maybeInstantMs(instant: string | null): number | null {
  if (instant === null) return null;
  const ms = Date.parse(instant);
  return Number.isFinite(ms) ? ms : null;
}

/** Milliseconds of an instant the caller must be able to trust. */
export function instantMs(instant: string): number {
  const ms = maybeInstantMs(instant);
  if (ms === null) throw new Error(`not an instant: ${instant}`);
  return ms;
}

export function isoOf(ms: number, rules: PlannerRules): string {
  return zonedIso(ms, rules.timeZone);
}

/** The intervals of `pool` that none of `busy` covers. */
export function carveIntervals(
  pool: MsInterval[],
  busy: MsInterval[],
): MsInterval[] {
  const blocked = busy
    .filter((b) => b.endMs > b.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out: MsInterval[] = [];
  for (const interval of pool) {
    let cursor = interval.startMs;
    for (const b of blocked) {
      if (b.endMs <= cursor) continue;
      if (b.startMs >= interval.endMs) break;
      if (b.startMs > cursor) {
        out.push({ startMs: cursor, endMs: Math.min(b.startMs, interval.endMs) });
      }
      cursor = Math.max(cursor, b.endMs);
      if (cursor >= interval.endMs) break;
    }
    if (cursor < interval.endMs) out.push({ startMs: cursor, endMs: interval.endMs });
  }
  return out
    .filter((iv) => iv.endMs > iv.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Behaviour 1. The window runs from the later of that weekday's wake target and
 * noFocusBefore to lights out. `now` is not an argument: it enters through
 * freeIntervals' `fromMs`, so the same window can be asked for any date.
 */
export function dayWindow(
  date: DateKey,
  rules: PlannerRules,
): { startMs: number; endMs: number } {
  const zone = rules.timeZone;
  const wake = rules.wakeByWeekday[weekdayOf(date)] ?? rules.wakeByWeekday[0];
  const startMinutes = Math.max(
    wallMinutes(wake),
    wallMinutes(rules.noFocusBefore),
  );
  return {
    startMs: minutesToMs(date, startMinutes, zone),
    endMs: endWallTimeToMs(date, rules.lightsOut, zone),
  };
}

/**
 * The planning day a moment belongs to: yesterday's date while `now` is still
 * before the END of yesterday's window, otherwise today's date in the zone.
 *
 * A lights out earlier than 06:00 belongs to the day before (types.ts), so with
 * lights out at 01:30 the day that began yesterday morning is still running at
 * 00:30 and only ends at 01:30. The calendar date flips at midnight and the
 * planning day does not, and everything the tick calls "today" means this one:
 * a plan, a close-out or a slip that used the calendar date would end the day
 * an hour and a half early, skip the blocks it had just planned for 00:10, and
 * do it again every night.
 *
 * With a lights out at or after 06:00 this is simply the date in the zone: the
 * previous day's window ended before midnight, so `now` is never inside it.
 */
export function planningDate(now: string, rules: PlannerRules): DateKey {
  const nowMs = instantMs(now);
  const calendar = zonedDateKey(nowMs, rules.timeZone);
  const yesterday = shiftDateKey(calendar, -1);
  return nowMs < dayWindow(yesterday, rules).endMs ? yesterday : calendar;
}

/**
 * The instants a planning day can hold anything at all: from its own local
 * midnight to the later of the next local midnight and lights out.
 *
 * Wider than `dayWindow` at both ends, on purpose. It is what a calendar read
 * covers and what "does this event belong to that day" is judged by, so an
 * event before the wake target is still seen (the morning message names the
 * first fixed thing of the day, and a shift before wake still counts toward the
 * weekly cap), and an event at 00:30 on a day whose lights out is 01:30 is not
 * invisible to the plan that may be placed over it.
 *
 * The lower bound is local midnight rather than the window start so that
 * widening the end cannot narrow the beginning.
 */
export function dayBounds(date: DateKey, rules: PlannerRules): MsInterval {
  const zone = rules.timeZone;
  return {
    startMs: minutesToMs(date, 0, zone),
    endMs: Math.max(
      minutesToMs(shiftDateKey(date, 1), 0, zone),
      endWallTimeToMs(date, rules.lightsOut, zone),
    ),
  };
}

function matchesTravel(
  event: FixedEvent,
  rule: PlannerRules["travel"][number],
): boolean {
  if (rule.calendarId !== null && rule.calendarId !== event.calendarId) {
    return false;
  }
  if (rule.locationIncludes !== null) {
    const where = (event.location ?? "").toLowerCase();
    if (!where.includes(rule.locationIncludes.toLowerCase())) return false;
  }
  return true;
}

/** The first matching travel rule's lead and trail, or nothing. */
export function travelFor(
  event: FixedEvent,
  rules: PlannerRules,
): { minutesBefore: number; minutesAfter: number } {
  const rule = rules.travel.find((candidate) => matchesTravel(event, candidate));
  return rule
    ? { minutesBefore: rule.minutesBefore, minutesAfter: rule.minutesAfter }
    : { minutesBefore: 0, minutesAfter: 0 };
}

// Behaviour 2, first half. Every timed fixed event, widened by the first
// matching travel rule and by the buffer on both sides. Edges land on whole
// seconds so a free interval can round-trip through an ISO instant.
function fixedBusy(fixed: FixedEvent[], rules: PlannerRules): MsInterval[] {
  const buffer = rules.bufferMinutes * MINUTE_MS;
  const out: MsInterval[] = [];
  for (const event of fixed) {
    if (event.allDay) continue;
    const startMs = maybeInstantMs(event.start);
    const endMs = maybeInstantMs(event.end);
    if (startMs === null || endMs === null || endMs < startMs) continue;
    const travel = travelFor(event, rules);
    out.push({
      startMs:
        Math.floor(
          (startMs - travel.minutesBefore * MINUTE_MS - buffer) / SECOND_MS,
        ) * SECOND_MS,
      endMs:
        Math.ceil((endMs + travel.minutesAfter * MINUTE_MS + buffer) / SECOND_MS) *
        SECOND_MS,
    });
  }
  return out;
}

// Behaviour 2, second half. A protected window is busy for everything except an
// item that closes today, and only when the window says unlessDueToday. Both
// the plan date and the next day are considered, because a window can run past
// midnight into a day whose lights out does too.
function protectedBusy(
  date: DateKey,
  rules: PlannerRules,
  allowProtected: boolean,
): MsInterval[] {
  const windows = allowProtected
    ? rules.protectedWindows.filter((w) => !w.unlessDueToday)
    : rules.protectedWindows;
  if (windows.length === 0) return [];

  const out: MsInterval[] = [];
  for (const key of [date, shiftDateKey(date, 1)]) {
    const weekday = weekdayOf(key);
    for (const window of windows) {
      if (window.weekday !== weekday) continue;
      const from = wallMinutes(window.from);
      const to = wallMinutes(window.to);
      out.push({
        startMs: minutesToMs(key, from, rules.timeZone),
        endMs: minutesToMs(
          key,
          to > from ? to : to + MINUTES_PER_DAY,
          rules.timeZone,
        ),
      });
    }
  }
  return out;
}

/**
 * Behaviour 2. The free stretches of the day: the window, minus every timed
 * fixed event with its travel and buffer, minus the protected windows that
 * apply, and never before `fromMs`.
 */
export function freeIntervals(
  date: DateKey,
  fixed: FixedEvent[],
  rules: PlannerRules,
  opts: { fromMs: number; allowProtected: boolean },
): MsInterval[] {
  const { startMs, endMs } = dayWindow(date, rules);
  const from = Math.ceil(opts.fromMs / SECOND_MS) * SECOND_MS;
  const lo = Math.max(startMs, from);
  if (endMs <= lo) return [];
  return carveIntervals(
    [{ startMs: lo, endMs }],
    [...fixedBusy(fixed, rules), ...protectedBusy(date, rules, opts.allowProtected)],
  );
}

/** When to leave for the fixed events that carry travel time. */
export function leaveByFor(
  fixed: FixedEvent[],
  rules: PlannerRules,
): PlanOutput["leaveBy"] {
  const out: Array<{ fixedId: string; at: string; ms: number }> = [];
  for (const event of fixed) {
    if (event.allDay) continue;
    const startMs = maybeInstantMs(event.start);
    if (startMs === null) continue;
    const { minutesBefore } = travelFor(event, rules);
    if (minutesBefore <= 0) continue;
    const ms = startMs - minutesBefore * MINUTE_MS;
    out.push({ fixedId: event.id, at: isoOf(ms, rules), ms });
  }
  return out
    .sort((a, b) => a.ms - b.ms || compareText(a.fixedId, b.fixedId))
    .map(({ fixedId, at }) => ({ fixedId, at }));
}
