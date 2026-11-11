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
import { capRoomHours, weekStartKey } from "@/app/lib/v2/plan/cap";
import { dayDiff, maybeInstantMs, shiftDateKey } from "@/app/lib/v2/plan/day";
import type { Block, DateKey, PlanInput } from "@/app/lib/v2/types";
import { clockLabel, dayLabel } from "@/app/lib/v2/view/format";

import type { MoneyDay, MoneyScreenData } from "./desk-data";

/** A ledger whose newest line is older than this many days is stale. */
export const STALE_AFTER_DAYS = 7;

export type MoneySpan = 14 | 30 | 60;

export interface MoneyAge {
  /**
   * Whole days from the newest ledger line to the desk's day, never below zero,
   * or null for an empty ledger.
   */
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
  /**
   * The source's balance for the day, worded ("1,500"). Null out of range, and
   * null for a day of the span the source has no row for: in range, no figure.
   */
  balance: string | null;
  /** What is firm on the day, worded: "Pay 640", "Phone 50". */
  marks: Array<{ kind: "in" | "out"; label: string }>;
  /** True on the lowest day of the span, and on any day under zero. */
  low: boolean;
  negative: boolean;
  /**
   * The month, short ("Apr"), on the first day of the window and on each 1st
   * in range, where the day's number alone would not say which month; else
   * null. A cell that only pads a week names no month.
   */
  month: string | null;
}

export interface MoneyForecastView {
  age: MoneyAge;
  span: MoneySpan;
  /** Monday first, short. */
  weekdays: string[];
  /**
   * Rows of seven, padded with cells that are not in range, up to the week of
   * the last day the source has a row for: exactly the weeks a grid draws.
   */
  weeks: MoneyCell[][];
  /**
   * The calendar days of the window in order, up to the last one the source
   * has a row for: exactly the days a narrow pane lists. `span` days when the
   * source covers the window.
   */
  list: MoneyCell[];
  /**
   * "Tuesday 24 March", its key, "4,550". Null when no day of the window has a
   * balance. A pane finds the one lowest cell by `dateKey`: every day under
   * zero is `low` too, so `low` alone cannot.
   */
  lowest: { date: string; dateKey: DateKey; balance: string } | null;
  /**
   * The last day the source has a row for, when the window runs past it, so a
   * pane can say where the forecast ends; null when the source covers it.
   */
  endsOn: DateKey | null;
  /** The sentence about the estimate, always present: it is a guess and says so. */
  estimate: string;
  /** Nothing in range to draw: the source has no forecast rows from the desk's day on. */
  empty: boolean;
}

export interface MoneyAccountsView {
  age: MoneyAge;
  /** The sum of the balances, or null when the accounts are in more than one currency. */
  total: string | null;
  /** Why there is no total (MONEY_COPY.mixedCurrencies), or null when there is one. */
  totalNote: string | null;
  /** The accounts' one currency, or the source's when there are no accounts or several. */
  currency: string;
  accounts: Array<{
    id: string;
    name: string;
    kind: string;
    balance: string;
    currency: string;
    negative: boolean;
  }>;
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
    /**
     * The whole note, its runs of white space made one space. Nothing is cut
     * here: the pane prints all of it and its line clamp cuts where the eye
     * needs, so a screen reader still has every word.
     */
    note: string;
    account: string;
    category: string | null;
  }>;
  more: number;
  empty: boolean;
}

/**
 * What a bar draws, worked out here so a pane only prints it: `share` is the
 * part of the bar filled, 0 to 1, never past its end and 0 when there is no
 * maximum; `valueNow` is the figure held to the meter's own range, for
 * `aria-valuenow`. The true figure is always the label.
 */
export interface MoneyMeter {
  share: number;
  valueNow: number;
}

export interface MoneyHoursView {
  /** Null when the rules set no weekly income target. */
  target: ({ hours: number; done: number; label: string } & MoneyMeter) | null;
  /**
   * Null whenever the planner itself would not hold the day to a cap: none is
   * set, the planned day is in an exempt range, or the day is planned in travel
   * mode. `over` is judged on the hours themselves; the figures are rounded.
   */
  cap: ({ hours: number; used: number; label: string; over: boolean } & MoneyMeter) | null;
  /** Neither is set. */
  empty: boolean;
}

/**
 * Every word the Money panes say. A placeholder in braces is filled by the
 * component; every sentence this file composes is built from these parts.
 */
export const MONEY_COPY = {
  age: {
    /**
     * The label the stale sentence opens with, so it is the first thing read:
     * "Last known figures. No transaction since 20 January, 50 days ago."
     */
    label: "Last known figures.",
    since: "No transaction since",
    daysAgo: "days ago",
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
  /** What an amount that is not a number prints as, in place of a figure. */
  unknownAmount: "Unknown",
  total: "Total",
  mixedCurrencies: "These accounts are in more than one currency, so they are not added up.",
  lowest: "Lowest",
  underZero: "Under zero",
  /** `{count}` is the number of lines not shown. */
  more: "{count} more",
  /**
   * The word after an amount that says which way it goes: "50 out", "2,000 in".
   * `kind` says the same in two words, which a forecast cell has no room for.
   */
  sign: { in: "in", out: "out" },
  /** Beside a stale pane's main figure: it is what was last known, not what is. */
  lastKnownTag: "Last known",
  /** Under a forecast the source stops short of the span. `{date}` is its last day. */
  endsOn: "The forecast in this copy ends on {date}.",
  empty: {
    forecast: "No forecast in this copy.",
    accounts: "No accounts in this copy.",
    coming: "No bills or pay with a date in this span.",
    ledger: "No transactions in this copy.",
    hours: "No weekly target or cap is set.",
  },
} as const;

const HOUR_MS = 3_600_000;
/** A Monday, any Monday: the weekday names are read off its week. */
const A_MONDAY = "2024-01-01";

// ---------------------------------------------------------------- wording

/**
 * Whole units, grouped by thousands with a comma, a minus sign before a
 * negative. Rounded ONCE, on the magnitude, so only a half goes away from zero:
 * 0.496 is "0", 0.5 is "1". Float noise in a sum is the summer's to absorb (the
 * accounts' total is added in whole cents), never snapped here. A number that
 * is not finite has no figure to print and says so in words.
 */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return MONEY_COPY.unknownAmount;
  const whole = Math.round(Math.abs(value));
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value < 0 && whole > 0 ? `-${grouped}` : grouped;
}

/** "23 December": `dayLabel` without its weekday, so the names live in one place. */
function dayMonthLabel(date: DateKey): string {
  return dayLabel(date).split(" ").slice(1).join(" ");
}

/** "Mar", "Apr": a month cut to three letters, as the weekdays are below. */
function shortMonth(date: DateKey): string {
  return (dayLabel(date).split(" ")[2] ?? "").slice(0, 3);
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

// ---------------------------------------------------------------- options

/**
 * The forecast's `span` option: "14", "30" or "60" days, and 30 for anything
 * else. Each choice is compared as a whole string, because the value comes
 * from a URL or a saved layout and a lookup keyed by it could answer from a
 * prototype. Here, beside the view it chooses, so a server module can read it
 * without importing a client file.
 */
export function forecastSpan(value: string | undefined): MoneySpan {
  if (value === "14") return 14;
  if (value === "60") return 60;
  return 30;
}

/** The ledger's `rows` option: "10", "25" or "50" lines, and 25 for anything else. */
export function ledgerRows(value: string | undefined): 10 | 25 | 50 {
  if (value === "10") return 10;
  if (value === "50") return 50;
  return 25;
}

// ---------------------------------------------------------------- the age

export function moneyAge(data: MoneyScreenData): MoneyAge {
  const copy = MONEY_COPY.age;
  if (data.ledgerLastOn === null) return { days: null, stale: true, line: copy.none };
  // A desk showing a day before the ledger's last line is looking at numbers
  // newer than itself: zero days old, never a negative count.
  const days = Math.max(0, dayDiff(data.ledgerLastOn, data.today));
  if (days <= STALE_AFTER_DAYS) return { days, stale: false, line: null };
  return {
    days,
    stale: true,
    line: `${copy.label} ${copy.since} ${dayMonthLabel(data.ledgerLastOn)}, ${days} ${copy.daysAgo}.`,
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

/**
 * The one schedule form a bill can be named by: "monthly on day N", in any
 * case, anywhere in the words, N one or two digits. Every other form ("every 14
 * days from 2026-03-01", "every 2 weeks") holds numbers that are not a day of
 * the month, so it answers null and its bill is never named.
 */
const MONTHLY_ON_DAY = /\bmonthly on day (\d{1,2})(?!\d)/i;

function monthlyDay(schedule: string): number | null {
  const match = MONTHLY_ON_DAY.exec(schedule);
  return match === null ? null : Number(match[1]);
}

/**
 * The firm money of one day, in then out. A mark carries a name only when
 * exactly one bill (or one fixed monthly income) accounts for it to the cent,
 * and for a bill only when its schedule is the monthly form naming that day of
 * the month; anything else is the plain word, because a guessed name would be
 * a confident claim about money the source never tied to it. A bill moved off a
 * day the month does not have (day 31 paid on the 30th) is therefore plain too.
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
      (bill) => cents(bill.amount) === cents(day.outflow) && monthlyDay(bill.schedule) === dayOfMonth,
    );
    marks.push({
      kind: "out",
      name: matches.length === 1 ? matches[0].name : MONEY_COPY.bill,
      amount: day.outflow,
    });
  }
  return marks;
}

/** One calendar day of the window: the source's row for it, or null for none. */
interface SpanDay {
  date: DateKey;
  day: MoneyDay | null;
  marks: Mark[];
}

/**
 * The days the panes speak about, each with the source's row and its marks.
 * The forecast and the list of what is coming both read this, and nothing else.
 *
 * A SPAN IS CALENDAR DAYS. The window starts at the desk's day, or at the
 * source's first day when that is later, and runs `span` days. A day in it the
 * source has no row for is still a day of the window, with no row: it is drawn
 * with no balance and no marks, and is never the lowest.
 *
 * ONE ROW PER DAY: the rows are put in date order first (by the date's own
 * arithmetic, never a locale; the sort is stable), and of two rows for one day
 * the one the source sent first is kept. Rows before the desk's day are dropped.
 */
function spanOf(data: MoneyScreenData, span: MoneySpan): SpanDay[] {
  const byDate = new Map<DateKey, MoneyDay>();
  const ordered = data.forecast
    .filter((day) => dayDiff(data.today, day.date) >= 0)
    .sort((a, b) => dayDiff(b.date, a.date));
  for (const day of ordered) if (!byDate.has(day.date)) byDate.set(day.date, day);
  if (ordered.length === 0) return [];

  const start = ordered[0].date;
  return Array.from({ length: span }, (_, offset) => {
    const date = shiftDateKey(start, offset);
    const day = byDate.get(date) ?? null;
    return { date, day, marks: day === null ? [] : marksOf(day, data) };
  });
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
    month: null,
  };
}

export function buildForecastView(data: MoneyScreenData, span: MoneySpan): MoneyForecastView {
  const days = spanOf(data, span);
  const age = moneyAge(data);
  const weekdays = weekdayNames();
  const rows = days.flatMap((entry) => (entry.day === null ? [] : [entry.day]));
  const estimate = estimateSentence(data, rows);

  if (days.length === 0) {
    return {
      age,
      span,
      weekdays,
      weeks: [],
      list: [],
      lowest: null,
      endsOn: null,
      estimate,
      empty: true,
    };
  }

  // WHERE THE SOURCE STOPS. Its forecast can end before the window does, and
  // the days after its last row have no balance. A run of weeks with nothing
  // in them would read as empty weeks rather than as weeks nobody can see, so
  // what is handed over stops there: the list at the last day with a row, the
  // grid at that day's week, and `endsOn` says the day. Only the tail: a gap in
  // the middle is drawn day by day, so the grid never silently skips a week.
  // The first day always has a row (`spanOf` starts the window at one).
  let lastRow = 0;
  days.forEach((entry, index) => {
    if (entry.day !== null) lastRow = index;
  });

  // The earliest of the lowest, over the days that have a balance to compare:
  // a strict comparison keeps the first on a tie, and a day with no row or a
  // balance that is not a number is never it.
  let lowest: MoneyDay | null = null;
  for (const day of rows) {
    if (!Number.isFinite(day.projected)) continue;
    if (lowest === null || day.projected < lowest.projected) lowest = day;
  }

  const inRange = days.map(({ date, day, marks }, index): MoneyCell => {
    const negative = day !== null && day.projected < 0;
    return {
      ...padCell(date, data.today),
      inRange: true,
      balance: day === null ? null : formatAmount(day.projected),
      marks: marks.map((mark) => ({ kind: mark.kind, label: `${mark.name} ${formatAmount(mark.amount)}` })),
      low: (lowest !== null && day === lowest) || negative,
      negative,
      month: index === 0 || isFirstOfMonth(date) ? shortMonth(date) : null,
    };
  });
  const cells = new Map(inRange.map((cell) => [cell.date, cell] as const));

  // The grid runs from the Monday of the window's first week to the Sunday of
  // the week of the source's last row. A cell outside the window is padding:
  // nothing is drawn in it.
  const first = weekStartKey(days[0].date);
  const last = shiftDateKey(weekStartKey(days[lastRow].date), 6);
  const weeks: MoneyCell[][] = [];
  for (let date = first; dayDiff(date, last) >= 0; date = shiftDateKey(date, 1)) {
    if (weeks.length === 0 || weeks[weeks.length - 1].length === 7) weeks.push([]);
    weeks[weeks.length - 1].push(cells.get(date) ?? padCell(date, data.today));
  }

  return {
    age,
    span,
    weekdays,
    weeks,
    list: inRange.slice(0, lastRow + 1),
    lowest:
      lowest === null
        ? null
        : {
            date: dayLabel(lowest.date),
            dateKey: lowest.date,
            balance: formatAmount(lowest.projected),
          },
    endsOn: lastRow < days.length - 1 ? days[lastRow].date : null,
    estimate,
    empty: false,
  };
}

/** Is this the 1st of its month? Read off the key, as the day of the month is. */
function isFirstOfMonth(date: DateKey): boolean {
  return Number(date.slice(8, 10)) === 1;
}

// ---------------------------------------------------------------- accounts

function takenLine(takenAt: string, timeZone: string): string {
  const copy = MONEY_COPY.taken;
  const ms = maybeInstantMs(takenAt);
  if (ms === null) return copy.unknown;
  return `${copy.lead} ${dayMonthLabel(zonedDateKey(ms, timeZone))} ${copy.at} ${clockLabel(takenAt, timeZone)}.`;
}

export function buildAccountsView(data: MoneyScreenData, timeZone: string): MoneyAccountsView {
  // Balances in different currencies have no sum: adding them would print a
  // confident number that means nothing, so the view says why there is none.
  const currencies = new Set(data.accounts.map((account) => account.currency));
  const mixed = currencies.size > 1;
  // The one sum in this file, in whole cents added as integers, so float noise
  // cannot carry a total across a half ([0.1, 0.7, -0.3] is 50 cents, not
  // 0.49999999999999994). formatAmount then rounds the exact figure once.
  const totalCents = data.accounts.reduce((sum, account) => sum + cents(account.balance), 0);
  return {
    age: moneyAge(data),
    total: mixed ? null : formatAmount(totalCents / 100),
    totalNote: mixed ? MONEY_COPY.mixedCurrencies : null,
    currency: currencies.size === 1 ? data.accounts[0].currency : data.currency,
    accounts: data.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind,
      balance: formatAmount(account.balance),
      currency: account.currency,
      negative: account.balance < 0,
    })),
    takenLine: takenLine(data.takenAt, timeZone),
    empty: data.accounts.length === 0,
  };
}

// ---------------------------------------------------------------- coming up

export function buildComingView(data: MoneyScreenData, span: MoneySpan): MoneyComingView {
  const items = spanOf(data, span).flatMap(({ date, marks }) =>
    marks.map((mark) => ({
      id: `${date}:${mark.kind}`,
      date: dayLabel(date),
      inDays: dayDiff(data.today, date),
      kind: mark.kind,
      name: mark.name,
      amount: formatAmount(mark.amount),
    })),
  );
  return { age: moneyAge(data), items, empty: items.length === 0 };
}

// ---------------------------------------------------------------- ledger

/**
 * A note as one line of text: each run of white space (a line break, a tab,
 * two spaces) made one space, and the ends trimmed. Nothing is cut. A cut made
 * here left a long note whole on no surface, since the pane could only print
 * the cut and a title is out of a finger's reach; the pane's line clamp does
 * the cutting, where the eye needs it, and a screen reader keeps every word.
 */
function wholeNote(note: string): string {
  return note.replace(/\s+/g, " ").trim();
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
      note: wholeNote(line.note),
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

/**
 * Does the planner hold this input's day to a cap at all? Answered by the
 * planner's own code where it has one, and mirrored only where it does not:
 *
 *  - `capRoomHours` (plan/cap.ts:44-56) is the planner's own call and answers
 *    Infinity for "no cap here": `weeklyHourCap` null (cap.ts:50) or the day in
 *    an exempt range (cap.ts:51). It is called, not copied.
 *  - Travel mode lifts the cap entirely (plan/planner.ts:421-424: `room` is
 *    POSITIVE_INFINITY when `mode === "travel"`). There is no exported predicate
 *    for that, so that one condition is mirrored here.
 *
 * A short night or a rough day does not lift it: the planner places no income
 * then (planner.ts:414), but nothing it places can cross the cap either.
 */
function capInForce(input: PlanInput): boolean {
  if (input.mode === "travel") return false;
  return capRoomHours(input.date, input.fixed, input.week, input.rules) !== Infinity;
}

/**
 * What a bar draws for `value` of `max`, from the figures its label prints, so
 * the bar and its sentence agree: the filled part held to 0..1 (a bar is drawn
 * full, never past its end), and the value held to 0..max for a meter, whose
 * value outside its own range is not one a screen reader can say. No maximum
 * draws nothing.
 */
function meterOf(value: number, max: number): MoneyMeter {
  if (!(max > 0)) return { share: 0, valueNow: 0 };
  return {
    share: Math.min(1, Math.max(0, value / max)),
    valueNow: Math.min(max, Math.max(0, value)),
  };
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
          return { hours, done, label: hoursLabel(done, hours), ...meterOf(done, hours) };
        })();

  const limit = rules.weeklyHourCap;
  const cap =
    limit === null || !capInForce(input)
      ? null
      : (() => {
          // The cap is a wall in the planner, so `over` is judged on the hours
          // themselves: 30.1 of 30 is over even though it reads "30 of 30".
          const usedHours = week.capHoursElsewhere + fixedToday + incomeToday;
          const hours = quarterHours(limit);
          const used = quarterHours(usedHours);
          return {
            hours,
            used,
            label: hoursLabel(used, hours),
            over: usedHours > limit,
            ...meterOf(used, hours),
          };
        })();

  return { target, cap, empty: target === null && cap === null };
}
