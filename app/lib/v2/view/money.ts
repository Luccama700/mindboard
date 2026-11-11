// Money as data: the source's numbers in, the words and cells of five panes out.
//
// THREE RULES THIS FILE EXISTS TO HOLD.
//
// 1. IT SAYS HOW OLD IT IS FIRST. A balance is a ledger's sum, so a ledger that
//    stopped months ago is a months old balance however recently it was read.
//    `moneyAge` is computed once from the newest ledger line and every money view
//    carries the same answer, so no pane can be the one that forgot to say it.
//
// 2. IT IS NOT A SECOND FORECAST ENGINE. The forecast was computed by the app
//    the copy was taken from, and this file displays it: no schedule is
//    expanded, no balance is summed, no estimate is applied. A day's balance is
//    the source's `projected` figure, verbatim. The one sum made here is the
//    accounts' total, which is a sum of what the source says each account holds.
//
// 3. ONLY WHAT IS FIRM IS MARKED. Money in and money out with a date are marks;
//    the everyday estimate and the grocery estimate are in the balance and in the
//    estimate sentence, which says they are guesses. One resolver (`spanOf`)
//    turns rows into marks for both the forecast and the list of what is coming,
//    so a name or an amount cannot differ between the two panes.
//
// Loaded by the browser: nothing here may reach the snapshot readers, next or
// node. Weekday and month names come from format.ts, never from Intl.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { weekStartKey } from "@/app/lib/v2/plan/cap";
import { dayDiff, maybeInstantMs, shiftDateKey } from "@/app/lib/v2/plan/day";
import type { Block, DateKey, PlanInput, PlannerRules } from "@/app/lib/v2/types";
import { clockLabel, dayLabel } from "@/app/lib/v2/view/format";

import type { MoneyDay, MoneyScreenData } from "./desk-data";

/** A ledger whose newest line is older than this many days is stale. */
export const STALE_AFTER_DAYS = 7;

export type MoneySpan = 14 | 30 | 60;

export interface MoneyAge {
  /** Whole days from the newest ledger line to the desk's day, or null for an empty ledger. */
  days: number | null;
  /** True when `days` is null, or greater than STALE_AFTER_DAYS. */
  stale: boolean;
  /** The one sentence every Money pane leads with when stale, else null. */
  line: string | null;
}

export interface MoneyCell {
  date: DateKey;
  dayOfMonth: number;
  isToday: boolean;
  /** False for a grid cell that pads the first or last week: nothing is drawn in it. */
  inRange: boolean;
  /** The source's balance for the day, worded ("1,500"), or null out of range. */
  balance: string | null;
  /** What is firm on the day, worded: "Pay 640", "Phone 50". */
  marks: Array<{ kind: "in" | "out"; label: string }>;
  /** True on the lowest day of the span, and on any day under zero. */
  low: boolean;
  negative: boolean;
}

export interface MoneyForecastView {
  age: MoneyAge;
  span: MoneySpan;
  /** Monday first, short. */
  weekdays: string[];
  /** Rows of seven, padded with cells that are not in range. */
  weeks: MoneyCell[][];
  /** The in range days in order, for a narrow pane. */
  list: MoneyCell[];
  /** "Tuesday 24 March", "4,550". Null when there is nothing in range. */
  lowest: { date: string; balance: string } | null;
  /** The sentence about the estimate, always present: it is a guess and says so. */
  estimate: string;
  /** Nothing in range to draw: the source has no forecast rows from the desk's day on. */
  empty: boolean;
}

export interface MoneyAccountsView {
  age: MoneyAge;
  total: string;
  currency: string;
  accounts: Array<{ id: string; name: string; kind: string; balance: string; negative: boolean }>;
  takenLine: string;
  empty: boolean;
}

export interface MoneyComingView {
  age: MoneyAge;
  items: Array<{
    id: string;
    date: string;
    inDays: number;
    kind: "in" | "out";
    name: string;
    amount: string;
  }>;
  empty: boolean;
}

export interface MoneyLedgerView {
  age: MoneyAge;
  rows: Array<{
    id: string;
    date: string;
    kind: "in" | "out";
    amount: string;
    note: string;
    account: string;
    category: string | null;
  }>;
  more: number;
  empty: boolean;
}

export interface MoneyHoursView {
  /** Null when the rules set no weekly income target. */
  target: { hours: number; done: number; label: string } | null;
  /** Null when the rules set no weekly cap, or the planned day is in an exempt range. */
  cap: { hours: number; used: number; label: string; over: boolean } | null;
  /** Neither is set. */
  empty: boolean;
}

/**
 * Every word the Money panes say. A placeholder in braces is filled by the
 * component; every sentence this file composes is built from these parts.
 */
export const MONEY_COPY = {
  age: {
    /** "No transaction since 20 January, 50 days ago." */
    since: "No transaction since",
    daysAgo: "days ago",
    lastKnown: "Everything here is what was last known.",
    none: "No transaction has been recorded at all, so nothing here can say how current it is.",
  },
  /** The plain word for money in that no fixed income accounts for. */
  pay: "Pay",
  /** The plain word for money out that no single bill accounts for. */
  bill: "Bill",
  estimate: {
    /** "Everyday spending is a guess of 30 a day, worked out from the ledger." */
    lead: "Everyday spending is a guess of",
    perDay: "a day",
    fromLedger: "worked out from the ledger.",
    byHand: "typed in by hand.",
    none: "There is no estimate of everyday spending in this forecast.",
    groceries: "Grocery trips in it are a guess too.",
  },
  /** "Last read 11 March at 05:00." */
  taken: { lead: "Last read", at: "at", unknown: "When these were read is not known." },
  hours: {
    of: "of",
    hour: "hour",
    hours: "hours",
    target: "Paid hours this week",
    cap: "Weekly cap",
    over: "Over the cap",
  },
  when: { today: "Today", tomorrow: "Tomorrow", in: "In", days: "days" },
  kind: { in: "Money in", out: "Money out" },
  total: "Total",
  lowest: "Lowest",
  underZero: "Under zero",
  /** `{count}` is the number of lines not shown. */
  more: "{count} more",
  empty: {
    forecast: "No forecast in this copy.",
    accounts: "No accounts in this copy.",
    coming: "No bills or pay with a date in this span.",
    ledger: "No transactions in this copy.",
    hours: "No weekly target or cap is set.",
  },
} as const;

/** The cut a long ledger note gets, in characters. */
const NOTE_LIMIT = 80;
const ELLIPSIS = "...";
const HOUR_MS = 3_600_000;
/** A Monday, any Monday: the weekday names are read off its week. */
const A_MONDAY = "2024-01-01";

// ---------------------------------------------------------------- wording

/**
 * Whole units, grouped by thousands with a comma, a minus sign before a
 * negative. Halves round away from zero, judged on whole cents so that a float
 * sum such as 2.4999999 reads as the 2.50 it meant.
 */
export function formatAmount(value: number): string {
  const cents = Math.round(Math.abs(value) * 100);
  const whole = Math.floor((cents + 50) / 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value < 0 && whole > 0 ? `-${grouped}` : grouped;
}

/** "23 December": `dayLabel` without its weekday, so the names live in one place. */
function dayMonthLabel(date: DateKey): string {
  return dayLabel(date).split(" ").slice(1).join(" ");
}

/** "Mon", "Tue" and so on, Monday first. */
function weekdayNames(): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    dayLabel(shiftDateKey(A_MONDAY, index)).split(" ")[0].slice(0, 3),
  );
}

/** "Today", "Tomorrow", "In 9 days": a coming item's distance from the desk's day. */
export function inDaysLabel(days: number): string {
  const { when } = MONEY_COPY;
  if (days <= 0) return when.today;
  if (days === 1) return when.tomorrow;
  return `${when.in} ${days} ${when.days}`;
}

/** A quarter of an hour, as a plain decimal: 6.5, 6.75, 17. */
function quarterHours(hours: number): number {
  return Math.round(hours * 4) / 4;
}

function hoursLabel(done: number, of: number): string {
  const { hours } = MONEY_COPY;
  return `${done} ${hours.of} ${of} ${of === 1 ? hours.hour : hours.hours}`;
}

// ---------------------------------------------------------------- the age

export function moneyAge(data: MoneyScreenData): MoneyAge {
  const copy = MONEY_COPY.age;
  if (data.ledgerLastOn === null) return { days: null, stale: true, line: copy.none };
  const days = dayDiff(data.ledgerLastOn, data.today);
  if (days <= STALE_AFTER_DAYS) return { days, stale: false, line: null };
  return {
    days,
    stale: true,
    line: `${copy.since} ${dayMonthLabel(data.ledgerLastOn)}, ${days} ${copy.daysAgo}. ${copy.lastKnown}`,
  };
}

// ---------------------------------------------------------------- the marks

interface Mark {
  kind: "in" | "out";
  name: string;
  amount: number;
}

function cents(value: number): number {
  return Math.round(value * 100);
}

/** The whole numbers in a schedule's words: "monthly on day 28" holds 28 and not 8. */
function scheduleHasDay(schedule: string, dayOfMonth: number): boolean {
  return (schedule.match(/\d+/g) ?? []).some((token) => Number(token) === dayOfMonth);
}

/**
 * The firm money of one day, in then out. A mark carries a name only when
 * exactly one bill (or one fixed monthly income) accounts for it to the cent,
 * and for a bill only when its schedule names that day of the month; anything
 * else is the plain word, because a guessed name would be a confident claim
 * about money the source never tied to it.
 */
function marksOf(day: MoneyDay, data: MoneyScreenData): Mark[] {
  const dayOfMonth = Number(day.date.slice(8, 10));
  const marks: Mark[] = [];
  if (day.inflow > 0) {
    const matches = data.income.filter(
      (income) => income.fixedMonthly !== null && cents(income.fixedMonthly.amount) === cents(day.inflow),
    );
    marks.push({
      kind: "in",
      name: matches.length === 1 ? matches[0].name : MONEY_COPY.pay,
      amount: day.inflow,
    });
  }
  if (day.outflow > 0) {
    const matches = data.bills.filter(
      (bill) => cents(bill.amount) === cents(day.outflow) && scheduleHasDay(bill.schedule, dayOfMonth),
    );
    marks.push({
      kind: "out",
      name: matches.length === 1 ? matches[0].name : MONEY_COPY.bill,
      amount: day.outflow,
    });
  }
  return marks;
}

/**
 * The rows the panes speak about: from the desk's day on (earlier rows are
 * dropped; a source that starts later starts there), the first `span` of them,
 * each with its marks. The forecast and the list of what is coming both read
 * this, and nothing else.
 *
 * The source promises one row per day in order; the order is made sure of here
 * anyway (by the date's own arithmetic, never a locale), and a second row for a
 * day already seen is dropped, so the two panes cannot disagree about either.
 */
function spanOf(data: MoneyScreenData, span: MoneySpan): Array<{ day: MoneyDay; marks: Mark[] }> {
  const seen = new Set<DateKey>();
  return data.forecast
    .filter((day) => {
      if (dayDiff(data.today, day.date) < 0 || seen.has(day.date)) return false;
      seen.add(day.date);
      return true;
    })
    .sort((a, b) => dayDiff(b.date, a.date))
    .slice(0, span)
    .map((day) => ({ day, marks: marksOf(day, data) }));
}

// ---------------------------------------------------------------- forecast

function estimateSentence(data: MoneyScreenData, days: readonly MoneyDay[]): string {
  const copy = MONEY_COPY.estimate;
  const { dailyRate, confident, manualFallback } = data.everyday;
  const lead = confident
    ? `${copy.lead} ${formatAmount(dailyRate)} ${copy.perDay}, ${copy.fromLedger}`
    : manualFallback !== null
      ? `${copy.lead} ${formatAmount(manualFallback)} ${copy.perDay}, ${copy.byHand}`
      : copy.none;
  return days.some((day) => day.groceries > 0) ? `${lead} ${copy.groceries}` : lead;
}

function padCell(date: DateKey, today: DateKey): MoneyCell {
  return {
    date,
    dayOfMonth: Number(date.slice(8, 10)),
    isToday: date === today,
    inRange: false,
    balance: null,
    marks: [],
    low: false,
    negative: false,
  };
}

export function buildForecastView(data: MoneyScreenData, span: MoneySpan): MoneyForecastView {
  const rows = spanOf(data, span);
  const age = moneyAge(data);
  const weekdays = weekdayNames();
  const estimate = estimateSentence(
    data,
    rows.map((entry) => entry.day),
  );

  if (rows.length === 0) {
    return { age, span, weekdays, weeks: [], list: [], lowest: null, estimate, empty: true };
  }

  // The earliest of the lowest: a strict comparison keeps the first on a tie.
  let lowestIndex = 0;
  rows.forEach((entry, index) => {
    if (entry.day.projected < rows[lowestIndex].day.projected) lowestIndex = index;
  });

  const cells = new Map<DateKey, MoneyCell>();
  rows.forEach(({ day, marks }, index) => {
    const negative = day.projected < 0;
    cells.set(day.date, {
      date: day.date,
      dayOfMonth: Number(day.date.slice(8, 10)),
      isToday: day.date === data.today,
      inRange: true,
      balance: formatAmount(day.projected),
      marks: marks.map((mark) => ({ kind: mark.kind, label: `${mark.name} ${formatAmount(mark.amount)}` })),
      low: index === lowestIndex || negative,
      negative,
    });
  });

  // The grid runs from the Monday of the first day's week to the Sunday of the
  // last day's. A day the source has no row for is padding: nothing is drawn.
  const first = weekStartKey(rows[0].day.date);
  const last = shiftDateKey(weekStartKey(rows[rows.length - 1].day.date), 6);
  const weeks: MoneyCell[][] = [];
  for (let date = first; dayDiff(date, last) >= 0; date = shiftDateKey(date, 1)) {
    if (weeks.length === 0 || weeks[weeks.length - 1].length === 7) weeks.push([]);
    weeks[weeks.length - 1].push(cells.get(date) ?? padCell(date, data.today));
  }

  const lowestDay = rows[lowestIndex].day;
  return {
    age,
    span,
    weekdays,
    weeks,
    list: weeks.flat().filter((cell) => cell.inRange),
    lowest: { date: dayLabel(lowestDay.date), balance: formatAmount(lowestDay.projected) },
    estimate,
    empty: false,
  };
}

// ---------------------------------------------------------------- accounts

function takenLine(takenAt: string, timeZone: string): string {
  const copy = MONEY_COPY.taken;
  const ms = maybeInstantMs(takenAt);
  if (ms === null) return copy.unknown;
  return `${copy.lead} ${dayMonthLabel(zonedDateKey(ms, timeZone))} ${copy.at} ${clockLabel(takenAt, timeZone)}.`;
}

export function buildAccountsView(data: MoneyScreenData, timeZone: string): MoneyAccountsView {
  // In whole cents, so a run of tenths cannot drift. The one sum in this file.
  const totalCents = data.accounts.reduce((sum, account) => sum + cents(account.balance), 0);
  return {
    age: moneyAge(data),
    total: formatAmount(totalCents / 100),
    currency: data.currency,
    accounts: data.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind,
      balance: formatAmount(account.balance),
      negative: account.balance < 0,
    })),
    takenLine: takenLine(data.takenAt, timeZone),
    empty: data.accounts.length === 0,
  };
}

// ---------------------------------------------------------------- coming up

export function buildComingView(data: MoneyScreenData, span: MoneySpan): MoneyComingView {
  const items = spanOf(data, span).flatMap(({ day, marks }) =>
    marks.map((mark) => ({
      id: `${day.date}:${mark.kind}`,
      date: dayLabel(day.date),
      inDays: dayDiff(data.today, day.date),
      kind: mark.kind,
      name: mark.name,
      amount: formatAmount(mark.amount),
    })),
  );
  return { age: moneyAge(data), items, empty: items.length === 0 };
}

// ---------------------------------------------------------------- ledger

/**
 * A note longer than NOTE_LIMIT characters, cut at the last space within the
 * limit and given three dots; one long word is cut at the limit itself. Counted
 * in code points, so a cut never splits a character in two. Nothing else in the
 * note is touched.
 */
function cutNote(note: string): string {
  const chars = Array.from(note);
  if (chars.length <= NOTE_LIMIT) return note;
  let at = -1;
  for (let index = NOTE_LIMIT; index > 0; index -= 1) {
    if (/\s/.test(chars[index])) {
      at = index;
      break;
    }
  }
  const kept = at > 0 ? chars.slice(0, at).join("").trimEnd() : "";
  return `${kept.length > 0 ? kept : chars.slice(0, NOTE_LIMIT).join("")}${ELLIPSIS}`;
}

export function buildLedgerView(data: MoneyScreenData, rows: 10 | 25 | 50): MoneyLedgerView {
  const shown = data.rows.slice(0, rows);
  return {
    age: moneyAge(data),
    rows: shown.map((line) => ({
      id: line.id,
      date: dayMonthLabel(line.on),
      kind: line.direction,
      amount: formatAmount(line.amount),
      note: cutNote(line.note),
      account: line.account,
      category: line.category,
    })),
    more: Math.max(0, data.rows.length - shown.length),
    empty: data.rows.length === 0,
  };
}

// ---------------------------------------------------------------- hours

/** Hours between two instants, or 0 when either cannot be read or they do not run forward. */
function spanHours(start: string, end: string): number {
  const startMs = maybeInstantMs(start);
  const endMs = maybeInstantMs(end);
  if (startMs === null || endMs === null || endMs <= startMs) return 0;
  return (endMs - startMs) / HOUR_MS;
}

/** The same test as plan/cap.ts `inExemptRange`: inclusive at both ends. */
function capExempt(date: DateKey, rules: PlannerRules): boolean {
  return rules.capExemptRanges.some(
    (range) => dayDiff(range.from, date) >= 0 && dayDiff(date, range.to) >= 0,
  );
}

/**
 * The week's paid hours against the target and the cap, from the planner's own
 * input. The week's other days are the planner's numbers (`input.week`); this
 * adds the planned day's income blocks that are not skipped, and for the cap the
 * day's fixed events that count toward it, measured exactly as plan/cap.ts
 * measures them. Nothing here reads a calendar or a wage.
 */
export function buildHoursView(input: PlanInput, blocks: readonly Block[]): MoneyHoursView {
  const { rules, week, date } = input;

  const incomeToday = blocks
    .filter((block) => block.date === date && block.kind === "income" && block.state !== "skipped")
    .reduce((sum, block) => sum + spanHours(block.start, block.end), 0);
  const fixedToday = input.fixed
    .filter((event) => !event.allDay && event.countsTowardCap)
    .reduce((sum, event) => sum + spanHours(event.start, event.end), 0);

  const goal = rules.incomeTarget;
  const target =
    goal === null
      ? null
      : (() => {
          const hours = quarterHours(goal.weeklyHours);
          const done = quarterHours(week.incomeHoursElsewhere + incomeToday);
          return { hours, done, label: hoursLabel(done, hours) };
        })();

  const cap =
    rules.weeklyHourCap === null || capExempt(date, rules)
      ? null
      : (() => {
          const hours = quarterHours(rules.weeklyHourCap);
          const used = quarterHours(week.capHoursElsewhere + fixedToday + incomeToday);
          return { hours, used, label: hoursLabel(used, hours), over: used > hours };
        })();

  return { target, cap, empty: target === null && cap === null };
}
