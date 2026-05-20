"use client";

import { startTransition, useOptimistic } from "react";
import {
  deleteTask,
  toggleTaskStatus,
  updateTask,
} from "@/app/actions/tasks";
import { TaskCaptureBar } from "./task-capture-bar";
import { TaskRow, type GroupOption } from "./task-row";
import type { Task } from "./types";

export type { Task } from "./types";

type UpdatePatch = {
  title?: string;
  dueDate?: string | null;
  groupId?: string | null;
  notes?: string | null;
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
  if (patch.groupId !== undefined) next = { ...next, group_id: patch.groupId };
  if (patch.notes !== undefined) next = { ...next, notes: patch.notes };
  return next;
}

export function TasksClient({
  initial,
  groupId,
  groups,
}: {
  initial: Task[];
  groupId: string | null;
  groups: GroupOption[];
}) {
  const [tasks, dispatch] = useOptimistic<Task[], OptimisticAction>(
    initial,
    (state, action) => {
      switch (action.kind) {
        case "add":
          if (action.task.group_id !== groupId) return state;
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
            action.patch.groupId !== groupId
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

  function onUpdate(id: string, patch: UpdatePatch) {
    startTransition(async () => {
      dispatch({ kind: "update", id, patch });
      await updateTask({ id, ...patch });
    });
  }

  const active = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <>
      <div className="space-y-1 pb-4">
        {active.length === 0 && done.length === 0 && (
          <p className="text-[#6b6b6b] text-sm text-center pt-12 pb-8">
            no tasks yet — start typing below.
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
          />
        ))}

        {done.length > 0 && (
          <div className="pt-8">
            <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2 px-1">
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

      <TaskCaptureBar
        groupId={groupId}
        groups={groups}
        onOptimisticAdd={(task) =>
          startTransition(() => dispatch({ kind: "add", task }))
        }
        onReplace={(tempId, task) =>
          startTransition(() =>
            dispatch({ kind: "replace", tempId, task }),
          )
        }
      />
    </>
  );
}
