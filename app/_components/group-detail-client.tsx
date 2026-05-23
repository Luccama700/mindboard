"use client";

import { startTransition, useOptimistic, useState } from "react";
import {
  deleteTask,
  toggleTaskStatus,
  updateTask,
} from "@/app/actions/tasks";
import { TaskCaptureBar } from "./task-capture-bar";
import { TaskRow, type GroupOption } from "./task-row";
import type { Task } from "./types";

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

export function GroupDetailClient({
  initial,
  groupId,
  groups,
  upcomingEventsSlot,
}: {
  initial: Task[];
  groupId: string;
  groups: GroupOption[];
  upcomingEventsSlot?: React.ReactNode;
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

  const [selectedId, setSelectedId] = useState<string | null>(null);

  function onToggle(task: Task) {
    const nextStatus = task.status === "done" ? "todo" : "done";
    startTransition(async () => {
      dispatch({ kind: "toggle", id: task.id, nextStatus });
      await toggleTaskStatus(task.id, task.status);
    });
  }

  function onDelete(id: string) {
    if (selectedId === id) setSelectedId(null);
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

  const selectedTask =
    selectedId !== null ? (tasks.find((t) => t.id === selectedId) ?? null) : null;

  function renderRow(t: Task) {
    return (
      <TaskRow
        key={t.id}
        task={t}
        groups={groups}
        onToggle={onToggle}
        onDelete={onDelete}
        onUpdate={onUpdate}
        open={selectedId === t.id}
        onOpenChange={(next) => setSelectedId(next ? t.id : null)}
        hideNotesInPanel
      />
    );
  }

  return (
    <>
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12 lg:items-start">
        <section className="min-w-0">
          {upcomingEventsSlot}

          <div className="space-y-1 pb-4">
            {active.length === 0 && done.length === 0 && (
              <p className="text-muted text-sm text-center pt-12 pb-8">
                no tasks yet — start typing below.
              </p>
            )}

            {active.map(renderRow)}

            {done.length > 0 && (
              <div className="pt-8">
                <p className="text-[10px] tracking-widest uppercase text-muted mb-2 px-1">
                  done · {done.length}
                </p>
                {done.map(renderRow)}
              </div>
            )}
          </div>
        </section>

        <aside className="min-w-0 flex flex-col min-h-[320px] lg:sticky lg:top-8 lg:h-[calc(100vh-4rem)]">
          <NotesPane task={selectedTask} onUpdate={onUpdate} />
        </aside>
      </div>

      <TaskCaptureBar
        groupId={groupId}
        groups={groups}
        onOptimisticAdd={(task) =>
          startTransition(() => dispatch({ kind: "add", task }))
        }
        onReplace={(tempId, task) =>
          startTransition(() => dispatch({ kind: "replace", tempId, task }))
        }
      />
    </>
  );
}

function NotesPane({
  task,
  onUpdate,
}: {
  task: Task | null;
  onUpdate: (id: string, patch: UpdatePatch) => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-[320px]">
      <p className="text-[10px] tracking-widest uppercase text-muted mb-2 px-1">
        markdown notes
      </p>
      {task ? (
        <NotesEditor key={task.id} task={task} onUpdate={onUpdate} />
      ) : (
        <div className="flex-1 min-h-[280px] border border-line bg-page px-4 py-3 text-muted text-sm">
          select a task to view its notes.
        </div>
      )}
    </div>
  );
}

function NotesEditor({
  task,
  onUpdate,
}: {
  task: Task;
  onUpdate: (id: string, patch: UpdatePatch) => void;
}) {
  const [draft, setDraft] = useState(task.notes ?? "");

  function commit() {
    const next = draft.trim();
    const current = task.notes ?? "";
    if (next === current) return;
    onUpdate(task.id, { notes: next || null });
  }

  return (
    <textarea
      id={`notes-pane-${task.id}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      placeholder="add details..."
      maxLength={5000}
      aria-label={`markdown notes for ${task.title}`}
      className="flex-1 min-h-[280px] w-full resize-none bg-card border border-line-strong focus:border-accent text-fg placeholder-muted text-sm leading-relaxed px-4 py-3 focus:outline-none transition-colors"
    />
  );
}
