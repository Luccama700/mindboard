"use client";

import { useState, useTransition } from "react";
import {
  archiveRecurringTask,
  updateRecurringTask,
} from "@/app/actions/recurring-tasks";
import type { RecurringTaskRow } from "@/app/lib/data/recurring-tasks";
import { formatRecurrence } from "@/app/lib/recurrence";
import type { GroupOption } from "@/app/_components/task-row";
import { RecurringEditPanel } from "@/app/_components/recurring-edit-panel";

function durationLabel(m: number): string {
  return m < 60 ? `${m}m` : `${m / 60}h`;
}

function scheduleLabel(rule: RecurringTaskRow): string {
  const parts = [formatRecurrence(rule)];
  if (rule.due_time) {
    parts.push(
      rule.duration_min
        ? `${rule.due_time.slice(0, 5)} · ${durationLabel(rule.duration_min)}`
        : rule.due_time.slice(0, 5),
    );
  } else if (rule.duration_min) {
    parts.push(durationLabel(rule.duration_min));
  }
  if (rule.group_name) parts.push(rule.group_name);
  return parts.join(" · ");
}

function RuleRow({
  rule,
  groups,
  onArchive,
  onUpdate,
}: {
  rule: RecurringTaskRow;
  groups: GroupOption[];
  onArchive: (id: string) => void;
  onUpdate: (id: string, patch: Parameters<typeof updateRecurringTask>[0]) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <li className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-h-11 items-center gap-3 rounded-lg px-1 py-2 text-left hover:bg-card transition-colors"
      >
        <span className="text-muted" aria-hidden>
          ↻
        </span>
        <span className="flex-1 min-w-0 truncate text-sm text-fg">
          {rule.title}
        </span>
        <span className="text-meta text-muted shrink-0">
          {scheduleLabel(rule)}
        </span>
      </button>

      {open && (
        <div className="px-1">
          <RecurringEditPanel
            rule={rule}
            groups={groups}
            onUpdate={(patch) => onUpdate(rule.id, { id: rule.id, ...patch })}
            onArchive={() => onArchive(rule.id)}
          />
        </div>
      )}
    </li>
  );
}

export function RecurringClient({
  initial,
  groups,
}: {
  initial: RecurringTaskRow[];
  groups: GroupOption[];
}) {
  const [rules, setRules] = useState(initial);
  const [, startTransition] = useTransition();

  function onArchive(id: string) {
    setRules((prev) => prev.filter((r) => r.id !== id));
    startTransition(async () => {
      await archiveRecurringTask(id);
    });
  }

  function onUpdate(
    id: string,
    patch: Parameters<typeof updateRecurringTask>[0],
  ) {
    setRules((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.priority !== undefined
                ? { priority: patch.priority }
                : {}),
              ...(patch.dueTime !== undefined
                ? { due_time: patch.dueTime ? `${patch.dueTime}:00` : null }
                : {}),
              ...(patch.durationMin !== undefined
                ? { duration_min: patch.durationMin ?? null }
                : {}),
              ...(patch.frequency !== undefined
                ? { frequency: patch.frequency }
                : {}),
              ...(patch.weekdays !== undefined
                ? { weekdays: patch.weekdays ?? null }
                : {}),
              ...(patch.dayOfMonth !== undefined
                ? { day_of_month: patch.dayOfMonth ?? null }
                : {}),
              ...(patch.intervalDays !== undefined
                ? { interval_days: patch.intervalDays ?? null }
                : {}),
              ...(patch.startDate !== undefined
                ? { start_date: patch.startDate ?? null }
                : {}),
              ...(patch.groupId !== undefined
                ? {
                    group_id: patch.groupId,
                    group_name:
                      groups.find((g) => g.id === patch.groupId)?.name ?? null,
                  }
                : {}),
            }
          : r,
      ),
    );
    startTransition(async () => {
      await updateRecurringTask(patch);
    });
  }

  if (rules.length === 0) {
    return (
      <p className="text-sm text-muted">
        nothing repeats yet — type a task like &quot;lunch 12:30 daily&quot; or
        &quot;gym mon/wed/fri 17:00&quot; below.
      </p>
    );
  }

  return (
    <ul>
      {rules.map((rule) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          groups={groups}
          onArchive={onArchive}
          onUpdate={onUpdate}
        />
      ))}
    </ul>
  );
}
