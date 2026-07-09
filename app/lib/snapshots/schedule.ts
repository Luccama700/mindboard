// Pure schedule rollup for the dashboard vitals strip: the next timed event that
// hasn't ended, and how many waking hours remain free today. "Free" = the gaps
// between timed events inside a wake window, after now. All-day events have no
// time and are ignored for both. `now` is passed in so the math is testable.
//
// Wake-window math is zone-aware: pass `timeZone` (IANA) and the window is
// computed in that zone — required on Vercel, where the process clock is UTC.
// Omit it (null) and the process clock is used, unchanged — correct in the
// browser, where the process clock already IS the user's zone.

import { addDaysKey } from "@/app/_components/finance-projection";
import {
  zonedClock,
  zonedClockMinutes,
  zonedDateKey,
  zonedWallTimeToUtcMs,
} from "@/app/lib/snapshots/zoned-time";

export type ScheduleEvent = {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
};

export type ScheduleVitals = {
  nextEvent: { summary: string; start: string } | null;
  freeHoursToday: number;
};

const DEFAULT_WAKE_START_HOUR = 8;
const DEFAULT_WAKE_END_HOUR = 22;

type Interval = { start: number; end: number };

function timedIntervals(events: ScheduleEvent[]): (Interval & {
  summary: string;
  startIso: string;
})[] {
  return events
    .filter((e) => !e.allDay && e.start && e.end)
    .map((e) => ({
      start: new Date(e.start).getTime(),
      end: new Date(e.end).getTime(),
      summary: e.summary,
      startIso: e.start,
    }))
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end));
}

// The free intervals inside [lo, hi] not covered by the busy intervals — the
// single sweep behind freeMsInWindow, freeGaps, and freeIntervalsForDay.
function freeIntervalsInWindow(
  busy: Interval[],
  lo: number,
  hi: number,
): Interval[] {
  if (hi <= lo) return [];
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, lo), end: Math.min(b.end, hi) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const free: Interval[] = [];
  let cursor = lo;
  for (const b of clipped) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < hi) free.push({ start: cursor, end: hi });
  return free;
}

function freeMsInWindow(busy: Interval[], lo: number, hi: number): number {
  return freeIntervalsInWindow(busy, lo, hi).reduce(
    (sum, iv) => sum + (iv.end - iv.start),
    0,
  );
}

export type FreeGap = {
  dateKey: string; // YYYY-MM-DD
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  minutes: number;
};

// The next free stretches inside the wake window, today first (from now),
// then subsequent days. Powers the [schedule ▾] one-tap chips and the week
// view's free-gap underlay.
export function freeGaps(input: {
  events: ScheduleEvent[];
  now: Date;
  wakeStartHour?: number;
  wakeEndHour?: number;
  days?: number;
  minMinutes?: number;
  limit?: number;
  timeZone?: string | null;
}): FreeGap[] {
  const {
    events,
    now,
    wakeStartHour = DEFAULT_WAKE_START_HOUR,
    wakeEndHour = DEFAULT_WAKE_END_HOUR,
    days = 2,
    minMinutes = 45,
    limit = 3,
    timeZone = null,
  } = input;

  const busy = timedIntervals(events).sort((a, b) => a.start - b.start);
  const gaps: FreeGap[] = [];
  const nowMs = now.getTime();
  const baseKey = zonedDateKey(nowMs, timeZone);

  for (let offset = 0; offset < days && gaps.length < limit; offset++) {
    const dayKey = addDaysKey(baseKey, offset);
    const wakeStart = zonedWallTimeToUtcMs(dayKey, wakeStartHour, 0, timeZone);
    const hi = zonedWallTimeToUtcMs(dayKey, wakeEndHour, 0, timeZone);

    let cursor = offset === 0 ? Math.max(nowMs, wakeStart) : wakeStart;
    if (cursor >= hi) continue;

    // Round the cursor up to the next quarter hour so chips land on clean times.
    // Real zone offsets are whole multiples of 15 minutes, so rounding the
    // absolute instant lands on a clean local quarter too.
    const quarter = 15 * 60_000;
    cursor = Math.ceil(cursor / quarter) * quarter;

    for (const iv of freeIntervalsInWindow(busy, cursor, hi)) {
      if (iv.end - iv.start >= minMinutes * 60_000) {
        gaps.push({
          dateKey: dayKey,
          start: zonedClock(iv.start, timeZone),
          end: zonedClock(iv.end, timeZone),
          minutes: Math.round((iv.end - iv.start) / 60_000),
        });
        if (gaps.length >= limit) break;
      }
    }
  }

  return gaps;
}

export type FreeInterval = {
  startMinutes: number; // minutes into the day, e.g. 12:30 = 750
  endMinutes: number;
  minutes: number;
};

// Every free interval of one day's wake window (no minimum, no cap) — the
// drawable rects for the week view's free-time underlay. For today, time
// before `now` is not free; other days ignore `now`.
export function freeIntervalsForDay(input: {
  events: ScheduleEvent[];
  dateKey: string; // YYYY-MM-DD
  now: Date;
  wakeStartHour?: number;
  wakeEndHour?: number;
  timeZone?: string | null;
}): FreeInterval[] {
  const { events, dateKey, now } = input;
  const wakeStartHour = input.wakeStartHour ?? DEFAULT_WAKE_START_HOUR;
  const wakeEndHour = input.wakeEndHour ?? DEFAULT_WAKE_END_HOUR;
  const timeZone = input.timeZone ?? null;

  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return [];
  const wakeStart = zonedWallTimeToUtcMs(dateKey, wakeStartHour, 0, timeZone);
  const wakeEnd = zonedWallTimeToUtcMs(dateKey, wakeEndHour, 0, timeZone);

  const lo =
    zonedDateKey(now.getTime(), timeZone) === dateKey
      ? Math.max(wakeStart, now.getTime())
      : wakeStart;

  // Clock minutes, except a boundary on the NEXT day (a wake window ending at
  // 24:00 is next-day midnight) reads as 1440+, not 0 — otherwise the last
  // interval of the day would come out negative-length and vanish.
  const minutesOf = (ms: number) => {
    const clock = zonedClockMinutes(ms, timeZone);
    return zonedDateKey(ms, timeZone) === dateKey ? clock : clock + 24 * 60;
  };

  return freeIntervalsInWindow(timedIntervals(events), lo, wakeEnd).map((iv) => {
    const startMinutes = minutesOf(iv.start);
    const endMinutes = minutesOf(iv.end);
    return { startMinutes, endMinutes, minutes: endMinutes - startMinutes };
  });
}

export function scheduleSnapshot(input: {
  events: ScheduleEvent[];
  now: Date;
  wakeStartHour?: number;
  wakeEndHour?: number;
  timeZone?: string | null;
}): ScheduleVitals {
  const { events, now } = input;
  const wakeStartHour = input.wakeStartHour ?? DEFAULT_WAKE_START_HOUR;
  const wakeEndHour = input.wakeEndHour ?? DEFAULT_WAKE_END_HOUR;
  const timeZone = input.timeZone ?? null;
  const nowMs = now.getTime();
  const intervals = timedIntervals(events);

  const upcoming = intervals
    .filter((x) => x.end > nowMs)
    .sort((a, b) => a.start - b.start)[0];
  const nextEvent = upcoming
    ? { summary: upcoming.summary, start: upcoming.startIso }
    : null;

  const todayKey = zonedDateKey(nowMs, timeZone);
  const wakeStart = zonedWallTimeToUtcMs(todayKey, wakeStartHour, 0, timeZone);
  const hi = zonedWallTimeToUtcMs(todayKey, wakeEndHour, 0, timeZone);

  const lo = Math.max(nowMs, wakeStart);
  const freeMs = freeMsInWindow(intervals, lo, hi);
  const freeHoursToday = Math.max(0, Math.round((freeMs / 3_600_000) * 10) / 10);

  return { nextEvent, freeHoursToday };
}
