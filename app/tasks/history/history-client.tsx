"use client";

import { startTransition, useOptimistic } from "react";
import { reopenTask } from "@/app/actions/tasks";
import { zonedClock } from "@/app/lib/snapshots/zoned-time";
import type { HistoryDay } from "@/app/lib/snapshots/history";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${MONTHS[m - 1]} ${d}`;
}

export function HistoryClient({
  days,
  timeZone,
}: {
  days: HistoryDay[];
  timeZone: string | null;
}) {
  const [visibleDays, dropEvent] = useOptimistic(days, (state, id: string) =>
    state
      .map((day) => ({
        ...day,
        events: day.events.filter((e) => e.id !== id),
      }))
      .filter((day) => day.events.length > 0),
  );

  function onReopen(id: string) {
    startTransition(async () => {
      dropEvent(id);
      await reopenTask(id);
    });
  }

  if (visibleDays.length === 0) {
    return (
      <p className="text-muted text-sm text-center pt-12 pb-8">
        nothing here yet — finished and missed tasks land here.
      </p>
    );
  }

  // Running index across day groups so rows cascade in, capped so a long
  // history doesn't stagger forever. Stable keys keep a reopen removal from
  // replaying its siblings' entrance.
  const orderIndex = new Map<string, number>();
  for (const day of visibleDays) {
    for (const e of day.events) orderIndex.set(e.id, orderIndex.size);
  }

  return (
    <div className="space-y-6">
      {visibleDays.map((day) => (
        <div key={day.dateKey}>
          <p className="text-[10px] tracking-widest uppercase text-muted mb-1.5 px-1">
            {dayLabel(day.dateKey)}
          </p>
          {day.events.map((e) => {
            const done = e.kind === "done";
            const delay = Math.min(orderIndex.get(e.id) ?? 0, 12) * 35;
            return (
              <div
                key={e.id}
                className="flex items-center gap-2.5 py-2 border-b border-line stream-rise"
                style={{ animationDelay: `${delay}ms` }}
              >
                <span
                  className={`flex-shrink-0 text-sm ${done ? "text-accent" : "text-danger"}`}
                  aria-hidden
                >
                  {done ? "✓" : "✕"}
                </span>
                <span
                  className={`flex-1 min-w-0 truncate text-sm ${done ? "text-fg" : "text-muted"}`}
                >
                  {e.title}
                </span>
                {e.group_name && (
                  <span className="inline-flex items-center gap-1.5 flex-shrink-0 text-[10px] tracking-widest uppercase">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: e.group_color ?? "var(--muted)" }}
                      aria-hidden
                    />
                    <span style={{ color: e.group_color ?? "var(--muted)" }}>
                      {e.group_name}
                    </span>
                  </span>
                )}
                <span className="flex-shrink-0 text-[10px] tracking-widest uppercase text-muted tabular-nums">
                  {zonedClock(new Date(e.at).getTime(), timeZone)}
                </span>
                {!done && (
                  <button
                    type="button"
                    onClick={() => onReopen(e.id)}
                    className="press flex-shrink-0 inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
                  >
                    reopen
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
