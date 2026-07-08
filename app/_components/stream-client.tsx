"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  createTask,
  toggleTaskStatus,
  updateTask,
} from "@/app/actions/tasks";
import { updateInventoryItem } from "@/app/actions/inventory";
import { completeRecurringOccurrence } from "@/app/actions/recurring-tasks";
import type { FreeGap } from "@/app/lib/snapshots/schedule";
import type {
  StreamCard,
  StreamSnapshot,
} from "@/app/lib/snapshots/stream";
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
import type { Task } from "./types";

type SectionKey = "now" | "next" | "later" | "loose";

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
  leaving,
  gaps,
  groups,
  onDone,
  onSnooze,
  onSchedule,
  onGroup,
  onLogBill,
  onBuyTask,
  onAdjust,
  onOpenLog,
  boughtIds,
}: {
  card: StreamCard;
  section: SectionKey;
  leaving: boolean;
  gaps: FreeGap[];
  groups: StreamGroup[];
  onDone: (card: StreamCard) => void;
  onSnooze: (card: StreamCard, dateKey: string) => void;
  onSchedule: (card: StreamCard, gap: FreeGap) => void;
  onGroup: (card: StreamCard, group: StreamGroup | null) => void;
  onLogBill: (card: StreamCard) => void;
  onBuyTask: (card: StreamCard) => void;
  onAdjust: (card: StreamCard, delta: number) => void;
  onOpenLog: () => void;
  boughtIds: Set<string>;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const today = todayISO();

  const isTask = card.entity.kind === "task" || card.entity.kind === "rtask";

  function onTouchStart(e: React.TouchEvent) {
    if (!isTask) return;
    touchStart.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }

  function onTouchMove(e: React.TouchEvent) {
    if (!isTask || !touchStart.current) return;
    const deltaX = e.touches[0].clientX - touchStart.current.x;
    const deltaY = e.touches[0].clientY - touchStart.current.y;
    if (Math.abs(deltaY) > Math.abs(deltaX)) return;
    setDx(Math.max(-120, Math.min(120, deltaX)));
  }

  function onTouchEnd() {
    if (!isTask) return;
    if (dx > 80) onDone(card);
    else if (dx < -80 && card.entity.kind === "task") setSnoozeOpen(true);
    setDx(0);
    touchStart.current = null;
  }

  const tick =
    section === "now" ? "border-l-2 border-accent" : "border-l-2 border-hairline";

  const actions: React.ReactNode[] = [];
  if (card.entity.kind === "task") {
    const taskGroupName = card.entity.task.group_name;
    const taskGroupColor = card.entity.task.group_color;
    actions.push(
      <button
        key="done"
        type="button"
        onClick={() => onDone(card)}
        className="min-h-11 px-3 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors"
      >
        done
      </button>,
      <div key="later" className="relative">
        <button
          type="button"
          onClick={() => setSnoozeOpen((v) => !v)}
          aria-expanded={snoozeOpen}
          className="min-h-11 px-3 text-action lowercase border border-hairline text-muted hover:text-fg transition-colors"
        >
          later ▾
        </button>
        {snoozeOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 border border-line bg-popover shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
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
          className="min-h-11 px-3 text-action lowercase border border-hairline text-muted hover:text-fg transition-colors"
        >
          schedule ▾
        </button>
        {scheduleOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 border border-line bg-popover shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
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
      <div key="group" className="relative">
        <button
          type="button"
          onClick={() => setGroupOpen((v) => !v)}
          aria-expanded={groupOpen}
          className="flex min-h-11 max-w-40 items-center gap-2 px-3 text-action lowercase border border-hairline text-muted hover:text-fg transition-colors"
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
          <div className="absolute left-0 top-full mt-1 z-30 max-h-56 overflow-y-auto border border-line bg-popover shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
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
        className="min-h-11 px-3 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors"
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
        className="min-h-11 px-3 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors"
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
        className="min-h-11 px-3 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors disabled:opacity-60"
      >
        {bought ? "task ✓" : "buy task"}
      </button>,
      <div key="adjust" className="inline-flex items-stretch border border-hairline">
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
        className="min-h-11 px-3 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors"
      >
        log day
      </button>,
    );
  } else if (card.entity.kind === "link") {
    actions.push(
      <Link
        key="open"
        href={card.entity.href}
        className="inline-flex items-center min-h-11 px-3 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors"
      >
        {card.entity.href.startsWith("/plan") ? "plan ◇" : "sort →"}
      </Link>,
    );
  } else if (card.entity.kind === "event") {
    actions.push(
      <Link
        key="week"
        href="/week"
        className="inline-flex items-center min-h-11 px-3 text-action lowercase border border-hairline text-muted hover:text-fg transition-colors"
      >
        open week ▦
      </Link>,
    );
  }

  return (
    <div
      // overflow-hidden only while collapsing: at rest it would clip the
      // later/schedule dropdowns, which open past the card's bottom edge.
      className={`transition-all ease-signal ${
        leaving
          ? "overflow-hidden max-h-0 opacity-0 -translate-x-1 duration-[280ms]"
          : "max-h-40 opacity-100 duration-[120ms]"
      }`}
    >
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={dx !== 0 ? { transform: `translateX(${dx}px)` } : undefined}
        className={`${tick} pl-3 pr-1 py-2 ${
          dx > 40 ? "bg-accent-wash" : dx < -40 ? "bg-card-hover" : ""
        }`}
      >
        <p className="text-body text-fg flex items-baseline gap-2 min-w-0">
          <span className="text-muted shrink-0" aria-hidden>
            {card.glyph}
          </span>
          <span className={leaving ? "line-through text-muted truncate" : "truncate"}>
            {card.fact}
          </span>
          {card.meta && (
            <span className="text-meta text-muted shrink-0">{card.meta}</span>
          )}
        </p>
        {actions.length > 0 && (
          <div className="flex items-center gap-2 mt-1.5">{actions}</div>
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
  todayLabel,
  clockLabel,
}: {
  snapshot: StreamSnapshot;
  accounts: SpendAccount[];
  categories: SpendCategory[];
  gaps: FreeGap[];
  groups: StreamGroup[];
  todayLabel: string;
  clockLabel: string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [bought, setBought] = useState<Set<string>>(new Set());
  const [qtys, setQtys] = useState<Record<string, number>>({});
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
  const [, startTransition] = useTransition();

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
        if (task.due_date !== todayISO()) return;
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
  function resolve(section: SectionKey, cardId: string) {
    const key = `${section}:${cardId}`;
    setLeaving((prev) => new Set(prev).add(key));
    setTimeout(() => {
      setHidden((prev) => new Set(prev).add(key));
    }, 300);
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
      const day = gap.dateKey === todayISO() ? "today" : "tomorrow";
      setRetimed((prev) => ({
        ...prev,
        [card.id]: `${day} ⌚ ${gap.start}`,
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

  function onBuyTask(card: StreamCard) {
    if (card.entity.kind !== "item") return;
    const name = card.entity.name;
    setBought((prev) => new Set(prev).add(card.id));
    startTransition(async () => {
      await createTask({
        title: `buy ${name}`,
        groupId: null,
        dueDate: todayISO(),
        notes: null,
        priority: "med",
      });
    });
  }

  function onAdjust(card: StreamCard, delta: number) {
    if (card.entity.kind !== "item") return;
    const itemId = card.entity.id;
    const current = qtys[card.id] ?? card.entity.quantity;
    const next = Math.max(0, current + delta);
    if (next === current) return;
    setQtys((prev) => ({ ...prev, [card.id]: next }));
    startTransition(async () => {
      await updateInventoryItem({ id: itemId, quantity: next });
    });
  }

  const visible = (section: SectionKey, cards: StreamCard[]) =>
    cards
      .filter((c) => !hidden.has(`${section}:${c.id}`))
      .map((c) => {
        let card = retimed[c.id] ? { ...c, meta: retimed[c.id] } : c;
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
          {cards.map((card) => (
            <CardRow
              key={card.id}
              card={card}
              section={key}
              leaving={leaving.has(`${key}:${card.id}`)}
              gaps={gaps}
              groups={groups}
              onDone={onDone(key)}
              onSnooze={onSnooze(key)}
              onSchedule={onSchedule()}
              onGroup={onGroup}
              onLogBill={(card) => setSpendCard({ card, section: key })}
              onBuyTask={onBuyTask}
              onAdjust={onAdjust}
              onOpenLog={() => setLogOpen(true)}
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
      <div className="flex items-baseline justify-between flex-wrap gap-x-4 gap-y-1 mb-8 pr-10 lg:pr-0">
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

      {empty ? (
        <div
          className="border border-hairline px-4 py-10 text-center mb-8"
          data-tour="stream"
        >
          <p className="text-label uppercase text-muted mb-3">— clear —</p>
          <p className="text-body text-fg mb-6">
            nothing needs you right now.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Link
              href="/plan"
              className="inline-flex items-center min-h-11 px-4 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors"
            >
              plan tomorrow ◇
            </Link>
            <Link
              href="/week"
              className="inline-flex items-center min-h-11 px-4 text-action lowercase border border-hairline text-fg hover:border-accent transition-colors"
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
          {renderSection("now", "now", nowCards, 0, "/tasks")}
          {renderSection("next", "next", nextCards, snapshot.nextOverflow, "/tasks")}
          {renderSection("later", "later", laterCards, snapshot.laterOverflow, "/week")}
        </div>
      )}

      {renderSection("loose", "loose ends", looseCards, 0, "/tasks")}

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
