"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import Link from "next/link";
import { useRef, useState } from "react";
import {
  freeIntervalsForDay,
  type ScheduleEvent,
} from "@/app/lib/snapshots/schedule";
import type { CalendarItem } from "./calendar-types";
import { formatClockTime, formatHourLabel } from "./date-utils";
import { formatSignedChange } from "./money";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const START_HOUR = 6;
const END_HOUR = 22;
const HOUR_HEIGHT = 42;
const SNAP_MINUTES = 15;
const DEFAULT_TASK_MINUTES = 30;
const LABEL_MIN_MINUTES = 45;

type TaskItem = Extract<CalendarItem, { kind: "task" }>;
type EventItem = Extract<CalendarItem, { kind: "event" }>;
type RtaskItem = Extract<CalendarItem, { kind: "rtask" }>;

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, count: number) {
  const next = new Date(date);
  next.setDate(date.getDate() + count);
  return next;
}

function startOfWeek(date: Date) {
  return addDays(date, -date.getDay());
}

function minutesIntoDay(value: string) {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

function timeToMinutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number) {
  const clamped = Math.max(0, Math.min(minutes, 23 * 60 + 45));
  const hh = String(Math.floor(clamped / 60)).padStart(2, "0");
  const mm = String(clamped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function blockStyle(startMinutes: number, endMinutes: number) {
  const start = Math.min(
    Math.max(startMinutes, START_HOUR * 60),
    END_HOUR * 60 - 30,
  );
  const end = Math.max(Math.min(endMinutes, END_HOUR * 60), start + 30);
  const top = ((start - START_HOUR * 60) / 60) * HOUR_HEIGHT;
  const rawHeight = ((end - start) / 60) * HOUR_HEIGHT;

  return {
    top: `${top}px`,
    height: `${Math.max(rawHeight, 32)}px`,
  };
}

function timedStyle(item: EventItem) {
  return blockStyle(minutesIntoDay(item.start), minutesIntoDay(item.end));
}

function formatRange(item: EventItem) {
  if (item.allDay) return "all day";
  return `${formatClockTime(item.start)} – ${formatClockTime(item.end)}`;
}

function buildWeek(selected: string) {
  const start = startOfWeek(new Date(`${selected}T00:00:00`));
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

function taskMinutes(item: TaskItem): { start: number; end: number } | null {
  if (!item.dueTime) return null;
  const start = timeToMinutes(item.dueTime.slice(0, 5));
  return { start, end: start + (item.durationMin ?? DEFAULT_TASK_MINUTES) };
}

function rtaskMinutes(item: RtaskItem): { start: number; end: number } {
  const start = timeToMinutes(item.dueTime.slice(0, 5));
  return { start, end: start + (item.durationMin ?? DEFAULT_TASK_MINUTES) };
}

type DragData =
  | { kind: "task"; id: string; dateKey: string }
  | {
      kind: "task-timed";
      id: string;
      dateKey: string;
      startMinutes: number;
      durationMin: number;
    }
  | { kind: "task-resize"; id: string; durationMin: number }
  | {
      kind: "event-timed";
      id: string;
      dateKey: string;
      startMinutes: number;
      endMinutes: number;
    }
  | { kind: "event-allday"; id: string; dateKey: string };

export type RescheduleEvent = {
  itemId: string;
  startDateKey: string;
  newStartMinutes: number | null;
  newEndMinutes: number | null;
  newDateKey: string;
};

export type RescheduleTask = {
  taskId: string;
  newDateKey: string;
  // undefined = keep the current time; null = clear it; "HH:MM" = set it.
  newTime?: string | null;
};

function TaskChip({ item, dateKey }: { item: TaskItem; dateKey: string }) {
  const draggable = useDraggable({
    id: `task-${item.id}`,
    data: { kind: "task", id: item.id, dateKey } satisfies DragData,
  });
  const { attributes, listeners, setNodeRef, isDragging } = draggable;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`truncate px-1.5 py-1 text-[10px] font-bold text-accent-fg cursor-grab touch-none ${
        isDragging ? "opacity-30" : ""
      }`}
      style={{ backgroundColor: item.color }}
    >
      {item.title}
    </div>
  );
}

// A time-blocked task: hollow (outlined) so owned blocks read differently
// from solid Google events; ⇅ marks a block mirrored to Google.
function TimedTaskBlock({
  item,
  dateKey,
}: {
  item: TaskItem;
  dateKey: string;
}) {
  const minutes = taskMinutes(item)!;
  const draggable = useDraggable({
    id: `task-timed-${item.id}`,
    data: {
      kind: "task-timed",
      id: item.id,
      dateKey,
      startMinutes: minutes.start,
      durationMin: item.durationMin ?? DEFAULT_TASK_MINUTES,
    } satisfies DragData,
  });
  const {
    attributes: resizeAttributes,
    listeners: resizeListeners,
    setNodeRef: setResizeRef,
  } = useDraggable({
    id: `task-resize-${item.id}`,
    data: {
      kind: "task-resize",
      id: item.id,
      durationMin: item.durationMin ?? DEFAULT_TASK_MINUTES,
    } satisfies DragData,
  });
  const { attributes, listeners, setNodeRef, isDragging } = draggable;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`absolute left-1 right-1 overflow-hidden border-2 bg-page/85 px-1.5 py-0.5 cursor-grab touch-none z-10 ${
        isDragging ? "opacity-30" : ""
      }`}
      style={{
        ...blockStyle(minutes.start, minutes.end),
        borderColor: item.color,
      }}
    >
      <p className="truncate text-[11px] font-bold text-fg">
        {item.pushed && <span aria-hidden>⇅ </span>}
        {item.title}
      </p>
      <p className="truncate text-[10px] text-muted">
        {minutesToTime(minutes.start)} – {minutesToTime(minutes.end)}
      </p>
      <div
        ref={setResizeRef}
        {...resizeAttributes}
        {...resizeListeners}
        aria-label={`resize ${item.title}`}
        className="absolute left-0 right-0 bottom-0 h-3 cursor-ns-resize touch-none"
      >
        <div className="mx-auto mt-1 h-0.5 w-6" style={{ backgroundColor: item.color }} />
      </div>
    </div>
  );
}

// A recurring occurrence: dashed hollow block, never draggable — the rule owns
// its schedule. Dimmed and struck once completed today.
function RecurringTaskBlock({ item }: { item: RtaskItem }) {
  const minutes = rtaskMinutes(item);
  return (
    <div
      className={`absolute left-1 right-1 overflow-hidden border-2 border-dashed bg-page/85 px-1.5 py-0.5 z-10 ${
        item.done ? "opacity-50" : ""
      }`}
      style={{
        ...blockStyle(minutes.start, minutes.end),
        borderColor: item.color,
      }}
    >
      <p
        className={`truncate text-[11px] font-bold text-fg ${
          item.done ? "line-through" : ""
        }`}
      >
        <span aria-hidden>↻ </span>
        {item.title}
      </p>
      <p className="truncate text-[10px] text-muted">
        {minutesToTime(minutes.start)} – {minutesToTime(minutes.end)}
      </p>
    </div>
  );
}

function AllDayEventChip({
  item,
  dateKey,
}: {
  item: EventItem;
  dateKey: string;
}) {
  const isWritable = item.writable !== false;
  const draggable = useDraggable({
    id: `event-allday-${item.id}`,
    disabled: !isWritable,
    data: { kind: "event-allday", id: item.id, dateKey } satisfies DragData,
  });
  const { attributes, listeners, setNodeRef, isDragging } = draggable;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`truncate px-1.5 py-1 text-[10px] font-bold text-accent-fg touch-none ${
        isWritable ? "cursor-grab" : "cursor-default opacity-60"
      } ${isDragging ? "opacity-30" : ""}`}
      style={{ backgroundColor: item.color }}
    >
      {item.title}
    </div>
  );
}

function TimedEventBlock({
  item,
  dateKey,
}: {
  item: EventItem;
  dateKey: string;
}) {
  const isWritable = item.writable !== false;
  const draggable = useDraggable({
    id: `event-timed-${item.id}`,
    disabled: !isWritable,
    data: {
      kind: "event-timed",
      id: item.id,
      dateKey,
      startMinutes: minutesIntoDay(item.start),
      endMinutes: minutesIntoDay(item.end),
    } satisfies DragData,
  });
  const { attributes, listeners, setNodeRef, isDragging } = draggable;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`absolute left-1 right-1 overflow-hidden px-1.5 py-1 text-accent-fg touch-none shadow-[inset_2px_0_0_rgba(0,0,0,0.35)] ${
        isWritable ? "cursor-grab" : "cursor-default opacity-60"
      } ${isDragging ? "opacity-30" : ""}`}
      style={{
        ...timedStyle(item),
        backgroundColor: item.color,
      }}
    >
      <p className="truncate text-[11px] font-bold">{item.title}</p>
      <p className="truncate text-[10px]">{formatRange(item)}</p>
    </div>
  );
}

function FinanceChip({
  item,
}: {
  item: Extract<CalendarItem, { kind: "finance" }>;
}) {
  return (
    <div
      className="truncate px-1.5 py-1 text-[10px] font-bold text-accent-fg"
      style={{ backgroundColor: item.color }}
    >
      {formatSignedChange(item.amount, item.direction, item.currency)}
    </div>
  );
}

function DragPreview({ item }: { item: CalendarItem }) {
  if (item.kind === "finance" || item.kind === "rtask") return null;
  const color = item.color;
  if (item.kind === "task" || item.allDay) {
    return (
      <div
        className="truncate px-1.5 py-1 text-[10px] font-bold text-accent-fg shadow-lg"
        style={{ backgroundColor: color }}
      >
        {item.title}
      </div>
    );
  }
  return (
    <div
      className="px-1.5 py-1 text-accent-fg shadow-lg"
      style={{
        backgroundColor: color,
        width: "9rem",
        height: timedStyle(item).height,
      }}
    >
      <p className="truncate text-[11px] font-bold">{item.title}</p>
      <p className="truncate text-[10px]">{formatRange(item)}</p>
    </div>
  );
}

// Underlay rects need honest heights: no 32px floor, clipped to the grid.
function underlayStyle(startMinutes: number, endMinutes: number) {
  const start = Math.max(startMinutes, START_HOUR * 60);
  const end = Math.min(endMinutes, END_HOUR * 60);
  if (end <= start) return null;
  return {
    top: `${((start - START_HOUR * 60) / 60) * HOUR_HEIGHT}px`,
    height: `${((end - start) / 60) * HOUR_HEIGHT}px`,
  };
}

// All free waking time, drawn under the events. Busy = timed events plus
// time-blocked tasks. Stretches of 45+ minutes show their duration and a
// plan ◇ handoff; shorter slivers are silent shading.
function FreeGapUnderlay({
  events,
  timedTasks,
  recurring,
  dateKey,
  now,
  wakeStartHour,
  wakeEndHour,
}: {
  events: EventItem[];
  timedTasks: TaskItem[];
  recurring: RtaskItem[];
  dateKey: string;
  now: Date;
  wakeStartHour: number;
  wakeEndHour: number;
}) {
  const busy: ScheduleEvent[] = [
    ...events.map((e) => ({
      summary: e.title,
      start: e.start,
      end: e.end,
      allDay: false,
    })),
    ...timedTasks.flatMap((t) => {
      const minutes = taskMinutes(t);
      if (!minutes) return [];
      return [
        {
          summary: t.title,
          start: `${dateKey}T${minutesToTime(minutes.start)}:00`,
          end: `${dateKey}T${minutesToTime(minutes.end)}:00`,
          allDay: false,
        },
      ];
    }),
    ...recurring.map((r) => {
      const minutes = rtaskMinutes(r);
      return {
        summary: r.title,
        start: `${dateKey}T${minutesToTime(minutes.start)}:00`,
        end: `${dateKey}T${minutesToTime(minutes.end)}:00`,
        allDay: false,
      };
    }),
  ];

  const intervals = freeIntervalsForDay({
    events: busy,
    dateKey,
    now,
    wakeStartHour,
    wakeEndHour,
  });

  return (
    <>
      {intervals.map((interval) => {
        const style = underlayStyle(
          interval.startMinutes,
          interval.endMinutes,
        );
        if (!style) return null;
        const hours = Math.round((interval.minutes / 60) * 10) / 10;
        return (
          <div
            key={interval.startMinutes}
            className="absolute left-0 right-0 bg-positive-wash pointer-events-none"
            style={style}
          >
            {interval.minutes >= LABEL_MIN_MINUTES && (
              <div className="flex items-start justify-between px-1 pt-0.5">
                <span className="text-[9px] text-positive">{hours}h</span>
                <Link
                  href="/plan"
                  className="pointer-events-auto text-[9px] text-muted hover:text-fg transition-colors"
                >
                  plan ◇
                </Link>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function WeekView({
  selected,
  today,
  itemsByDate,
  onSelect,
  onRescheduleEvent,
  onRescheduleTask,
  onResizeTask,
  wakeStartHour = 8,
  wakeEndHour = 22,
}: {
  selected: string;
  today: string;
  itemsByDate: Map<string, CalendarItem[]>;
  onSelect: (key: string) => void;
  onRescheduleEvent: (e: RescheduleEvent) => void;
  onRescheduleTask: (t: RescheduleTask) => void;
  onResizeTask?: (taskId: string, durationMin: number) => void;
  wakeStartHour?: number;
  wakeEndHour?: number;
}) {
  const week = buildWeek(selected);
  const timedRef = useRef<HTMLDivElement>(null);
  const [activeItem, setActiveItem] = useState<CalendarItem | null>(null);

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 8 },
    }),
  );

  const hourLabels = Array.from(
    { length: END_HOUR - START_HOUR + 1 },
    (_, index) => START_HOUR + index,
  );
  const weekHeight = (END_HOUR - START_HOUR) * HOUR_HEIGHT;

  function shiftDateKey(dateKey: string, days: number): string {
    const date = new Date(`${dateKey}T00:00:00`);
    return toDateKey(addDays(date, days));
  }

  function columnWidth(): number {
    const grid = timedRef.current;
    if (!grid) return 1;
    const total = grid.getBoundingClientRect().width;
    return Math.max((total - 56) / 7, 1); // 56 = 3.5rem left column
  }

  function findItem(itemId: string): CalendarItem | null {
    for (const items of itemsByDate.values()) {
      const match = items.find((i) => i.id === itemId);
      if (match) return match;
    }
    return null;
  }

  // Where (in day-minutes) the dragged element's top edge landed, or null when
  // it ended outside the hour grid.
  function droppedMinutes(event: DragEndEvent): number | null {
    const grid = timedRef.current;
    const translated = event.active.rect.current.translated;
    if (!grid || !translated) return null;
    const gridRect = grid.getBoundingClientRect();
    if (
      translated.top < gridRect.top - 8 ||
      translated.top > gridRect.bottom
    ) {
      return null;
    }
    const raw =
      ((translated.top - gridRect.top) / HOUR_HEIGHT) * 60 + START_HOUR * 60;
    const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
    return Math.max(
      START_HOUR * 60,
      Math.min(snapped, END_HOUR * 60 - SNAP_MINUTES),
    );
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as DragData | undefined;
    if (!data || data.kind === "task-resize") return;
    const item = findItem(data.id);
    if (item) setActiveItem(item);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveItem(null);
    const data = event.active.data.current as DragData | undefined;
    if (!data) return;

    const colW = columnWidth();
    const dayShift = Math.round(event.delta.x / colW);

    if (data.kind === "task-resize") {
      const minuteDelta =
        Math.round((event.delta.y / HOUR_HEIGHT) * 60 / SNAP_MINUTES) *
        SNAP_MINUTES;
      if (minuteDelta === 0) return;
      const next = Math.max(SNAP_MINUTES, data.durationMin + minuteDelta);
      onResizeTask?.(data.id, next);
      return;
    }

    if (data.kind === "task") {
      const minutes = droppedMinutes(event);
      if (minutes !== null) {
        // Dropped inside the hour grid: the task becomes a time-block.
        onRescheduleTask({
          taskId: data.id,
          newDateKey: dayShift === 0 ? data.dateKey : shiftDateKey(data.dateKey, dayShift),
          newTime: minutesToTime(minutes),
        });
        return;
      }
      if (dayShift === 0) return;
      onRescheduleTask({
        taskId: data.id,
        newDateKey: shiftDateKey(data.dateKey, dayShift),
      });
      return;
    }

    if (data.kind === "task-timed") {
      const grid = timedRef.current;
      const translated = event.active.rect.current.translated;
      if (grid && translated) {
        const gridRect = grid.getBoundingClientRect();
        if (translated.top < gridRect.top - 12) {
          // Dragged back up into the all-day row: the block dissolves.
          onRescheduleTask({
            taskId: data.id,
            newDateKey:
              dayShift === 0
                ? data.dateKey
                : shiftDateKey(data.dateKey, dayShift),
            newTime: null,
          });
          return;
        }
      }
      const rawMinuteShift = (event.delta.y / HOUR_HEIGHT) * 60;
      const minuteShift =
        Math.round(rawMinuteShift / SNAP_MINUTES) * SNAP_MINUTES;
      if (dayShift === 0 && minuteShift === 0) return;
      const newStart = Math.max(
        START_HOUR * 60,
        Math.min(data.startMinutes + minuteShift, END_HOUR * 60 - SNAP_MINUTES),
      );
      onRescheduleTask({
        taskId: data.id,
        newDateKey:
          dayShift === 0 ? data.dateKey : shiftDateKey(data.dateKey, dayShift),
        newTime: minutesToTime(newStart),
      });
      return;
    }

    if (data.kind === "event-allday") {
      if (dayShift === 0) return;
      const newDateKey = shiftDateKey(data.dateKey, dayShift);
      onRescheduleEvent({
        itemId: data.id,
        startDateKey: data.dateKey,
        newDateKey,
        newStartMinutes: null,
        newEndMinutes: null,
      });
      return;
    }

    if (data.kind === "event-timed") {
      const rawMinuteShift = (event.delta.y / HOUR_HEIGHT) * 60;
      const minuteShift =
        Math.round(rawMinuteShift / SNAP_MINUTES) * SNAP_MINUTES;
      if (dayShift === 0 && minuteShift === 0) return;
      const newDateKey = shiftDateKey(data.dateKey, dayShift);
      const duration = data.endMinutes - data.startMinutes;
      const newStart = data.startMinutes + minuteShift;
      const newEnd = newStart + duration;
      onRescheduleEvent({
        itemId: data.id,
        startDateKey: data.dateKey,
        newDateKey,
        newStartMinutes: newStart,
        newEndMinutes: newEnd,
      });
    }
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveItem(null)}
    >
      <div className="overflow-x-auto border border-line">
        <div className="min-w-[43rem] bg-page">
          <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line">
            <div className="border-r border-line" />
            {week.map((date) => {
              const key = toDateKey(date);
              const isSelected = selected === key;
              const isToday = key === today;

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSelect(key)}
                  className={`min-h-16 border-r border-line px-2 py-2 text-center transition-colors last:border-r-0 ${
                    isSelected ? "bg-card" : "bg-page"
                  }`}
                >
                  <p className="text-[9px] tracking-widest uppercase text-muted">
                    {WEEKDAYS[date.getDay()]}
                  </p>
                  <p
                    className={`mx-auto mt-1 flex h-9 w-9 items-center justify-center text-xl ${
                      isToday
                        ? "rounded-full bg-accent text-accent-fg"
                        : "text-fg"
                    }`}
                  >
                    {date.getDate()}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line">
            <div className="border-r border-line px-2 py-2 text-[9px] tracking-widest uppercase text-muted">
              due
            </div>
            {week.map((date) => {
              const key = toDateKey(date);
              const allDayItems = (itemsByDate.get(key) ?? []).filter(
                (item): item is Exclude<CalendarItem, { kind: "rtask" }> =>
                  (item.kind === "task" && !item.dueTime) ||
                  item.kind === "finance" ||
                  (item.kind === "event" && item.allDay),
              );

              return (
                <div
                  key={key}
                  onClick={() => onSelect(key)}
                  className={`min-h-24 border-r border-line p-1.5 text-left last:border-r-0 ${
                    key === today ? "bg-card" : ""
                  }`}
                >
                  <div className="space-y-1">
                    {allDayItems.slice(0, 2).map((item) =>
                      item.kind === "task" ? (
                        <TaskChip
                          key={`${item.kind}-${item.id}`}
                          item={item}
                          dateKey={key}
                        />
                      ) : item.kind === "finance" ? (
                        <FinanceChip
                          key={`${item.kind}-${item.id}`}
                          item={item}
                        />
                      ) : (
                        <AllDayEventChip
                          key={`${item.kind}-${item.id}`}
                          item={item}
                          dateKey={key}
                        />
                      ),
                    )}
                    {allDayItems.length > 2 && (
                      <span className="inline-flex h-5 items-center border border-line-subtle px-2 text-[10px] text-muted">
                        +{allDayItems.length - 2} more
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            ref={timedRef}
            className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]"
            style={{ height: weekHeight }}
          >
            <div className="relative border-r border-line">
              {hourLabels.slice(0, -1).map((hour, index) => (
                <div
                  key={hour}
                  className="absolute left-0 right-0 border-t border-line px-1 pt-1 text-right text-[10px] text-muted"
                  style={{ top: index * HOUR_HEIGHT }}
                >
                  {formatHourLabel(hour)}
                </div>
              ))}
            </div>

            {week.map((date) => {
              const key = toDateKey(date);
              const dayItems = itemsByDate.get(key) ?? [];
              const timedItems = dayItems.filter(
                (item): item is EventItem =>
                  item.kind === "event" && !item.allDay,
              );
              const timedTasks = dayItems.filter(
                (item): item is TaskItem =>
                  item.kind === "task" && item.dueTime !== null,
              );
              const recurringItems = dayItems.filter(
                (item): item is RtaskItem => item.kind === "rtask",
              );
              const isToday = key === today;
              const nowTop =
                ((nowMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;

              return (
                <div
                  key={key}
                  onClick={() => onSelect(key)}
                  className={`relative border-r border-line text-left last:border-r-0 ${
                    isToday ? "bg-card" : ""
                  }`}
                >
                  {hourLabels.slice(0, -1).map((hour, index) => (
                    <div
                      key={hour}
                      className="absolute left-0 right-0 border-t border-line"
                      style={{ top: index * HOUR_HEIGHT }}
                    />
                  ))}

                  <FreeGapUnderlay
                    events={timedItems}
                    timedTasks={timedTasks}
                    recurring={recurringItems}
                    dateKey={key}
                    now={now}
                    wakeStartHour={wakeStartHour}
                    wakeEndHour={wakeEndHour}
                  />

                  {timedItems.map((item) => (
                    <TimedEventBlock key={item.id} item={item} dateKey={key} />
                  ))}

                  {recurringItems.map((item) => (
                    <RecurringTaskBlock key={item.id} item={item} />
                  ))}

                  {timedTasks.map((item) => (
                    <TimedTaskBlock key={item.id} item={item} dateKey={key} />
                  ))}

                  {isToday &&
                    nowMinutes >= START_HOUR * 60 &&
                    nowMinutes <= END_HOUR * 60 && (
                      <div
                        aria-hidden
                        className="absolute left-0 right-0 z-20 pointer-events-none"
                        style={{ top: nowTop }}
                      >
                        <div className="h-px bg-accent" />
                        <div className="absolute -top-[3px] left-0 h-[7px] w-[7px] rounded-full bg-accent" />
                      </div>
                    )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeItem ? <DragPreview item={activeItem} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
