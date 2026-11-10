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
  // as an ordinary step or side quest, and inside that tier it sorts after
  // every item that is not overdue, most recently overdue first
  // (`ordinaryOrder`); capacity and the lane limit then decide how much of the
  // backlog the day takes on.
  if (candidate.hard && dueMs !== null && dueMs >= nowMs) {
    if (zonedDateKey(dueMs, rules.timeZone) === todayKey) return "due-today";
    if (dueMs - nowMs <= rules.hardWindowHours * HOUR_MS) return "hard-window";
  }
  return candidate.kind === "side" ? "side" : "lane-step";
}

/**
 * The ordinary tiers, which are the only ones the overdue rule applies in. The
 * deadline tiers cannot hold an overdue item at all: `tierOf` refuses one.
 */
function isOrdinary(tier: CandidateTier): boolean {
  return tier === "lane-step" || tier === "side";
}

/**
 * How an item sorts inside the ordinary tiers: `overdue` 1 sorts AFTER every
 * item whose own date is still ahead or absent, and `at` is the instant it
 * sorts on inside its own group, ascending.
 *
 * An overdue item's `at` is the NEGATED instant, so the most recently overdue
 * comes first. A pile of lapsed items holds some that are dead and some that
 * are still alive and the planner cannot tell which, so the oldest is the worst
 * possible guess: ordering by it put the day's guaranteed floor block on a
 * homework three weeks past its date, ahead of a paper due in three days, every
 * day. Last, and freshest first, is the honest default.
 *
 * Exported because planner.ts re-sorts the lane-step tier to add its low-energy
 * tie-break, and a second spelling of this rule there is how the two come apart.
 */
export function ordinaryOrder(
  candidate: Candidate,
  nowMs: number,
): { overdue: number; at: number } {
  const dueMs = maybeInstantMs(candidate.due);
  if (dueMs !== null && dueMs < nowMs) return { overdue: 1, at: -dueMs };
  return { overdue: 0, at: dueMs ?? Number.POSITIVE_INFINITY };
}

/**
 * The sort key a bucket orders by: the deadline, the expiry for a side quest,
 * or the negated deadline for an overdue item. An overdue side quest is ordered
 * by its own lapsed date rather than by its expiry, because an expiry says
 * nothing about how long ago the date went.
 */
function clockKey(ranked: RankedCandidate, nowMs: number): number {
  const order = ordinaryOrder(ranked.candidate, nowMs);
  if (isOrdinary(ranked.tier) && order.overdue === 1) return order.at;
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
      // Overdue after everything that is not, dated or undated, and decided
      // BEFORE the pinned rule: a pinned side quest whose date is still ahead
      // is live work and an overdue one is not.
      const overdueA = isOrdinary(a.tier) ? ordinaryOrder(a.candidate, nowMs).overdue : 0;
      const overdueB = isOrdinary(b.tier) ? ordinaryOrder(b.candidate, nowMs).overdue : 0;
      if (overdueA !== overdueB) return overdueA - overdueB;
      // A pinned side quest never expires, so it waits for the ones that do.
      if (a.tier === "side" && a.candidate.pinned !== b.candidate.pinned) {
        return a.candidate.pinned ? 1 : -1;
      }
      const byClock = compare(clockKey(a, nowMs), clockKey(b, nowMs));
      if (byClock !== 0) return byClock;
      return compareText(a.candidate.id, b.candidate.id);
    });
}
