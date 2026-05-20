"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CalendarEvent } from "@/utils/google/calendar";
import type { TaskWithGroup } from "./types";

type CalendarStatus = "connected" | "connect" | "error";

type CalendarLink = {
  groupId: string;
  groupName: string;
  groupColor: string;
};

type CalendarItem =
  | {
      kind: "task";
      id: string;
      title: string;
      color: string;
      group: string;
    }
  | {
      kind: "event";
      id: string;
      title: string;
      start: string;
      end: string;
      allDay: boolean;
      calendar: string;
      color: string;
    };

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const START_HOUR = 6;
const END_HOUR = 22;
const HOUR_HEIGHT = 42;
type CalendarView = "month" | "week";

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
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function weekLabel(dateKey: string) {
  const start = startOfWeek(new Date(`${dateKey}T00:00:00`));
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();

  const startLabel = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const endLabel = end.toLocaleDateString(undefined, {
    month: sameMonth ? undefined : "short",
    day: "numeric",
  });

  return `${startLabel} – ${endLabel}`;
}

function addMonths(month: string, count: number) {
  const date = parseMonth(month);
  date.setMonth(date.getMonth() + count);
  return monthKey(date);
}

function addDays(date: Date, count: number) {
  const next = new Date(date);
  next.setDate(date.getDate() + count);
  return next;
}

function startOfWeek(date: Date) {
  return addDays(date, -date.getDay());
}

function eventDateKey(event: CalendarEvent) {
  if (event.allDay) return event.start.slice(0, 10);
  return toDateKey(new Date(event.start));
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatEventRange(item: Extract<CalendarItem, { kind: "event" }>) {
  if (item.allDay) return "all day";
  return `${formatTime(item.start)} – ${formatTime(item.end)}`;
}

function timeLabel(hour: number) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  });
}

function minutesIntoDay(value: string) {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
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

function buildWeek(selected: string) {
  const start = startOfWeek(new Date(`${selected}T00:00:00`));

  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function timedStyle(item: Extract<CalendarItem, { kind: "event" }>) {
  const start = Math.min(
    Math.max(minutesIntoDay(item.start), START_HOUR * 60),
    END_HOUR * 60 - 30,
  );
  const end = Math.max(Math.min(minutesIntoDay(item.end), END_HOUR * 60), start + 30);
  const top = ((start - START_HOUR * 60) / 60) * HOUR_HEIGHT;
  const rawHeight = ((end - start) / 60) * HOUR_HEIGHT;

  return {
    top: `${top}px`,
    height: `${Math.max(rawHeight, 32)}px`,
  };
}

export function DashboardCalendar({
  month,
  tasks,
  events,
  status,
  calendarLinks = {},
}: {
  month: string;
  tasks: TaskWithGroup[];
  events: CalendarEvent[];
  status: CalendarStatus;
  calendarLinks?: Record<string, CalendarLink>;
}) {
  const today = toDateKey(new Date());
  const grid = useMemo(() => buildGrid(month), [month]);
  const firstInMonth = `${month}-01`;
  const initialSelected = grid.some((date) => toDateKey(date) === today)
    ? today
    : firstInMonth;
  const [selected, setSelected] = useState(
    initialSelected,
  );
  const [view, setView] = useState<CalendarView>("month");

  const week = useMemo(() => buildWeek(selected), [selected]);

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();

    for (const task of tasks) {
      if (!task.due_date) continue;
      const items = map.get(task.due_date) ?? [];
      items.push({
        kind: "task",
        id: task.id,
        title: task.title,
        color: task.group_color ?? "#b5ff3c",
        group: task.group_name ?? "inbox",
      });
      map.set(task.due_date, items);
    }

    for (const event of events) {
      const key = eventDateKey(event);
      const items = map.get(key) ?? [];
      const link = calendarLinks[event.calendarId];
      items.push({
        kind: "event",
        id: event.id,
        title: event.summary,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        calendar: link?.groupName ?? event.calendarSummary,
        color: link?.groupColor ?? event.calendarColor,
      });
      map.set(key, items);
    }

    return map;
  }, [calendarLinks, events, tasks]);

  const selectedItems = itemsByDate.get(selected) ?? [];
  const hourLabels = Array.from(
    { length: END_HOUR - START_HOUR + 1 },
    (_, index) => START_HOUR + index,
  );
  const weekHeight = (END_HOUR - START_HOUR) * HOUR_HEIGHT;
  const selectedLabel = new Date(`${selected}T00:00:00`).toLocaleDateString(
    undefined,
    {
      weekday: "short",
      month: "short",
      day: "numeric",
    },
  );

  return (
    <section className="border border-[#1f1f1f] bg-[#101010] p-3 lg:min-h-[calc(100vh-4rem)]">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b]">
            calendar
          </p>
          <h2 className="text-xl font-bold text-[#f5f0e8] mt-1">
            {view === "month" ? monthLabel(month) : weekLabel(selected)}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/?m=${addMonths(month, -1)}`}
            className="flex h-9 min-w-9 items-center justify-center border border-[#2a2a2a] text-[#6b6b6b] transition-colors hover:border-[#f5f0e8] hover:text-[#f5f0e8]"
            aria-label="previous month"
          >
            ←
          </Link>
          <Link
            href={`/?m=${addMonths(month, 1)}`}
            className="flex h-9 min-w-9 items-center justify-center border border-[#2a2a2a] text-[#6b6b6b] transition-colors hover:border-[#f5f0e8] hover:text-[#f5f0e8]"
            aria-label="next month"
          >
            →
          </Link>
        </div>
      </header>

      <div className="mb-3 ml-auto grid w-56 grid-cols-2 gap-px border border-[#1f1f1f] bg-[#1f1f1f]">
        {(["month", "week"] as CalendarView[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setView(option)}
            className={`min-h-8 text-[9px] tracking-widest uppercase transition-colors ${
              view === option
                ? "bg-[#b5ff3c] text-[#0d0d0d]"
                : "bg-[#0d0d0d] text-[#6b6b6b] hover:text-[#f5f0e8]"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {status !== "connected" && (
        <div className="border border-[#2a2a2a] px-3 py-2 mb-4">
          <p className="text-xs text-[#6b6b6b] leading-relaxed">
            {status === "connect"
              ? "connect google calendar by signing out and back in."
              : "google calendar is temporarily unavailable."}
          </p>
        </div>
      )}

      {view === "month" ? (
        <div className="grid grid-cols-7 gap-px bg-[#1f1f1f] border border-[#1f1f1f]">
          {WEEKDAYS.map((day) => (
            <div
              key={day}
              className="bg-[#0d0d0d] text-[9px] tracking-widest uppercase text-[#6b6b6b] px-1 py-2 text-center"
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
                className={`min-h-24 bg-[#0d0d0d] p-1.5 text-left transition-colors ${
                  isSelected ? "outline outline-1 outline-[#b5ff3c]" : ""
                } ${inMonth ? "text-[#f5f0e8]" : "text-[#3a3a3a]"}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`text-xs ${
                      isToday ? "text-[#b5ff3c] font-bold" : ""
                    }`}
                  >
                    {date.getDate()}
                  </span>
                  {items.length > 0 && (
                    <span className="text-[9px] text-[#6b6b6b]">
                      {items.length}
                    </span>
                  )}
                </div>

                <div className="space-y-1">
                  {visible.map((item) => (
                    <div
                      key={`${item.kind}-${item.id}`}
                      className="truncate px-1 py-0.5 text-[10px] text-[#0d0d0d]"
                      style={{ backgroundColor: item.color }}
                    >
                      {item.title}
                    </div>
                  ))}
                  {remaining > 0 && (
                    <p className="text-[10px] text-[#6b6b6b]">+{remaining}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto border border-[#1f1f1f]">
          <div className="min-w-[43rem] bg-[#0d0d0d]">
            <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-[#1f1f1f]">
              <div className="border-r border-[#1f1f1f]" />
              {week.map((date) => {
                const key = toDateKey(date);
                const isSelected = selected === key;
                const isToday = key === today;

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelected(key)}
                    className={`min-h-16 border-r border-[#1f1f1f] px-2 py-2 text-center transition-colors last:border-r-0 ${
                      isSelected ? "bg-[#141414]" : "bg-[#0d0d0d]"
                    }`}
                  >
                    <p className="text-[9px] tracking-widest uppercase text-[#6b6b6b]">
                      {WEEKDAYS[date.getDay()]}
                    </p>
                    <p
                      className={`mx-auto mt-1 flex h-9 w-9 items-center justify-center text-xl ${
                        isToday
                          ? "rounded-full bg-[#b5ff3c] text-[#0d0d0d]"
                          : "text-[#f5f0e8]"
                      }`}
                    >
                      {date.getDate()}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-[#1f1f1f]">
              <div className="border-r border-[#1f1f1f] px-2 py-2 text-[9px] tracking-widest uppercase text-[#6b6b6b]">
                due
              </div>
              {week.map((date) => {
                const key = toDateKey(date);
                const allDayItems = (itemsByDate.get(key) ?? []).filter(
                  (item) => item.kind === "task" || item.allDay,
                );

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelected(key)}
                    className="min-h-24 border-r border-[#1f1f1f] p-1.5 text-left last:border-r-0"
                  >
                    <div className="space-y-1">
                      {allDayItems.slice(0, 2).map((item) => (
                        <div
                          key={`${item.kind}-${item.id}`}
                          className="truncate px-1.5 py-1 text-[10px] font-bold text-[#0d0d0d]"
                          style={{ backgroundColor: item.color }}
                        >
                          {item.title}
                        </div>
                      ))}
                      {allDayItems.length > 2 && (
                        <span className="inline-flex h-5 items-center border border-[#3a3a3a] px-2 text-[10px] text-[#6b6b6b]">
                          +{allDayItems.length - 2} more
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div
              className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"
              style={{ height: weekHeight }}
            >
              <div className="relative border-r border-[#1f1f1f]">
                {hourLabels.slice(0, -1).map((hour, index) => (
                  <div
                    key={hour}
                    className="absolute left-0 right-0 border-t border-[#1f1f1f] px-1 pt-1 text-right text-[10px] text-[#6b6b6b]"
                    style={{ top: index * HOUR_HEIGHT }}
                  >
                    {timeLabel(hour)}
                  </div>
                ))}
              </div>

              {week.map((date) => {
                const key = toDateKey(date);
                const timedItems = (itemsByDate.get(key) ?? []).filter(
                  (
                    item,
                  ): item is Extract<CalendarItem, { kind: "event" }> =>
                    item.kind === "event" && !item.allDay,
                );

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelected(key)}
                    className="relative border-r border-[#1f1f1f] text-left last:border-r-0"
                  >
                    {hourLabels.slice(0, -1).map((hour, index) => (
                      <div
                        key={hour}
                        className="absolute left-0 right-0 border-t border-[#1f1f1f]"
                        style={{ top: index * HOUR_HEIGHT }}
                      />
                    ))}

                    {timedItems.map((item) => (
                      <div
                        key={item.id}
                        className="absolute left-1 right-1 overflow-hidden px-1.5 py-1 text-[#0d0d0d]"
                        style={{
                          ...timedStyle(item),
                          backgroundColor: item.color,
                        }}
                      >
                        <p className="truncate text-[11px] font-bold">
                          {item.title}
                        </p>
                        <p className="truncate text-[10px]">
                          {formatEventRange(item)}
                        </p>
                      </div>
                    ))}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-[#1f1f1f] pt-4">
        <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2">
          {selectedLabel}
          {selectedItems.length > 0 && ` · ${selectedItems.length}`}
        </p>

        {selectedItems.length === 0 ? (
          <p className="text-sm text-[#6b6b6b]">nothing scheduled.</p>
        ) : (
          <div className="space-y-2">
            {selectedItems.map((item) => (
              <div
                key={`${item.kind}-${item.id}`}
                className="border border-[#1f1f1f] px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-3 w-3 flex-shrink-0"
                    style={{ backgroundColor: item.color }}
                    aria-hidden
                  />
                  <p className="truncate text-sm text-[#f5f0e8]">
                    {item.title}
                  </p>
                </div>
                <p
                  className="mt-1 text-[10px] uppercase tracking-widest"
                  style={{
                    color:
                      item.kind === "task" ? item.color : "#6b6b6b",
                  }}
                >
                  {item.kind === "task"
                    ? item.group
                    : `${item.calendar} · ${formatEventRange(item)}`}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
