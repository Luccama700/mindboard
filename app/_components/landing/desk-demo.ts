// The landing's working miniature: one capture line feeding four panes. All of
// it is pure, so it is unit-tested (__tests__/landing-desk.test.ts) and the
// component is only the drawing.
//
// The grammar is not a copy. It is the Dock's own parser (app/lib/capture/
// parse.ts): bare text is a task, `$` logs a spend, `?` asks the copilot, and a
// task's trailing time, repeat and estimate are lifted off the end. What a
// visitor types here is read exactly as the app would read it; it is just kept
// in memory instead of a database.

import {
  extractTrailingEstimate,
  extractTrailingRecurrence,
  extractTrailingTime,
  parseCapture,
} from "@/app/lib/capture/parse";

export type Lane = "today" | "money" | "shelf" | "copilot";

export const LANES: Lane[] = ["today", "money", "shelf", "copilot"];

export type DeskTask = {
  id: number;
  title: string;
  /** The life lane the task is filed under. Captures land in the inbox. */
  group: string;
  meta: string;
  done: boolean;
  /** Filed through the dock in this visit (drawn with the landing flash). */
  fresh: boolean;
};

export type DeskSpend = { id: number; amount: number; label: string };

export type DeskAsk = { id: number; question: string; answer: string };

export type Receipt = {
  ok: boolean;
  lane: Lane;
  /** One line, e.g. "task · today 17:00" or a hint when nothing was filed. */
  text: string;
};

export type DeskState = {
  seq: number;
  balance: number;
  tasks: DeskTask[];
  spends: DeskSpend[];
  ask: DeskAsk | null;
  last: Receipt | null;
};

export const START_BALANCE = 1240.5;

/** The longest line the demo accepts; the real dock has no such cap. */
export const MAX_CAPTURE = 64;

/** What the page types by itself until the visitor takes over. */
export const EXAMPLES = [
  "buy milk 5pm",
  "$4.50 coffee",
  "? what should i do tonight",
] as const;

/** Tappable suggestions under the dock: one per thing the grammar reads. */
export const SUGGESTIONS = [
  "buy milk 5pm",
  "$4.50 coffee",
  "gym mon/wed/fri",
  "read chapter 4 ~45m",
  "? what should i do tonight",
] as const;

export function initialDesk(): DeskState {
  return {
    seq: 3,
    balance: START_BALANCE,
    tasks: [
      { id: 1, title: "call the landlord", group: "home", meta: "today", done: false, fresh: false },
      { id: 2, title: "stats lecture", group: "uni", meta: "14:00", done: false, fresh: false },
      { id: 3, title: "outline the essay", group: "uni", meta: "fri", done: false, fresh: false },
    ],
    spends: [],
    ask: null,
    last: null,
  };
}

export function money(value: number): string {
  const abs = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? "−" : ""}$${abs}`;
}

// ---- reading a line -------------------------------------------------------

export type Reading = {
  lane: Lane;
  /** The prompt glyph the dock shows for this mode. */
  glyph: "›" | "$" | "?";
  /** What the line was understood as, in the order the dock shows its chips. */
  chips: string[];
  title: string;
  amount: number | null;
};

/** How the dock understands a line, before anything is filed. */
export function readCapture(input: string): Reading {
  const parsed = parseCapture(input);

  if (parsed.mode === "copilot") {
    return {
      lane: "copilot",
      glyph: "?",
      chips: ["ask the copilot"],
      title: parsed.message,
      amount: null,
    };
  }

  if (parsed.mode === "spend") {
    const chips = ["spend"];
    if (parsed.amount !== null) chips.push(money(parsed.amount));
    return {
      lane: "money",
      glyph: "$",
      chips,
      title: parsed.description,
      amount: parsed.amount,
    };
  }

  // Task mode. Same order as the dock: the repeat comes off the end first,
  // then a time (which may sit before the repeat), then the estimate.
  let title = parsed.title;
  let time = parsed.time;
  const chips = ["task"];

  const repeat = extractTrailingRecurrence(title);
  if (repeat) {
    title = repeat.title;
    if (time === null) {
      const inner = extractTrailingTime(title);
      if (inner) {
        title = inner.title;
        time = inner.time;
      }
    }
  }

  const estimate = extractTrailingEstimate(title);
  if (estimate) title = estimate.title;

  chips.push(repeat ? `↻ ${repeat.matched}` : "today");
  if (time) chips.push(time);
  if (estimate) chips.push(estimate.matched);

  return { lane: "today", glyph: "›", chips, title, amount: null };
}

// ---- filing it ------------------------------------------------------------

function refuse(state: DeskState, lane: Lane, text: string): DeskState {
  return { ...state, last: { ok: false, lane, text } };
}

/** File one line. Never throws; a line it cannot file comes back as a hint. */
export function fileCapture(state: DeskState, input: string): DeskState {
  const raw = input.trim().slice(0, MAX_CAPTURE);
  if (!raw) return state;

  const reading = readCapture(raw);
  const id = state.seq + 1;

  if (reading.lane === "copilot") {
    if (!reading.title) {
      return refuse(state, "copilot", "ask something after the ?");
    }
    return {
      ...state,
      seq: id,
      ask: { id, question: reading.title, answer: copilotAnswer(state) },
      last: { ok: true, lane: "copilot", text: "asked the copilot" },
    };
  }

  if (reading.lane === "money") {
    if (reading.amount === null) {
      return refuse(state, "money", "a spend needs an amount: $4.50 coffee");
    }
    const label = reading.title || "spend";
    return {
      ...state,
      seq: id,
      balance: Math.round((state.balance - reading.amount) * 100) / 100,
      spends: [{ id, amount: reading.amount, label }, ...state.spends].slice(0, 4),
      last: {
        ok: true,
        lane: "money",
        text: `spend · ${money(-reading.amount)} ${label}`,
      },
    };
  }

  if (!reading.title) return state;
  const meta = reading.chips.slice(1).join(" ");
  return {
    ...state,
    seq: id,
    tasks: [
      { id, title: reading.title, group: "inbox", meta, done: false, fresh: true },
      ...state.tasks,
    ].slice(0, 8),
    last: { ok: true, lane: "today", text: `task · ${meta}` },
  };
}

export function toggleTask(state: DeskState, id: number): DeskState {
  return {
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === id ? { ...task, done: !task.done } : task,
    ),
  };
}

// ---- the forecast ---------------------------------------------------------

// A fortnight from a Tuesday: a little spent every day, rent on Friday, payday
// the Friday after. The same shape the app's cashflow forecast draws, with the
// numbers small enough to follow by eye.
const DAYS = 14;
const DAILY = 22;
const RENT = { day: 3, amount: 900 };
const PAYDAY = { day: 10, amount: 2100 };

export type Forecast = {
  /** End-of-day balance for each of the fourteen days. */
  series: number[];
  /** The lowest the balance gets before payday lands. */
  low: number;
  survives: boolean;
};

export function forecast(balance: number): Forecast {
  const series: number[] = [];
  let running = balance;
  for (let day = 0; day < DAYS; day++) {
    if (day > 0) running -= DAILY;
    if (day === RENT.day) running -= RENT.amount;
    if (day === PAYDAY.day) running += PAYDAY.amount;
    series.push(Math.round(running * 100) / 100);
  }
  const low = Math.min(...series.slice(0, PAYDAY.day));
  return { series, low, survives: low >= 0 };
}

export const FORECAST_MARKS = { rent: RENT.day, payday: PAYDAY.day };

/** The forecast as an SVG polyline, plus where zero sits when it is in view. */
export function sparkline(
  series: number[],
  width: number,
  height: number,
  pad = 6,
): { points: string; zeroY: number | null; xs: number[]; ys: number[] } {
  // Zero is always inside the box, so the line is read against it and the
  // zero rule never lands outside the drawing.
  const min = Math.min(0, ...series);
  const max = Math.max(0, ...series, min + 1);
  const span = max - min;
  const xs = series.map((_, i) => (i / (series.length - 1)) * width);
  const yOf = (value: number) =>
    height - pad - ((value - min) / span) * (height - pad * 2);
  const ys = series.map(yOf);
  const points = series
    .map((_, i) => `${xs[i].toFixed(1)},${ys[i].toFixed(1)}`)
    .join(" ");
  return { points, zeroY: min < 0 ? yOf(0) : null, xs, ys };
}

// ---- the copilot ----------------------------------------------------------

/** One short answer, read off the board as it stands. */
export function copilotAnswer(state: DeskState): string {
  const open = state.tasks.filter((task) => !task.done);
  const { low, survives } = forecast(state.balance);

  // What was already waiting comes before what was just typed in.
  const first = open.find((task) => !task.fresh) ?? open[0];
  const day =
    open.length === 0
      ? "nothing open today. take the evening."
      : open.length === 1
        ? `one thing left: ${first.title}.`
        : `${open.length} open. start with ${first.title}; the rest can wait.`;

  const cash = survives
    ? "money holds through rent."
    : `careful: you are ${money(-low)} short before payday.`;

  return `${day} ${cash} and get milk by thursday.`;
}
