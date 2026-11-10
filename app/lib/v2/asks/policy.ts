// When may an ask interrupt? Pure policy over plain values. Quiet hours come from
// the rules (lights out to the wake target of the day the night ends in), using
// the zoned-time helpers; nothing here reads the process clock.

import { zonedDateKey, zonedWallTimeToUtcMs } from "../../snapshots/zoned-time";
import type { Ask, DateKey, Delivery, Instant, PlannerRules } from "../types";

export interface DeliveryContext {
  now: Instant;
  rules: PlannerRules;
  interruptsSentToday: number;
  unansweredOnTopicThisWeek: number;
  /** Share of recent asks that got an answer, 0..1. null = not known yet. */
  weeklyAnswerRate: number | null;
  roughDay: boolean;
}

/** Two unanswered asks on a topic this week and the topic goes quiet. */
const BACKOFF_AT = 2;
/** Below this answer rate the interrupt budget is halved. */
const LOW_ANSWER_RATE = 0.5;
/** A lights-out time before this belongs to the next calendar day (see types.ts). */
const NEXT_DAY_BEFORE_MINUTES = 6 * 60;

function parseWall(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour, minute };
}

/** Calendar arithmetic on a date key. Not a clock read: UTC is only a ruler here. */
function addDays(dateKey: DateKey, days: number): DateKey {
  const [y, m, d] = dateKey.split("-").map(Number);
  return zonedDateKey(Date.UTC(y, m - 1, d + days), "UTC");
}

/** 0 = Sunday, matching `PlannerRules.wakeByWeekday`. */
function weekdayOf(dateKey: DateKey): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(
    Date.UTC(y, m - 1, d),
  );
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/** True when `nowMs` is between lights out and the wake target of the day the night ends in. */
function inQuietHours(nowMs: number, rules: PlannerRules): boolean {
  const zone = rules.timeZone;
  const today = zonedDateKey(nowMs, zone);
  const lights = parseWall(rules.lightsOut);
  const lightsAfterMidnight = lights.hour * 60 + lights.minute < NEXT_DAY_BEFORE_MINUTES;

  // The night that contains `now` ends today (it began last evening or after
  // midnight) or tomorrow (it begins this evening).
  for (const endDate of [today, addDays(today, 1)]) {
    const startDate = lightsAfterMidnight ? endDate : addDays(endDate, -1);
    const wake = parseWall(rules.wakeByWeekday[weekdayOf(endDate)]);
    const start = zonedWallTimeToUtcMs(startDate, lights.hour, lights.minute, zone);
    const end = zonedWallTimeToUtcMs(endDate, wake.hour, wake.minute, zone);
    if (start <= nowMs && nowMs < end) return true;
  }
  return false;
}

function interruptBudget(ctx: DeliveryContext): number {
  const base = ctx.rules.interruptsPerDay;
  return ctx.weeklyAnswerRate !== null && ctx.weeklyAnswerRate < LOW_ANSWER_RATE
    ? Math.ceil(base / 2)
    : base;
}

/**
 * Decides how an ask reaches him. Checked in order:
 * 1. quiet hours hold it (a night-guard ask is the one exception),
 * 2. a topic with two unanswered asks this week holds it,
 * 3. a rough day sends everything to the digest,
 * 4. an ask that is not time-critical goes to the digest,
 * 5. a time-critical ask interrupts while the day's budget has room.
 */
export function decideDelivery(ask: Ask, ctx: DeliveryContext): Delivery {
  if (ask.kind !== "night-guard" && inQuietHours(Date.parse(ctx.now), ctx.rules)) return "hold";
  if (ctx.unansweredOnTopicThisWeek >= BACKOFF_AT) return "hold";
  if (ctx.roughDay) return "digest";
  if (!ask.timeCritical) return "digest";
  return ctx.interruptsSentToday < interruptBudget(ctx) ? "interrupt" : "digest";
}
