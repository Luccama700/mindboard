"use client";

import { useState } from "react";
import type { CalendarItem } from "./calendar-types";
import { formatClockTime } from "./date-utils";
import { eventDateKey, wallTimeToIso } from "./event-time";

type EventItem = Extract<CalendarItem, { kind: "event" }>;

// The inputs read and write wall-clock values in the user's stored zone (the
// same zone the grid positions the block in), so editing from a device in
// another zone neither shows nor saves a shifted time.
export function EventEditPanel({
  event,
  timeZone,
  onSubmit,
  onCancel,
}: {
  event: EventItem;
  timeZone: string | null;
  onSubmit: (next: { start: string; end: string; allDay: boolean }) => void;
  onCancel: () => void;
}) {
  const [allDay, setAllDay] = useState(event.allDay);
  const [startDate, setStartDate] = useState(
    eventDateKey(event.start, event.allDay, timeZone),
  );
  const [startTime, setStartTime] = useState(
    event.allDay ? "09:00" : formatClockTime(event.start, timeZone),
  );
  const [endDate, setEndDate] = useState(
    eventDateKey(event.end, event.allDay, timeZone),
  );
  const [endTime, setEndTime] = useState(
    event.allDay ? "10:00" : formatClockTime(event.end, timeZone),
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

    const startIso = wallTimeToIso(startDate, startTime, timeZone);
    const endIso = wallTimeToIso(endDate, endTime, timeZone);
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
