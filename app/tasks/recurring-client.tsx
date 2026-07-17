"use client";

import { useState, useTransition } from "react";
import {
  archiveRecurringTask,
  updateRecurringTask,
} from "@/app/actions/recurring-tasks";
import type { RecurringTaskRow } from "@/app/lib/data/recurring-tasks";
import { formatRecurrence } from "@/app/lib/recurrence";
import type { GroupOption } from "@/app/_components/task-row";

const WEEKDAY_LABELS = ["s", "m", "t", "w", "t", "f", "s"];

function scheduleLabel(rule: RecurringTaskRow): string {
  const parts = [formatRecurrence(rule)];
  if (rule.due_time) parts.push(`⌚ ${rule.due_time.slice(0, 5)}`);
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
  const [titleDraft, setTitleDraft] = useState(rule.title);
  const [timeDraft, setTimeDraft] = useState(rule.due_time?.slice(0, 5) ?? "");
  const [days, setDays] = useState<number[]>(rule.weekdays ?? []);

  function commitTitle() {
    const next = titleDraft.trim();
    if (next && next !== rule.title) onUpdate(rule.id, { id: rule.id, title: next });
  }

  function commitTime() {
    const next = timeDraft || null;
    if (next !== (rule.due_time?.slice(0, 5) ?? null)) {
      onUpdate(rule.id, { id: rule.id, dueTime: next });
    }
  }

  function toggleDay(day: number) {
    if (rule.frequency !== "weekly") return;
    const next = days.includes(day)
      ? days.filter((d) => d !== day)
      : [...days, day].sort((a, b) => a - b);
    if (next.length === 0) return; // weekly needs at least one day
    setDays(next);
    onUpdate(rule.id, { id: rule.id, frequency: "weekly", weekdays: next });
  }

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
        <div className="px-1 pb-3 space-y-3">
          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => e.key === "Enter" && commitTitle()}
            aria-label="rule title"
            maxLength={200}
            className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
          />

          {rule.frequency === "weekly" && (
            <div className="flex gap-1">
              {WEEKDAY_LABELS.map((label, day) => {
                const active = days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleDay(day)}
                    className={`min-h-11 flex-1 border text-[10px] tracking-widest uppercase transition-colors ${
                      active
                        ? "bg-accent text-accent-fg border-accent"
                        : "border-line-strong text-muted hover:border-fg hover:text-fg"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2">
            <label
              htmlFor={`rule-time-${rule.id}`}
              className="text-[10px] tracking-widest uppercase text-muted"
            >
              time
            </label>
            <input
              id={`rule-time-${rule.id}`}
              type="time"
              value={timeDraft}
              onChange={(e) => setTimeDraft(e.target.value)}
              onBlur={commitTime}
              className="bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm px-2 py-2 focus:outline-none transition-colors"
            />
            {timeDraft && (
              <button
                type="button"
                onClick={() => {
                  setTimeDraft("");
                  onUpdate(rule.id, { id: rule.id, dueTime: null });
                }}
                aria-label="clear time"
                className="text-muted text-lg leading-none hover:text-fg transition-colors px-1.5"
              >
                ×
              </button>
            )}
            <select
              value={rule.group_id ?? ""}
              onChange={(e) =>
                onUpdate(rule.id, { id: rule.id, groupId: e.target.value || null })
              }
              aria-label="group"
              className="ml-auto bg-glass-well rounded-field border border-line-strong text-fg text-sm px-2 py-2 focus:border-accent focus:outline-none transition-colors"
            >
              <option value="">inbox</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => onArchive(rule.id)}
            className="min-h-11 border border-line-strong rounded-full px-3 text-[10px] tracking-widest uppercase text-muted hover:border-danger hover:text-danger transition-colors"
          >
            stop repeating
          </button>
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
              ...(patch.dueTime !== undefined
                ? { due_time: patch.dueTime ? `${patch.dueTime}:00` : null }
                : {}),
              ...(patch.weekdays !== undefined
                ? { weekdays: patch.weekdays ?? null }
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
