// Pure capture-text parsing: the three-mode grammar. Exactly three modes —
// bare text = task, `$` = spend log, `?` = copilot handoff. Nothing else
// parses; parser trust is a budget and it is spent on these three.
// (extractTrailingRecurrence is an extractor within task mode — like the
// trailing time — not a fourth mode.)

import type { TaskRecurrence } from "@/app/lib/recurrence";

export type ParsedCapture =
  | { mode: "task"; title: string; time: string | null }
  | {
      mode: "spend";
      amount: number | null;
      description: string;
      categoryId: string | null;
    }
  | { mode: "copilot"; message: string };

export type CategoryOption = { id: string; name: string };

// Suggest (never silently commit) a category whose name appears in — or
// shares a word-prefix with — the description.
export function suggestCategory(
  description: string,
  categories: CategoryOption[],
): string | null {
  const haystack = description.toLowerCase();
  if (!haystack) return null;
  const words = haystack.split(/\s+/).filter(Boolean);
  for (const category of categories) {
    const name = category.name.toLowerCase();
    if (!name) continue;
    if (haystack.includes(name)) return category.id;
    if (
      words.some(
        (word) =>
          word.length >= 4 &&
          (name.startsWith(word) || word.startsWith(name)),
      )
    ) {
      return category.id;
    }
  }
  return null;
}

const SPEND_RE = /^\$\s*(\d+(?:[.,]\d{1,2})?)?\s*(.*)$/;

export function parseCapture(
  input: string,
  categories: CategoryOption[] = [],
): ParsedCapture {
  const raw = input.trim();

  if (raw.startsWith("?")) {
    return { mode: "copilot", message: raw.slice(1).trim() };
  }

  if (raw.startsWith("$")) {
    const match = SPEND_RE.exec(raw);
    const amountRaw = match?.[1]?.replace(",", ".");
    const amount = amountRaw ? Number(amountRaw) : null;
    const description = (match?.[2] ?? "").trim();
    return {
      mode: "spend",
      amount: amount !== null && Number.isFinite(amount) && amount > 0 ? amount : null,
      description,
      categoryId: suggestCategory(description, categories),
    };
  }

  const time = extractTrailingTime(raw);
  return {
    mode: "task",
    title: time ? time.title : raw,
    time: time ? time.time : null,
  };
}

export type TrailingTime = {
  title: string; // input with the time phrase removed
  time: string; // "HH:MM" 24h
  matched: string; // the raw phrase that was removed
};

// Trailing forms only — a time in the middle of a title is part of the title:
//   "call landlord 3pm" · "gym at 17:30" · "standup 9:15am" · "lunch 12 pm"
const TRAILING_TIME_RE =
  /(?:^|\s)(?:at\s+)?((?:[01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?)\s*$/i;

export function extractTrailingTime(input: string): TrailingTime | null {
  const match = TRAILING_TIME_RE.exec(input);
  if (!match) return null;

  const [, , minutesRaw, meridiem] = match;
  const hourRaw = match[1].replace(/\s*(am|pm)\s*$/i, "").split(":")[0];
  let hours = Number(hourRaw);
  const minutes = minutesRaw ? Number(minutesRaw) : 0;

  // A bare number with no colon and no am/pm is too ambiguous to be a time
  // ("buy 2" is a quantity, not 2 o'clock).
  if (!minutesRaw && !meridiem) return null;
  if (!Number.isFinite(hours) || hours > 23) return null;

  if (meridiem) {
    const isPm = meridiem.toLowerCase() === "pm";
    if (hours === 12) hours = isPm ? 12 : 0;
    else if (isPm) hours += 12;
    if (hours > 23) return null;
  }

  const title = input.slice(0, match.index).trim();
  if (!title) return null;

  return {
    title,
    time: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    matched: input.slice(match.index).trim(),
  };
}

export type TrailingRecurrence = {
  title: string; // input with the recurrence phrase removed
  rule: TaskRecurrence;
  matched: string; // the raw phrase that was removed
};

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// Trailing forms only — conservative on purpose, like the trailing time:
//   "lunch daily" · "gym mon/wed/fri" · "standup weekdays" ·
//   "water plants every 3 days" · "laundry every sunday"
// A single bare weekday ("call mom mon") is too ambiguous and does not match.
const TRAILING_RECURRENCE_RE =
  /(?:^|\s)(daily|everyday|every\s+day|weekdays|every\s+(\d+)\s+days?|every\s+([a-z]+)|((?:sun|mon|tue|wed|thu|fri|sat)(?:\/(?:sun|mon|tue|wed|thu|fri|sat))+))\s*$/i;

export function extractTrailingRecurrence(
  input: string,
): TrailingRecurrence | null {
  const match = TRAILING_RECURRENCE_RE.exec(input);
  if (!match) return null;

  const phrase = match[1].toLowerCase().replace(/\s+/g, " ");
  let rule: TaskRecurrence | null = null;

  const weekly = (weekdays: number[]): TaskRecurrence => ({
    frequency: "weekly",
    weekdays,
    day_of_month: null,
    interval_days: null,
    start_date: null,
  });

  if (phrase === "daily" || phrase === "everyday" || phrase === "every day") {
    rule = {
      frequency: "daily",
      weekdays: null,
      day_of_month: null,
      interval_days: null,
      start_date: null,
    };
  } else if (phrase === "weekdays") {
    rule = weekly([1, 2, 3, 4, 5]);
  } else if (match[2]) {
    const interval = Number(match[2]);
    if (!Number.isFinite(interval) || interval < 1) return null;
    rule =
      interval === 1
        ? {
            frequency: "daily",
            weekdays: null,
            day_of_month: null,
            interval_days: null,
            start_date: null,
          }
        : {
            frequency: "custom",
            weekdays: null,
            day_of_month: null,
            interval_days: interval,
            start_date: null, // the action anchors it to today
          };
  } else if (match[3]) {
    const day = WEEKDAY_NAMES[match[3].toLowerCase()];
    if (day === undefined) return null; // "every morning" is not a schedule
    rule = weekly([day]);
  } else if (match[4]) {
    const days = [
      ...new Set(
        match[4]
          .toLowerCase()
          .split("/")
          .map((d) => WEEKDAY_NAMES[d]),
      ),
    ].sort((a, b) => a - b);
    if (days.some((d) => d === undefined)) return null;
    rule = weekly(days);
  }

  const title = input.slice(0, match.index).trim();
  if (!title || !rule) return null;

  return { title, rule, matched: input.slice(match.index).trim() };
}
