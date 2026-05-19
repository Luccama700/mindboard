"use client";

import { startTransition, useOptimistic } from "react";
import { deleteTask, toggleTaskStatus } from "@/app/actions/tasks";
import { TaskCaptureBar } from "./task-capture-bar";
import { TaskRow } from "./task-row";
import type { Task } from "./types";

export type { Task } from "./types";

type OptimisticAction =
  | { kind: "add"; task: Task }
  | { kind: "replace"; tempId: string; task: Task }
  | { kind: "toggle"; id: string; nextStatus: "todo" | "done" }
  | { kind: "delete"; id: string };

export function TasksClient({
  initial,
  groupId,
}: {
  initial: Task[];
  groupId: string | null;
}) {
  const [tasks, dispatch] = useOptimistic<Task[], OptimisticAction>(
    initial,
    (state, action) => {
      switch (action.kind) {
        case "add":
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
            onToggle={onToggle}
            onDelete={onDelete}
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
                onToggle={onToggle}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>

      <TaskCaptureBar
        groupId={groupId}
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
