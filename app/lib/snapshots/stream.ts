// The Stream: one deterministic, ranked queue synthesized across every domain.
// NOW is an urgency board — overdue + all due-today tasks, ranked by
// urgencyScore and capped at maxTasks (non-task NOW cards stay uncapped), each
// task stamped with a tier the client reads for elevation. NEXT/LATER remain
// objective time-facts (events, recurring, stock, bills). Pure: `today`/`now`
// are injected.

import {
  ruleLandsOn,
  type RecurringRule,
} from "@/app/_components/finance-projection";
import { urgencyScore, urgencyTier } from "./urgency";
import {
  effectiveDailyRate,
  runOutDateKey,
  type UsageRule,
} from "@/app/_components/inventory-projection";
import {
  formatRecurrence,
  taskRuleLandsOn,
  type TaskRecurrence,
} from "@/app/lib/recurrence";
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
  priority: "low" | "med" | "high";
};

export type StreamGoalInput = {
  id: string;
  title: string;
  status: string;
  created_at: string;
};

export type StreamRecurringTaskInput = TaskRecurrence & {
  id: string;
  title: string;
  due_time: string | null;
  duration_min: number | null;
  priority: "low" | "med" | "high";
  group_id: string | null;
  group_name: string | null;
  group_color: string | null;
  notes: string | null;
};

export type StreamSection = "now" | "next" | "later" | "loose" | "routines";
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
  | {
      kind: "rtask";
      ruleId: string;
      dateKey: string;
      title: string;
      dueTime: string | null;
      durationMin: number | null;
      frequency: TaskRecurrence["frequency"];
      weekdays: number[] | null;
      day_of_month: number | null;
      interval_days: number | null;
      start_date: string | null;
      priority: "low" | "med" | "high";
      group_id: string | null;
      group_name: string | null;
      hasNotes: boolean;
      plannedStart: string | null;
      slotStart: string | null;
    }
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
  // Urgency tier for NOW task cards only (0..3); absent on every other card.
  tier?: 0 | 1 | 2 | 3;
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
  nowOverflow: number;
  next: StreamCard[];
  nextOverflow: number;
  later: StreamCard[];
  laterOverflow: number;
  loose: StreamCard[];
  routines: StreamCard[];
  routinesOverflow: number;
  nextUp: string | null;
};

export type StreamInput = {
  today: string; // YYYY-MM-DD, server-local like the rest of the app
  now: Date;
  tasks: TaskWithGroup[]; // every non-done task, with or without a due date
  events: StreamEventInput[];
  bills: StreamBillInput[];
  recurringTasks: StreamRecurringTaskInput[];
  completedRecurringToday: Set<string>; // rule ids checked off today
  // Advisory soft placements for untimed occurrences (rule id -> "HH:MM"),
  // computed by the gap planner. Display only: a planned time never escalates a
  // card to NOW (that stays keyed on real due_time).
  plannedStartByRule?: Map<string, string>;
  // Approved per-occurrence slots for today (rule id -> "HH:MM"): a committed
  // time that overrides the rule's placement. Accepted here for a parallel
  // workstream to consume; not yet read by this snapshot.
  slotStartByRule?: Map<string, string>;
  items: StreamItemInput[];
  usagesByItem: Record<string, UsageRule[]>;
  goals: StreamGoalInput[];
  hasDailyLogToday: boolean;
  moodToday: number | null;
  pendingProposals: number;
  wakeEndHour: number;
  // IANA zone for wall-clock facts (the log-invite hour gate, due-time
  // comparisons, event day bucketing). Omitted/null = process-local clock.
  timeZone?: string | null;
  freeHoursToday: number;
  todayDelta: number;
  currency: string;
  // Cap for the task-bearing lists (NOW tasks, NEXT, LATER). Default 5.
  maxTasks?: number;
};

const SECTION_CAP = 5;
const STALE_DAYS = 14;
const SOON_WINDOW_DAYS = 7;
const NOW_EVENT_LEAD_MS = 60 * 60 * 1000;
const HIGH_RUNOUT_LEAD_DAYS = 2;

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

// Wall-clock HH:MM of an instant, in the user's zone when one is set. The
// process clock is UTC on Vercel, so bare getHours() is not the user's hour.
function wallClock(d: Date, timeZone: string | null | undefined): string {
  if (!timeZone) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

function clock(iso: string, timeZone: string | null | undefined): string {
  return wallClock(new Date(iso), timeZone);
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

function dateKeyOf(iso: string, timeZone: string | null | undefined): string {
  const d = new Date(iso);
  if (timeZone) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function shortTime(time: string): string {
  return time.slice(0, 5);
}

// "~45m" under an hour, else "~2h" / "~1.5h" (the .0 trimmed).
export function formatEstimate(minutes: number): string {
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  const label = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `~${label}h`;
}

function taskMeta(task: TaskWithGroup, today: string): string {
  const parts: string[] = [];
  if (task.due_date) {
    const late = daysLate(task.due_date, today);
    if (late > 0) parts.push(late === 1 ? "1d late" : `${late}d late`);
    else if (late === 0)
      parts.push(task.due_time ? `today ${shortTime(task.due_time)}` : "today");
    else
      parts.push(
        task.due_time
          ? `${shortDate(task.due_date)} ${shortTime(task.due_time)}`
          : shortDate(task.due_date),
      );
  }
  if (task.priority === "high") parts.push("!!!");
  if (task.group_name) parts.push(task.group_name);
  if (task.estimated_minutes) parts.push(formatEstimate(task.estimated_minutes));
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

function rtaskCard(
  rule: StreamRecurringTaskInput,
  today: string,
  plannedStart: string | null = null,
  slotStart: string | null = null,
): StreamCard {
  // A committed slot or the rule's fixed due_time shows a firm time (slot wins);
  // an untimed rule the gap planner soft-placed shows an advisory "~" time; a
  // bare untimed rule just reads "today".
  const firmTime = slotStart ?? (rule.due_time ? shortTime(rule.due_time) : null);
  const timeLabel = firmTime
    ? `today ${firmTime}`
    : plannedStart
      ? `today ~${shortTime(plannedStart)}`
      : "today";
  const parts: string[] = [timeLabel, formatRecurrence(rule)];
  if (rule.priority === "high") parts.push("!!!");
  if (rule.group_name) parts.push(rule.group_name);
  return {
    id: `rtask:${rule.id}:${today}`,
    domain: "task",
    glyph: "↻",
    fact: rule.title,
    meta: parts.join(" · "),
    entity: {
      kind: "rtask",
      ruleId: rule.id,
      dateKey: today,
      title: rule.title,
      dueTime: rule.due_time,
      durationMin: rule.duration_min,
      frequency: rule.frequency,
      weekdays: rule.weekdays,
      day_of_month: rule.day_of_month,
      interval_days: rule.interval_days,
      start_date: rule.start_date,
      priority: rule.priority,
      group_id: rule.group_id,
      group_name: rule.group_name,
      hasNotes: (rule.notes ?? "").trim().length > 0,
      plannedStart: rule.due_time || slotStart ? null : plannedStart,
      slotStart,
    },
  };
}

function eventCard(
  e: StreamEventInput,
  now: Date,
  timeZone: string | null | undefined,
  opts?: { tomorrow?: boolean },
): StreamCard {
  const started = new Date(e.start).getTime() <= now.getTime();
  const meta = opts?.tomorrow
    ? `tomorrow · ${clock(e.start, timeZone)}`
    : started
      ? `${clock(e.start, timeZone)} · now`
      : `${clock(e.start, timeZone)} · ${relative(e.start, now)}`;
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
    recurringTasks,
    completedRecurringToday,
    plannedStartByRule,
    slotStartByRule,
    items,
    usagesByItem,
    goals,
    hasDailyLogToday,
    moodToday,
    pendingProposals,
    wakeEndHour,
    timeZone,
    freeHoursToday,
    todayDelta,
    currency,
    maxTasks = SECTION_CAP,
  } = input;

  const cap = maxTasks;
  const nowMs = now.getTime();
  const tomorrow = addDaysKey(today, 1);
  const soonLimit = addDaysKey(today, SOON_WINDOW_DAYS);

  const openTasks = tasks.filter(
    (t) => t.status !== "done" && t.status !== "missed",
  );
  const timedEvents = events.filter((e) => !e.allDay && e.start && e.end);

  // Per-item run-out keys, computed once. Low-priority stock never enters the
  // Stream; high-priority stock escalates to NOW while merely running low.
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

  const streamItems = items.filter((item) => item.priority !== "low");
  const itemOut = (item: StreamItemInput) => {
    const key = runOuts.get(item.id);
    return key !== null && key !== undefined && key <= today;
  };
  const itemRunningLow = (item: StreamItemInput) => {
    if (itemOut(item)) return true;
    if (
      item.reorder_threshold !== null &&
      item.quantity <= item.reorder_threshold
    ) {
      return true;
    }
    const key = runOuts.get(item.id);
    return (
      key !== null &&
      key !== undefined &&
      key <= addDaysKey(today, HIGH_RUNOUT_LEAD_DAYS)
    );
  };
  const itemUrgent = (item: StreamItemInput) =>
    item.priority === "high" && itemRunningLow(item);

  // ---- NOW: objective, uncapped -------------------------------------------
  const nowEvents = timedEvents
    .filter((e) => {
      const start = new Date(e.start).getTime();
      const end = new Date(e.end).getTime();
      return end > nowMs && start <= nowMs + NOW_EVENT_LEAD_MS;
    })
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => eventCard(e, now, timeZone));

  const nowClock = wallClock(now, timeZone);

  // NOW is the urgency board: overdue + ALL due-today tasks (untimed and
  // future-timed alike), ranked by urgencyScore (byPriorityThenLateness breaks
  // ties), capped at maxTasks with the surplus surfaced as nowOverflow. Each
  // card is stamped with its tier for the client's elevation treatment.
  const nowTaskEntries = openTasks
    .filter((t) => t.due_date !== null && t.due_date <= today)
    .map((t) => ({ task: t, score: urgencyScore(t, today, nowClock) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return byPriorityThenLateness(today)(a.task, b.task);
    });
  const nowTaskCards = nowTaskEntries
    .slice(0, cap)
    .map(({ task, score }) => ({
      ...taskCard(task, today),
      tier: urgencyTier(score),
    }));
  const nowOverflow = Math.max(0, nowTaskEntries.length - cap);

  const todayDate = parseKey(today);
  const billsToday = bills
    .filter((b) => ruleLandsOn(b, todayDate))
    .map((b) => billCard(b, today, today, currency));

  // Today's uncompleted recurring occurrences. They no longer mix into NOW/NEXT
  // or the to-clear count — recurring is a quiet backdrop, so every occurrence
  // sinks to its own `routines` section at the very bottom of the stream.
  // Yesterday's misses never appear — each day is fresh (completions are the
  // history). Ordered by effective time: a committed slot, then the rule's
  // fixed due_time, then a soft-placed plan; untimed-unplaced last, ties by
  // priority then title then rule id.
  const todaysRules = recurringTasks.filter(
    (r) => taskRuleLandsOn(r, todayDate) && !completedRecurringToday.has(r.id),
  );
  const effectiveRtaskTime = (r: StreamRecurringTaskInput): string | null => {
    const slot = slotStartByRule?.get(r.id);
    if (slot) return slot;
    if (r.due_time) return shortTime(r.due_time);
    return plannedStartByRule?.get(r.id) ?? null;
  };
  const routineCards = todaysRules
    .slice()
    .sort((a, b) => {
      const ta = effectiveRtaskTime(a);
      const tb = effectiveRtaskTime(b);
      if (ta && tb) {
        const c = ta.localeCompare(tb);
        if (c !== 0) return c;
      } else if (ta) return -1;
      else if (tb) return 1;
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      const t = a.title.localeCompare(b.title);
      if (t !== 0) return t;
      return a.id.localeCompare(b.id);
    })
    .map((r) =>
      rtaskCard(
        r,
        today,
        plannedStartByRule?.get(r.id) ?? null,
        slotStartByRule?.get(r.id) ?? null,
      ),
    );
  const routines = routineCards.slice(0, cap);
  const routinesOverflow = Math.max(0, routineCards.length - cap);

  const urgentStock = streamItems
    .filter(itemUrgent)
    .sort((a, b) => {
      const outDiff = (itemOut(a) ? 0 : 1) - (itemOut(b) ? 0 : 1);
      if (outDiff !== 0) return outDiff;
      const ra = runOuts.get(a.id) ?? "9999-99-99";
      const rb = runOuts.get(b.id) ?? "9999-99-99";
      const r = ra.localeCompare(rb);
      if (r !== 0) return r;
      return a.name.localeCompare(b.name);
    })
    .map((item) => {
      const runOut = runOuts.get(item.id);
      const fact =
        item.quantity <= 0
          ? `${item.name} is out`
          : itemOut(item)
            ? `${item.name} runs out today`
            : `${item.name} is low`;
      const detail = itemOut(item)
        ? null
        : runOut && runOut > today
          ? `out ${shortDate(runOut)}`
          : `${item.quantity} ${item.unit} left`;
      return itemCard(item, fact, detail ? `!!! · ${detail}` : "!!!");
    });

  const runOutNow = streamItems
    .filter((item) => item.priority === "med" && itemOut(item))
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

  const nowCards = [
    ...nowEvents,
    ...urgentStock,
    ...nowTaskCards,
    ...billsToday,
    ...runOutNow,
  ];

  // ---- NEXT: cap maxTasks --------------------------------------------------
  const laterTodayEvents = timedEvents
    .filter((e) => {
      const start = new Date(e.start).getTime();
      return (
        dateKeyOf(e.start, timeZone) === today &&
        start > nowMs + NOW_EVENT_LEAD_MS
      );
    })
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => eventCard(e, now, timeZone));

  const tomorrowFirst = timedEvents
    .filter((e) => dateKeyOf(e.start, timeZone) === tomorrow)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 1)
    .map((e) => eventCard(e, now, timeZone, { tomorrow: true }));

  // Due-today real tasks live in NOW; recurring occurrences live in `routines`.
  // NEXT now carries only ambient schedule context and low stock.
  const lowItems = streamItems
    .filter((item) => {
      if (itemUrgent(item) || itemOut(item)) return false;
      return (
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

  // Ambient schedule context, then low stock.
  const nextAll = [
    ...laterTodayEvents,
    ...tomorrowFirst,
    ...lowItems,
  ];
  const nextCards = nextAll.slice(0, cap);
  const nextOverflow = Math.max(0, nextAll.length - cap);

  // ---- LATER: cap maxTasks, by date ---------------------------------------
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

  const laterRunOuts = streamItems
    .filter((item) => {
      if (itemUrgent(item)) return false;
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
    !hasDailyLogToday && Number(nowClock.slice(0, 2)) >= wakeEndHour - 2
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
  const laterCards = laterAll.map((x) => x.card).slice(0, cap);
  const laterOverflow = Math.max(0, laterAll.length - cap);

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
    const key = dateKeyOf(upcoming.start, timeZone);
    const day =
      key === today ? "" : key === tomorrow ? "tomorrow " : `${shortDate(key)} `;
    nextUp = `${upcoming.summary}, ${day}${clock(upcoming.start, timeZone)}`;
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
    nowOverflow,
    next: nextCards,
    nextOverflow,
    later: laterCards,
    laterOverflow,
    loose,
    routines,
    routinesOverflow,
    nextUp,
  };
}
