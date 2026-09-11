// Soft-placement invariant: the slots this module produces are ADVISORY. A
// PlannedSlot is a suggested time for an untimed, not-done recurring occurrence.
// It is a display hint only and must NEVER feed the busy/free math — not
// occurrenceBusyEvents, freeGaps, freeIntervalsForDay, scheduleSnapshot, nor
// planningSnapshot. Placement READS free intervals but never writes back into
// them, so a suggestion can never make a day read as busier than it truly is.
// busyFromDayItems below is the shared busy-builder: it counts only real timed
// commitments (google events, time-blocked tasks, TIMED recurring, and APPROVED
// slots — a slot overrides its rule's due_time for that day), never the planned
// ghosts. Only plannedStart placements stay advisory.

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

// The effective committed timing of an rtask item: an approved slot overrides
// the rule's due_time (and its duration) for that day. Returns null when the
// occurrence carries neither a slot nor a due_time (a bare untimed habit —
// still advisory even when soft-placed).
export function rtaskEffectiveTiming(
  item: Extract<CalendarItem, { kind: "rtask" }>,
): { time: string; minutes: number } | null {
  const time = item.slotStart ?? item.dueTime;
  if (time === null) return null;
  return {
    time,
    minutes: item.slotMinutes ?? item.durationMin ?? DEFAULT_MINUTES,
  };
}

// The busy blocks of one calendar day, shared by the gap planner and the week
// view's free-gap underlay so they cannot drift: timed google events, timed
// tasks (due_time), and committed recurring occurrences (TIMED, or with an
// approved slot). Untimed rules — including soft-placed ghosts — contribute
// nothing.
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
    } else if (item.kind === "task") {
      if (item.dueTime === null) continue;
      const start = timeToMinutes(item.dueTime.slice(0, 5));
      const end = start + (item.durationMin ?? DEFAULT_MINUTES);
      busy.push({
        summary: item.title,
        start: `${dateKey}T${minutesToTime(start)}:00`,
        end: `${dateKey}T${minutesToTime(end)}:00`,
        allDay: false,
      });
    } else if (item.kind === "rtask") {
      const timing = rtaskEffectiveTiming(item);
      if (timing === null) continue;
      const start = timeToMinutes(timing.time.slice(0, 5));
      const end = start + timing.minutes;
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

// ---------- subtasks: backwards from the parent's deadline ----------
//
// A decomposed task's children each carry a window [not_before, due_date]
// (due_date is the child's "must be done by", never the day it is scheduled).
// This placement is ADVISORY like everything above: the day (and quarter-hour
// start) a child lands on is computed at read time from free intervals and
// never written back — a skipped child slides its not_before and is simply
// re-planned. Children are taken latest-deadline first and each takes the
// LATEST day of its window that still has a fitting free interval, so work
// packs toward the deadline while every child keeps a day of its own where
// the calendar allows it.
//
// Energy is a soft preference, never a constraint: a heavy child (cost ≥ 4)
// prefers a day whose logged energy is ≥ 3 and avoids one logged ≤ 2; a light
// child (cost ≤ 2) prefers a day logged ≤ 2 so low days fill with light work.
// Days without a log are neutral — in practice only today (and the past) have
// one. A child that fits nowhere still lands on its window's last day, without
// a time, because it must land somewhere before the deadline.

export type SubtaskPlanChild = {
  id: string;
  parent_task_id: string;
  due_date: string;
  not_before: string | null;
  duration_min: number | null;
  estimated_minutes: number | null;
  energy_cost: number | null;
  created_at: string;
};

export type PlannedSubtask = {
  taskId: string;
  parentId: string;
  dateKey: string;
  start: string | null; // "HH:MM", null when nothing fit and the day is a fallback
  end: string | null;
  minutes: number;
  fitted: boolean;
};

function energyRank(cost: number | null, logged: number | undefined): 0 | 1 | 2 {
  if (logged === undefined || cost === null) return 1;
  if (cost >= 4) return logged >= 3 ? 2 : 0;
  if (cost <= 2) return logged <= 2 ? 2 : 1;
  return 1;
}

function dayKeysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor.getTime() <= end.getTime()) {
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    keys.push(`${cursor.getFullYear()}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

export function planSubtasks(input: {
  today: string;
  children: SubtaskPlanChild[];
  // Free intervals per day. A day missing from the map has no busy data (the
  // caller's fetch did not cover it) and is skipped for fitting.
  intervalsByDay: ReadonlyMap<string, FreeInterval[]>;
  // Logged energy (1..5) per day; absent = no log = neutral.
  energyByDay?: ReadonlyMap<string, number>;
}): PlannedSubtask[] {
  const { today, children, intervalsByDay } = input;
  const energyByDay = input.energyByDay ?? new Map<string, number>();

  const ordered = children
    .filter((c) => c.due_date >= today)
    .sort((a, b) => {
      const d = b.due_date.localeCompare(a.due_date);
      if (d !== 0) return d;
      const nb = (b.not_before ?? "").localeCompare(a.not_before ?? "");
      if (nb !== 0) return nb;
      const ma = a.duration_min ?? a.estimated_minutes ?? DEFAULT_MINUTES;
      const mb = b.duration_min ?? b.estimated_minutes ?? DEFAULT_MINUTES;
      if (ma !== mb) return mb - ma;
      const c = a.created_at.localeCompare(b.created_at);
      if (c !== 0) return c;
      return a.id.localeCompare(b.id);
    });

  // One mutable pool per day, carved as children land and given back when a
  // child moves (same shape as the untimed-occurrence planner above).
  type Span = { start: number; end: number };
  const pools = new Map<string, Span[]>();
  const poolFor = (dateKey: string): Span[] | null => {
    let pool = pools.get(dateKey);
    if (!pool) {
      const ivs = intervalsByDay.get(dateKey);
      if (!ivs) return null;
      pool = ivs
        .map((iv) => ({ start: iv.startMinutes, end: iv.endMinutes }))
        .sort((a, b) => a.start - b.start);
      pools.set(dateKey, pool);
    }
    return pool;
  };
  const tryFit = (dateKey: string, minutes: number) => {
    const pool = poolFor(dateKey);
    if (!pool) return null;
    for (let i = 0; i < pool.length; i++) {
      const span = pool[i];
      const alignedStart = Math.ceil(span.start / QUARTER) * QUARTER;
      const alignedEnd = alignedStart + minutes;
      if (alignedEnd > span.end) continue;
      return { index: i, alignedStart, alignedEnd, span };
    }
    return null;
  };
  const carve = (dateKey: string, minutes: number): Span | null => {
    const fit = tryFit(dateKey, minutes);
    if (!fit) return null;
    const pool = poolFor(dateKey)!;
    const replacement: Span[] = [];
    if (fit.alignedStart > fit.span.start) {
      replacement.push({ start: fit.span.start, end: fit.alignedStart });
    }
    if (fit.alignedEnd < fit.span.end) {
      replacement.push({ start: fit.alignedEnd, end: fit.span.end });
    }
    pool.splice(fit.index, 1, ...replacement);
    return { start: fit.alignedStart, end: fit.alignedEnd };
  };
  const release = (dateKey: string, span: Span) => {
    const pool = poolFor(dateKey)!;
    pool.push({ ...span });
    pool.sort((a, b) => a.start - b.start);
    // Re-merge touching spans so a later child can use the whole stretch.
    for (let i = 0; i + 1 < pool.length; ) {
      if (pool[i].end >= pool[i + 1].start) {
        pool[i].end = Math.max(pool[i].end, pool[i + 1].end);
        pool.splice(i + 1, 1);
      } else i++;
    }
  };
  const windowOf = (child: SubtaskPlanChild): string[] => {
    const first =
      child.not_before && child.not_before > today ? child.not_before : today;
    return dayKeysBetween(first, child.due_date);
  };
  const minutesOf = (child: SubtaskPlanChild) =>
    child.duration_min ?? child.estimated_minutes ?? DEFAULT_MINUTES;

  // Pass 1 — feasibility: latest day of the window that fits, energy-blind,
  // so a deadline is never lost to a preference. A child that fits nowhere
  // takes its window's last day untimed.
  type Placement = { child: SubtaskPlanChild; dateKey: string; span: Span | null };
  const placements: Placement[] = [];
  for (const child of ordered) {
    const minutes = minutesOf(child);
    const days = windowOf(child);
    let placed: Placement | null = null;
    for (let i = days.length - 1; i >= 0; i--) {
      const span = carve(days[i], minutes);
      if (span) {
        placed = { child, dateKey: days[i], span };
        break;
      }
    }
    placements.push(placed ?? { child, dateKey: child.due_date, span: null });
  }

  // Pass 2 — energy: a fitted child whose day is not a preferred match moves
  // to the latest day of its window that fits in the REMAINING free time and
  // ranks better. Only leftover space is used, so nothing placed in pass 1
  // can be displaced: the preference stays soft by construction.
  for (const p of placements) {
    if (!p.span) continue;
    const current = energyRank(p.child.energy_cost, energyByDay.get(p.dateKey));
    if (current === 2) continue;
    const minutes = minutesOf(p.child);
    const days = windowOf(p.child);
    let best: { dateKey: string; rank: number } | null = null;
    for (let i = days.length - 1; i >= 0; i--) {
      const dateKey = days[i];
      if (dateKey === p.dateKey) continue;
      const rank = energyRank(p.child.energy_cost, energyByDay.get(dateKey));
      if (rank <= current) continue;
      if (!tryFit(dateKey, minutes)) continue;
      if (!best || rank > best.rank) best = { dateKey, rank };
      if (best.rank === 2) break;
    }
    if (!best) continue;
    release(p.dateKey, p.span);
    const span = carve(best.dateKey, minutes)!;
    p.dateKey = best.dateKey;
    p.span = span;
  }

  return placements.map((p) => ({
    taskId: p.child.id,
    parentId: p.child.parent_task_id,
    dateKey: p.dateKey,
    start: p.span ? toClock(p.span.start) : null,
    end: p.span ? toClock(p.span.end) : null,
    minutes: minutesOf(p.child),
    fitted: p.span !== null,
  }));
}
