// Today's remaining energy budget — the ONE aggregate the energy axis is
// allowed to produce, and only for the day being planned. Never a score, never
// a streak, never a total for a past day: it exists so a planner (the
// assistant, a chat client) can tell whether today still has room for a heavy
// task. Pure; the caller decides which tasks count as today's.

// Budget = logged energy × 4. Anchors: a day logged 3 holds about four
// moderate (cost-3) tasks, 12 points; a 5 day holds twenty; a 1 day holds four
// — one heavy thing, or a few light ones.
export const ENERGY_BUDGET_PER_LEVEL = 4;

export type EnergyBudget = {
  loggedEnergy: number; // today's daily-log energy, 1..5
  budget: number;
  scheduled: number; // sum of energy_cost over today's tasks that carry one
  remaining: number; // budget − scheduled, floored at 0
  unrated: number; // today's tasks with no energy_cost (not in `scheduled`)
};

export function energyBudget(
  loggedEnergy: number | null | undefined,
  tasksToday: { energy_cost: number | null }[],
): EnergyBudget | null {
  if (loggedEnergy == null || loggedEnergy < 1 || loggedEnergy > 5) return null;
  let scheduled = 0;
  let unrated = 0;
  for (const t of tasksToday) {
    if (t.energy_cost == null) unrated++;
    else scheduled += t.energy_cost;
  }
  const budget = loggedEnergy * ENERGY_BUDGET_PER_LEVEL;
  return {
    loggedEnergy,
    budget,
    scheduled,
    remaining: Math.max(0, budget - scheduled),
    unrated,
  };
}

// Which open tasks count as "today's" for the budget: top-level tasks due on
// or before today (the NOW board) — except a parent whose open children stand
// in for it — plus children planned for today or already at/past their
// window end. `plannedToday` holds child ids the planner put on today. A
// child whose parent is not among the open tasks is hidden everywhere else,
// so it does not count here either.
export function tasksCountedToday<
  T extends {
    id: string;
    due_date: string | null;
    parent_task_id: string | null;
    energy_cost: number | null;
  },
>(tasks: T[], today: string, plannedToday: ReadonlySet<string>): T[] {
  const openIds = new Set(tasks.map((t) => t.id));
  const parentsWithOpenChildren = new Set(
    tasks
      .filter((t) => t.parent_task_id && openIds.has(t.parent_task_id))
      .map((t) => t.parent_task_id as string),
  );
  return tasks.filter((t) => {
    if (t.parent_task_id) {
      if (!openIds.has(t.parent_task_id)) return false;
      return plannedToday.has(t.id) || (t.due_date !== null && t.due_date <= today);
    }
    if (parentsWithOpenChildren.has(t.id)) return false;
    return t.due_date !== null && t.due_date <= today;
  });
}
