"use client";

import { useState } from "react";
import type { CalendarItem } from "./calendar-types";

type RtaskItem = Extract<CalendarItem, { kind: "rtask" }>;

// Inline panel that turns one routine occurrence into a real Google Calendar
// event. The title is set at creation only — renaming existing Google events
// stays out of scope — so this is the one place to name the event.
export function RtaskPromotePanel({
  item,
  dateKey,
  onSubmit,
  onCancel,
}: {
  item: RtaskItem;
  dateKey: string;
  onSubmit: (p: {
    title: string;
    start: string;
    durationMin: number;
  }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const prefillStart =
    item.slotStart ?? item.dueTime ?? item.plannedStart ?? "12:00";
  const prefillMinutes =
    item.slotMinutes ?? item.durationMin ?? item.plannedMinutes ?? 30;

  const [title, setTitle] = useState(item.title);
  const [start, setStart] = useState(prefillStart.slice(0, 5));
  const [minutes, setMinutes] = useState(String(prefillMinutes));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (title.trim().length === 0) {
      setError("title required");
      return;
    }
    const durationMin = Math.trunc(Number(minutes));
    if (!Number.isFinite(durationMin) || durationMin < 15) {
      setError("duration must be 15+ minutes");
      return;
    }
    setPending(true);
    const ok = await onSubmit({ title: title.trim(), start, durationMin });
    setPending(false);
    if (!ok) setError(null); // the caller surfaces its own error message
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-line p-3 space-y-3">
      <p className="text-[10px] tracking-widest uppercase text-muted">
        make calendar event · {dateKey}
      </p>

      <label className="block">
        <span className="block text-[10px] tracking-widest uppercase text-muted mb-1">
          title
        </span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none"
          required
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[10px] tracking-widest uppercase text-muted mb-1">
            start
          </span>
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none"
            required
          />
        </label>
        <label className="block">
          <span className="block text-[10px] tracking-widest uppercase text-muted mb-1">
            minutes
          </span>
          <input
            type="number"
            min={15}
            step={15}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none"
            required
          />
        </label>
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors px-3 py-1.5"
        >
          cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="bg-accent text-accent-fg text-xs tracking-widest uppercase font-bold px-3 py-1.5 hover:opacity-90 transition-colors disabled:opacity-50"
        >
          {pending ? "creating…" : "create event"}
        </button>
      </div>
    </form>
  );
}
