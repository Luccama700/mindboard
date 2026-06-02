"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CalendarEvent } from "@/utils/google/calendar";
import { rescheduleEvent } from "@/app/actions/calendar";
import { updateTask } from "@/app/actions/tasks";
import type { CalendarItem } from "./calendar-types";
import {
  formatClockTime,
  formatMonthDay,
  formatMonthYear,
  formatWeekdayMonthDay,
} from "./date-utils";
import { formatSignedChange } from "./money";
import { EventEditPanel } from "./event-edit-panel";
import { WeekView, type RescheduleEvent, type RescheduleTask } from "./week-view";
import type { TaskWithGroup } from "./types";

type CalendarStatus = "connected" | "connect" | "error";

type CalendarLink = {
  groupName: string;
  groupColor: string;
};

export type FinanceChange = {
  id: string;
  occurredAt: string;
  title: string;
  color: string;
  direction: "in" | "out";
  amount: number;
  currency: string;
  account: string;
};

type EventOverride = {
  start: string;
  end: string;
  allDay: boolean;
};

type TaskOverride = string | null;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(year, monthNumber - 1, 1);
}

function monthKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function monthLabel(month: string) {
  const date = parseMonth(month);
  return formatMonthYear(date);
}

function weekLabel(dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00`);
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();

  const startLabel = formatMonthDay(start);
  const endLabel = formatMonthDay(end, !sameMonth);

  return `${startLabel} – ${endLabel}`;
}

function addMonths(month: string, count: number) {
  const date = parseMonth(month);
  date.setMonth(date.getMonth() + count);
  return monthKey(date);
}

function eventDateKey(start: string, allDay: boolean) {
  if (allDay) return start.slice(0, 10);
  return toDateKey(new Date(start));
}

function formatEventRange(item: Extract<CalendarItem, { kind: "event" }>) {
  if (item.allDay) return "all day";
  return `${formatClockTime(item.start)} – ${formatClockTime(item.end)}`;
}

function combineDateAndMinutes(dateKey: string, minutes: number): Date {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setMinutes(minutes);
  return date;
}

function buildGrid(month: string) {
  const first = parseMonth(month);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

export function DashboardCalendar({
  month,
  tasks,
  events,
  finance = [],
  status,
  calendarLinks = {},
}: {
  month: string;
  tasks: TaskWithGroup[];
  events: CalendarEvent[];
  finance?: FinanceChange[];
  status: CalendarStatus;
  calendarLinks?: Record<string, CalendarLink>;
}) {
  const today = toDateKey(new Date());
  const grid = useMemo(() => buildGrid(month), [month]);
  const firstInMonth = `${month}-01`;
  const initialSelected = grid.some((date) => toDateKey(date) === today)
    ? today
    : firstInMonth;
  const [selected, setSelected] = useState(initialSelected);
  const [view, setView] = useState<"month" | "week">("month");
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [eventOverrides, setEventOverrides] = useState<
    Record<string, EventOverride>
  >({});
  const [taskOverrides, setTaskOverrides] = useState<
    Record<string, TaskOverride>
  >({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();

    for (const task of tasks) {
      const override = taskOverrides[task.id];
      const due = override !== undefined ? override : task.due_date;
      if (!due) continue;
      const items = map.get(due) ?? [];
      items.push({
        kind: "task",
        id: task.id,
        title: task.title,
        color: task.group_color ?? "#b5ff3c",
        group: task.group_name ?? "inbox",
      });
      map.set(due, items);
    }

    for (const event of events) {
      const override = eventOverrides[event.id];
      const start = override?.start ?? event.start;
      const end = override?.end ?? event.end;
      const allDay = override?.allDay ?? event.allDay;
      const key = eventDateKey(start, allDay);
      const items = map.get(key) ?? [];
      const link = calendarLinks[event.calendarId];
      items.push({
        kind: "event",
        id: event.id,
        eventId: event.eventId,
        calendarId: event.calendarId,
        title: event.summary,
        start,
        end,
        allDay,
        calendar: link?.groupName ?? event.calendarSummary,
        color: link?.groupColor ?? event.calendarColor,
        writable: event.writable,
        startTimeZone: event.startTimeZone,
        endTimeZone: event.endTimeZone,
      });
      map.set(key, items);
    }

    for (const change of finance) {
      const items = map.get(change.occurredAt) ?? [];
      items.push({
        kind: "finance",
        id: change.id,
        title: change.title,
        color: change.color,
        direction: change.direction,
        amount: change.amount,
        currency: change.currency,
        category: change.account,
      });
      map.set(change.occurredAt, items);
    }

    return map;
  }, [calendarLinks, events, tasks, finance, eventOverrides, taskOverrides]);

  async function commitEventReschedule(
    eventItem: Extract<CalendarItem, { kind: "event" }>,
    next: EventOverride,
  ) {
    setErrorMessage(null);
    setEventOverrides((o) => ({ ...o, [eventItem.id]: next }));
    const result = await rescheduleEvent({
      calendarId: eventItem.calendarId,
      eventId: eventItem.eventId,
      allDay: next.allDay,
      start: next.start,
      end: next.end,
      startTimeZone: eventItem.startTimeZone,
      endTimeZone: eventItem.endTimeZone,
    });
    if (result.error) {
      setEventOverrides((o) => {
        const copy = { ...o };
        delete copy[eventItem.id];
        return copy;
      });
      setErrorMessage(result.error || "reschedule failed");
    }
  }

  function findEvent(itemId: string): Extract<CalendarItem, { kind: "event" }> | null {
    for (const items of itemsByDate.values()) {
      const match = items.find((i) => i.kind === "event" && i.id === itemId);
      if (match && match.kind === "event") return match;
    }
    return null;
  }

  function onRescheduleEvent(payload: RescheduleEvent) {
    const item = findEvent(payload.itemId);
    if (!item) return;

    if (item.allDay) {
      const originalEnd = item.end.slice(0, 10);
      const newStart = payload.newDateKey;
      const dayShift =
        new Date(`${payload.newDateKey}T00:00:00`).getTime() -
        new Date(`${payload.startDateKey}T00:00:00`).getTime();
      const newEnd = new Date(`${originalEnd}T00:00:00`);
      newEnd.setTime(newEnd.getTime() + dayShift);
      void commitEventReschedule(item, {
        start: newStart,
        end: toDateKey(newEnd),
        allDay: true,
      });
      return;
    }

    if (
      payload.newStartMinutes !== null &&
      payload.newEndMinutes !== null
    ) {
      const newStart = combineDateAndMinutes(
        payload.newDateKey,
        payload.newStartMinutes,
      );
      const newEnd = combineDateAndMinutes(
        payload.newDateKey,
        payload.newEndMinutes,
      );
      void commitEventReschedule(item, {
        start: newStart.toISOString(),
        end: newEnd.toISOString(),
        allDay: false,
      });
    }
  }

  async function onRescheduleTask(payload: RescheduleTask) {
    setErrorMessage(null);
    setTaskOverrides((o) => ({ ...o, [payload.taskId]: payload.newDateKey }));
    const result = await updateTask({
      id: payload.taskId,
      dueDate: payload.newDateKey,
    });
    if (result?.error) {
      setTaskOverrides((o) => {
        const copy = { ...o };
        delete copy[payload.taskId];
        return copy;
      });
      setErrorMessage(result.error || "task reschedule failed");
    }
  }

  function onEditEvent(
    eventItem: Extract<CalendarItem, { kind: "event" }>,
    next: EventOverride,
  ) {
    void commitEventReschedule(eventItem, next);
  }

  const selectedItems = itemsByDate.get(selected) ?? [];
  const selectedLabel = formatWeekdayMonthDay(
    new Date(`${selected}T00:00:00`),
  );

  return (
    <section className="border border-line bg-popover p-3 lg:min-h-[calc(100vh-4rem)]">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-muted">
            calendar
          </p>
          <h2 className="text-xl font-bold text-fg mt-1">
            {view === "month" ? monthLabel(month) : weekLabel(selected)}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/?m=${addMonths(month, -1)}`}
            className="flex h-9 min-w-9 items-center justify-center border border-line-strong text-muted transition-colors hover:border-fg hover:text-fg"
            aria-label="previous month"
          >
            ←
          </Link>
          <Link
            href={`/?m=${addMonths(month, 1)}`}
            className="flex h-9 min-w-9 items-center justify-center border border-line-strong text-muted transition-colors hover:border-fg hover:text-fg"
            aria-label="next month"
          >
            →
          </Link>
        </div>
      </header>

      <div className="mb-3 ml-auto grid w-56 grid-cols-2 gap-px border border-line bg-line">
        {(["month", "week"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setView(option)}
            className={`min-h-8 text-[9px] tracking-widest uppercase transition-colors ${
              view === option
                ? "bg-accent text-accent-fg"
                : "bg-page text-muted hover:text-fg"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {status !== "connected" && (
        <div className="border border-line-strong px-3 py-2 mb-4">
          <p className="text-xs text-muted leading-relaxed">
            {status === "connect"
              ? "connect google calendar by signing out and back in."
              : "google calendar is temporarily unavailable."}
          </p>
        </div>
      )}

      {errorMessage && (
        <div className="border border-danger px-3 py-2 mb-4 flex items-start justify-between gap-2">
          <p className="text-xs text-danger leading-relaxed">
            {errorMessage}
          </p>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="dismiss"
            className="text-danger hover:text-danger-hover text-lg leading-none"
          >
            ×
          </button>
        </div>
      )}

      {view === "month" ? (
        <div className="grid grid-cols-7 gap-px bg-line border border-line">
          {WEEKDAYS.map((day) => (
            <div
              key={day}
              className="bg-page text-[9px] tracking-widest uppercase text-muted px-1 py-2 text-center"
            >
              {day}
            </div>
          ))}

          {grid.map((date) => {
            const key = toDateKey(date);
            const inMonth = key.startsWith(month);
            const items = itemsByDate.get(key) ?? [];
            const visible = items.slice(0, 3);
            const remaining = items.length - visible.length;
            const isSelected = selected === key;
            const isToday = key === today;

            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected(key)}
                className={`min-h-24 bg-page p-1.5 text-left transition-colors ${
                  isSelected ? "outline outline-1 outline-accent" : ""
                } ${inMonth ? "text-fg" : "text-line-subtle"}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`text-xs ${
                      isToday ? "text-accent font-bold" : ""
                    }`}
                  >
                    {date.getDate()}
                  </span>
                  {items.length > 0 && (
                    <span className="text-[9px] text-muted">
                      {items.length}
                    </span>
                  )}
                </div>

                <div className="space-y-1">
                  {visible.map((item) => (
                    <div
                      key={`${item.kind}-${item.id}`}
                      className="truncate px-1 py-0.5 text-[10px] text-accent-fg"
                      style={{ backgroundColor: item.color }}
                    >
                      {item.kind === "finance"
                        ? formatSignedChange(
                            item.amount,
                            item.direction,
                            item.currency,
                          )
                        : item.title}
                    </div>
                  ))}
                  {remaining > 0 && (
                    <p className="text-[10px] text-muted">+{remaining}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <WeekView
          selected={selected}
          today={today}
          itemsByDate={itemsByDate}
          onSelect={setSelected}
          onRescheduleEvent={onRescheduleEvent}
          onRescheduleTask={onRescheduleTask}
        />
      )}

      <div className="mt-4 border-t border-line pt-4">
        <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
          {selectedLabel}
          {selectedItems.length > 0 && ` · ${selectedItems.length}`}
        </p>

        {selectedItems.length === 0 ? (
          <p className="text-sm text-muted">nothing scheduled.</p>
        ) : (
          <div className="space-y-2">
            {selectedItems.map((item) => {
              const itemKey = `${item.kind}-${item.id}`;
              const isExpanded = expandedItem === itemKey;
              const isEditableEvent =
                item.kind === "event" && item.writable !== false;

              return (
                <div
                  key={itemKey}
                  className="border border-line"
                >
                  <button
                    type="button"
                    onClick={() =>
                      isEditableEvent
                        ? setExpandedItem(isExpanded ? null : itemKey)
                        : undefined
                    }
                    className={`block w-full text-left px-3 py-2 ${
                      isEditableEvent ? "hover:bg-card cursor-pointer" : "cursor-default"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 flex-shrink-0"
                        style={{ backgroundColor: item.color }}
                        aria-hidden
                      />
                      <p className="truncate text-sm text-fg">
                        {item.title}
                      </p>
                    </div>
                    <p
                      className="mt-1 text-[10px] uppercase tracking-widest"
                      style={{
                        color:
                          item.kind === "event" ? "#6b6b6b" : item.color,
                      }}
                    >
                      {item.kind === "task"
                        ? item.group
                        : item.kind === "finance"
                          ? `${item.category} · ${formatSignedChange(item.amount, item.direction, item.currency)}`
                          : `${item.calendar} · ${formatEventRange(item)}`}
                    </p>
                  </button>

                  {isExpanded && item.kind === "event" && isEditableEvent && (
                    <EventEditPanel
                      event={item}
                      onSubmit={(next) => {
                        onEditEvent(item, next);
                        setExpandedItem(null);
                      }}
                      onCancel={() => setExpandedItem(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
