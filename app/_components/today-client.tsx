"use client";

import { startTransition, useOptimistic } from "react";
import { deleteTask, toggleTaskStatus } from "@/app/actions/tasks";
import { daysFromToday, priorityRank, todayISO } from "./date-utils";
import { TaskCaptureBar } from "./task-capture-bar";
import { TaskRow } from "./task-row";
import type { Task, TaskWithGroup } from "./types";

type OptimisticAction =
  | { kind: "add"; task: TaskWithGroup }
  | { kind: "replace"; tempId: string; task: Task }
  | { kind: "toggle"; id: string; nextStatus: "todo" | "done" }
  | { kind: "delete"; id: string };

export function TodayClient({ initial }: { initial: TaskWithGroup[] }) {
  const [tasks, dispatch] = useOptimistic<TaskWithGroup[], OptimisticAction>(
    initial,
    (state, action) => {
      switch (action.kind) {
        case "add":
          return [action.task, ...state];
        case "replace":
          return state.map((t) =>
            t.id === action.tempId
              ? {
                  ...action.task,
                  group_name: t.group_name,
                  group_color: t.group_color,
                }
              : t,
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

  const today = todayISO();

  const open = tasks.filter((t) => t.status !== "done" && t.due_date);

  const overdue = open
    .filter((t) => daysFromToday(t.due_date!) < 0)
    .sort((a, b) => {
      const p = priorityRank(a.priority) - priorityRank(b.priority);
      if (p !== 0) return p;
      return a.due_date!.localeCompare(b.due_date!);
    });

  const dueToday = open
    .filter((t) => daysFromToday(t.due_date!) === 0)
    .sort((a, b) => {
      const p = priorityRank(a.priority) - priorityRank(b.priority);
      if (p !== 0) return p;
      return a.created_at.localeCompare(b.created_at);
    });

  const dueSoon = open
    .filter((t) => {
      const d = daysFromToday(t.due_date!);
      return d > 0 && d <= 7;
    })
    .sort((a, b) => {
      const p = priorityRank(a.priority) - priorityRank(b.priority);
      if (p !== 0) return p;
      return a.due_date!.localeCompare(b.due_date!);
    });

  const allClear =
    overdue.length === 0 && dueToday.length === 0 && dueSoon.length === 0;

  return (
    <>
      <div className="pb-4 space-y-10">
        {overdue.length > 0 && (
          <section>
            <p className="text-[10px] tracking-widest uppercase text-[#ff6b6b] mb-2 px-1">
              overdue · {overdue.length}
            </p>
            <div>
              {overdue.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  variant="overdue"
                />
              ))}
            </div>
          </section>
        )}

        <section>
          <p className="text-[10px] tracking-widest uppercase text-[#f5f0e8] mb-2 px-1">
            today
            {dueToday.length > 0 && (
              <span className="text-[#6b6b6b]"> · {dueToday.length}</span>
            )}
          </p>
          {dueToday.length === 0 ? (
            <p className="text-[#6b6b6b] text-sm py-2 px-1">
              {allClear
                ? "all clear. type below to capture something."
                : "nothing due today."}
            </p>
          ) : (
            <div>
              {dueToday.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  hideDate
                />
              ))}
            </div>
          )}
        </section>

        {dueSoon.length > 0 && (
          <section>
            <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2 px-1">
              due soon · {dueSoon.length}
            </p>
            <div>
              {dueSoon.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggle={onToggle}
                  onDelete={onDelete}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      <TaskCaptureBar
        groupId={null}
        defaultDueDate={today}
        onOptimisticAdd={(task) =>
          startTransition(() =>
            dispatch({
              kind: "add",
              task: { ...task, group_name: null, group_color: null },
            }),
          )
        }
        onReplace={(tempId, task) =>
          startTransition(() => dispatch({ kind: "replace", tempId, task }))
        }
      />
    </>
  );
}
