// Which bucket a candidate falls in, and the order inside each bucket.
//
// The deadline buckets are decided before the kind, so a side quest that
// genuinely closes today is treated as a deadline, not as an errand. Both
// deadline buckets require `hard`: types.ts describes the reserved session and
// the early touch as belonging to a hard item, and a soft window that matters
// is promoted to `hard` upstream rather than guessed at here.
//
// The second argument is THE REFERENCE INSTANT, not necessarily the clock.
// "Today" is the day it falls on in the user's zone, and the hard window is
// measured from it. The caller passes the later of `now` and the start of the
// planned day's window, so the buckets describe the day being planned rather
// than the day the planner happens to run, and they do not shift when the same
// day is replanned before wake (behaviour 11, handled in planner.ts).
//
// Energy is deliberately not an argument. The low-energy preference for cheap
// work is a planner concern (it only reorders the lane-step bucket), so it lives
// in planner.ts where the answered energy is known.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { compareText, instantMs, maybeInstantMs } from "@/app/lib/v2/plan/day";
import type { Candidate, DateKey, Instant, PlannerRules } from "@/app/lib/v2/types";

export type CandidateTier = "due-today" | "hard-window" | "lane-step" | "side";

export interface RankedCandidate {
  candidate: Candidate;
  tier: CandidateTier;
}

const TIER_ORDER: Record<CandidateTier, number> = {
  "due-today": 0,
  "hard-window": 1,
  "lane-step": 2,
  side: 3,
};

const HOUR_MS = 3_600_000;

export function tierOf(
  candidate: Candidate,
  nowMs: number,
  todayKey: string,
  rules: PlannerRules,
): CandidateTier {
  const dueMs = maybeInstantMs(candidate.due);
  // An item whose closing instant is BEHIND the reference instant is neither in
  // the hard window nor due today. It reads as though it were both, which is
  // what made six overdue items on a low day produce six mandatory hard-window
  // blocks, every day, with nothing dropped: the deadline tiers are exempt from
  // capacity and from the per-lane limit, so nothing bounded them. Nor is it a
  // deadline the day can still serve: the day it closed on has gone. It ranks
  // as an ordinary step or side quest, by its date, earliest first (which puts
  // the oldest overdue one first), and from there capacity and the lane limit
  // decide how much of the backlog the day takes on.
  if (candidate.hard && dueMs !== null && dueMs >= nowMs) {
    if (zonedDateKey(dueMs, rules.timeZone) === todayKey) return "due-today";
    if (dueMs - nowMs <= rules.hardWindowHours * HOUR_MS) return "hard-window";
  }
  return candidate.kind === "side" ? "side" : "lane-step";
}

/** The sort key a bucket orders by: deadline, or expiry for side quests. */
function clockKey(ranked: RankedCandidate): number {
  const value =
    ranked.tier === "side" ? ranked.candidate.expiresAt : ranked.candidate.due;
  return maybeInstantMs(value) ?? Number.POSITIVE_INFINITY;
}

// Subtraction is not safe here: two candidates with no deadline both key on
// Infinity, and Infinity - Infinity is NaN, which makes the whole sort
// undefined rather than falling through to the id.
function compare(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The day's candidates in the order the demand list walks them. `now` is the
 * reference instant the buckets are read against (see the note above). The
 * final tie-break is the id rather than the input position, so re-ordered rows
 * out of the database cannot change the plan.
 *
 * `today` is the day being planned, and it is REQUIRED rather than derived from
 * the reference instant, because the two are not the same day once lights out
 * is after midnight. At 00:05 on a day whose lights out is 01:30 the reference
 * instant falls on the next calendar date, so "closes today" read as tomorrow's
 * deadline and the planner crammed its three-hour session into the ninety
 * minutes left before lights out. Deriving it was the defect; a required
 * argument is how the compiler names every caller that has to choose.
 */
export function rankCandidates(
  candidates: Candidate[],
  now: Instant,
  rules: PlannerRules,
  today: DateKey,
): RankedCandidate[] {
  const nowMs = instantMs(now);
  const todayKey = today;

  return candidates
    .map((candidate) => ({
      candidate,
      tier: tierOf(candidate, nowMs, todayKey, rules),
    }))
    .sort((a, b) => {
      const byTier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
      if (byTier !== 0) return byTier;
      // A pinned side quest never expires, so it waits for the ones that do.
      if (a.tier === "side" && a.candidate.pinned !== b.candidate.pinned) {
        return a.candidate.pinned ? 1 : -1;
      }
      const byClock = compare(clockKey(a), clockKey(b));
      if (byClock !== 0) return byClock;
      return compareText(a.candidate.id, b.candidate.id);
    });
}
