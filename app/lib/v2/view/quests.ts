// The Quests panes as data. One pure function takes what the desk was handed
// and returns exactly what the four panes render (Lanes, Steps, Side quests,
// Done lately), so the components decide nothing and every rule is testable.
//
// THE ONE RULE THIS FILE EXISTS TO HOLD: Quests reads exactly what Today reads.
// It ranks and counts from the very planner input Today plans from, judges every
// date against the instant the planner judges it from, names a task by the one
// identity rule and splits a title by the one split. Nothing here is a second
// opinion: a lane that says "3 open" here says "3 open" on Today, on one input,
// and `__tests__/v2-view-quests.test.ts` builds both views to prove it.
//
// Loaded by the browser. It imports nothing under app/lib/v2/local, nothing from
// next and nothing from node. Ordering is code point order through
// `compareText`, never the locale's, and dates are worded through format.ts,
// because this renders on the server and again in the browser.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import {
  compareText,
  dayDiff,
  maybeInstantMs,
  planReference,
  planningDate,
} from "@/app/lib/v2/plan/day";
import { rankCandidates } from "@/app/lib/v2/plan/rank";
import type { Candidate, DateKey, Instant, LaneKey, PlannerRules } from "@/app/lib/v2/types";
import type { QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import { dayLabel } from "@/app/lib/v2/view/format";
import { TODAY_COPY, identityFor, splitTitle } from "@/app/lib/v2/view/today";

export { laneDueLabel, laneOpenLabel } from "@/app/lib/v2/view/today";

/** A task as the Quests panes show it, open or finished. */
export interface QuestItem {
  id: string;
  /** Split exactly as Today splits a title (`splitTitle`). */
  title: string;
  detail: string | null;
  lane: LaneKey | null;
  /** Resolved exactly as a stop's is on Today (`identityFor`). */
  identity: { label: string; color: string; source: "tag" | "lane" } | null;
  /** "13 November", or null when it has no date. */
  due: string | null;
  /**
   * Where its date stands against the planned day, read from the planner's own
   * reference instant: `soon` is inside the planner's hard window.
   */
  when: "past" | "today" | "soon" | "later" | "none";
  hard: boolean;
  /**
   * Its place in the planner's own order, 1 first, counted over every candidate
   * of the input. Something finished in this session leaves the lists and keeps
   * its number, so the numbers can have gaps: never use one as an index.
   */
  rank: number;
}

export interface QuestLane {
  key: LaneKey;
  label: string;
  color: string;
  /** Equal to Today's lane line for the same input. */
  open: number;
  /** The step the planner ranks first in this lane, or null when the lane is empty. */
  next: QuestItem | null;
  /** The nearest date still ahead, worded as Today words it ("18 April"), or null. */
  due: string | null;
  /** How many of its open steps have a date that has gone by. */
  past: number;
  /** Finished in the lane inside the span, or null when the source has no history for the span. */
  done: number | null;
  /** True when nothing is open and nothing was finished: the lane says nothing at all. */
  quiet: boolean;
}

export interface QuestDoneItem {
  id: string;
  /** The first level of the split title: what the thing was. */
  title: string;
  identity: QuestItem["identity"];
}

export interface QuestsView {
  /** Every lane of the user, in their order, quiet ones included. */
  lanes: QuestLane[];
  /** Every open step of every lane, by rank. */
  steps: QuestItem[];
  /** Everything with no lane, by rank. */
  side: QuestItem[];
  done: {
    span: number;
    /** The days of the span that have something, newest first, items newest first. */
    days: Array<{ date: DateKey; label: string; items: QuestDoneItem[] }>;
    total: number;
    /** Per week over the span, to one decimal. Null when the span is not known. */
    perWeek: number | null;
    /** Whether the source's history reaches back the whole span. */
    known: boolean;
  };
  /** Nothing open anywhere and nothing done. */
  empty: boolean;
}

/** The spans Done lately can show, shortest first. */
export const QUEST_SPANS = [7, 14, 28] as const;
export type QuestSpan = (typeof QUEST_SPANS)[number];

/** How far back a source is asked for its history: the longest span. */
export const QUEST_HISTORY_DAYS: QuestSpan = QUEST_SPANS[QUEST_SPANS.length - 1];

const HOUR_MS = 3_600_000;

// ------------------------------------------------------------------- the words

/**
 * Every word the Quests panes say. The pane titles are the frame's, not these.
 *
 * A lane's count and its next date are Today's own words, taken from
 * TODAY_COPY rather than written again, so the same lane cannot read two ways
 * on one desk.
 */
export const QUESTS_COPY = {
  /** "{count} open", Today's words. */
  laneOpen: TODAY_COPY.laneOpen,
  /** "next {day}", Today's words. */
  laneDue: TODAY_COPY.laneDue,
  /** How many of a lane's steps are past their date. */
  lanePastOne: "1 past its date",
  lanePastMany: "{count} past their date",
  /** The label over a lane's first step. */
  next: "Next",
  /** The mark an item wears for where its date stands. Empty where it says nothing. */
  when: {
    past: "Past its date",
    today: "Today",
    soon: "Soon",
    later: "",
    none: "",
  } satisfies Record<QuestItem["when"], string>,
  /** Beside a date that is a real deadline. */
  hard: "Hard date",
  /** The steps pane's lane filter. */
  filterLabel: "Show steps from",
  filterAll: "All",
  noLanes: "No lanes yet.",
  noSteps: "No open steps in any lane.",
  noSide: "Nothing without a lane.",
  /** How many things were finished in the span. */
  doneTotal: "{count} finished",
  /** The rate, shown only when the source can see the whole span. */
  donePerWeek: "{rate} a week",
  /** A span the source can see and nothing was finished in. */
  doneNone: "Nothing finished in the last {days} days.",
  /**
   * A span the source cannot see. It says what is true and shows no number: a
   * rate over days nobody can see would be invented.
   */
  noHistory: "No record of what was finished over these days, so there is no rate.",
  /** One span option. */
  span: "Last {days} days",
} as const;

export function questPastLabel(count: number): string {
  return count === 1
    ? QUESTS_COPY.lanePastOne
    : QUESTS_COPY.lanePastMany.replace("{count}", String(count));
}

export function questDoneTotalLabel(count: number): string {
  return QUESTS_COPY.doneTotal.replace("{count}", String(count));
}

/** `rate` is already rounded to one decimal, so it prints as "2.5" or "3". */
export function questPerWeekLabel(rate: number): string {
  return QUESTS_COPY.donePerWeek.replace("{rate}", String(rate));
}

export function questDoneNoneLabel(span: QuestSpan): string {
  return QUESTS_COPY.doneNone.replace("{days}", String(span));
}

export function questSpanLabel(span: QuestSpan): string {
  return QUESTS_COPY.span.replace("{days}", String(span));
}

// ------------------------------------------------------------------- the days

/**
 * "15 April": a date key without its weekday, exactly as Today words a lane's
 * next date. Taken off `dayLabel` the way Today takes it, so the month names
 * stay in format.ts.
 */
function dayAndMonth(date: DateKey): string {
  const [, ...rest] = dayLabel(date).split(" ");
  return rest.join(" ");
}

/**
 * The day a finish belongs to: the PLANNING day it fell in, as everywhere else
 * on the desk, or null for an instant that cannot be read.
 *
 * Not the calendar date. With lights out after midnight, something finished at
 * 00:20 was finished on the day still being lived, and a press on Today at that
 * hour lands on the planned day; reading the history's 00:20 as the next date
 * would put two finishes of one night on two different days.
 *
 * Exported because the local loader picks its window of history by this same
 * rule, and two spellings of it is how a row comes to be read and not shown.
 */
export function doneDayOf(doneAt: Instant, rules: PlannerRules): DateKey | null {
  if (maybeInstantMs(doneAt) === null) return null;
  return planningDate(doneAt, rules);
}

/** Is `day` the planned day or one of the `days - 1` days before it? */
export function withinDays(day: DateKey, planned: DateKey, days: number): boolean {
  const back = dayDiff(day, planned);
  return back >= 0 && back < days;
}

// ------------------------------------------------------------------- the view

interface OpenEntry {
  item: QuestItem;
  dueMs: number | null;
}

interface DoneEntry {
  item: QuestDoneItem;
  lane: LaneKey | null;
  day: DateKey;
  /** null for something finished in this session, which has no instant yet. */
  ms: number | null;
}

/**
 * The Quests panes, from what the desk was handed.
 *
 * `doneIds` are the tasks finished in this session (from the day's state). Each
 * leaves the open lists and joins the planned day in Done lately. Nothing is
 * replanned: every other step keeps its place and its number.
 */
export function buildQuestsView(
  data: QuestsScreenData,
  doneIds: ReadonlySet<string>,
  span: QuestSpan,
): QuestsView {
  const { input } = data;
  const rules = input.rules;
  const zone = rules.timeZone;

  // The instant every date is read against: the planner's own, which before
  // wake is later than the clock. Ranking, "past", "soon" and a lane's next
  // date all read this one, as the planner and Today do.
  const reference = planReference(input.now, input.date, rules);
  const referenceMs = reference.ms;
  const windowMs = rules.hardWindowHours * HOUR_MS;

  const identityOf = (candidate: Candidate) =>
    identityFor(candidate.id, candidate.lane, data.tags, data.lanes);

  const whenOf = (dueMs: number | null): QuestItem["when"] => {
    if (dueMs === null) return "none";
    if (dueMs < referenceMs) return "past";
    if (zonedDateKey(dueMs, zone) === input.date) return "today";
    if (dueMs - referenceMs <= windowMs) return "soon";
    return "later";
  };

  // ------------------------------------------------------------- open items
  const ranked = rankCandidates(input.candidates, reference.instant, rules, input.date);
  const open: OpenEntry[] = [];
  ranked.forEach(({ candidate }, index) => {
    if (doneIds.has(candidate.id)) return;
    const dueMs = maybeInstantMs(candidate.due);
    const { title, detail } = splitTitle(candidate.title);
    open.push({
      dueMs,
      item: {
        id: candidate.id,
        title,
        detail,
        lane: candidate.lane,
        identity: identityOf(candidate),
        // The zone is the user's: a deadline at 23:30 local is that day.
        due: dueMs === null ? null : dayAndMonth(zonedDateKey(dueMs, zone)),
        when: whenOf(dueMs),
        hard: candidate.hard,
        rank: index + 1,
      },
    });
  });

  // ------------------------------------------------------------ done lately
  const entries: DoneEntry[] = [];
  const counted = new Set<string>();

  for (const done of data.done) {
    const day = doneDayOf(done.doneAt, rules);
    if (day === null || !withinDays(day, input.date, span) || counted.has(done.id)) continue;
    counted.add(done.id);
    // The one identity rule, fed this task's own group: `data.tags` covers the
    // open candidates only, and a finished task is not one of them.
    const tags = done.tag === null ? {} : { [done.id]: done.tag };
    entries.push({
      lane: done.lane,
      day,
      ms: maybeInstantMs(done.doneAt),
      item: {
        id: done.id,
        title: splitTitle(done.title).title,
        identity: identityFor(done.id, done.lane, tags, data.lanes),
      },
    });
  }

  for (const candidate of input.candidates) {
    if (!doneIds.has(candidate.id) || counted.has(candidate.id)) continue;
    counted.add(candidate.id);
    entries.push({
      lane: candidate.lane,
      day: input.date,
      ms: null,
      item: {
        id: candidate.id,
        title: splitTitle(candidate.title).title,
        identity: identityOf(candidate),
      },
    });
  }

  // Newest day first. Inside a day, this session's finishes first (they came
  // after anything the source recorded), then the newest instant; a tie is the
  // id, in code point order.
  entries.sort((a, b) => {
    const byDay = compareText(b.day, a.day);
    if (byDay !== 0) return byDay;
    if (a.ms === null || b.ms === null) {
      if (a.ms !== b.ms) return a.ms === null ? -1 : 1;
    } else if (a.ms !== b.ms) {
      return b.ms - a.ms;
    }
    return compareText(a.item.id, b.item.id);
  });

  const days: QuestsView["done"]["days"] = [];
  for (const entry of entries) {
    const last = days[days.length - 1];
    if (last !== undefined && last.date === entry.day) last.items.push(entry.item);
    else days.push({ date: entry.day, label: dayLabel(entry.day), items: [entry.item] });
  }

  const known = data.historyDays >= span;
  const total = entries.length;

  // ------------------------------------------------------------------ lanes
  // Today's lane line, read the same way: every open item of the lane counts,
  // and the date is the nearest one still ahead of the reference.
  const lanes: QuestLane[] = data.lanes.map((lane) => {
    const own = open.filter((entry) => entry.item.lane === lane.key);
    let nearestMs: number | null = null;
    let past = 0;
    for (const { dueMs } of own) {
      if (dueMs === null) continue;
      if (dueMs < referenceMs) past += 1;
      else if (nearestMs === null || dueMs < nearestMs) nearestMs = dueMs;
    }
    const finished = entries.filter((entry) => entry.lane === lane.key).length;
    return {
      key: lane.key,
      label: lane.label,
      color: lane.color,
      open: own.length,
      next: own[0]?.item ?? null,
      due: nearestMs === null ? null : dayAndMonth(zonedDateKey(nearestMs, zone)),
      past,
      done: known ? finished : null,
      // From what is there, not from the count: with no history `done` is null,
      // and a lane with something finished in this session still has a voice.
      quiet: own.length === 0 && finished === 0,
    };
  });

  const items = open.map((entry) => entry.item);
  return {
    lanes,
    steps: items.filter((item) => item.lane !== null),
    side: items.filter((item) => item.lane === null),
    done: {
      span,
      days,
      total,
      // total / (span / 7), to one decimal, without dividing by a fraction.
      perWeek: known ? Math.round((total * 70) / span) / 10 : null,
      known,
    },
    empty: open.length === 0 && total === 0,
  };
}
