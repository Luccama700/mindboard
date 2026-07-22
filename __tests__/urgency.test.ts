import { describe, expect, test } from "vitest";

import {
  daysLate,
  urgencyScore,
  urgencyTier,
  type UrgencyTask,
} from "@/app/lib/snapshots/urgency";

const TODAY = "2026-07-06";
const NOON = "12:00";

function t(over: Partial<UrgencyTask> = {}): UrgencyTask {
  return {
    due_date: null,
    due_time: null,
    priority: "med",
    estimated_minutes: null,
    ...over,
  };
}

describe("daysLate", () => {
  test.each([
    ["2026-07-06", 0],
    ["2026-07-05", 1],
    ["2026-07-01", 5],
    ["2026-06-20", 16],
    ["2026-07-08", -2],
  ])("%s -> %d", (due, expected) => {
    expect(daysLate(due, TODAY)).toBe(expected);
  });
});

describe("urgencyScore — components", () => {
  test.each<[string, UrgencyTask, string | undefined, number]>([
    // priority alone (no date)
    ["low, no date", t({ priority: "low" }), NOON, 0],
    ["med, no date", t({ priority: "med" }), NOON, 3],
    ["high, no date", t({ priority: "high" }), NOON, 6],
    // overdue: daysLate × 10 + priority
    ["1d late med", t({ due_date: "2026-07-05" }), NOON, 13],
    ["3d late med", t({ due_date: "2026-07-03" }), NOON, 33],
    ["1d late high", t({ due_date: "2026-07-05", priority: "high" }), NOON, 16],
    // due today
    ["due today untimed med", t({ due_date: TODAY }), NOON, 6],
    ["due today low untimed", t({ due_date: TODAY, priority: "low" }), NOON, 3],
    // due today, time passed (+8)
    [
      "due today time passed",
      t({ due_date: TODAY, due_time: "11:00:00" }),
      NOON,
      3 + 8 + 3,
    ],
    // due today, within 2h (+5)
    [
      "due today within 2h",
      t({ due_date: TODAY, due_time: "13:30" }),
      NOON,
      3 + 5 + 3,
    ],
    // due today, more than 2h away (no time boost)
    [
      "due today >2h away",
      t({ due_date: TODAY, due_time: "15:00" }),
      NOON,
      3 + 3,
    ],
    // no nowClock -> no time boost even with a due_time
    [
      "due today timed, no clock",
      t({ due_date: TODAY, due_time: "11:00" }),
      undefined,
      3 + 3,
    ],
    // estimate boost only when due today or late
    [
      "estimate ignored when not urgent",
      t({ estimated_minutes: 240 }),
      NOON,
      3,
    ],
    [
      "estimate ≥30m due today",
      t({ due_date: TODAY, estimated_minutes: 30 }),
      NOON,
      3 + 3 + 1,
    ],
    [
      "estimate ≥60m late",
      t({ due_date: "2026-07-05", estimated_minutes: 90 }),
      NOON,
      10 + 3 + 2,
    ],
    [
      "estimate ≥120m due today",
      t({ due_date: TODAY, estimated_minutes: 120 }),
      NOON,
      3 + 3 + 3,
    ],
    // spec sanity example: high-priority 2h task due today, time passed
    [
      "high 2h due today time passed",
      t({
        due_date: TODAY,
        due_time: "11:00",
        priority: "high",
        estimated_minutes: 120,
      }),
      NOON,
      20,
    ],
  ])("%s = %d", (_label, task, clock, expected) => {
    expect(urgencyScore(task, TODAY, clock)).toBe(expected);
  });
});

describe("urgencyTier — thresholds", () => {
  test.each<[number, 0 | 1 | 2 | 3]>([
    [0, 0],
    [1, 1],
    [7, 1],
    [8, 2],
    [13, 2],
    [14, 3],
    [20, 3],
  ])("score %d -> tier %d", (score, tier) => {
    expect(urgencyTier(score)).toBe(tier);
  });

  test("spec sanity tiers", () => {
    // high-priority 2h task due today, time passed -> 20 -> focus
    expect(
      urgencyTier(
        urgencyScore(
          t({
            due_date: TODAY,
            due_time: "11:00",
            priority: "high",
            estimated_minutes: 120,
          }),
          TODAY,
          NOON,
        ),
      ),
    ).toBe(3);
    // 3-days-late med task -> 33 -> focus
    expect(
      urgencyTier(urgencyScore(t({ due_date: "2026-07-03" }), TODAY, NOON)),
    ).toBe(3);
    // low task due today, untimed, no estimate -> 3 -> standard
    expect(
      urgencyTier(
        urgencyScore(t({ due_date: TODAY, priority: "low" }), TODAY, NOON),
      ),
    ).toBe(1);
  });
});
