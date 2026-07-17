"use client";

import { useState } from "react";
import type { CalendarItem } from "./calendar-types";

type EventItem = Extract<CalendarItem, { kind: "event" }>;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDateInput(value: string, allDay: boolean): string {
  if (allDay) {
    return value.slice(0, 10);
  }
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTimeInput(value: string): string {
  const d = new Date(value);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function combineDateAndTime(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const d = new Date(year, month - 1, day, hours, minutes);
  return d.toISOString();
}

export function EventEditPanel({
  event,
  onSubmit,
  onCancel,
}: {
  event: EventItem;
  onSubmit: (next: { start: string; end: string; allDay: boolean }) => void;
  onCancel: () => void;
}) {
  const [allDay, setAllDay] = useState(event.allDay);
  const [startDate, setStartDate] = useState(
    localDateInput(event.start, event.allDay),
  );
  const [startTime, setStartTime] = useState(
    event.allDay ? "09:00" : localTimeInput(event.start),
  );
  const [endDate, setEndDate] = useState(
    localDateInput(event.end, event.allDay),
  );
  const [endTime, setEndTime] = useState(
    event.allDay ? "10:00" : localTimeInput(event.end),
  );
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!startDate || !endDate) {
      setError("date required");
      return;
    }

    if (allDay) {
      if (endDate < startDate) {
        setError("end date must be on or after start");
        return;
      }
      onSubmit({ start: startDate, end: endDate, allDay: true });
      return;
    }

    if (!startTime || !endTime) {
      setError("time required");
      return;
    }

    const startIso = combineDateAndTime(startDate, startTime);
    const endIso = combineDateAndTime(endDate, endTime);
    if (Date.parse(endIso) <= Date.parse(startIso)) {
      setError("end must be after start");
      return;
    }

    onSubmit({ start: startIso, end: endIso, allDay: false });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-line p-3 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          edit time
        </p>
        <label className="flex items-center gap-2 text-[10px] tracking-widest uppercase text-muted">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            className="accent-accent"
          />
          all day
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[10px] tracking-widest uppercase text-muted mb-1">
            start date
          </span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none"
            required
          />
        </label>
        {!allDay && (
          <label className="block">
            <span className="block text-[10px] tracking-widest uppercase text-muted mb-1">
              start time
            </span>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none"
              required
            />
          </label>
        )}
        <label className="block">
          <span className="block text-[10px] tracking-widest uppercase text-muted mb-1">
            end date
          </span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none"
            required
          />
        </label>
        {!allDay && (
          <label className="block">
            <span className="block text-[10px] tracking-widest uppercase text-muted mb-1">
              end time
            </span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none"
              required
            />
          </label>
        )}
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors px-3 py-1.5"
        >
          cancel
        </button>
        <button
          type="submit"
          className="bg-accent text-accent-fg text-xs tracking-widest uppercase font-bold px-3 py-1.5 hover:opacity-90 transition-colors"
        >
          save
        </button>
      </div>
    </form>
  );
}
