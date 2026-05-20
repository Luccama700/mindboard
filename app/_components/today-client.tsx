"use client";

import { startTransition, useOptimistic } from "react";
import {
  deleteTask,
  toggleTaskStatus,
  updateTask,
} from "@/app/actions/tasks";
import type { CalendarEvent } from "@/utils/google/calendar";
import { daysFromToday, priorityRank, todayISO } from "./date-utils";
import { EventRow, type VirtualEvent } from "./event-row";
import { TaskCaptureBar } from "./task-capture-bar";
import { TaskRow, type GroupOption } from "./task-row";
import type { Task, TaskWithGroup } from "./types";

type CalendarLink = {
  groupId: string;
  groupName: string;
  groupColor: string;
};

type UpdatePatch = {
  title?: string;
  dueDate?: string | null;
  groupId?: string | null;
};

type OptimisticAction =
  | { kind: "add"; task: TaskWithGroup }
  | { kind: "replace"; tempId: string; task: Task }
  | { kind: "toggle"; id: string; nextStatus: "todo" | "done" }
  | { kind: "delete"; id: string }
  | {
      kind: "update";
      id: string;
      patch: UpdatePatch;
      groups: GroupOption[];
    };

type ListItem =
  | { kind: "task"; sortKey: string; task: TaskWithGroup }
  | { kind: "event"; sortKey: string; event: VirtualEvent };

function applyPatch(
  task: TaskWithGroup,
  patch: UpdatePatch,
  groups: GroupOption[],
): TaskWithGroup {
  let next = task;
  if (patch.title !== undefined) next = { ...next, title: patch.title };
  if (patch.dueDate !== undefined) next = { ...next, due_date: patch.dueDate };
  if (patch.groupId !== undefined) {
    const group = patch.groupId
      ? (groups.find((g) => g.id === patch.groupId) ?? null)
      : null;
    next = {
      ...next,
      group_id: patch.groupId,
      group_name: group?.name ?? null,
      group_color: group?.color ?? null,
    };
  }
  return next;
}

function toLocalDateKey(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildVirtualEvents(
  events: CalendarEvent[],
  calendarLinks: Record<string, CalendarLink>,
  todayKey: string,
): VirtualEvent[] {
  const now = Date.now();
  return events.flatMap<VirtualEvent>((event) => {
    const link = calendarLinks[event.calendarId];
    if (!link) return [];

    const startDateKey = toLocalDateKey(event.start);
    if (startDateKey < todayKey) return [];

    if (!event.allDay) {
      const endMs = new Date(event.end).getTime();
      if (Number.isFinite(endMs) && endMs <= now) return [];
    }

    return [
      {
        id: event.id,
        title: event.summary,
        startDateKey,
        startTime: event.allDay ? null : formatTime(event.start),
        endTime: event.allDay ? null : formatTime(event.end),
        allDay: event.allDay,
        groupName: link.groupName,
        groupColor: link.groupColor,
      },
    ];
  });
}

function eventSortKey(event: VirtualEvent): string {
  // All-day events sort before timed events within a day.
  if (event.allDay) return `${event.startDateKey}T00:00`;
  return `${event.startDateKey}T${event.startTime ?? "00:00"}`;
}

function taskSortKey(task: TaskWithGroup): string {
  // Tasks sort after timed events within a day; rank by priority.
  const dateKey = task.due_date ?? "9999-99-99";
  const rank = priorityRank(task.priority).toString().padStart(2, "0");
  return `${dateKey}T99:${rank}-${task.created_at}`;
}

export function TodayClient({
  initial,
  groups,
  events,
  calendarLinks,
}: {
  initial: TaskWithGroup[];
  groups: GroupOption[];
  events: CalendarEvent[];
  calendarLinks: Record<string, CalendarLink>;
}) {
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
        case "update":
          return state.map((t) =>
            t.id === action.id ? applyPatch(t, action.patch, action.groups) : t,
          );
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
      dispatch({ kind: "update", id, patch, groups });
      await updateTask({ id, ...patch });
    });
  }

  const today = todayISO();
  const virtualEvents = buildVirtualEvents(events, calendarLinks, today);

  const openTasks = tasks.filter((t) => t.status !== "done" && t.due_date);

  const overdueTasks = openTasks
    .filter((t) => daysFromToday(t.due_date!) < 0)
    .sort((a, b) => {
      const p = priorityRank(a.priority) - priorityRank(b.priority);
      if (p !== 0) return p;
      return a.due_date!.localeCompare(b.due_date!);
    });

  const todayEvents = virtualEvents.filter(
    (e) => e.startDateKey === today,
  );
  const soonEvents = virtualEvents.filter((e) => {
    if (e.startDateKey === today) return false;
    const days = daysFromToday(e.startDateKey);
    return days > 0 && days <= 7;
  });

  const dueTodayTasks = openTasks
    .filter((t) => daysFromToday(t.due_date!) === 0)
    .sort((a, b) => {
      const p = priorityRank(a.priority) - priorityRank(b.priority);
      if (p !== 0) return p;
      return a.created_at.localeCompare(b.created_at);
    });

  const dueSoonTasks = openTasks
    .filter((t) => {
      const d = daysFromToday(t.due_date!);
      return d > 0 && d <= 7;
    })
    .sort((a, b) => {
      const p = priorityRank(a.priority) - priorityRank(b.priority);
      if (p !== 0) return p;
      return a.due_date!.localeCompare(b.due_date!);
    });

  const todayItems: ListItem[] = [
    ...todayEvents.map<ListItem>((event) => ({
      kind: "event",
      sortKey: eventSortKey(event),
      event,
    })),
    ...dueTodayTasks.map<ListItem>((task) => ({
      kind: "task",
      sortKey: taskSortKey(task),
      task,
    })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const soonItems: ListItem[] = [
    ...soonEvents.map<ListItem>((event) => ({
      kind: "event",
      sortKey: eventSortKey(event),
      event,
    })),
    ...dueSoonTasks.map<ListItem>((task) => ({
      kind: "task",
      sortKey: taskSortKey(task),
      task,
    })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const allClear =
    overdueTasks.length === 0 &&
    todayItems.length === 0 &&
    soonItems.length === 0;

  return (
    <>
      <div className="pb-4 space-y-10">
        {overdueTasks.length > 0 && (
          <section>
            <p className="text-[10px] tracking-widest uppercase text-[#ff6b6b] mb-2 px-1">
              overdue · {overdueTasks.length}
            </p>
            <div>
              {overdueTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  groups={groups}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onUpdate={onUpdate}
                  variant="overdue"
                />
              ))}
            </div>
          </section>
        )}

        <section>
          <p className="text-[10px] tracking-widest uppercase text-[#f5f0e8] mb-2 px-1">
            today
            {todayItems.length > 0 && (
              <span className="text-[#6b6b6b]"> · {todayItems.length}</span>
            )}
          </p>
          {todayItems.length === 0 ? (
            <p className="text-[#6b6b6b] text-sm py-2 px-1">
              {allClear
                ? "all clear. type below to capture something."
                : "nothing due today."}
            </p>
          ) : (
            <div>
              {todayItems.map((item) =>
                item.kind === "task" ? (
                  <TaskRow
                    key={item.task.id}
                    task={item.task}
                    groups={groups}
                    onToggle={onToggle}
                    onDelete={onDelete}
                    onUpdate={onUpdate}
                    hideDate
                  />
                ) : (
                  <EventRow key={item.event.id} event={item.event} hideDate />
                ),
              )}
            </div>
          )}
        </section>

        {soonItems.length > 0 && (
          <section>
            <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2 px-1">
              due soon · {soonItems.length}
            </p>
            <div>
              {soonItems.map((item) =>
                item.kind === "task" ? (
                  <TaskRow
                    key={item.task.id}
                    task={item.task}
                    groups={groups}
                    onToggle={onToggle}
                    onDelete={onDelete}
                    onUpdate={onUpdate}
                  />
                ) : (
                  <EventRow key={item.event.id} event={item.event} />
                ),
              )}
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
