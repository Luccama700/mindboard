// Turns feed statuses into alert actions: one open alert per cause, escalating
// on a timer, closing when the cause clears. Pure; ids come from `newId`, time
// from `now`.
//
// The caller applies the actions. `update` is silent (stored, never sent): it
// carries an open alert whose feed list changed when nothing else happens to it.
// `escalate` and `close` also carry the current feed list.

import type { Alert, AlertAction, FeedStatus, Instant } from "../types";

const HOUR_MS = 3_600_000;
/** Open this long and the alert is at step 1. */
const STEP_1_AFTER_MS = 2 * HOUR_MS;
/** Open this long and the alert is at step 2. */
const STEP_2_AFTER_MS = 12 * HOUR_MS;

/** Cause used when a failing feed arrives without one, so it still gets an alert. */
const UNKNOWN_CAUSE = "unknown";

/** Failing and blind feeds raise alerts. Alive and late ones do not. */
function raisesAlert(status: FeedStatus): boolean {
  return status.state === "failing" || status.state === "blind";
}

/** Failing feeds grouped by cause, causes and feeds in order of first appearance. */
function groupByCause(statuses: FeedStatus[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const status of statuses) {
    if (!raisesAlert(status)) continue;
    const cause = status.cause ?? UNKNOWN_CAUSE;
    const feeds = groups.get(cause) ?? [];
    if (!feeds.includes(status.feed)) feeds.push(status.feed);
    groups.set(cause, feeds);
  }
  return groups;
}

/** The step an alert's age calls for. Age alone decides it. */
function stepForAge(alert: Alert, nowMs: number): 0 | 1 | 2 {
  const openMs = nowMs - Date.parse(alert.since);
  if (openMs >= STEP_2_AFTER_MS) return 2;
  if (openMs >= STEP_1_AFTER_MS) return 1;
  return 0;
}

function sameFeeds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((feed) => b.includes(feed));
}

export function planAlerts(
  statuses: FeedStatus[],
  open: Alert[],
  now: Instant,
  newId: () => string,
): AlertAction[] {
  const nowMs = Date.parse(now);
  const openAlerts = open.filter((alert) => alert.status === "open");
  const groups = groupByCause(statuses);
  const actions: AlertAction[] = [];

  for (const [cause, feeds] of groups) {
    const existing = openAlerts.find((alert) => alert.cause === cause);
    if (!existing) {
      actions.push({
        type: "open",
        alert: {
          id: newId(),
          cause,
          feeds,
          since: now,
          step: 0,
          lastSentAt: null,
          status: "open",
        },
      });
      continue;
    }
    // Straight to the step the age calls for; never back down.
    const step = stepForAge(existing, nowMs);
    if (step > existing.step) {
      actions.push({ type: "escalate", alert: { ...existing, feeds, step, lastSentAt: now } });
    } else if (!sameFeeds(existing.feeds, feeds)) {
      actions.push({ type: "update", alert: { ...existing, feeds } });
    }
  }

  for (const alert of openAlerts) {
    if (!groups.has(alert.cause)) {
      actions.push({ type: "close", alert: { ...alert, status: "closed" } });
    }
  }
  return actions;
}
