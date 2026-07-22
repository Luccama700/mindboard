// Soft-placement invariant: the slots this module produces are ADVISORY. A
// PlannedSlot is a suggested time for an untimed, not-done recurring occurrence.
// It is a display hint only and must NEVER feed the busy/free math — not
// occurrenceBusyEvents, freeGaps, freeIntervalsForDay, scheduleSnapshot, nor
// planningSnapshot. Placement READS free intervals but never writes back into
// them, so a suggestion can never make a day read as busier than it truly is.
// busyFromDayItems below is the shared busy-builder: it counts only real timed
// commitments (google events, time-blocked tasks, TIMED recurring), never the
// planned ghosts.

import type { CalendarItem } from "@/app/_components/calendar-types";
import type { FreeInterval, ScheduleEvent } from "@/app/lib/snapshots/schedule";

const DEFAULT_MINUTES = 30;
const QUARTER = 15;

export type PlannedSlot = {
  ruleId: string;
  dateKey: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  minutes: number;
};

type PlanRule = {
  id: string;
  priority: "low" | "med" | "high";
  duration_min: number | null;
  created_at: string;
};

const PRIORITY_RANK: Record<PlanRule["priority"], number> = {
  high: 0,
  med: 1,
  low: 2,
};

function toClock(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// Mirrors week-view's minutesToTime: clamped to a same-day clock so the busy
// strings match the underlay exactly.
function minutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(minutes, 23 * 60 + 45));
  const hh = String(Math.floor(clamped / 60)).padStart(2, "0");
  const mm = String(clamped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// First-fit soft placement of untimed occurrences into a day's free intervals.
// Rules are ordered high>med>low priority, then longer first, then oldest, then
// id — fully deterministic. Each placement ceils its start to the next quarter
// hour (freeIntervalsForDay does not pre-round) and carves its span out of the
// pool, leaving the pre-alignment sliver and the remainder available for later
// rules. A rule that fits nowhere is omitted.
export function planUntimedOccurrences(input: {
  rules: PlanRule[];
  intervals: FreeInterval[];
  dateKey: string;
}): PlannedSlot[] {
  const { rules, intervals, dateKey } = input;

  const ordered = [...rules].sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    const da = a.duration_min ?? DEFAULT_MINUTES;
    const db = b.duration_min ?? DEFAULT_MINUTES;
    if (da !== db) return db - da;
    const c = a.created_at.localeCompare(b.created_at);
    if (c !== 0) return c;
    return a.id.localeCompare(b.id);
  });

  const pool = intervals
    .map((iv) => ({ start: iv.startMinutes, end: iv.endMinutes }))
    .sort((a, b) => a.start - b.start);

  const slots: PlannedSlot[] = [];
  for (const rule of ordered) {
    const minutes = rule.duration_min ?? DEFAULT_MINUTES;
    for (let i = 0; i < pool.length; i++) {
      const span = pool[i];
      const alignedStart = Math.ceil(span.start / QUARTER) * QUARTER;
      const alignedEnd = alignedStart + minutes;
      if (alignedEnd > span.end) continue;
      slots.push({
        ruleId: rule.id,
        dateKey,
        start: toClock(alignedStart),
        end: toClock(alignedEnd),
        minutes,
      });
      const replacement: { start: number; end: number }[] = [];
      if (alignedStart > span.start)
        replacement.push({ start: span.start, end: alignedStart });
      if (alignedEnd < span.end)
        replacement.push({ start: alignedEnd, end: span.end });
      pool.splice(i, 1, ...replacement);
      break;
    }
  }

  return slots;
}

// The busy blocks of one calendar day, shared by the gap planner and the week
// view's free-gap underlay so they cannot drift: timed google events, timed
// tasks (due_time), and TIMED recurring occurrences (dueTime !== null). Untimed
// rules — including soft-placed ghosts — contribute nothing.
export function busyFromDayItems(
  dateKey: string,
  items: CalendarItem[],
): ScheduleEvent[] {
  const busy: ScheduleEvent[] = [];
  for (const item of items) {
    if (item.kind === "event") {
      if (item.allDay) continue;
      busy.push({
        summary: item.title,
        start: item.start,
        end: item.end,
        allDay: false,
      });
    } else if (item.kind === "task" || item.kind === "rtask") {
      if (item.dueTime === null) continue;
      const start = timeToMinutes(item.dueTime.slice(0, 5));
      const end = start + (item.durationMin ?? DEFAULT_MINUTES);
      busy.push({
        summary: item.title,
        start: `${dateKey}T${minutesToTime(start)}:00`,
        end: `${dateKey}T${minutesToTime(end)}:00`,
        allDay: false,
      });
    }
  }
  return busy;
}
