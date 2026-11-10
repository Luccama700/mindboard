// Is each data feed alive? Pure: runs and expectations in, one status per feed
// out. The clock arrives as `now`; local hours come from the zone through the
// zoned-time helpers.

import { zonedClockMinutes, zonedDateKey } from "../../snapshots/zoned-time";
import type { Expectation, FeedRun, FeedStatus, Instant, WallTime } from "../types";

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

type FinishedRun = FeedRun & { finishedAt: Instant };

function isFinished(run: FeedRun): run is FinishedRun {
  return run.finishedAt !== null;
}

/** A good run finished, said ok, and produced at least `minCount` items. */
function isGood(run: FinishedRun, expectation: Expectation): boolean {
  return run.status === "ok" && run.count >= expectation.minCount;
}

function minutesOf(time: WallTime): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

/** From inclusive, to exclusive; a window with from after to runs past midnight. */
function inActiveHours(expectation: Expectation, now: Instant, timeZone: string): boolean {
  if (expectation.activeHours === null) return true;
  const local = zonedClockMinutes(Date.parse(now), timeZone);
  const from = minutesOf(expectation.activeHours.from);
  const to = minutesOf(expectation.activeHours.to);
  return from <= to ? from <= local && local < to : local >= from || local < to;
}

function evaluateFeed(
  expectation: Expectation,
  allRuns: FeedRun[],
  now: Instant,
  timeZone: string,
): FeedStatus {
  const nowMs = Date.parse(now);
  // A run with no finishedAt is still going and says nothing yet.
  const finished = allRuns
    .filter((run) => run.feed === expectation.feed)
    .filter(isFinished)
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));

  const newest = finished[0] ?? null;
  const newestGood = finished.find((run) => isGood(run, expectation)) ?? null;
  const lastGoodAt = newestGood ? newestGood.finishedAt : null;
  const status = (state: FeedStatus["state"], cause: string | null): FeedStatus => ({
    feed: expectation.feed,
    state,
    lastGoodAt,
    cause,
  });

  const intervalMs = expectation.everyMinutes * MS_PER_MINUTE;
  const graceMs = expectation.graceMinutes * MS_PER_MINUTE;
  const sinceGoodMs = newestGood ? nowMs - Date.parse(newestGood.finishedAt) : null;

  // 2. A good run inside the interval plus grace.
  if (sinceGoodMs !== null && sinceGoodMs <= intervalMs + graceMs) return status("alive", null);

  // 3. The newest finished run errored.
  if (newest && newest.status === "error") return status("failing", newest.errorClass ?? "error");

  // 4. The newest finished run was ok but came back with too few items.
  if (newest && newest.status === "ok" && newest.count < expectation.minCount) {
    return status("failing", "empty-run");
  }

  // 6. Outside active hours a feed is not downgraded for lateness.
  if (!inActiveHours(expectation, now, timeZone)) return status("alive", null);

  // 5. Late for up to twice the interval plus grace, then blind.
  if (sinceGoodMs !== null && sinceGoodMs <= 2 * intervalMs + graceMs) {
    return status("late", "no-run");
  }
  return status("blind", "no-run");
}

/** One status per expectation, in the order given. */
export function evaluateFeeds(
  expectations: Expectation[],
  runs: FeedRun[],
  now: Instant,
  timeZone: string,
): FeedStatus[] {
  return expectations.map((expectation) => evaluateFeed(expectation, runs, now, timeZone));
}

function dateKeyDay(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

/** Calendar days between two instants in the zone. 0 on the same day, never negative. */
export function daysSince(since: Instant, now: Instant, timeZone: string): number {
  const from = dateKeyDay(zonedDateKey(Date.parse(since), timeZone));
  const to = dateKeyDay(zonedDateKey(Date.parse(now), timeZone));
  return Math.max(0, to - from);
}
