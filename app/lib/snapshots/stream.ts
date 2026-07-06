// The Stream: one deterministic, ranked queue synthesized across every domain.
// Section membership is objective time-facts only (see docs/REDESIGN.md §6 —
// that table is this module's test spec). Priority orders within sections and
// never promotes across them. Pure: `today`/`now` are injected.

import {
  ruleLandsOn,
  type RecurringRule,
} from "@/app/_components/finance-projection";
import {
  effectiveDailyRate,
  runOutDateKey,
  type UsageRule,
} from "@/app/_components/inventory-projection";
import { formatMoney } from "@/app/_components/money";
import type { TaskWithGroup } from "@/app/_components/types";

export type StreamEventInput = {
  id: string;
  summary: string;
  start: string; // ISO datetime for timed events
  end: string;
  allDay: boolean;
};

export type StreamBillInput = RecurringRule & { id: string; name: string };

export type StreamItemInput = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  reorder_threshold: number | null;
};

export type StreamGoalInput = {
  id: string;
  title: string;
  status: string;
  created_at: string;
};

export type StreamSection = "now" | "next" | "later" | "loose";
export type StreamDomain =
  | "task"
  | "event"
  | "money"
  | "stock"
  | "goal"
  | "log"
  | "entropy";

export type StreamEntity =
  | { kind: "task"; task: TaskWithGroup }
  | { kind: "event"; id: string; summary: string; start: string; end: string }
  | { kind: "bill"; id: string; name: string; amount: number; dateKey: string }
  | {
      kind: "item";
      id: string;
      name: string;
      quantity: number;
      unit: string;
    }
  | { kind: "log" }
  | { kind: "link"; href: string };

export type StreamCard = {
  id: string;
  domain: StreamDomain;
  glyph: string;
  fact: string;
  meta: string | null;
  entity: StreamEntity;
};

export type StreamSnapshot = {
  pulse: {
    todayDelta: number;
    currency: string;
    toClear: number;
    freeHours: number;
    mood: number | null;
  };
  now: StreamCard[];
  next: StreamCard[];
  nextOverflow: number;
  later: StreamCard[];
  laterOverflow: number;
  loose: StreamCard[];
  nextUp: string | null;
};

export type StreamInput = {
  today: string; // YYYY-MM-DD, server-local like the rest of the app
  now: Date;
  tasks: TaskWithGroup[]; // every non-done task, with or without a due date
  events: StreamEventInput[];
  bills: StreamBillInput[];
  items: StreamItemInput[];
  usagesByItem: Record<string, UsageRule[]>;
  goals: StreamGoalInput[];
  hasDailyLogToday: boolean;
  moodToday: number | null;
  pendingProposals: number;
  wakeEndHour: number;
  freeHoursToday: number;
  todayDelta: number;
  currency: string;
};

const SECTION_CAP = 5;
const STALE_DAYS = 14;
const SOON_WINDOW_DAYS = 7;
const NOW_EVENT_LEAD_MS = 60 * 60 * 1000;

const PRIORITY_RANK: Record<TaskWithGroup["priority"], number> = {
  high: 0,
  med: 1,
  low: 2,
};

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysKey(key: string, days: number): string {
  const date = parseKey(key);
  date.setDate(date.getDate() + days);
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function daysLate(dueKey: string, today: string): number {
  return Math.round(
    (parseKey(today).getTime() - parseKey(dueKey).getTime()) / 86_400_000,
  );
}

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function relative(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 6) / 10;
  return `in ${hours}h`;
}

function shortDate(key: string): string {
  const d = parseKey(key);
  const months = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function dateKeyOf(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function taskMeta(task: TaskWithGroup, today: string): string {
  const parts: string[] = [];
  if (task.due_date) {
    const late = daysLate(task.due_date, today);
    if (late > 0) parts.push(late === 1 ? "1d late" : `${late}d late`);
    else if (late === 0) parts.push("today");
    else parts.push(shortDate(task.due_date));
  }
  if (task.priority === "high") parts.push("!!!");
  if (task.group_name) parts.push(task.group_name);
  return parts.join(" · ");
}

function taskCard(task: TaskWithGroup, today: string): StreamCard {
  return {
    id: `task:${task.id}`,
    domain: "task",
    glyph: "○",
    fact: task.title,
    meta: taskMeta(task, today) || null,
    entity: { kind: "task", task },
  };
}

function eventCard(
  e: StreamEventInput,
  now: Date,
  opts?: { tomorrow?: boolean },
): StreamCard {
  const started = new Date(e.start).getTime() <= now.getTime();
  const meta = opts?.tomorrow
    ? `tomorrow · ${clock(e.start)}`
    : started
      ? `${clock(e.start)} · now`
      : `${clock(e.start)} · ${relative(e.start, now)}`;
  return {
    id: `event:${e.id}`,
    domain: "event",
    glyph: "▸",
    fact: e.summary || "(untitled event)",
    meta,
    entity: { kind: "event", id: e.id, summary: e.summary, start: e.start, end: e.end },
  };
}

function billCard(
  bill: StreamBillInput,
  dateKey: string,
  today: string,
  currency: string,
): StreamCard {
  const when = dateKey === today ? "lands today" : shortDate(dateKey);
  return {
    id: `bill:${bill.id}:${dateKey}`,
    domain: "money",
    glyph: "◆",
    fact: `${bill.name} ${formatMoney(bill.amount, currency)}`,
    meta: when,
    entity: {
      kind: "bill",
      id: bill.id,
      name: bill.name,
      amount: bill.amount,
      dateKey,
    },
  };
}

function itemCard(
  item: StreamItemInput,
  fact: string,
  meta: string | null,
): StreamCard {
  return {
    id: `item:${item.id}`,
    domain: "stock",
    glyph: "◇",
    fact,
    meta,
    entity: {
      kind: "item",
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
    },
  };
}

function byPriorityThenLateness(today: string) {
  return (a: TaskWithGroup, b: TaskWithGroup) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    const lateA = a.due_date ? daysLate(a.due_date, today) : 0;
    const lateB = b.due_date ? daysLate(b.due_date, today) : 0;
    if (lateA !== lateB) return lateB - lateA;
    return a.created_at.localeCompare(b.created_at);
  };
}

export function streamSnapshot(input: StreamInput): StreamSnapshot {
  const {
    today,
    now,
    tasks,
    events,
    bills,
    items,
    usagesByItem,
    goals,
    hasDailyLogToday,
    moodToday,
    pendingProposals,
    wakeEndHour,
    freeHoursToday,
    todayDelta,
    currency,
  } = input;

  const nowMs = now.getTime();
  const tomorrow = addDaysKey(today, 1);
  const soonLimit = addDaysKey(today, SOON_WINDOW_DAYS);

  const openTasks = tasks.filter((t) => t.status !== "done");
  const timedEvents = events.filter((e) => !e.allDay && e.start && e.end);

  // Per-item run-out keys, computed once.
  const runOuts = new Map<string, string | null>();
  for (const item of items) {
    const rules = usagesByItem[item.id] ?? [];
    const rate = effectiveDailyRate(rules);
    if (item.quantity <= 0) {
      runOuts.set(item.id, today);
    } else if (rate > 0) {
      runOuts.set(item.id, runOutDateKey(today, item.quantity, rate));
    } else {
      runOuts.set(item.id, null);
    }
  }

  // ---- NOW: objective, uncapped -------------------------------------------
  const nowEvents = timedEvents
    .filter((e) => {
      const start = new Date(e.start).getTime();
      const end = new Date(e.end).getTime();
      return end > nowMs && start <= nowMs + NOW_EVENT_LEAD_MS;
    })
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => eventCard(e, now));

  const overdueTasks = openTasks
    .filter((t) => t.due_date && t.due_date < today)
    .sort(byPriorityThenLateness(today))
    .map((t) => taskCard(t, today));

  const todayDate = parseKey(today);
  const billsToday = bills
    .filter((b) => ruleLandsOn(b, todayDate))
    .map((b) => billCard(b, today, today, currency));

  const runOutNow = items
    .filter((item) => {
      const key = runOuts.get(item.id);
      return key !== null && key !== undefined && key <= today;
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) =>
      itemCard(
        item,
        item.quantity <= 0
          ? `${item.name} is out`
          : `${item.name} runs out today`,
        null,
      ),
    );

  const nowCards = [...nowEvents, ...overdueTasks, ...billsToday, ...runOutNow];

  // ---- NEXT: cap 5 ---------------------------------------------------------
  const laterTodayEvents = timedEvents
    .filter((e) => {
      const start = new Date(e.start).getTime();
      return dateKeyOf(e.start) === today && start > nowMs + NOW_EVENT_LEAD_MS;
    })
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => eventCard(e, now));

  const tomorrowFirst = timedEvents
    .filter((e) => dateKeyOf(e.start) === tomorrow)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 1)
    .map((e) => eventCard(e, now, { tomorrow: true }));

  const dueTodayTasks = openTasks
    .filter((t) => t.due_date === today)
    .sort(byPriorityThenLateness(today))
    .map((t) => taskCard(t, today));

  const lowItems = items
    .filter((item) => {
      const runOut = runOuts.get(item.id);
      const alreadyNow = runOut !== null && runOut !== undefined && runOut <= today;
      return (
        !alreadyNow &&
        item.reorder_threshold !== null &&
        item.quantity <= item.reorder_threshold
      );
    })
    .sort((a, b) => {
      const ra = runOuts.get(a.id) ?? "9999-99-99";
      const rb = runOuts.get(b.id) ?? "9999-99-99";
      return ra.localeCompare(rb);
    })
    .map((item) => {
      const runOut = runOuts.get(item.id);
      return itemCard(
        item,
        `${item.name} is low`,
        runOut ? `out ${shortDate(runOut)}` : `${item.quantity} ${item.unit} left`,
      );
    });

  const nextAll = [
    ...laterTodayEvents,
    ...tomorrowFirst,
    ...dueTodayTasks,
    ...lowItems,
  ];
  const nextCards = nextAll.slice(0, SECTION_CAP);
  const nextOverflow = Math.max(0, nextAll.length - SECTION_CAP);

  // ---- LATER: cap 5, by date ----------------------------------------------
  const laterTasks = openTasks
    .filter((t) => t.due_date && t.due_date > today && t.due_date <= soonLimit)
    .map((t) => ({ dateKey: t.due_date!, order: 0, card: taskCard(t, today) }));

  let nextBill: { dateKey: string; card: StreamCard } | null = null;
  outer: for (let offset = 1; offset <= SOON_WINDOW_DAYS; offset++) {
    const key = addDaysKey(today, offset);
    const date = parseKey(key);
    for (const bill of bills) {
      if (ruleLandsOn(bill, date)) {
        nextBill = { dateKey: key, card: billCard(bill, key, today, currency) };
        break outer;
      }
    }
  }

  const laterRunOuts = items
    .filter((item) => {
      const key = runOuts.get(item.id);
      return key && key > today && key <= soonLimit;
    })
    .map((item) => {
      const key = runOuts.get(item.id)!;
      return {
        dateKey: key,
        order: 2,
        card: itemCard(item, `${item.name} runs out ${shortDate(key)}`, null),
      };
    });

  const logInvite =
    !hasDailyLogToday && now.getHours() >= wakeEndHour - 2
      ? [
          {
            dateKey: today,
            order: 9,
            card: {
              id: "log:today",
              domain: "log" as const,
              glyph: "●",
              fact: "log today: mood · energy · sleep",
              meta: null,
              entity: { kind: "log" as const },
            },
          },
        ]
      : [];

  const laterAll = [
    ...laterTasks,
    ...(nextBill ? [{ dateKey: nextBill.dateKey, order: 1, card: nextBill.card }] : []),
    ...laterRunOuts,
    ...logInvite,
  ].sort((a, b) => {
    const d = a.dateKey.localeCompare(b.dateKey);
    if (d !== 0) return d;
    return a.order - b.order;
  });
  const laterCards = laterAll.map((x) => x.card).slice(0, SECTION_CAP);
  const laterOverflow = Math.max(0, laterAll.length - SECTION_CAP);

  // ---- LOOSE ENDS: fixed order, absent when tidy ---------------------------
  const loose: StreamCard[] = [];
  const inboxCount = openTasks.filter((t) => t.group_id === null).length;
  if (inboxCount > 0) {
    loose.push({
      id: "loose:inbox",
      domain: "entropy",
      glyph: "◌",
      fact:
        inboxCount === 1
          ? "1 inbox task needs a group"
          : `${inboxCount} inbox tasks need a group`,
      meta: null,
      entity: { kind: "link", href: "/tasks?group=inbox" },
    });
  }

  const staleCutoff = parseKey(addDaysKey(today, -STALE_DAYS)).getTime();
  const staleTasks = openTasks.filter(
    (t) => !t.due_date && new Date(t.created_at).getTime() < staleCutoff,
  );
  if (staleTasks.length > 0) {
    loose.push({
      id: "loose:stale-tasks",
      domain: "entropy",
      glyph: "◌",
      fact:
        staleTasks.length === 1
          ? "1 task has drifted 2+ weeks with no date"
          : `${staleTasks.length} tasks have drifted 2+ weeks with no date`,
      meta: null,
      entity: { kind: "link", href: "/tasks" },
    });
  }

  const staleGoals = goals.filter(
    (g) =>
      g.status === "active" && new Date(g.created_at).getTime() < staleCutoff,
  );
  for (const goal of staleGoals) {
    loose.push({
      id: `loose:goal:${goal.id}`,
      domain: "goal",
      glyph: "★",
      fact: `"${goal.title}" has been quiet 2+ weeks`,
      meta: null,
      entity: { kind: "link", href: "/plan" },
    });
  }

  if (pendingProposals > 0) {
    loose.push({
      id: "loose:proposals",
      domain: "goal",
      glyph: "★",
      fact:
        pendingProposals === 1
          ? "1 copilot proposal awaits your confirm"
          : `${pendingProposals} copilot proposals await your confirm`,
      meta: null,
      entity: { kind: "link", href: "/plan" },
    });
  }

  // ---- next up (empty-state hint) ------------------------------------------
  const upcoming = timedEvents
    .filter((e) => new Date(e.start).getTime() > nowMs)
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  let nextUp: string | null = null;
  if (upcoming) {
    const key = dateKeyOf(upcoming.start);
    const day =
      key === today ? "" : key === tomorrow ? "tomorrow " : `${shortDate(key)} `;
    nextUp = `${upcoming.summary}, ${day}${clock(upcoming.start)}`;
  }

  return {
    pulse: {
      todayDelta,
      currency,
      toClear: nowCards.length,
      freeHours: freeHoursToday,
      mood: moodToday,
    },
    now: nowCards,
    next: nextCards,
    nextOverflow,
    later: laterCards,
    laterOverflow,
    loose,
    nextUp,
  };
}
