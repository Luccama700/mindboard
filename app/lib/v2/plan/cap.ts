// The weekly hour cap. It exists because the limit it models is a legal one, so
// it is a wall rather than a warning: the planner will not place a block that
// would cross it.
//
// The week starts on Monday, computed from the date key itself, which is
// already a local calendar date. No instant and no zone are involved, so the
// week cannot shift when the process clock disagrees with the user's.

import { dayDiff, maybeInstantMs, weekdayOf, shiftDateKey } from "@/app/lib/v2/plan/day";
import type { DateKey, FixedEvent, PlannerRules, WeekStats } from "@/app/lib/v2/types";

const HOUR_MS = 3_600_000;

/** The Monday of that week. A Sunday belongs to the week that began on Monday. */
export function weekStartKey(date: DateKey): DateKey {
  const weekday = weekdayOf(date);
  return shiftDateKey(date, -((weekday + 6) % 7));
}

function inExemptRange(date: DateKey, rules: PlannerRules): boolean {
  return rules.capExemptRanges.some(
    (range) => dayDiff(range.from, date) >= 0 && dayDiff(date, range.to) >= 0,
  );
}

/** Hours of capped work already fixed on this day. */
function cappedHoursToday(fixed: FixedEvent[]): number {
  let hours = 0;
  for (const event of fixed) {
    if (event.allDay || !event.countsTowardCap) continue;
    const startMs = maybeInstantMs(event.start);
    const endMs = maybeInstantMs(event.end);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    hours += (endMs - startMs) / HOUR_MS;
  }
  return hours;
}

/**
 * How many capped hours this day still has room for: Infinity with no cap or
 * inside an exempt range, otherwise the cap minus the rest of the week minus
 * what is already fixed today.
 */
export function capRoomHours(
  date: DateKey,
  fixed: FixedEvent[],
  week: WeekStats,
  rules: PlannerRules,
): number {
  if (rules.weeklyHourCap === null) return Infinity;
  if (inExemptRange(date, rules)) return Infinity;
  return Math.max(
    0,
    rules.weeklyHourCap - week.capHoursElsewhere - cappedHoursToday(fixed),
  );
}
