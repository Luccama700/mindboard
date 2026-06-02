// Pure task rollup for the dashboard vitals strip: counts of open dated tasks
// that are overdue, due today, or due within the next week. `today` is passed
// in (not read from the clock) so the function stays deterministic and testable.

import { daysBetween } from "@/app/_components/inventory-projection";
import type { TaskWithGroup } from "@/app/_components/types";

export type TaskVitals = {
  overdue: number;
  dueToday: number;
  dueSoon: number;
};

export function tasksSnapshot(
  tasks: TaskWithGroup[],
  today: string,
): TaskVitals {
  let overdue = 0;
  let dueToday = 0;
  let dueSoon = 0;

  for (const task of tasks) {
    if (task.status === "done" || !task.due_date) continue;
    const days = daysBetween(today, task.due_date);
    if (days < 0) overdue++;
    else if (days === 0) dueToday++;
    else if (days <= 7) dueSoon++;
  }

  return { overdue, dueToday, dueSoon };
}
