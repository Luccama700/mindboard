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

// Total free milliseconds inside [lo, hi] not covered by the busy intervals.
function freeMsInWindow(busy: Interval[], lo: number, hi: number): number {
  if (hi <= lo) return 0;
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, lo), end: Math.min(b.end, hi) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  let covered = 0;
  let cursor = lo;
  for (const b of clipped) {
    if (b.start > cursor) cursor = b.start;
    if (b.end > cursor) {
      covered += b.end - cursor;
      cursor = b.end;
    }
  }
  return hi - lo - covered;
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
