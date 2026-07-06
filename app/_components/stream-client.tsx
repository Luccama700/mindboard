"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createTask, toggleTaskStatus, updateTask } from "@/app/actions/tasks";
import { updateInventoryItem } from "@/app/actions/inventory";
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

function CardRow({
  card,
  section,
  leaving,
  onDone,
  onSnooze,
  onLogBill,
  onBuyTask,
  onAdjust,
  onOpenLog,
  boughtIds,
}: {
  card: StreamCard;
  section: SectionKey;
  leaving: boolean;
  onDone: (card: StreamCard) => void;
  onSnooze: (card: StreamCard, dateKey: string) => void;
  onLogBill: (card: StreamCard) => void;
  onBuyTask: (card: StreamCard) => void;
  onAdjust: (card: StreamCard, delta: number) => void;
  onOpenLog: () => void;
  boughtIds: Set<string>;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const today = todayISO();

  const isTask = card.entity.kind === "task";

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
    else if (dx < -80) setSnoozeOpen(true);
    setDx(0);
    touchStart.current = null;
  }

  const tick =
    section === "now" ? "border-l-2 border-accent" : "border-l-2 border-hairline";

  const actions: React.ReactNode[] = [];
  if (card.entity.kind === "task") {
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
      className={`overflow-hidden transition-all ease-signal ${
        leaving
          ? "max-h-0 opacity-0 -translate-x-1 duration-[280ms]"
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
  todayLabel,
  clockLabel,
}: {
  snapshot: StreamSnapshot;
  accounts: SpendAccount[];
  categories: SpendCategory[];
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
  const [spendCard, setSpendCard] = useState<StreamCard | null>(null);
  const [, startTransition] = useTransition();

  // Optimistically surface tasks captured from the Dock.
  useEffect(
    () =>
      subscribeCapture({
        onOptimisticAdd: (task: Task) => {
          const today = todayISO();
          if (task.due_date !== today) return;
          setExtraNext((cards) => [
            {
              id: `task:${task.id}`,
              domain: "task",
              glyph: "○",
              fact: task.title,
              meta: "today",
              entity: {
                kind: "task",
                task: { ...task, group_name: null, group_color: null },
              },
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
                    entity: {
                      kind: "task",
                      task: { ...task, group_name: null, group_color: null },
                    },
                  }
                : c,
            ),
          ),
      }),
    [],
  );

  function resolve(cardId: string) {
    setLeaving((prev) => new Set(prev).add(cardId));
    setTimeout(() => {
      setHidden((prev) => new Set(prev).add(cardId));
    }, 300);
  }

  function onDone(card: StreamCard) {
    if (card.entity.kind !== "task") return;
    const task = card.entity.task;
    resolve(card.id);
    startTransition(async () => {
      await toggleTaskStatus(task.id, task.status);
    });
  }

  function onSnooze(card: StreamCard, dateKey: string) {
    if (card.entity.kind !== "task") return;
    const task = card.entity.task;
    resolve(card.id);
    startTransition(async () => {
      await updateTask({ id: task.id, dueDate: dateKey });
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

  const visible = (cards: StreamCard[]) =>
    cards.filter((c) => !hidden.has(c.id));

  const nowCards = visible(snapshot.now);
  const nextCards = visible([...extraNext, ...snapshot.next]);
  const laterCards = visible(snapshot.later);
  const looseCards = visible(snapshot.loose);
  const empty =
    nowCards.length === 0 && nextCards.length === 0 && laterCards.length === 0;

  const moodDots = useMemo(() => {
    const filled = mood ?? 0;
    return Array.from({ length: 5 }, (_, i) => (i < filled ? "●" : "○")).join("");
  }, [mood]);

  const delta = snapshot.pulse.todayDelta;

  const sectionProps = {
    onDone,
    onSnooze,
    onLogBill: (card: StreamCard) => setSpendCard(card),
    onBuyTask,
    onAdjust,
    onOpenLog: () => setLogOpen(true),
    boughtIds: bought,
  };

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
              leaving={leaving.has(card.id)}
              {...sectionProps}
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
      <div className="flex items-baseline justify-between flex-wrap gap-x-4 gap-y-1 mb-8">
        <p className="text-body text-fg">
          {todayLabel} <span className="text-muted">· {clockLabel}</span>
        </p>
        <p className="flex items-baseline gap-3 text-meta text-muted">
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
        <div className="border border-hairline px-4 py-10 text-center mb-8">
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
        <>
          {renderSection("now", "now", nowCards, 0, "/tasks")}
          {renderSection("next", "next", nextCards, snapshot.nextOverflow, "/tasks")}
          {renderSection("later", "later", laterCards, snapshot.laterOverflow, "/week")}
        </>
      )}

      {renderSection("loose", "loose ends", looseCards, 0, "/tasks")}

      {logOpen && (
        <DailyLogSheet
          onClose={() => setLogOpen(false)}
          onSaved={(m) => {
            setMood(m);
            setHidden((prev) => new Set(prev).add("log:today"));
          }}
        />
      )}
      {spendCard && spendCard.entity.kind === "bill" && (
        <SpendSheet
          billName={spendCard.entity.name}
          amount={spendCard.entity.amount}
          accounts={accounts}
          categories={categories}
          onClose={() => setSpendCard(null)}
          onLogged={() => resolve(spendCard.id)}
        />
      )}
    </div>
  );
}
