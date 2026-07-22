"use client";

import { startTransition, useEffect, useOptimistic, useState } from "react";
import {
  deleteTask,
  markTaskMissed,
  toggleTaskStatus,
  updateTask,
} from "@/app/actions/tasks";
import { autoSortInbox } from "@/app/actions/auto-sort";
import { subscribeCapture } from "./capture-bus";
import { todayISO } from "./date-utils";
import { TaskRow, type GroupOption } from "./task-row";
import type { Task } from "./types";

type UpdatePatch = {
  title?: string;
  dueDate?: string | null;
  estimatedMinutes?: number | null;
  groupId?: string | null;
  notes?: string | null;
  priority?: "low" | "med" | "high";
};

type OptimisticAction =
  | { kind: "add"; task: Task }
  | { kind: "replace"; tempId: string; task: Task }
  | { kind: "toggle"; id: string; nextStatus: "todo" | "done" }
  | { kind: "delete"; id: string }
  | { kind: "update"; id: string; patch: UpdatePatch };

function applyPatch(task: Task, patch: UpdatePatch): Task {
  let next = task;
  if (patch.title !== undefined) next = { ...next, title: patch.title };
  if (patch.dueDate !== undefined) next = { ...next, due_date: patch.dueDate };
  if (patch.estimatedMinutes !== undefined)
    next = { ...next, estimated_minutes: patch.estimatedMinutes };
  if (patch.groupId !== undefined) next = { ...next, group_id: patch.groupId };
  if (patch.notes !== undefined) next = { ...next, notes: patch.notes };
  if (patch.priority !== undefined) next = { ...next, priority: patch.priority };
  return next;
}

// filter: "all" shows every task; null shows the inbox (no group); a group id
// shows that group's tasks.
export type TaskFilter = "all" | string | null;

function matchesFilter(groupId: string | null, filter: TaskFilter): boolean {
  if (filter === "all") return true;
  return groupId === filter;
}

export function TasksClient({
  initial,
  filter,
  groups,
}: {
  initial: Task[];
  filter: TaskFilter;
  groups: GroupOption[];
}) {
  const [tasks, dispatch] = useOptimistic<Task[], OptimisticAction>(
    initial,
    (state, action) => {
      switch (action.kind) {
        case "add":
          if (!matchesFilter(action.task.group_id, filter)) return state;
          return [action.task, ...state];
        case "replace":
          return state.map((t) =>
            t.id === action.tempId ? action.task : t,
          );
        case "toggle":
          return state.map((t) =>
            t.id === action.id
              ? {
                  ...t,
                  status: action.nextStatus,
                  completed_at:
                    action.nextStatus === "done"
                      ? new Date().toISOString()
                      : null,
                }
              : t,
          );
        case "delete":
          return state.filter((t) => t.id !== action.id);
        case "update": {
          if (
            action.patch.groupId !== undefined &&
            !matchesFilter(action.patch.groupId, filter)
          ) {
            return state.filter((t) => t.id !== action.id);
          }
          return state.map((t) =>
            t.id === action.id ? applyPatch(t, action.patch) : t,
          );
        }
      }
    },
  );

  useEffect(
    () =>
      subscribeCapture({
        onOptimisticAdd: (task) =>
          startTransition(() => dispatch({ kind: "add", task })),
        onReplace: (tempId, task) =>
          startTransition(() => dispatch({ kind: "replace", tempId, task })),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter],
  );

  function onToggle(task: Task) {
    const nextStatus = task.status === "done" ? "todo" : "done";
    startTransition(async () => {
      dispatch({ kind: "toggle", id: task.id, nextStatus });
      await toggleTaskStatus(task.id, task.status);
    });
  }

  function onDelete(id: string) {
    startTransition(async () => {
      dispatch({ kind: "delete", id });
      await deleteTask(id);
    });
  }

  function onMiss(id: string) {
    startTransition(async () => {
      dispatch({ kind: "delete", id });
      await markTaskMissed(id);
    });
  }

  function onUpdate(id: string, patch: UpdatePatch) {
    startTransition(async () => {
      dispatch({ kind: "update", id, patch });
      await updateTask({ id, ...patch });
    });
  }

  const [sorting, setSorting] = useState(false);
  const [sortNote, setSortNote] = useState<string | null>(null);

  function onAutoSort() {
    setSorting(true);
    setSortNote(null);
    startTransition(async () => {
      const result = await autoSortInbox();
      setSorting(false);
      if (result.error) {
        setSortNote(result.error);
        return;
      }
      const moves = result.moves ?? [];
      if (moves.length === 0) {
        setSortNote("nothing sorted — no confident matches");
        return;
      }
      const names = new Map(groups.map((g) => [g.id, g.name]));
      const counts = new Map<string, number>();
      for (const m of moves) {
        counts.set(m.groupId, (counts.get(m.groupId) ?? 0) + 1);
      }
      const breakdown = [...counts]
        .map(([id, n]) => `${names.get(id) ?? "?"} ×${n}`)
        .join(" · ");
      const left = result.left ?? 0;
      setSortNote(
        `sorted ${moves.length} → ${breakdown}${left > 0 ? ` · ${left} left in inbox` : ""}`,
      );
    });
  }

  const today = todayISO();
  const active = tasks.filter(
    (t) => t.status !== "done" && t.status !== "missed",
  );
  const done = tasks.filter((t) => t.status === "done");
  const showAutoSort =
    filter === null && groups.length > 0 && (active.length > 0 || !!sortNote);

  return (
    <div className="space-y-1 pb-4">
      {showAutoSort && (
        <div className="flex flex-wrap items-center gap-3 pb-2">
          <button
            type="button"
            onClick={onAutoSort}
            disabled={sorting}
            className="inline-flex items-center min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-muted hover:text-fg transition-colors disabled:opacity-50"
          >
            {sorting ? "sorting…" : "✦ auto sort"}
          </button>
          {sortNote && <p className="text-meta text-muted">{sortNote}</p>}
        </div>
      )}
      {active.length === 0 && done.length === 0 && (
        <p className="text-muted text-sm text-center pt-12 pb-8">
          no tasks here — capture one below.
        </p>
      )}

      {active.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          groups={groups}
          onToggle={onToggle}
          onDelete={onDelete}
          onUpdate={onUpdate}
          onMiss={onMiss}
          variant={
            t.due_date && t.due_date < today && t.status === "todo"
              ? "overdue"
              : "default"
          }
        />
      ))}

      {done.length > 0 && (
        <div className="pt-8">
          <p className="text-[10px] tracking-widest uppercase text-muted mb-2 px-1">
            done · {done.length}
          </p>
          {done.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              groups={groups}
              onToggle={onToggle}
              onDelete={onDelete}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
