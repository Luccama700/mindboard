import { describe, expect, test } from "vitest";

import {
  ENERGY_BUDGET_PER_LEVEL,
  energyBudget,
  tasksCountedToday,
  todayEnergyBudget,
  type BudgetTaskRow,
} from "@/app/lib/snapshots/energy-budget";

describe("energyBudget", () => {
  test("maps the logged level to a budget and subtracts what today carries", () => {
    const b = energyBudget(3, [{ energy_cost: 4 }, { energy_cost: 2 }, { energy_cost: null }]);
    expect(b).toEqual({
      loggedEnergy: 3,
      budget: 3 * ENERGY_BUDGET_PER_LEVEL,
      scheduled: 6,
      remaining: 6,
      unrated: 1,
    });
  });

  test("remaining floors at zero rather than going negative", () => {
    expect(energyBudget(1, [{ energy_cost: 5 }, { energy_cost: 5 }])!.remaining).toBe(0);
  });

  test("no log today means no budget at all; only a real 1-5 level counts", () => {
    expect(energyBudget(null, [{ energy_cost: 3 }])).toBeNull();
    expect(energyBudget(undefined, [])).toBeNull();
    expect(energyBudget(9, [])).toBeNull();
    for (const level of [NaN, Infinity, -Infinity, 2.5]) {
      expect(energyBudget(level, [{ energy_cost: 3 }])).toBeNull();
    }
  });
});

describe("tasksCountedToday", () => {
  const today = "2026-09-15";
  const t = (over: {
    id: string;
    due_date?: string | null;
    parent_task_id?: string | null;
    energy_cost?: number | null;
  }) => ({
    due_date: null,
    parent_task_id: null,
    energy_cost: null,
    ...over,
  });

  test("top-level tasks on or before today count; a parent with open children does not", () => {
    const counted = tasksCountedToday(
      [
        t({ id: "a", due_date: today }),
        t({ id: "late", due_date: "2026-09-10" }),
        t({ id: "future", due_date: "2026-09-20" }),
        t({ id: "parent", due_date: today }),
        t({ id: "child", parent_task_id: "parent", due_date: "2026-09-20" }),
        t({ id: "undated" }),
      ],
      today,
      new Set(),
    ).map((x) => x.id);
    expect(counted).toEqual(["a", "late"]);
  });

  test("children count when planned today or at/past their window end", () => {
    const counted = tasksCountedToday(
      [
        t({ id: "parent", due_date: "2026-09-24" }),
        t({ id: "planned", parent_task_id: "parent", due_date: "2026-09-20" }),
        t({ id: "atEnd", parent_task_id: "parent", due_date: today }),
        t({ id: "later", parent_task_id: "parent", due_date: "2026-09-22" }),
      ],
      today,
      new Set(["planned"]),
    ).map((x) => x.id);
    expect(counted).toEqual(["planned", "atEnd"]);
  });
});

describe("tasksCountedToday hides what the stream hides", () => {
  test("a child whose parent is not among the open tasks does not consume budget", () => {
    const today = "2026-09-15";
    const counted = tasksCountedToday(
      [{ id: "orphan", parent_task_id: "resolved-parent", due_date: today, energy_cost: 5 }],
      today,
      new Set(),
    );
    expect(counted).toEqual([]);
    expect(energyBudget(3, counted)?.remaining).toBe(12);
  });
});

describe("todayEnergyBudget (the shared snapshot recipe)", () => {
  const TZ = "America/Vancouver";
  const today = "2026-09-15";
  const now = new Date("2026-09-15T15:00:00.000Z"); // 08:00 Vancouver
  const row = (over: Partial<BudgetTaskRow> & { id: string }): BudgetTaskRow => ({
    title: over.id,
    due_date: null,
    due_time: null,
    parent_task_id: null,
    not_before: null,
    duration_min: null,
    estimated_minutes: null,
    energy_cost: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  });
  const base = { today, now, events: [], wakeStartHour: 8, wakeEndHour: 22, timeZone: TZ };

  test("null without a check-in, whatever is on the board", () => {
    expect(
      todayEnergyBudget({ ...base, loggedEnergy: null, tasks: [row({ id: "a", due_date: today, energy_cost: 5 })] }),
    ).toBeNull();
  });

  test("today's board plus the children the planner lands on today, not the parent", () => {
    const tasks = [
      row({ id: "a", due_date: today, energy_cost: 4 }),
      row({ id: "p", due_date: "2026-09-20", energy_cost: 5, estimated_minutes: 240 }),
      // Window is only today → must land today.
      row({ id: "c1", parent_task_id: "p", due_date: today, not_before: today, estimated_minutes: 30, energy_cost: 2 }),
      // Window opens tomorrow → cannot count today.
      row({ id: "c2", parent_task_id: "p", due_date: "2026-09-19", not_before: "2026-09-16", estimated_minutes: 30, energy_cost: 3 }),
    ];
    const b = todayEnergyBudget({ ...base, loggedEnergy: 3, tasks });
    expect(b).toEqual({
      loggedEnergy: 3,
      budget: 3 * ENERGY_BUDGET_PER_LEVEL,
      scheduled: 6,
      remaining: 6,
      unrated: 0,
    });
  });

  test("a time-blocked task is busy time: a child cannot be planned into it", () => {
    // The whole wake window is blocked by one timed task, so the flexible
    // child has no free time today and lands later in its window.
    const tasks = [
      row({ id: "block", due_date: today, due_time: "08:00", duration_min: 14 * 60, energy_cost: 1 }),
      row({ id: "p", due_date: "2026-09-17" }),
      row({ id: "c", parent_task_id: "p", due_date: "2026-09-17", not_before: today, estimated_minutes: 30, energy_cost: 3 }),
    ];
    const b = todayEnergyBudget({ ...base, loggedEnergy: 2, tasks });
    expect(b?.scheduled).toBe(1);
  });
});
