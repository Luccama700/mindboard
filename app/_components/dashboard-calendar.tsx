"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CalendarEvent } from "@/utils/google/calendar";
import type { TaskWithGroup } from "./types";

type CalendarStatus = "connected" | "connect" | "error";

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
      allDay: boolean;
    };

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
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

export function DashboardCalendar({
  month,
  tasks,
  events,
  status,
}: {
  month: string;
  tasks: TaskWithGroup[];
  events: CalendarEvent[];
  status: CalendarStatus;
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
      items.push({
        kind: "event",
        id: event.id,
        title: event.summary,
        allDay: event.allDay,
      });
      map.set(key, items);
    }

    return map;
  }, [events, tasks]);

  const selectedItems = itemsByDate.get(selected) ?? [];
  const selectedLabel = new Date(`${selected}T00:00:00`).toLocaleDateString(
    undefined,
    {
      weekday: "short",
      month: "short",
      day: "numeric",
    },
  );

  return (
    <section className="border border-[#1f1f1f] bg-[#101010] p-4 lg:min-h-[calc(100vh-4rem)]">
      <header className="flex items-center justify-between gap-3 mb-4">
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
            className="min-w-11 h-11 border border-[#2a2a2a] text-[#6b6b6b] hover:text-[#f5f0e8] hover:border-[#f5f0e8] transition-colors flex items-center justify-center"
            aria-label="previous month"
          >
            ←
          </Link>
          <Link
            href={`/?m=${addMonths(month, 1)}`}
            className="min-w-11 h-11 border border-[#2a2a2a] text-[#6b6b6b] hover:text-[#f5f0e8] hover:border-[#f5f0e8] transition-colors flex items-center justify-center"
            aria-label="next month"
          >
            →
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-px bg-[#1f1f1f] border border-[#1f1f1f] mb-4">
        {(["month", "week"] as CalendarView[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setView(option)}
            className={`min-h-11 text-[10px] tracking-widest uppercase transition-colors ${
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
                      className={`truncate text-[10px] px-1 py-0.5 ${
                        item.kind === "task"
                          ? "bg-[#b5ff3c] text-[#0d0d0d]"
                          : "bg-[#1a1a1a] text-[#f5f0e8] border border-[#2a2a2a]"
                      }`}
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
        <div className="grid grid-cols-1 gap-px bg-[#1f1f1f] border border-[#1f1f1f] sm:grid-cols-7">
          {week.map((date) => {
            const key = toDateKey(date);
            const items = itemsByDate.get(key) ?? [];
            const isSelected = selected === key;
            const isToday = key === today;

            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected(key)}
                className={`min-h-32 bg-[#0d0d0d] p-3 text-left transition-colors lg:min-h-72 ${
                  isSelected ? "outline outline-1 outline-[#b5ff3c]" : ""
                }`}
              >
                <p className="text-[9px] tracking-widest uppercase text-[#6b6b6b]">
                  {WEEKDAYS[date.getDay()]}
                </p>
                <p
                  className={`text-2xl font-bold mt-1 ${
                    isToday ? "text-[#b5ff3c]" : "text-[#f5f0e8]"
                  }`}
                >
                  {date.getDate()}
                </p>

                <div className="space-y-2 mt-4">
                  {items.length === 0 ? (
                    <p className="text-xs text-[#3a3a3a]">clear</p>
                  ) : (
                    items.map((item) => (
                      <div
                        key={`${item.kind}-${item.id}`}
                        className={`text-xs leading-snug px-2 py-1 ${
                          item.kind === "task"
                            ? "bg-[#b5ff3c] text-[#0d0d0d]"
                            : "bg-[#1a1a1a] text-[#f5f0e8] border border-[#2a2a2a]"
                        }`}
                      >
                        <p className="line-clamp-2">{item.title}</p>
                      </div>
                    ))
                  )}
                </div>
              </button>
            );
          })}
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
                <p className="text-sm text-[#f5f0e8] truncate">
                  {item.title}
                </p>
                <p
                  className="text-[10px] tracking-widest uppercase mt-1"
                  style={{
                    color:
                      item.kind === "task" ? item.color : "#6b6b6b",
                  }}
                >
                  {item.kind === "task" ? item.group : "google calendar"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
