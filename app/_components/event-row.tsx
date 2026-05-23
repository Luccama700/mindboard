"use client";

import { formatDue } from "./date-utils";

export type VirtualEvent = {
  id: string;
  title: string;
  startDateKey: string;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  groupName: string;
  groupColor: string;
};

export function EventRow({
  event,
  variant = "default",
  hideDate = false,
}: {
  event: VirtualEvent;
  variant?: "default" | "overdue";
  hideDate?: boolean;
}) {
  const isOverdue = variant === "overdue";

  const timeLabel = event.allDay
    ? "all day"
    : event.startTime
      ? event.endTime
        ? `${event.startTime} – ${event.endTime}`
        : event.startTime
      : null;

  return (
    <div className="border-b border-line">
      <div className="flex items-center gap-3 py-3">
        <span
          className="flex-shrink-0 w-7 h-7 border-2 flex items-center justify-center"
          style={{ borderColor: event.groupColor }}
          aria-hidden
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
            <rect
              x="2"
              y="3"
              width="12"
              height="11"
              stroke={event.groupColor}
              strokeWidth="1.5"
            />
            <line
              x1="2"
              y1="6"
              x2="14"
              y2="6"
              stroke={event.groupColor}
              strokeWidth="1.5"
            />
          </svg>
        </span>

        <div className="flex-1 min-w-0 py-1">
          <p
            className={`text-base truncate ${
              isOverdue
                ? "text-fg font-bold"
                : "text-fg"
            }`}
          >
            {event.title}
          </p>
          <p className="text-[10px] tracking-widest uppercase mt-0.5 flex items-center gap-1.5">
            <span style={{ color: event.groupColor }}>{event.groupName}</span>
            {timeLabel && (
              <>
                <span className="text-line-subtle">·</span>
                <span className={isOverdue ? "text-danger" : "text-muted"}>
                  {timeLabel}
                </span>
              </>
            )}
            {!hideDate && (
              <>
                <span className="text-line-subtle">·</span>
                <span className={isOverdue ? "text-danger" : "text-muted"}>
                  {formatDue(event.startDateKey)}
                </span>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
