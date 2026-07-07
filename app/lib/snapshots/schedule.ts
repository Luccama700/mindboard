// Pure schedule rollup for the dashboard vitals strip: the next timed event that
// hasn't ended, and how many waking hours remain free today. "Free" = the gaps
// between timed events inside a wake window, after now. All-day events have no
// time and are ignored for both. `now` is passed in so the math is testable; it
// uses local time, consistent with the rest of the app's date handling.

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

function dateKeyOf(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

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
}): FreeGap[] {
  const {
    events,
    now,
    wakeStartHour = DEFAULT_WAKE_START_HOUR,
    wakeEndHour = DEFAULT_WAKE_END_HOUR,
    days = 2,
    minMinutes = 45,
    limit = 3,
  } = input;

  const busy = timedIntervals(events).sort((a, b) => a.start - b.start);
  const gaps: FreeGap[] = [];

  for (let offset = 0; offset < days && gaps.length < limit; offset++) {
    const day = new Date(now);
    day.setDate(now.getDate() + offset);
    const wakeStart = new Date(day);
    wakeStart.setHours(wakeStartHour, 0, 0, 0);
    const wakeEnd = new Date(day);
    wakeEnd.setHours(wakeEndHour, 0, 0, 0);

    let cursor =
      offset === 0
        ? Math.max(now.getTime(), wakeStart.getTime())
        : wakeStart.getTime();
    const hi = wakeEnd.getTime();
    if (cursor >= hi) continue;

    // Round the cursor up to the next quarter hour so chips land on clean times.
    const quarter = 15 * 60_000;
    cursor = Math.ceil(cursor / quarter) * quarter;

    for (const iv of freeIntervalsInWindow(busy, cursor, hi)) {
      if (iv.end - iv.start >= minMinutes * 60_000) {
        gaps.push({
          dateKey: dateKeyOf(day),
          start: clockOf(iv.start),
          end: clockOf(iv.end),
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
}): FreeInterval[] {
  const { events, dateKey, now } = input;
  const wakeStartHour = input.wakeStartHour ?? DEFAULT_WAKE_START_HOUR;
  const wakeEndHour = input.wakeEndHour ?? DEFAULT_WAKE_END_HOUR;

  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return [];
  const wakeStart = new Date(y, m - 1, d, wakeStartHour, 0, 0, 0);
  const wakeEnd = new Date(y, m - 1, d, wakeEndHour, 0, 0, 0);

  const lo =
    dateKeyOf(now) === dateKey
      ? Math.max(wakeStart.getTime(), now.getTime())
      : wakeStart.getTime();

  const minutesOf = (ms: number) => {
    const t = new Date(ms);
    return t.getHours() * 60 + t.getMinutes();
  };

  return freeIntervalsInWindow(
    timedIntervals(events),
    lo,
    wakeEnd.getTime(),
  ).map((iv) => {
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
}): ScheduleVitals {
  const { events, now } = input;
  const wakeStartHour = input.wakeStartHour ?? DEFAULT_WAKE_START_HOUR;
  const wakeEndHour = input.wakeEndHour ?? DEFAULT_WAKE_END_HOUR;
  const nowMs = now.getTime();
  const intervals = timedIntervals(events);

  const upcoming = intervals
    .filter((x) => x.end > nowMs)
    .sort((a, b) => a.start - b.start)[0];
  const nextEvent = upcoming
    ? { summary: upcoming.summary, start: upcoming.startIso }
    : null;

  const wakeStart = new Date(now);
  wakeStart.setHours(wakeStartHour, 0, 0, 0);
  const wakeEnd = new Date(now);
  wakeEnd.setHours(wakeEndHour, 0, 0, 0);

  const lo = Math.max(nowMs, wakeStart.getTime());
  const hi = wakeEnd.getTime();
  const freeMs = freeMsInWindow(intervals, lo, hi);
  const freeHoursToday = Math.max(0, Math.round((freeMs / 3_600_000) * 10) / 10);

  return { nextEvent, freeHoursToday };
}
