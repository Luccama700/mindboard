"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { CalendarEvent } from "@/utils/google/calendar";
import { rescheduleEvent } from "@/app/actions/calendar";
import { updateTask } from "@/app/actions/tasks";
import {
  approveRecurringSlot,
  clearRecurringSlot,
  promoteRecurringToEvent,
  unpromoteRecurringEvent,
} from "@/app/actions/recurring-tasks";
import { freeIntervalsForDay } from "@/app/lib/snapshots/schedule";
import type { ScheduleVitals } from "@/app/lib/snapshots/schedule";
import {
  busyFromDayItems,
  planUntimedOccurrences,
} from "@/app/lib/snapshots/gap-plan";
import type { CalendarRecurringTask } from "@/app/lib/data/dashboard";
import type { RecurringSlotRow } from "@/app/lib/data/recurring-tasks";
import { formatRecurrence, taskRuleLandsOn } from "@/app/lib/recurrence";
import type { CalendarItem } from "./calendar-types";
import { eventDateKey, wallMinutesToIso } from "./event-time";
import {
  formatClockTime,
  formatMonthDay,
  formatMonthYear,
  formatRelativeToNow,
  formatWeekdayMonthDay,
} from "./date-utils";
import { formatSignedChange } from "./money";
import { EventEditPanel } from "./event-edit-panel";
import { RtaskPromotePanel } from "./rtask-promote-panel";
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

type TaskOverride = {
  dateKey: string | null;
  dueTime?: string | null;
  durationMin?: number | null;
};

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

function addDaysToKey(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

function formatEventRange(
  item: Extract<CalendarItem, { kind: "event" }>,
  timeZone: string | null,
) {
  if (item.allDay) return "all day";
  return `${formatClockTime(item.start, timeZone)} – ${formatClockTime(item.end, timeZone)}`;
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
  today,
  timeZone,
  tasks,
  events,
  finance = [],
  status,
  calendarLinks = {},
  initialView = "month",
  selectedDay = null,
  wakeStartHour = 8,
  wakeEndHour = 22,
  scheduleVitals,
  basePath = "/",
  recurringTasks = [],
  recurringCompletions = [],
  recurringSlots = [],
}: {
  month: string;
  // The USER'S day (user_settings.timezone), resolved by the page. Required,
  // not derived: this both highlights "today" in the grid and gates
  // drag-reschedule / slot-approval writes, so deriving it from the device
  // clock put a capture-bar task in one column while highlighting another.
  today: string;
  // The USER'S zone (user_settings.timezone; null = device). Google events
  // arrive as instants — which day column and which hour a block lands on, the
  // time labels, the now-line, and the instants written back by drag / the edit
  // panel are all resolved in this zone so a Vancouver schedule viewed from
  // London still reads in Vancouver time.
  timeZone: string | null;
  tasks: TaskWithGroup[];
  events: CalendarEvent[];
  finance?: FinanceChange[];
  status: CalendarStatus;
  calendarLinks?: Record<string, CalendarLink>;
  initialView?: "month" | "week";
  selectedDay?: string | null;
  wakeStartHour?: number;
  wakeEndHour?: number;
  scheduleVitals?: ScheduleVitals;
  basePath?: string;
  recurringTasks?: CalendarRecurringTask[];
  recurringCompletions?: { rule_id: string; occurred_on: string }[];
  recurringSlots?: RecurringSlotRow[];
}) {
  const router = useRouter();
  const grid = useMemo(() => buildGrid(month), [month]);
  const firstInMonth = `${month}-01`;
  // A ?d= param (week arrows) anchors the selection; otherwise land on today
  // when it's in view, else the first of the month.
  const initialSelected =
    selectedDay && /^\d{4}-\d{2}-\d{2}$/.test(selectedDay)
      ? selectedDay
      : grid.some((date) => toDateKey(date) === today)
        ? today
        : firstInMonth;
  const [selected, setSelected] = useState(initialSelected);
  const [view, setView] = useState<"month" | "week">(initialView);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [eventOverrides, setEventOverrides] = useState<
    Record<string, EventOverride>
  >({});
  const [taskOverrides, setTaskOverrides] = useState<
    Record<string, TaskOverride>
  >({});
  // Optimistic per-occurrence slot state, keyed `${ruleId}:${dateKey}`. Tri-state:
  // a value is an optimistic commitment, null is an optimistic clear, absent
  // defers to the DB slot. Applied during materialization before the planning
  // pass so an approved slot wins over any DB row and suppresses its ghost.
  const [slotOverrides, setSlotOverrides] = useState<
    Record<string, { start: string; minutes: number } | null>
  >({});
  // Occurrences promoted to real events this session, keyed `${ruleId}:${dateKey}`:
  // hidden immediately, the refreshed fetch brings in the Google event.
  const [promotedKeys, setPromotedKeys] = useState<Set<string>>(new Set());
  const [promoteFor, setPromoteFor] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();

    for (const task of tasks) {
      const override = taskOverrides[task.id];
      const due = override !== undefined ? override.dateKey : task.due_date;
      if (!due) continue;
      const dueTime =
        override && override.dueTime !== undefined
          ? override.dueTime
          : task.due_time;
      const durationMin =
        override && override.durationMin !== undefined
          ? override.durationMin
          : task.duration_min;
      const items = map.get(due) ?? [];
      items.push({
        kind: "task",
        id: task.id,
        title: task.title,
        color: task.group_color ?? "#b5ff3c",
        group: task.group_name ?? "inbox",
        dueTime,
        durationMin,
        pushed: Boolean(task.gcal_event_id),
      });
      map.set(due, items);
    }

    for (const event of events) {
      const override = eventOverrides[event.id];
      const start = override?.start ?? event.start;
      const end = override?.end ?? event.end;
      const allDay = override?.allDay ?? event.allDay;
      const key = eventDateKey(start, allDay, timeZone);
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

    if (recurringTasks.length > 0) {
      const completed = new Set(
        recurringCompletions.map((c) => `${c.rule_id}:${c.occurred_on}`),
      );
      const slotByKey = new Map(
        recurringSlots.map((s) => [`${s.rule_id}:${s.occurred_on}`, s]),
      );
      for (const date of grid) {
        const key = toDateKey(date);
        for (const rule of recurringTasks) {
          if (!taskRuleLandsOn(rule, date)) continue;
          const overrideKey = `${rule.id}:${key}`;
          const override = slotOverrides[overrideKey];
          const slot = slotByKey.get(overrideKey);
          // Promoted: the real Google event (fetched normally) stands in for
          // this day's occurrence — no rtask item at all.
          if (slot?.gcal_event_id || promotedKeys.has(overrideKey)) continue;
          let slotStart: string | null = null;
          let slotMinutes: number | null = null;
          if (override === null) {
            // optimistically cleared: no slot
          } else if (override !== undefined) {
            slotStart =
              override.start.length === 5
                ? `${override.start}:00`
                : override.start;
            slotMinutes = override.minutes;
          } else if (slot) {
            slotStart =
              slot.start_time.length === 5
                ? `${slot.start_time}:00`
                : slot.start_time;
            slotMinutes = slot.duration_min;
          }
          const items = map.get(key) ?? [];
          items.push({
            kind: "rtask",
            id: `rtask:${rule.id}:${key}`,
            ruleId: rule.id,
            title: rule.title,
            color: rule.group_color ?? "#b5ff3c",
            dueTime: rule.due_time,
            durationMin: rule.duration_min,
            plannedStart: null,
            plannedMinutes: null,
            slotStart,
            slotMinutes,
            scheduleLabel: formatRecurrence(rule),
            done: completed.has(`${rule.id}:${key}`),
          });
          map.set(key, items);
        }
      }

      // Soft-placement pass: advisory only, never touches busy/free math. For
      // each day from today forward, drop that day's untimed, not-done
      // occurrences into its free gaps and stamp plannedStart/plannedMinutes on
      // the matching rtask items. Past days stay unplaced (null).
      const ruleById = new Map(recurringTasks.map((r) => [r.id, r]));
      const now = new Date();
      for (const date of grid) {
        const key = toDateKey(date);
        if (key < today) continue;
        const dayItems = map.get(key);
        if (!dayItems) continue;
        // Committed slots (slotStart set) are excluded from the proposal planner
        // — they are real placements, and busyFromDayItems already counts them,
        // so remaining ghosts pack around them.
        const untimed = dayItems.filter(
          (item): item is Extract<CalendarItem, { kind: "rtask" }> =>
            item.kind === "rtask" &&
            item.dueTime === null &&
            item.slotStart === null &&
            !item.done,
        );
        if (untimed.length === 0) continue;
        const intervals = freeIntervalsForDay({
          events: busyFromDayItems(key, dayItems),
          dateKey: key,
          now,
          wakeStartHour,
          wakeEndHour,
          timeZone,
        });
        const slots = planUntimedOccurrences({
          rules: untimed.map((item) => {
            const rule = ruleById.get(item.ruleId);
            return {
              id: item.ruleId,
              priority: rule?.priority ?? "med",
              duration_min: item.durationMin,
              created_at: rule?.created_at ?? "",
            };
          }),
          intervals,
          dateKey: key,
        });
        for (const slot of slots) {
          const item = untimed.find((i) => i.ruleId === slot.ruleId);
          if (item) {
            item.plannedStart = `${slot.start}:00`;
            item.plannedMinutes = slot.minutes;
          }
        }
      }
    }

    return map;
  }, [
    calendarLinks,
    events,
    tasks,
    finance,
    eventOverrides,
    taskOverrides,
    recurringTasks,
    recurringCompletions,
    recurringSlots,
    slotOverrides,
    promotedKeys,
    grid,
    today,
    timeZone,
    wakeStartHour,
    wakeEndHour,
  ]);

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
      void commitEventReschedule(item, {
        start: wallMinutesToIso(
          payload.newDateKey,
          payload.newStartMinutes,
          timeZone,
        ),
        end: wallMinutesToIso(payload.newDateKey, payload.newEndMinutes, timeZone),
        allDay: false,
      });
    }
  }

  async function onRescheduleTask(payload: RescheduleTask) {
    setErrorMessage(null);
    setTaskOverrides((o) => ({
      ...o,
      [payload.taskId]: {
        dateKey: payload.newDateKey,
        ...(payload.newTime !== undefined ? { dueTime: payload.newTime } : {}),
      },
    }));
    const result = await updateTask({
      id: payload.taskId,
      dueDate: payload.newDateKey,
      ...(payload.newTime !== undefined ? { dueTime: payload.newTime } : {}),
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

  async function onResizeTask(taskId: string, durationMin: number) {
    setErrorMessage(null);
    setTaskOverrides((o) => {
      const prev = o[taskId];
      return {
        ...o,
        [taskId]: prev
          ? { ...prev, durationMin }
          : {
              dateKey:
                tasks.find((t) => t.id === taskId)?.due_date ?? null,
              durationMin,
            },
      };
    });
    const result = await updateTask({ id: taskId, durationMin });
    if (result?.error) setErrorMessage(result.error || "resize failed");
  }

  function onEditEvent(
    eventItem: Extract<CalendarItem, { kind: "event" }>,
    next: EventOverride,
  ) {
    void commitEventReschedule(eventItem, next);
  }

  async function handleScheduleRtask(p: {
    ruleId: string;
    occurredOn: string;
    start: string;
    durationMin: number;
    fromDateKey?: string;
  }) {
    setErrorMessage(null);
    const crossDay =
      p.fromDateKey !== undefined && p.fromDateKey !== p.occurredOn;
    if (crossDay) {
      const rule = recurringTasks.find((r) => r.id === p.ruleId);
      if (
        rule &&
        !taskRuleLandsOn(rule, new Date(`${p.occurredOn}T00:00:00`))
      ) {
        setErrorMessage("that routine doesn't occur on that day");
        return;
      }
    }

    const targetKey = `${p.ruleId}:${p.occurredOn}`;
    const sourceKey = crossDay ? `${p.ruleId}:${p.fromDateKey}` : null;
    const priors: Record<
      string,
      { start: string; minutes: number } | null | undefined
    > = { [targetKey]: slotOverrides[targetKey] };
    if (sourceKey) priors[sourceKey] = slotOverrides[sourceKey];

    const startSec = p.start.length === 5 ? `${p.start}:00` : p.start;
    setSlotOverrides((o) => {
      const next = { ...o, [targetKey]: { start: startSec, minutes: p.durationMin } };
      if (sourceKey) next[sourceKey] = null;
      return next;
    });

    const result = await approveRecurringSlot({
      ruleId: p.ruleId,
      dateKey: p.occurredOn,
      start: p.start,
      durationMin: p.durationMin,
      fromDateKey: p.fromDateKey,
    });
    if (result?.error) {
      setSlotOverrides((o) => {
        const next = { ...o };
        for (const [k, v] of Object.entries(priors)) {
          if (v === undefined) delete next[k];
          else next[k] = v;
        }
        return next;
      });
      setErrorMessage(result.error || "couldn't schedule that routine");
    }
  }

  async function handleUnpromote(ruleId: string, occurredOn: string) {
    setErrorMessage(null);
    const result = await unpromoteRecurringEvent(ruleId, occurredOn);
    if (result?.error) {
      setErrorMessage(result.error || "couldn't restore the routine");
      return;
    }
    setPromotedKeys((keys) => {
      const next = new Set(keys);
      next.delete(`${ruleId}:${occurredOn}`);
      return next;
    });
    router.refresh();
  }

  async function handlePromoteRtask(p: {
    ruleId: string;
    occurredOn: string;
    title: string;
    start: string;
    durationMin: number;
  }) {
    setErrorMessage(null);
    const result = await promoteRecurringToEvent(p);
    if (result?.error) {
      setErrorMessage(result.error || "couldn't create the event");
      return false;
    }
    setPromotedKeys((keys) => {
      const next = new Set(keys);
      next.add(`${p.ruleId}:${p.occurredOn}`);
      return next;
    });
    router.refresh();
    return true;
  }

  async function handleClearRtaskSlot(ruleId: string, dateKey: string) {
    setErrorMessage(null);
    const key = `${ruleId}:${dateKey}`;
    const prior = slotOverrides[key];
    setSlotOverrides((o) => ({ ...o, [key]: null }));
    const result = await clearRecurringSlot(ruleId, dateKey);
    if (result?.error) {
      setSlotOverrides((o) => {
        const next = { ...o };
        if (prior === undefined) delete next[key];
        else next[key] = prior;
        return next;
      });
      setErrorMessage(result.error || "couldn't clear that slot");
    }
  }

  // Events that exist because a routine occurrence was promoted, keyed by the
  // Google event id — these get a "back to routine" affordance in the day list.
  const promotedByEventId = useMemo(() => {
    const map = new Map<string, { ruleId: string; occurredOn: string }>();
    for (const s of recurringSlots) {
      if (s.gcal_event_id) {
        map.set(s.gcal_event_id, {
          ruleId: s.rule_id,
          occurredOn: s.occurred_on,
        });
      }
    }
    return map;
  }, [recurringSlots]);

  const selectedItems = itemsByDate.get(selected) ?? [];
  const selectedLabel = formatWeekdayMonthDay(
    new Date(`${selected}T00:00:00`),
  );

  // The loaded data spans the 42-day grid (6 full weeks, Sunday-aligned), so a
  // week step that stays inside it needs no server round-trip — just move the
  // selection. Only crossing the window fetches a new month (which reloads
  // Google Calendar), the slow path we avoid for adjacent weeks.
  const gridStart = toDateKey(grid[0]);
  const gridEnd = toDateKey(grid[grid.length - 1]);

  function stepWeek(days: number) {
    const target = addDaysToKey(selected, days);
    if (target >= gridStart && target <= gridEnd) {
      setSelected(target);
    } else {
      router.push(`${basePath}?m=${target.slice(0, 7)}&d=${target}`);
    }
  }

  const navArrowClass =
    "flex min-h-11 min-w-11 items-center justify-center border rounded-full border-line-strong text-muted transition-colors hover:border-fg hover:text-fg";

  return (
    <section className="glass-panel p-3 lg:min-h-[calc(100vh-4rem)]">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-muted">
            calendar
          </p>
          <h2 className="text-xl font-bold text-fg mt-1">
            {view === "month" ? monthLabel(month) : weekLabel(selected)}
          </h2>
          {view === "week" && scheduleVitals && (
            <p className="mt-1 text-meta text-muted" suppressHydrationWarning>
              {scheduleVitals.nextEvent && (
                <>
                  ▸ {scheduleVitals.nextEvent.summary}{" "}
                  {formatRelativeToNow(scheduleVitals.nextEvent.start)}
                  {" · "}
                </>
              )}
              <span className="text-positive">
                {scheduleVitals.freeHoursToday}h free
              </span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {view === "week" ? (
            <>
              <button
                type="button"
                onClick={() => stepWeek(-7)}
                className={navArrowClass}
                aria-label="previous week"
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => stepWeek(7)}
                className={navArrowClass}
                aria-label="next week"
              >
                →
              </button>
            </>
          ) : (
            <>
              <Link
                href={`${basePath}?m=${addMonths(month, -1)}`}
                className={navArrowClass}
                aria-label="previous month"
              >
                ←
              </Link>
              <Link
                href={`${basePath}?m=${addMonths(month, 1)}`}
                className={navArrowClass}
                aria-label="next month"
              >
                →
              </Link>
            </>
          )}
        </div>
      </header>

      <div className="mb-3 ml-auto grid w-56 grid-cols-2 gap-px border border-line bg-line rounded-full overflow-hidden">
        {(["month", "week"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setView(option)}
            className={`min-h-11 text-[9px] tracking-widest uppercase transition-colors ${
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
        <div className="border border-line-strong rounded-field px-3 py-2 mb-4">
          <p className="text-xs text-muted leading-relaxed">
            {status === "connect"
              ? "connect google calendar by signing out and back in."
              : "google calendar is temporarily unavailable."}
          </p>
        </div>
      )}

      {errorMessage && (
        <div className="border border-danger rounded-field px-3 py-2 mb-4 flex items-start justify-between gap-2">
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
        <div className="grid grid-cols-7 gap-px bg-line border border-line rounded-xl overflow-hidden">
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
                  isSelected ? "outline outline-1 outline-accent-ink" : ""
                } ${inMonth ? "text-fg" : "text-line-subtle"}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`text-xs ${
                      isToday ? "text-accent-ink font-bold" : ""
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

                {/* Narrow columns (~46px on mobile) can't fit readable chip
                    text — every label truncates to "−CA…" — so show color
                    squares instead; the day taps through to the selected-day
                    list below. Wider screens keep the labelled chips. */}
                {items.length > 0 && (
                  <div className="flex flex-wrap gap-0.5 lg:hidden">
                    {items.slice(0, 8).map((item) => (
                      <span
                        key={`dot-${item.kind}-${item.id}`}
                        className="h-1.5 w-1.5"
                        style={{ backgroundColor: item.color }}
                        aria-hidden
                      />
                    ))}
                  </div>
                )}

                <div className="hidden space-y-1 lg:block">
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
          wakeStartHour={wakeStartHour}
          wakeEndHour={wakeEndHour}
          onResizeTask={onResizeTask}
          today={today}
          timeZone={timeZone}
          itemsByDate={itemsByDate}
          onSelect={setSelected}
          onRescheduleEvent={onRescheduleEvent}
          onRescheduleTask={onRescheduleTask}
          onScheduleRtask={handleScheduleRtask}
          onClearRtaskSlot={handleClearRtaskSlot}
        />
      )}

      <div className="mt-4 border-t border-line pt-4" data-tour="week-day-list">
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
                  className="border border-line rounded-xl overflow-hidden"
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
                          : item.kind === "rtask"
                            ? `↻ ${item.scheduleLabel} · ${
                                item.slotStart
                                  ? item.slotStart.slice(0, 5)
                                  : item.dueTime
                                    ? item.dueTime.slice(0, 5)
                                    : item.plannedStart
                                      ? `~${item.plannedStart.slice(0, 5)}`
                                      : "anytime"
                              }${item.done ? " · done" : ""}`
                            : `${item.calendar} · ${formatEventRange(item, timeZone)}`}
                    </p>
                  </button>

                  {isExpanded && item.kind === "event" && isEditableEvent && (
                    <EventEditPanel
                      event={item}
                      timeZone={timeZone}
                      onSubmit={(next) => {
                        onEditEvent(item, next);
                        setExpandedItem(null);
                      }}
                      onCancel={() => setExpandedItem(null)}
                    />
                  )}

                  {item.kind === "event" && promotedByEventId.has(item.id) && (
                    <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-1">
                      <span className="truncate text-[10px] text-muted">
                        was a routine · the google event stays until deleted
                        there
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const p = promotedByEventId.get(item.id);
                          if (p) handleUnpromote(p.ruleId, p.occurredOn);
                        }}
                        className="min-h-11 shrink-0 px-3 text-xs text-muted hover:text-danger transition-colors"
                      >
                        back to routine ×
                      </button>
                    </div>
                  )}

                  {item.kind === "rtask" && !item.done && (
                    <div className="flex justify-end gap-1 border-t border-line px-3 py-1">
                      <button
                        type="button"
                        onClick={() =>
                          setPromoteFor((k) => (k === itemKey ? null : itemKey))
                        }
                        className="min-h-11 px-3 text-xs text-accent-ink hover:text-fg transition-colors"
                      >
                        make event →
                      </button>
                      {item.slotStart !== null && (
                        <button
                          type="button"
                          onClick={() =>
                            handleClearRtaskSlot(item.ruleId, selected)
                          }
                          className="min-h-11 px-3 text-xs text-muted hover:text-danger transition-colors"
                        >
                          unpin ×
                        </button>
                      )}
                    </div>
                  )}

                  {item.kind === "rtask" && item.done && item.slotStart !== null && (
                    <div className="flex justify-end border-t border-line px-3 py-1">
                      <button
                        type="button"
                        onClick={() =>
                          handleClearRtaskSlot(item.ruleId, selected)
                        }
                        className="min-h-11 px-3 text-xs text-muted hover:text-danger transition-colors"
                      >
                        unpin ×
                      </button>
                    </div>
                  )}

                  {item.kind === "rtask" && promoteFor === itemKey && (
                    <RtaskPromotePanel
                      item={item}
                      dateKey={selected}
                      onSubmit={async (p) => {
                        const ok = await handlePromoteRtask({
                          ruleId: item.ruleId,
                          occurredOn: selected,
                          ...p,
                        });
                        if (ok) setPromoteFor(null);
                        return ok;
                      }}
                      onCancel={() => setPromoteFor(null)}
                    />
                  )}

                  {item.kind === "rtask" &&
                    item.dueTime === null &&
                    item.plannedStart !== null &&
                    item.slotStart === null &&
                    !item.done && (
                      <div className="flex justify-end border-t border-line px-3 py-1">
                        <button
                          type="button"
                          onClick={() =>
                            handleScheduleRtask({
                              ruleId: item.ruleId,
                              occurredOn: selected,
                              start: item.plannedStart!.slice(0, 5),
                              durationMin:
                                item.plannedMinutes ?? item.durationMin ?? 30,
                            })
                          }
                          className="min-h-11 px-3 text-xs text-accent-ink hover:text-fg transition-colors"
                        >
                          add {item.plannedStart!.slice(0, 5)}
                        </button>
                      </div>
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
