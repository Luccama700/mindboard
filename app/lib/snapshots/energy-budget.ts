import { addDaysKey } from "@/app/_components/finance-projection";
import { planSubtasks } from "@/app/lib/snapshots/gap-plan";
import {
  freeIntervalsForDay,
  type ScheduleEvent,
} from "@/app/lib/snapshots/schedule";
import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";

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
  if (
    loggedEnergy == null ||
    !Number.isInteger(loggedEnergy) ||
    loggedEnergy < 1 ||
    loggedEnergy > 5
  ) {
    return null;
  }
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

export type BudgetTaskRow = {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null;
  parent_task_id: string | null;
  not_before: string | null;
  duration_min: number | null;
  estimated_minutes: number | null;
  energy_cost: number | null;
  created_at: string;
};

export const BUDGET_PLAN_DAYS = 3;

// The whole recipe behind every `energyBudget` field the snapshots expose
// (MCP schedule_snapshot, the assistant's lean get_snapshot): time-blocked
// tasks join the events as busy time, the open children are planned over the
// next few days' free intervals, and the ones landing on today count beside
// today's board. Pure; the caller fetches the rows. Returns null without a
// check-in, before doing any planning.
export function todayEnergyBudget(input: {
  today: string;
  loggedEnergy: number | null | undefined;
  tasks: BudgetTaskRow[]; // every open task (todo/doing)
  events: ScheduleEvent[];
  now: Date;
  wakeStartHour: number;
  wakeEndHour: number;
  timeZone: string | null;
  days?: number;
}): EnergyBudget | null {
  const { today, loggedEnergy, tasks, now, wakeStartHour, wakeEndHour, timeZone } = input;
  if (energyBudget(loggedEnergy, []) === null) return null;
  const days = input.days ?? BUDGET_PLAN_DAYS;

  const openIds = new Set(tasks.map((t) => t.id));
  const busy: ScheduleEvent[] = [...input.events];
  for (const t of tasks) {
    if (!t.due_date || !t.due_time) continue;
    const [h, m] = t.due_time.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    const startMs = zonedWallTimeToUtcMs(t.due_date, h, m, timeZone);
    const endMs = startMs + (t.duration_min ?? t.estimated_minutes ?? 30) * 60_000;
    busy.push({
      summary: t.title,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      allDay: false,
    });
  }
  const intervalsByDay = new Map(
    Array.from({ length: days }, (_, i) => addDaysKey(today, i)).map((dateKey) => [
      dateKey,
      freeIntervalsForDay({ events: busy, dateKey, now, wakeStartHour, wakeEndHour, timeZone }),
    ]),
  );
  const plannedToday = new Set(
    planSubtasks({
      today,
      children: tasks
        .filter(
          (t) =>
            t.parent_task_id !== null && t.due_date !== null && openIds.has(t.parent_task_id),
        )
        .map((t) => ({
          id: t.id,
          parent_task_id: t.parent_task_id as string,
          due_date: t.due_date as string,
          due_time: t.due_time,
          not_before: t.not_before,
          duration_min: t.duration_min,
          estimated_minutes: t.estimated_minutes,
          energy_cost: t.energy_cost,
          created_at: t.created_at,
        })),
      intervalsByDay,
      energyByDay: new Map([[today, loggedEnergy as number]]),
    })
      .filter((p) => p.dateKey === today)
      .map((p) => p.taskId),
  );
  return energyBudget(loggedEnergy, tasksCountedToday(tasks, today, plannedToday));
}
