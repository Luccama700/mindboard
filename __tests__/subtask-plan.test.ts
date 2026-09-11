import { describe, expect, test } from "vitest";

import { planSubtasks, type SubtaskPlanChild } from "@/app/lib/snapshots/gap-plan";
import type { FreeInterval } from "@/app/lib/snapshots/schedule";

const TODAY = "2026-09-15";

function iv(startMinutes: number, endMinutes: number): FreeInterval {
  return { startMinutes, endMinutes, minutes: endMinutes - startMinutes };
}

function child(over: Partial<SubtaskPlanChild> & { id: string }): SubtaskPlanChild {
  return {
    parent_task_id: "essay",
    due_date: "2026-09-24",
    not_before: null,
    duration_min: null,
    estimated_minutes: 60,
    energy_cost: 3,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

// Every day in [from, to] gets the same free intervals.
function days(from: string, to: string, intervals: FreeInterval[]): Map<string, FreeInterval[]> {
  const map = new Map<string, FreeInterval[]>();
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor.getTime() <= end.getTime()) {
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    map.set(`${cursor.getFullYear()}-${m}-${d}`, intervals.map((x) => ({ ...x })));
    cursor.setDate(cursor.getDate() + 1);
  }
  return map;
}

const WIDE_OPEN = days(TODAY, "2026-09-30", [iv(540, 1020)]); // 09:00–17:00 free

function byId(planned: ReturnType<typeof planSubtasks>) {
  return new Map(planned.map((p) => [p.taskId, p]));
}

describe("planSubtasks — backwards from the deadline", () => {
  test("each child lands on the latest day of its own window, quarter-aligned", () => {
    const planned = byId(
      planSubtasks({
        today: TODAY,
        children: [
          child({ id: "quotes", not_before: "2026-09-15", due_date: "2026-09-18", estimated_minutes: 20 }),
          child({ id: "outline", not_before: "2026-09-17", due_date: "2026-09-20", estimated_minutes: 40 }),
          child({ id: "draft", not_before: "2026-09-19", due_date: "2026-09-22", estimated_minutes: 90 }),
          child({ id: "edit", not_before: "2026-09-22", due_date: "2026-09-24", estimated_minutes: 45 }),
        ],
        intervalsByDay: WIDE_OPEN,
      }),
    );
    expect(planned.get("edit")).toMatchObject({ dateKey: "2026-09-24", start: "09:00", end: "09:45", fitted: true });
    expect(planned.get("draft")).toMatchObject({ dateKey: "2026-09-22", start: "09:00", end: "10:30" });
    expect(planned.get("outline")).toMatchObject({ dateKey: "2026-09-20", start: "09:00", end: "09:40" });
    expect(planned.get("quotes")).toMatchObject({ dateKey: "2026-09-18", start: "09:00", end: "09:20" });
  });

  test("a day's free time is carved as children land, pushing the next one earlier", () => {
    const intervals = days(TODAY, "2026-09-20", [iv(600, 660)]); // one 60-minute gap per day
    const planned = byId(
      planSubtasks({
        today: TODAY,
        children: [
          child({ id: "a", due_date: "2026-09-20", estimated_minutes: 45 }),
          child({ id: "b", due_date: "2026-09-20", estimated_minutes: 30 }),
        ],
        intervalsByDay: intervals,
      }),
    );
    // Longer child is taken first and takes the deadline day; the shorter one
    // no longer fits there (15 min left) and moves to the day before.
    expect(planned.get("a")).toMatchObject({ dateKey: "2026-09-20", start: "10:00" });
    expect(planned.get("b")).toMatchObject({ dateKey: "2026-09-19", start: "10:00" });
  });

  test("a child that fits nowhere still lands on its window's last day, untimed", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "big", due_date: "2026-09-17", estimated_minutes: 300 })],
      intervalsByDay: days(TODAY, "2026-09-17", [iv(600, 660)]),
    });
    expect(planned).toEqual([
      {
        taskId: "big",
        parentId: "essay",
        dateKey: "2026-09-17",
        start: null,
        end: null,
        minutes: 300,
        fitted: false,
      },
    ]);
  });

  test("days without busy data are skipped for fitting; none covered → fallback", () => {
    const planned = byId(
      planSubtasks({
        today: TODAY,
        children: [
          child({ id: "near", due_date: "2026-09-17" }),
          child({ id: "far", not_before: "2026-09-25", due_date: "2026-09-28" }),
        ],
        intervalsByDay: days(TODAY, "2026-09-20", [iv(540, 1020)]),
      }),
    );
    expect(planned.get("near")).toMatchObject({ dateKey: "2026-09-17", fitted: true });
    expect(planned.get("far")).toMatchObject({ dateKey: "2026-09-28", fitted: false, start: null });
  });

  test("children already past their window end are left to the overdue path", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "late", due_date: "2026-09-14" })],
      intervalsByDay: WIDE_OPEN,
    });
    expect(planned).toEqual([]);
  });

  test("a not_before in the past clamps the window to today", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "x", not_before: "2026-09-01", due_date: "2026-09-15" })],
      intervalsByDay: WIDE_OPEN,
    });
    expect(planned[0]).toMatchObject({ dateKey: TODAY, fitted: true });
  });

  test("duration_min wins over estimated_minutes, default 30", () => {
    const planned = byId(
      planSubtasks({
        today: TODAY,
        children: [
          child({ id: "d", duration_min: 15, estimated_minutes: 120 }),
          child({ id: "e", duration_min: null, estimated_minutes: null }),
        ],
        intervalsByDay: WIDE_OPEN,
      }),
    );
    expect(planned.get("d")!.minutes).toBe(15);
    expect(planned.get("e")!.minutes).toBe(30);
  });
});

describe("planSubtasks — energy as a soft preference", () => {
  test("a heavy child avoids a low-energy today when a later day fits", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "draft", energy_cost: 5, due_date: "2026-09-17" })],
      intervalsByDay: WIDE_OPEN,
      energyByDay: new Map([[TODAY, 2]]),
    });
    expect(planned[0].dateKey).toBe("2026-09-17");
  });

  test("a heavy child prefers a high-energy today over a later neutral day", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "draft", energy_cost: 4, due_date: "2026-09-17" })],
      intervalsByDay: WIDE_OPEN,
      energyByDay: new Map([[TODAY, 4]]),
    });
    expect(planned[0].dateKey).toBe(TODAY);
  });

  test("a light child fills a low-energy today", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "quotes", energy_cost: 1, due_date: "2026-09-18" })],
      intervalsByDay: WIDE_OPEN,
      energyByDay: new Map([[TODAY, 1]]),
    });
    expect(planned[0].dateKey).toBe(TODAY);
  });

  test("a medium child ignores energy and stays latest-first", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "m", energy_cost: 3, due_date: "2026-09-18" })],
      intervalsByDay: WIDE_OPEN,
      energyByDay: new Map([[TODAY, 5]]),
    });
    expect(planned[0].dateKey).toBe("2026-09-18");
  });

  test("energy never blocks a placement: the only day wins even on a low day", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "draft", energy_cost: 5, due_date: TODAY })],
      intervalsByDay: WIDE_OPEN,
      energyByDay: new Map([[TODAY, 1]]),
    });
    expect(planned[0]).toMatchObject({ dateKey: TODAY, fitted: true });
  });

  test("no log for a day means no preference", () => {
    const planned = planSubtasks({
      today: TODAY,
      children: [child({ id: "draft", energy_cost: 5, due_date: "2026-09-17" })],
      intervalsByDay: WIDE_OPEN,
    });
    expect(planned[0].dateKey).toBe("2026-09-17");
  });
});

describe("planSubtasks — the preference never costs a deadline", () => {
  test("a flexible heavy child does not take an urgent child's only gap today", () => {
    const tomorrow = "2026-09-16";
    const make = (id: string, due_date: string) =>
      child({ id, due_date, not_before: TODAY, estimated_minutes: 60, energy_cost: 4 });
    const planned = byId(
      planSubtasks({
        today: TODAY,
        children: [make("flexible", tomorrow), make("urgent", TODAY)],
        intervalsByDay: new Map([
          [TODAY, [iv(540, 600)]],
          [tomorrow, [iv(540, 600)]],
        ]),
        energyByDay: new Map([[TODAY, 5]]),
      }),
    );
    expect(planned.get("urgent")).toMatchObject({ dateKey: TODAY, fitted: true });
    expect(planned.get("flexible")).toMatchObject({ dateKey: tomorrow, fitted: true });
  });

  test("a child that moved for energy gives its old gap back", () => {
    // Pass 1 (energy-blind): heavy takes the 17th, later fits only today.
    // Pass 2: heavy would prefer today (logged 5) but that gap is taken, so
    // it stays — nothing placed in pass 1 is ever displaced.
    const planned = byId(
      planSubtasks({
        today: TODAY,
        children: [
          child({ id: "heavy", energy_cost: 5, due_date: "2026-09-17", estimated_minutes: 60 }),
          child({ id: "later", energy_cost: 3, due_date: "2026-09-17", estimated_minutes: 60 }),
        ],
        intervalsByDay: new Map([
          [TODAY, [iv(540, 600)]],
          ["2026-09-16", []],
          ["2026-09-17", [iv(540, 600)]],
        ]),
        energyByDay: new Map([[TODAY, 5]]),
      }),
    );
    expect(planned.get("heavy")).toMatchObject({ dateKey: "2026-09-17", fitted: true });
    expect(planned.get("later")).toMatchObject({ dateKey: TODAY, fitted: true });
  });
});
