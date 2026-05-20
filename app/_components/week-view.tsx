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
import { useRef, useState } from "react";
import type { CalendarItem } from "./calendar-types";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const START_HOUR = 6;
const END_HOUR = 22;
const HOUR_HEIGHT = 42;
const SNAP_MINUTES = 15;

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

function timeLabel(hour: number) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function minutesIntoDay(value: string) {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

function timedStyle(item: Extract<CalendarItem, { kind: "event" }>) {
  const start = Math.min(
    Math.max(minutesIntoDay(item.start), START_HOUR * 60),
    END_HOUR * 60 - 30,
  );
  const end = Math.max(
    Math.min(minutesIntoDay(item.end), END_HOUR * 60),
    start + 30,
  );
  const top = ((start - START_HOUR * 60) / 60) * HOUR_HEIGHT;
  const rawHeight = ((end - start) / 60) * HOUR_HEIGHT;

  return {
    top: `${top}px`,
    height: `${Math.max(rawHeight, 32)}px`,
  };
}

function formatRange(item: Extract<CalendarItem, { kind: "event" }>) {
  if (item.allDay) return "all day";
  return `${formatTime(item.start)} – ${formatTime(item.end)}`;
}

function buildWeek(selected: string) {
  const start = startOfWeek(new Date(`${selected}T00:00:00`));
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

type DragData =
  | { kind: "task"; id: string; dateKey: string }
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
};

function TaskChip({
  item,
  dateKey,
}: {
  item: Extract<CalendarItem, { kind: "task" }>;
  dateKey: string;
}) {
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
      className={`truncate px-1.5 py-1 text-[10px] font-bold text-[#0d0d0d] cursor-grab touch-none ${
        isDragging ? "opacity-30" : ""
      }`}
      style={{ backgroundColor: item.color }}
    >
      {item.title}
    </div>
  );
}

function AllDayEventChip({
  item,
  dateKey,
}: {
  item: Extract<CalendarItem, { kind: "event" }>;
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
      className={`truncate px-1.5 py-1 text-[10px] font-bold text-[#0d0d0d] touch-none ${
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
  item: Extract<CalendarItem, { kind: "event" }>;
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
      className={`absolute left-1 right-1 overflow-hidden px-1.5 py-1 text-[#0d0d0d] touch-none ${
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

function DragPreview({ item }: { item: CalendarItem }) {
  const color = item.color;
  if (item.kind === "task" || item.allDay) {
    return (
      <div
        className="truncate px-1.5 py-1 text-[10px] font-bold text-[#0d0d0d] shadow-lg"
        style={{ backgroundColor: color }}
      >
        {item.title}
      </div>
    );
  }
  return (
    <div
      className="px-1.5 py-1 text-[#0d0d0d] shadow-lg"
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

export function WeekView({
  selected,
  today,
  itemsByDate,
  onSelect,
  onRescheduleEvent,
  onRescheduleTask,
}: {
  selected: string;
  today: string;
  itemsByDate: Map<string, CalendarItem[]>;
  onSelect: (key: string) => void;
  onRescheduleEvent: (e: RescheduleEvent) => void;
  onRescheduleTask: (t: RescheduleTask) => void;
}) {
  const week = buildWeek(selected);
  const timedRef = useRef<HTMLDivElement>(null);
  const [activeItem, setActiveItem] = useState<CalendarItem | null>(null);

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

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as DragData | undefined;
    if (!data) return;
    const item = findItem(data.id);
    if (item) setActiveItem(item);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveItem(null);
    const data = event.active.data.current as DragData | undefined;
    if (!data) return;

    const colW = columnWidth();
    const dayShift = Math.round(event.delta.x / colW);

    if (data.kind === "task") {
      if (dayShift === 0) return;
      const newDateKey = shiftDateKey(data.dateKey, dayShift);
      onRescheduleTask({ taskId: data.id, newDateKey });
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
                  onClick={() => onSelect(key)}
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
                <div
                  key={key}
                  onClick={() => onSelect(key)}
                  className="min-h-24 border-r border-[#1f1f1f] p-1.5 text-left last:border-r-0"
                >
                  <div className="space-y-1">
                    {allDayItems.slice(0, 2).map((item) =>
                      item.kind === "task" ? (
                        <TaskChip
                          key={`${item.kind}-${item.id}`}
                          item={item}
                          dateKey={key}
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
                      <span className="inline-flex h-5 items-center border border-[#3a3a3a] px-2 text-[10px] text-[#6b6b6b]">
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
                (item): item is Extract<CalendarItem, { kind: "event" }> =>
                  item.kind === "event" && !item.allDay,
              );

              return (
                <div
                  key={key}
                  onClick={() => onSelect(key)}
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
                    <TimedEventBlock key={item.id} item={item} dateKey={key} />
                  ))}
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
