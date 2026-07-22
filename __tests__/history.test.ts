import { describe, expect, test } from "vitest";

import { historyRollup, type HistoryRow } from "@/app/lib/snapshots/history";

function row(partial: Partial<HistoryRow>): HistoryRow {
  return {
    id: "r",
    title: "task",
    status: "done",
    completed_at: null,
    missed_at: null,
    group_name: null,
    group_color: null,
    ...partial,
  };
}

// Wednesday. Its Monday-start week begins 2026-07-20.
const TODAY = "2026-07-22";

describe("historyRollup", () => {
  test("empty input yields only the current (empty) week and no days", () => {
    const roll = historyRollup([], TODAY, "America/New_York");
    expect(roll.days).toEqual([]);
    expect(roll.weeks).toEqual([{ startKey: "2026-07-20", done: 0, missed: 0 }]);
  });

  test("a Sunday-23:30-local event lands in that Sunday's week, not the UTC-Monday one", () => {
    // 2026-07-19 23:30 America/New_York (EDT, UTC-4) = 2026-07-20 03:30 UTC.
    // Naive UTC bucketing would file it under Monday 2026-07-20 (current week);
    // zoned bucketing keeps it on Sunday 2026-07-19 → week starting 2026-07-13.
    const roll = historyRollup(
      [row({ id: "sun", status: "done", completed_at: "2026-07-20T03:30:00Z" })],
      TODAY,
      "America/New_York",
    );
    expect(roll.days[0].dateKey).toBe("2026-07-19");
    expect(roll.weeks).toEqual([
      { startKey: "2026-07-20", done: 0, missed: 0 },
      { startKey: "2026-07-13", done: 1, missed: 0 },
    ]);
  });

  test("done and missed on the same day sort desc by timestamp within the day", () => {
    const roll = historyRollup(
      [
        row({ id: "early", status: "done", completed_at: "2026-07-21T09:00:00Z" }),
        row({ id: "late", status: "missed", missed_at: "2026-07-21T20:00:00Z" }),
        row({ id: "mid", status: "done", completed_at: "2026-07-21T14:00:00Z" }),
      ],
      TODAY,
      "America/New_York",
    );
    expect(roll.days).toHaveLength(1);
    expect(roll.days[0].events.map((e) => e.id)).toEqual(["late", "mid", "early"]);
    expect(roll.days[0].events[0].kind).toBe("missed");
  });

  test("weeks are Monday-start, current-first, capped at 4, only where data lands", () => {
    const roll = historyRollup(
      [
        row({ id: "w0", status: "done", completed_at: "2026-07-21T15:00:00Z" }), // wk 07-20
        row({ id: "w1a", status: "done", completed_at: "2026-07-15T15:00:00Z" }), // wk 07-13
        row({ id: "w1b", status: "missed", missed_at: "2026-07-14T15:00:00Z" }), // wk 07-13
        row({ id: "w2", status: "missed", missed_at: "2026-07-08T15:00:00Z" }), // wk 07-06
      ],
      TODAY,
      "America/New_York",
    );
    expect(roll.weeks).toEqual([
      { startKey: "2026-07-20", done: 1, missed: 0 },
      { startKey: "2026-07-13", done: 1, missed: 1 },
      { startKey: "2026-07-06", done: 0, missed: 1 },
    ]);
  });

  test("rows missing their status timestamp are skipped", () => {
    const roll = historyRollup(
      [
        row({ id: "no-ts", status: "done", completed_at: null }),
        row({ id: "ok", status: "missed", missed_at: "2026-07-21T15:00:00Z" }),
      ],
      TODAY,
      "America/New_York",
    );
    expect(roll.days).toHaveLength(1);
    expect(roll.days[0].events).toHaveLength(1);
    expect(roll.days[0].events[0].id).toBe("ok");
  });
});
