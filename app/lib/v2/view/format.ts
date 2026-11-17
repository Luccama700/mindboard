// Every label the Today screen prints. Pure functions over an instant and a
// zone, so the same input always reads the same way.
//
// NO Intl LONG FORMAT LIVES HERE, on purpose. `toLocaleDateString` with a long
// weekday or month punctuates differently between Node and a browser engine
// (and between ICU versions), and the Today screen renders on the server and
// then hydrates in the browser, so a difference is a hydration mismatch rather
// than a cosmetic one. The weekday and the month are read out of the date key
// with plain arithmetic instead, exactly as app/lib/v2/plan/day.ts does.
//
// Clock times DO go through Intl, via the zone helpers: a wall clock in an IANA
// zone cannot be computed without the zone database, and those helpers return
// digits only, which every engine agrees on.

import { zonedClock, zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import type { DateKey, Instant } from "@/app/lib/v2/types";

const DAY_MS = 86_400_000;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Epoch day of a date key, read as a plain calendar date. */
function epochDay(date: DateKey): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** Weekday of a date key, 0 = Sunday. 1970-01-01 was a Thursday. */
function weekdayOf(date: DateKey): number {
  return (((epochDay(date) + 4) % 7) + 7) % 7;
}

/** "HH:MM", 24 hour, in the given zone. */
export function clockLabel(at: Instant, timeZone: string): string {
  return zonedClock(Date.parse(at), timeZone);
}

/** "Wednesday 15 April". The date key is already a local date, so no zone. */
export function dayLabel(date: DateKey): string {
  const [, month, day] = date.split("-").map(Number);
  return `${WEEKDAYS[weekdayOf(date)]} ${day} ${MONTHS[month - 1]}`;
}

/**
 * "9 to 15 November", the week a calendar is showing.
 *
 * Each end carries only what the other does not already say: one month when the
 * week sits inside one, both when it crosses one, and both years when it crosses
 * a new year. The word is "to" rather than a dash, which the copy rules forbid.
 */
export function weekLabel(week: readonly DateKey[]): string {
  const first = week[0];
  const last = week[week.length - 1];
  // A week with no days has no label. Never happens with `weekOf`, which always
  // answers seven, and a crash here would take the whole screen with it.
  if (first === undefined || last === undefined) return "";

  const [fromYear, fromMonth, fromDay] = first.split("-").map(Number);
  const [toYear, toMonth, toDay] = last.split("-").map(Number);
  const sameYear = fromYear === toYear;

  const from = !sameYear
    ? `${fromDay} ${MONTHS[fromMonth - 1]} ${fromYear}`
    : fromMonth === toMonth
      ? `${fromDay}`
      : `${fromDay} ${MONTHS[fromMonth - 1]}`;
  const to = sameYear
    ? `${toDay} ${MONTHS[toMonth - 1]}`
    : `${toDay} ${MONTHS[toMonth - 1]} ${toYear}`;
  return `${from} to ${to}`;
}

/** "13:00 to 14:00" in the zone given. Two clocks, never a dash. */
export function timeRangeLabel(start: Instant, end: Instant, timeZone: string): string {
  return `${clockLabel(start, timeZone)} to ${clockLabel(end, timeZone)}`;
}

/** "15 April", for a day that is not today. */
function shortDayLabel(date: DateKey): string {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

/** "25 minutes", "1 hour", "1 hour 40 minutes". Empty for nothing at all. */
export function minutesLabel(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole <= 0) return "";
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (rest > 0) parts.push(`${rest} ${rest === 1 ? "minute" : "minutes"}`);
  return parts.join(" ");
}

/**
 * When a feed was last seen, as the tail of "I can't see X since ...": the
 * clock for earlier today, the day for anything older, and a fragment rather
 * than a blank for a feed that has never had a good run.
 */
export function sinceLabel(
  at: Instant | null,
  now: Instant,
  timeZone: string,
): string {
  if (at === null) return "the start";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "the start";
  const day = zonedDateKey(ms, timeZone);
  const today = zonedDateKey(Date.parse(now), timeZone);
  return day === today ? zonedClock(ms, timeZone) : shortDayLabel(day);
}
