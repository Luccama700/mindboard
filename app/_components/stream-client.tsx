"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createTask,
  markTaskMissed,
  toggleTaskStatus,
  updateTask,
} from "@/app/actions/tasks";
import { updateInventoryItem } from "@/app/actions/inventory";
import {
  archiveRecurringTask,
  completeRecurringOccurrence,
  updateRecurringTask,
  type RecurringTaskInput,
} from "@/app/actions/recurring-tasks";
import type { FreeGap } from "@/app/lib/snapshots/schedule";
import {
  formatEstimate,
  type StreamCard,
  type StreamSnapshot,
} from "@/app/lib/snapshots/stream";
import { daysLate } from "@/app/lib/snapshots/urgency";
import { subscribeCapture } from "./capture-bus";
import { todayISO } from "./date-utils";
import { formatMoney } from "./money";
import { SectionRuler } from "./ui";
import {
  DailyLogSheet,
  SpendSheet,
  type SpendAccount,
  type SpendCategory,
} from "./stream-sheets";
import { RecurringEditPanel } from "./recurring-edit-panel";
import { MindspaceBar } from "./mindspace-bar";
import type { MindshareBar } from "@/app/lib/mindspace/share-bar";
import type { Task } from "./types";

type SectionKey = "now" | "next" | "later" | "loose" | "routines";

function snoozeOptions(today: string): { label: string; dateKey: string }[] {
  const parse = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const fmt = (date: Date) => {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${m}-${d}`;
  };
  const base = parse(today);
  const tomorrow = new Date(base);
  tomorrow.setDate(base.getDate() + 1);
  const weekend = new Date(base);
  weekend.setDate(base.getDate() + ((6 - base.getDay() + 7) % 7 || 7));
  const nextWeek = new Date(base);
  nextWeek.setDate(base.getDate() + ((8 - base.getDay()) % 7 || 7));
  return [
    { label: "tomorrow", dateKey: fmt(tomorrow) },
    { label: "weekend", dateKey: fmt(weekend) },
    { label: "next week", dateKey: fmt(nextWeek) },
  ];
}

export type StreamGroup = { id: string; name: string; color: string };

function CardRow({
  card,
  section,
  index,
  animate,
  leaving,
  gaps,
  groups,
  onDone,
  onMiss,
  onSnooze,
  onSchedule,
  onGroup,
  onLogBill,
  onBuyTask,
  onAdjust,
  onOpenLog,
  onRtaskUpdate,
  onRtaskArchive,
  boughtIds,
}: {
  card: StreamCard;
  section: SectionKey;
  index: number;
  animate: boolean;
  leaving: "done" | "missed" | null;
  gaps: FreeGap[];
  groups: StreamGroup[];
  onDone: (card: StreamCard) => void;
  onMiss: (card: StreamCard) => void;
  onSnooze: (card: StreamCard, dateKey: string) => void;
  onSchedule: (card: StreamCard, gap: FreeGap) => void;
  onGroup: (card: StreamCard, group: StreamGroup | null) => void;
  onLogBill: (card: StreamCard) => void;
  onBuyTask: (card: StreamCard) => void;
  onAdjust: (card: StreamCard, delta: number) => void;
  onOpenLog: () => void;
  onRtaskUpdate: (card: StreamCard, patch: Partial<RecurringTaskInput>) => void;
  onRtaskArchive: (card: StreamCard) => void;
  boughtIds: Set<string>;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const today = todayISO(null);

  const isTask = card.entity.kind === "task" || card.entity.kind === "rtask";
  const cardTask = card.entity.kind === "task" ? card.entity.task : null;
  const taskTier = card.entity.kind === "task" ? (card.tier ?? 0) : undefined;
  const isFocus = taskTier === 3;
  const isOverdueTask =
    cardTask !== null &&
    cardTask.due_date !== null &&
    cardTask.due_date < today;

  function onTouchStart(e: React.TouchEvent) {
    if (!isTask || editOpen) return;
    touchStart.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!isTask || editOpen || !touchStart.current) return;
    const deltaX = e.touches[0].clientX - touchStart.current.x;
    const deltaY = e.touches[0].clientY - touchStart.current.y;
    if (Math.abs(deltaY) > Math.abs(deltaX)) return;
    setDx(Math.max(-120, Math.min(120, deltaX)));
  }

  function onTouchEnd() {
    if (!isTask || editOpen) return;
    if (dx > 80) onDone(card);
    else if (dx < -80 && card.entity.kind === "task") setSnoozeOpen(true);
    setDx(0);
    touchStart.current = null;
  }

  // Task/rtask cards carry their GROUP color on the left tick (set inline
  // below); missed cards flash danger; other cards follow their section.
  const cardGroupColor =
    card.entity.kind === "task"
      ? card.entity.task.group_color
      : card.entity.kind === "rtask"
        ? card.entity.group_color
        : null;
  const tickColor =
    leaving === "missed"
      ? "border-danger"
      : isTask
        ? cardGroupColor
          ? ""
          : "border-hairline"
        : section === "now"
          ? "border-accent"
          : "border-hairline";
  const tick = `border-l-2 ${tickColor}`;

  const actions: React.ReactNode[] = [];
  if (card.entity.kind === "task") {
    const taskGroupName = card.entity.task.group_name;
    const taskGroupColor = card.entity.task.group_color;
    actions.push(
      <button
        key="done"
        type="button"
        onClick={() => onDone(card)}
        className="press min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors"
      >
        done
      </button>,
    );
    if (isOverdueTask) {
      actions.push(
        <button
          key="incomplete"
          type="button"
          onClick={() => onMiss(card)}
          className="press min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-danger opacity-70 hover:opacity-100 hover:border-danger transition-[color,opacity,border-color]"
        >
          incomplete
        </button>,
      );
    }
    actions.push(
      <div key="later" className="relative">
        <button
          type="button"
          onClick={() => setSnoozeOpen((v) => !v)}
          aria-expanded={snoozeOpen}
          className="press min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-muted hover:text-fg transition-colors"
        >
          later ▾
        </button>
        {snoozeOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 glass-pop glass-rise rounded-pop overflow-hidden">
            {snoozeOptions(today).map((opt) => (
              <button
                key={opt.dateKey}
                type="button"
                onClick={() => {
                  setSnoozeOpen(false);
                  onSnooze(card, opt.dateKey);
                }}
                className="flex w-full min-h-11 items-center px-4 text-action lowercase text-fg hover:bg-card transition-colors whitespace-nowrap"
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>,
    );
    actions.push(
      <div key="schedule" className="relative">
        <button
          type="button"
          onClick={() => setScheduleOpen((v) => !v)}
          aria-expanded={scheduleOpen}
          className="press min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-muted hover:text-fg transition-colors"
        >
          schedule ▾
        </button>
        {scheduleOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 glass-pop glass-rise rounded-pop overflow-hidden">
            {gaps.map((gap) => (
              <button
                key={`${gap.dateKey}-${gap.start}`}
                type="button"
                onClick={() => {
                  setScheduleOpen(false);
                  onSchedule(card, gap);
                }}
                className="flex w-full min-h-11 items-center gap-2 px-4 text-action lowercase text-fg hover:bg-card transition-colors whitespace-nowrap"
              >
                <span>
                  {gap.dateKey === today ? "today" : "tomorrow"} {gap.start}
                </span>
                <span className="text-meta text-muted">
                  {Math.round((gap.minutes / 60) * 10) / 10}h free
                </span>
              </button>
            ))}
            <Link
              href="/week"
              className="flex w-full min-h-11 items-center px-4 text-action lowercase text-muted hover:text-fg hover:bg-card transition-colors whitespace-nowrap"
            >
              pick on week →
            </Link>
          </div>
        )}
      </div>,
      <div key="group" className="relative min-w-0">
        <button
          type="button"
          onClick={() => setGroupOpen((v) => !v)}
          aria-expanded={groupOpen}
          className="press flex min-h-11 min-w-0 max-w-40 items-center gap-2 px-3 text-action lowercase border rounded-full border-hairline text-muted hover:text-fg transition-colors"
        >
          <span
            className={`h-2.5 w-2.5 flex-shrink-0 ${
              taskGroupName ? "" : "border border-muted border-dashed"
            }`}
            style={{ backgroundColor: taskGroupColor ?? "transparent" }}
            aria-hidden
          />
          <span className="truncate">{taskGroupName ?? "inbox"} ▾</span>
        </button>
        {groupOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 max-h-56 overflow-y-auto glass-pop glass-rise rounded-pop">
            <button
              type="button"
              onClick={() => {
                setGroupOpen(false);
                onGroup(card, null);
              }}
              className="flex w-full min-h-11 items-center gap-2 px-4 text-action lowercase text-fg hover:bg-card transition-colors whitespace-nowrap"
            >
              <span
                className="h-2.5 w-2.5 flex-shrink-0 border border-muted border-dashed"
                aria-hidden
              />
              inbox
            </button>
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => {
                  setGroupOpen(false);
                  onGroup(card, group);
                }}
                className="flex w-full min-h-11 items-center gap-2 px-4 text-action lowercase text-fg hover:bg-card transition-colors whitespace-nowrap"
              >
                <span
                  className="h-2.5 w-2.5 flex-shrink-0"
                  style={{ backgroundColor: group.color }}
                  aria-hidden
                />
                <span className="truncate">{group.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>,
    );
  } else if (card.entity.kind === "rtask") {
    // Recurring occurrences: done only — no snooze/schedule, tomorrow's
    // occurrence regenerates itself.
    actions.push(
      <button
        key="done"
        type="button"
        onClick={() => onDone(card)}
        className="press min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors"
      >
        done
      </button>,
    );
  } else if (card.entity.kind === "bill") {
    actions.push(
      <button
        key="log"
        type="button"
        onClick={() => onLogBill(card)}
        className="press min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors"
      >
        log it
      </button>,
    );
  } else if (card.entity.kind === "item") {
    const bought = boughtIds.has(card.id);
    actions.push(
      <button
        key="buy"
        type="button"
        disabled={bought}
        onClick={() => onBuyTask(card)}
        className="min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors disabled:opacity-60"
      >
        {bought ? "task ✓" : "buy task"}
      </button>,
      <div key="adjust" className="inline-flex items-stretch border rounded-full overflow-hidden border-hairline">
        <button
          type="button"
          onClick={() => onAdjust(card, -1)}
          aria-label={`decrease ${card.entity.name}`}
          className="min-h-11 px-3 text-muted hover:text-fg transition-colors"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => onAdjust(card, 1)}
          aria-label={`increase ${card.entity.name}`}
          className="min-h-11 px-3 text-muted hover:text-fg transition-colors border-l border-hairline"
        >
          ＋
        </button>
      </div>,
    );
  } else if (card.entity.kind === "log") {
    actions.push(
      <button
        key="log-day"
        type="button"
        onClick={onOpenLog}
        className="press min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors"
      >
        log day
      </button>,
    );
  } else if (card.entity.kind === "link") {
    actions.push(
      <Link
        key="open"
        href={card.entity.href}
        className="inline-flex items-center min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors"
      >
        {card.entity.href.startsWith("/plan") ? "plan ◇" : "sort →"}
      </Link>,
    );
  } else if (card.entity.kind === "event") {
    actions.push(
      <Link
        key="week"
        href="/week"
        className="inline-flex items-center min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-muted hover:text-fg transition-colors"
      >
        open week ▦
      </Link>,
    );
  }

  // Focus cards carry their own meta line: effort + lateness, lateness in danger.
  const focusEstimate =
    cardTask?.estimated_minutes != null
      ? formatEstimate(cardTask.estimated_minutes)
      : null;
  let focusLate: React.ReactNode = null;
  if (cardTask?.due_date) {
    if (cardTask.due_date < today) {
      const n = daysLate(cardTask.due_date, today);
      focusLate = (
        <span className="text-danger">{n === 1 ? "1d late" : `${n}d late`}</span>
      );
    } else if (cardTask.due_date === today) {
      focusLate = <span className="text-muted">today</span>;
    }
  }
  const factStruck = leaving === "done";

  const restMax = isFocus || editOpen ? "max-h-[40rem]" : "max-h-40";
  const leaveClass =
    leaving === "missed"
      ? "overflow-hidden max-h-0 opacity-0 translate-y-1 scale-[.98] duration-[400ms]"
      : leaving === "done"
        ? "overflow-hidden max-h-0 opacity-0 -translate-x-1 duration-[280ms]"
        : `${restMax} opacity-100 duration-[120ms]`;

  const innerStyle: React.CSSProperties = {};
  if (dx !== 0) innerStyle.transform = `translateX(${dx}px)`;
  if (animate) innerStyle.animationDelay = `${Math.min(index, 10) * 35}ms`;
  if (leaving !== "missed" && isTask && cardGroupColor) {
    innerStyle.borderLeftColor = cardGroupColor;
  }
  const swipeBg = dx > 40 ? "bg-accent-wash" : dx < -40 ? "bg-card-hover" : "";
  const innerClass = isFocus
    ? `glass-panel rounded-panel ${tick} p-4 ${swipeBg}`
    : `${tick} pl-3 pr-1 py-2 ${swipeBg}`;

  const rtaskRule =
    card.entity.kind === "rtask"
      ? {
          id: card.entity.ruleId,
          title: card.entity.title,
          due_time: card.entity.dueTime,
          duration_min: card.entity.durationMin,
          priority: card.entity.priority,
          frequency: card.entity.frequency,
          weekdays: card.entity.weekdays,
          day_of_month: card.entity.day_of_month,
          interval_days: card.entity.interval_days,
          group_id: card.entity.group_id,
        }
      : null;

  return (
    <div
      // overflow-hidden only while collapsing: at rest it would clip the
      // later/schedule dropdowns, which open past the card's bottom edge.
      className={`transition-all ease-signal ${isFocus ? "my-2" : ""} ${
        animate && isFocus ? "focus-pop" : ""
      } ${leaveClass}`}
    >
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={innerStyle}
        className={`${innerClass} ${animate ? "stream-rise" : ""}`}
      >
        {isFocus ? (
          <>
            <p className="text-base font-medium text-fg flex items-baseline gap-2 min-w-0">
              <span className="text-muted shrink-0" aria-hidden>
                {card.glyph}
              </span>
              <span
                className={
                  factStruck ? "line-through text-muted truncate" : "truncate"
                }
              >
                {card.fact}
              </span>
            </p>
            {(focusEstimate || focusLate) && (
              <p className="text-meta text-muted mt-1 flex items-center gap-1.5">
                {focusEstimate && <span>{focusEstimate}</span>}
                {focusEstimate && focusLate && <span aria-hidden>·</span>}
                {focusLate}
              </p>
            )}
            {actions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2.5 mt-3">
                {actions}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-body text-fg flex items-baseline gap-2 min-w-0">
              <span className="text-muted shrink-0" aria-hidden>
                {card.glyph}
              </span>
              {rtaskRule ? (
                <button
                  type="button"
                  onClick={() => setEditOpen((v) => !v)}
                  aria-expanded={editOpen}
                  className={`min-w-0 text-left truncate ${
                    factStruck ? "line-through text-muted" : ""
                  } ${editOpen ? "text-accent" : ""}`}
                >
                  {card.fact}
                </button>
              ) : (
                <span
                  className={`${factStruck ? "line-through text-muted" : ""} ${
                    taskTier === 2 ? "font-medium" : ""
                  } truncate`}
                >
                  {card.fact}
                </span>
              )}
              {card.meta && (
                <span className="text-meta text-muted shrink-0">{card.meta}</span>
              )}
            </p>
            {rtaskRule && editOpen && (
              <RecurringEditPanel
                rule={rtaskRule}
                groups={groups}
                onUpdate={(patch) => onRtaskUpdate(card, patch)}
                onArchive={() => onRtaskArchive(card)}
              />
            )}
            {actions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                {actions}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function StreamClient({
  snapshot,
  accounts,
  categories,
  gaps,
  groups,
  weekDone,
  weekMissed,
  mindshare,
  todayLabel,
  clockLabel,
}: {
  snapshot: StreamSnapshot;
  accounts: SpendAccount[];
  categories: SpendCategory[];
  gaps: FreeGap[];
  groups: StreamGroup[];
  weekDone: number;
  weekMissed: number;
  mindshare: MindshareBar | null;
  todayLabel: string;
  clockLabel: string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Map<string, "done" | "missed">>(
    new Map(),
  );
  const [bought, setBought] = useState<Set<string>>(new Set());
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [stepError, setStepError] = useState<string | null>(null);
  const [extraNext, setExtraNext] = useState<StreamCard[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [mood, setMood] = useState<number | null>(snapshot.pulse.mood);
  const [spendCard, setSpendCard] = useState<{ card: StreamCard; section: SectionKey } | null>(null);
  // Optimistic meta overrides (schedule + group changes): the card stays in
  // place with its new label instead of vanishing (these edits usually
  // re-bucket into the same section, so hiding would keep the card hidden
  // forever). Cleared when the next server snapshot arrives.
  const [retimed, setRetimed] = useState<Record<string, string>>({});
  // Optimistic group override: the group button re-labels/recolors the
  // moment a new group is picked, before the server snapshot lands.
  const [regrouped, setRegrouped] = useState<
    Record<string, { name: string; color: string } | null>
  >({});
  // Optimistic rtask title: the card's fact re-labels the moment a new title
  // commits, before the revalidated snapshot lands. Other rtask edits (time,
  // duration, frequency, priority, group) settle via that snapshot refresh.
  const [retitled, setRetitled] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  // Entrance stagger runs on the first client mount only — later snapshot
  // refreshes (post-action revalidation) must not re-stagger the whole list.
  // The flag drops once every card's rise/glow has finished, so removing the
  // class is a no-op rather than a killed animation.
  const [animateEntrance, setAnimateEntrance] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setAnimateEntrance(false), 900);
    return () => clearTimeout(id);
  }, []);

  // Latest groups for the capture subscription, which stays mounted with []
  // deps — read through the ref so an optimistic card shows its real group.
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Every card id the current server snapshot already owns, across sections.
  const snapshotIds = useMemo(
    () =>
      new Set(
        [
          ...snapshot.now,
          ...snapshot.next,
          ...snapshot.later,
          ...snapshot.loose,
        ].map((c) => c.id),
      ),
    [snapshot],
  );

  // A fresh server snapshot carries the committed reschedule — drop the
  // overrides so the server meta is the single source again. Render-time
  // state adjustment, per the React "adjusting state when a prop changes"
  // pattern.
  const [prevSnapshot, setPrevSnapshot] = useState(snapshot);
  if (prevSnapshot !== snapshot) {
    setPrevSnapshot(snapshot);
    if (Object.keys(retimed).length > 0) setRetimed({});
    if (Object.keys(regrouped).length > 0) setRegrouped({});
    if (Object.keys(retitled).length > 0) setRetitled({});
    // Drop optimistic captures the server snapshot now owns, so the temporary
    // card doesn't linger beside the real one.
    if (extraNext.some((c) => snapshotIds.has(c.id))) {
      setExtraNext((cards) => cards.filter((c) => !snapshotIds.has(c.id)));
    }
  }

  // Optimistically surface tasks captured from the Dock. The captured Task
  // carries only group_id, so resolve the group's name/color for display.
  useEffect(() => {
    const withGroup = (task: Task) => {
      const group = task.group_id
        ? groupsRef.current.find((g) => g.id === task.group_id)
        : null;
      return {
        ...task,
        group_name: group?.name ?? null,
        group_color: group?.color ?? null,
      };
    };
    return subscribeCapture({
      onOptimisticAdd: (task: Task) => {
        if (task.due_date !== todayISO(null)) return;
        setExtraNext((cards) => [
          {
            id: `task:${task.id}`,
            domain: "task",
            glyph: "○",
            fact: task.title,
            meta: "today",
            entity: { kind: "task", task: withGroup(task) },
          },
          ...cards,
        ]);
      },
      onReplace: (tempId, task) =>
        setExtraNext((cards) =>
          cards.map((c) =>
            c.id === `task:${tempId}`
              ? {
                  ...c,
                  id: `task:${task.id}`,
                  entity: { kind: "task", task: withGroup(task) },
                }
              : c,
          ),
        ),
    });
  }, []);

  // Resolution is scoped to the section a card left from, so the same entity
  // legitimately reappearing in another section (snooze -> LATER) still shows.
  // The "missed" variant sinks slower (400ms exit, 450ms hide) than "done".
  function resolve(
    section: SectionKey,
    cardId: string,
    variant: "done" | "missed" = "done",
  ) {
    const key = `${section}:${cardId}`;
    setLeaving((prev) => new Map(prev).set(key, variant));
    setTimeout(
      () => {
        setHidden((prev) => new Set(prev).add(key));
      },
      variant === "missed" ? 450 : 300,
    );
  }

  function onDone(section: SectionKey) {
    return (card: StreamCard) => {
      if (card.entity.kind === "rtask") {
        const { ruleId, dateKey } = card.entity;
        resolve(section, card.id);
        startTransition(async () => {
          await completeRecurringOccurrence(ruleId, dateKey);
        });
        return;
      }
      if (card.entity.kind !== "task") return;
      const task = card.entity.task;
      resolve(section, card.id);
      startTransition(async () => {
        await toggleTaskStatus(task.id, task.status);
      });
    };
  }

  function onMiss(section: SectionKey) {
    return (card: StreamCard) => {
      if (card.entity.kind !== "task") return;
      const task = card.entity.task;
      resolve(section, card.id, "missed");
      startTransition(async () => {
        await markTaskMissed(task.id);
      });
    };
  }

  function onSnooze(section: SectionKey) {
    return (card: StreamCard, dateKey: string) => {
      if (card.entity.kind !== "task") return;
      const task = card.entity.task;
      resolve(section, card.id);
      startTransition(async () => {
        await updateTask({ id: task.id, dueDate: dateKey, dueTime: null });
      });
    };
  }

  function onSchedule() {
    return (card: StreamCard, gap: FreeGap) => {
      if (card.entity.kind !== "task") return;
      const task = card.entity.task;
      const day = gap.dateKey === todayISO(null) ? "today" : "tomorrow";
      setRetimed((prev) => ({
        ...prev,
        [card.id]: `${day} ${gap.start}`,
      }));
      startTransition(async () => {
        await updateTask({
          id: task.id,
          dueDate: gap.dateKey,
          dueTime: gap.start,
        });
      });
    };
  }

  function onGroup(card: StreamCard, group: StreamGroup | null) {
    if (card.entity.kind !== "task") return;
    const task = card.entity.task;
    // Optimistic meta: strip any part that is a group name, then append the
    // new group's name — the card stays in place and re-labels immediately.
    const groupNames = new Set(groups.map((g) => g.name));
    const parts = (card.meta ?? "")
      .split(" · ")
      .filter((part) => part && !groupNames.has(part));
    if (group) parts.push(group.name);
    setRetimed((prev) => ({ ...prev, [card.id]: parts.join(" · ") }));
    setRegrouped((prev) => ({
      ...prev,
      [card.id]: group ? { name: group.name, color: group.color } : null,
    }));
    startTransition(async () => {
      await updateTask({ id: task.id, groupId: group?.id ?? null });
    });
  }

  function onRtaskUpdate(card: StreamCard, patch: Partial<RecurringTaskInput>) {
    if (card.entity.kind !== "rtask") return;
    const { ruleId } = card.entity;
    if (patch.title) {
      const title = patch.title;
      setRetitled((prev) => ({ ...prev, [card.id]: title }));
    }
    startTransition(async () => {
      await updateRecurringTask({ id: ruleId, ...patch });
    });
  }

  function onRtaskArchive(section: SectionKey) {
    return (card: StreamCard) => {
      if (card.entity.kind !== "rtask") return;
      const { ruleId } = card.entity;
      setHidden((prev) => new Set(prev).add(`${section}:${card.id}`));
      startTransition(async () => {
        await archiveRecurringTask(ruleId);
      });
    };
  }

  function onBuyTask(card: StreamCard) {
    if (card.entity.kind !== "item") return;
    const name = card.entity.name;
    setBought((prev) => new Set(prev).add(card.id));
    startTransition(async () => {
      await createTask({
        title: `buy ${name}`,
        groupId: null,
        dueDate: todayISO(null),
        notes: null,
        priority: "med",
      });
    });
  }

  function onAdjust(card: StreamCard, delta: number) {
    if (card.entity.kind !== "item") return;
    const itemId = card.entity.id;
    const itemName = card.entity.name;
    const current = qtys[card.id] ?? card.entity.quantity;
    const next = Math.max(0, current + delta);
    if (next === current) return;
    setQtys((prev) => ({ ...prev, [card.id]: next }));
    startTransition(async () => {
      const result = await updateInventoryItem({ id: itemId, quantity: next });
      // Drop the optimistic override once the write settles so the next tap
      // (and any reconciliation) reads the authoritative server quantity from
      // revalidation — a stale override must never seed the next adjustment,
      // mask an external change, or survive a failed write. Only clear if this
      // adjustment is still the latest (not superseded by a newer tap).
      setQtys((prev) => {
        if (prev[card.id] !== next) return prev;
        const rest = { ...prev };
        delete rest[card.id];
        return rest;
      });
      if (result?.error) {
        setStepError(`couldn't update ${itemName}`);
      }
    });
  }

  const visible = (section: SectionKey, cards: StreamCard[]) =>
    cards
      .filter((c) => !hidden.has(`${section}:${c.id}`))
      .map((c) => {
        let card = retimed[c.id] ? { ...c, meta: retimed[c.id] } : c;
        if (retitled[c.id]) card = { ...card, fact: retitled[c.id] };
        const override = regrouped[c.id];
        if (override !== undefined && card.entity.kind === "task") {
          card = {
            ...card,
            entity: {
              ...card.entity,
              task: {
                ...card.entity.task,
                group_name: override?.name ?? null,
                group_color: override?.color ?? null,
              },
            },
          };
        }
        return card;
      });

  // Hide any optimistic card the snapshot already includes — covers the race
  // where the real task lands in the snapshot before emitTaskReplace swaps ids.
  const liveExtra = extraNext.filter((c) => !snapshotIds.has(c.id));
  const nowCards = visible("now", snapshot.now);
  const nextCards = visible("next", [...liveExtra, ...snapshot.next]);
  const laterCards = visible("later", snapshot.later);
  const looseCards = visible("loose", snapshot.loose);
  const empty =
    nowCards.length === 0 && nextCards.length === 0 && laterCards.length === 0;

  const moodDots = useMemo(() => {
    const filled = mood ?? 0;
    return Array.from({ length: 5 }, (_, i) => (i < filled ? "●" : "○")).join("");
  }, [mood]);

  const delta = snapshot.pulse.todayDelta;

  function renderSection(
    key: SectionKey,
    label: string,
    cards: StreamCard[],
    overflow: number,
    overflowHref: string,
  ) {
    if (cards.length === 0 && overflow === 0) return null;
    return (
      <section className="mb-8">
        <SectionRuler label={label} count={cards.length} />
        <div className="mt-2 divide-y divide-hairline">
          {cards.map((card, index) => (
            <CardRow
              key={card.id}
              card={card}
              section={key}
              index={index}
              animate={animateEntrance}
              leaving={leaving.get(`${key}:${card.id}`) ?? null}
              gaps={gaps}
              groups={groups}
              onDone={onDone(key)}
              onMiss={onMiss(key)}
              onSnooze={onSnooze(key)}
              onSchedule={onSchedule()}
              onGroup={onGroup}
              onLogBill={(card) => setSpendCard({ card, section: key })}
              onBuyTask={onBuyTask}
              onAdjust={onAdjust}
              onOpenLog={() => setLogOpen(true)}
              onRtaskUpdate={onRtaskUpdate}
              onRtaskArchive={onRtaskArchive(key)}
              boughtIds={bought}
            />
          ))}
        </div>
        {overflow > 0 && (
          <Link
            href={overflowHref}
            className="inline-flex items-center min-h-11 text-meta text-muted hover:text-fg transition-colors"
          >
            {overflow} more →
          </Link>
        )}
      </section>
    );
  }

  return (
    <div>
      <div className="mb-8">
      <div className="flex items-baseline justify-between flex-wrap gap-x-4 gap-y-1 pr-10 lg:pr-0">
        <p className="text-body text-fg">
          {todayLabel} <span className="text-muted">· {clockLabel}</span>
        </p>
        <p
          className="flex items-baseline gap-3 text-meta text-muted"
          data-tour="vitals"
        >
          {delta !== 0 && (
            <Link
              href="/finance"
              className={`text-body ${delta > 0 ? "text-positive" : "text-danger"} hover:opacity-80 transition-opacity`}
            >
              {delta > 0 ? "▲" : "▼"}{" "}
              {formatMoney(Math.abs(delta), snapshot.pulse.currency)}
            </Link>
          )}
          <span>{snapshot.pulse.toClear} to clear</span>
          <Link href="/week" className="hover:text-fg transition-colors">
            {snapshot.pulse.freeHours}h free
          </Link>
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            aria-label="daily check-in"
            className="hover:text-fg transition-colors tracking-[0.2em]"
          >
            {moodDots}
          </button>
        </p>
      </div>
      {weekDone + weekMissed > 0 && (
        <Link
          href="/tasks/history"
          className="mt-1 inline-block text-meta text-muted hover:text-fg transition-colors"
        >
          this week · {weekDone} done · {weekMissed} missed
        </Link>
      )}
      {mindshare && (
        <div className="mt-2">
          <MindspaceBar bar={mindshare} animate={animateEntrance} />
        </div>
      )}
      </div>

      {stepError && (
        <button
          type="button"
          onClick={() => setStepError(null)}
          className="block w-full text-left text-meta text-danger mb-4"
        >
          {stepError} · tap to dismiss
        </button>
      )}

      {empty ? (
        <div
          className="glass-panel px-4 py-10 text-center mb-8"
          data-tour="stream"
        >
          <p className="text-label uppercase text-muted mb-3">— clear —</p>
          <p className="text-body text-fg mb-6">
            nothing needs you right now.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Link
              href="/plan"
              className="inline-flex items-center min-h-11 px-4 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors"
            >
              plan tomorrow ◇
            </Link>
            <Link
              href="/week"
              className="inline-flex items-center min-h-11 px-4 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors"
            >
              open week ▦
            </Link>
          </div>
          {snapshot.nextUp && (
            <p className="text-meta text-muted mt-6">
              ▸ next up: {snapshot.nextUp}
            </p>
          )}
        </div>
      ) : (
        <div data-tour="stream">
          {renderSection("now", "now", nowCards, snapshot.nowOverflow, "/tasks")}
          {renderSection("next", "next", nextCards, snapshot.nextOverflow, "/tasks")}
          {renderSection("later", "later", laterCards, snapshot.laterOverflow, "/week")}
        </div>
      )}

      {renderSection("loose", "loose ends", looseCards, 0, "/tasks")}

      {renderSection(
        "routines",
        "routines",
        visible("routines", snapshot.routines),
        snapshot.routinesOverflow,
        "/week",
      )}

      {logOpen && (
        <DailyLogSheet
          onClose={() => setLogOpen(false)}
          onSaved={(m) => {
            setMood(m);
            setHidden((prev) => new Set(prev).add("later:log:today"));
          }}
        />
      )}
      {spendCard && spendCard.card.entity.kind === "bill" && (
        <SpendSheet
          billName={spendCard.card.entity.name}
          amount={spendCard.card.entity.amount}
          accounts={accounts}
          categories={categories}
          onClose={() => setSpendCard(null)}
          onLogged={() => resolve(spendCard.section, spendCard.card.id)}
        />
      )}
    </div>
  );
}
