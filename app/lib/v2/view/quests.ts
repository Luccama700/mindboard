// The Quests panes as data. One pure function takes what the desk was handed
// and returns exactly what the four panes render (Lanes, Steps, Side quests,
// Done lately), so the components decide nothing and every rule is testable.
//
// THE ONE RULE THIS FILE EXISTS TO HOLD: Quests reads exactly what Today reads.
// It orders by the planner's own ordering function on the very planner input
// Today plans from, judges every date against the instant the planner judges it
// from, and gets each lane's count and next date by CALLING Today's lane
// summary on the same list of open candidates. A task is named by the one
// identity rule and its title split by the one split. Nothing here is a second
// opinion: `__tests__/v2-view-quests.test.ts` builds both views on one input,
// a press on Today included, to prove it.
//
// TWO DAY RULES, ON PURPOSE. A due date is read on its CALENDAR day in the
// user's zone (the planner's "closes today" and Today's labels read it so). A
// finish is read on its PLANNING day (`doneDayOf`), the day being lived, as a
// press on Today is. They differ only with lights out after midnight; each site
// below says which it uses.
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
import {
  TODAY_COPY,
  dayAndMonth,
  identityFor,
  laneSummary,
  shownLane,
  splitTitle,
} from "@/app/lib/v2/view/today";

export { laneDueLabel, laneOpenLabel } from "@/app/lib/v2/view/today";

/** A task as the Quests panes show it, open or finished. */
export interface QuestItem {
  id: string;
  /** Split exactly as Today splits a title (`splitTitle`). */
  title: string;
  detail: string | null;
  /**
   * One of the user's lanes, or null. A candidate whose lane is not among the
   * user's lanes is null here and a side quest, as Today counts it under "No
   * lane": a lane nobody can see cannot hold it.
   */
  lane: LaneKey | null;
  /** Resolved exactly as a stop's is on Today (`identityFor`). */
  identity: { label: string; color: string; source: "tag" | "lane" } | null;
  /** "13 November", or null when it has no date. Its calendar day in the user's zone. */
  due: string | null;
  /**
   * Where its date stands against the planned day, read from the planner's own
   * reference instant: `soon` is inside the planner's hard window.
   */
  when: "past" | "today" | "soon" | "later" | "none";
  hard: boolean;
  /**
   * Its place in the list Quests shows, 1 first: the open candidates once this
   * session's finished ones are removed, in the planner's ordering function
   * (`rankCandidates`). Not the planner's own index, which also leaves out a task
   * with a skipped block and counts the finished ones.
   */
  rank: number;
}

export interface QuestLane {
  key: LaneKey;
  label: string;
  color: string;
  /** Today's lane line for the same list, by calling it (`laneSummary`). */
  open: number;
  /** The step the planner orders first in this lane, or null when the lane is empty. */
  next: QuestItem | null;
  /** The nearest date still ahead, Today's lane line's own ("18 April"), or null. */
  due: string | null;
  /** How many of its open steps have a date that has gone by. */
  past: number;
  /**
   * Finished in the lane inside the span. Null unless the history covers the
   * whole span (`done.known`), and null for a quiet lane always: a quiet lane says
   * nothing, not even zero.
   */
  done: number | null;
  /** True when nothing is open and nothing was finished in the span: the lane says nothing. */
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
  /** Every open step of the user's lanes, in the list's order. */
  steps: QuestItem[];
  /** Everything with no lane, in the list's order. */
  side: QuestItem[];
  done: {
    span: number;
    /** The days of the span that have something, newest first, items newest first. */
    days: Array<{ date: DateKey; label: string; items: QuestDoneItem[] }>;
    total: number;
    /**
     * Per week over the span, to one decimal. Null when the span is not known OR
     * nothing was finished in it: zero is never a rate here.
     */
    perWeek: number | null;
    /** Whether the history covers the whole span: it has an end and reaches back `span` days. */
    known: boolean;
    /**
     * The day "lately" ends on, worded ("Sunday 12 April"), when that is BEFORE
     * the planned day because the history stops there. Null when lately ends on
     * the planned day.
     */
    through: string | null;
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
  /** The rate, shown only when the history covers the span and something was finished. */
  donePerWeek: "{rate} a week",
  /** A span the history covers and nothing was finished in. There is no rate of zero. */
  doneNone: "Nothing finished in this span.",
  /**
   * The source keeps no history at all (`historyThrough` is null). It says what is
   * true and shows no number: a rate over days nobody can see would be invented.
   */
  noHistory: "This copy keeps no history of finished tasks.",
  /** The history does not reach back the whole span. No number either. */
  shortHistory: "The history does not reach back this far, so there is no rate.",
  /** When lately ends before the planned day. `{day}` is `done.through`. */
  through: "Up to {day}",
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

export function questThroughLabel(day: string): string {
  return QUESTS_COPY.through.replace("{day}", day);
}

export function questSpanLabel(span: QuestSpan): string {
  return QUESTS_COPY.span.replace("{days}", String(span));
}

// ------------------------------------------------------------------- the days

/**
 * The day a finish belongs to: its PLANNING day, or null for an instant that
 * cannot be read.
 *
 * Not the calendar date, unlike a due date (see `whenOf` below). With lights out
 * after midnight, something finished at 00:20 was finished on the day still
 * being lived, and a press on Today at that hour lands on the planned day;
 * reading the history's 00:20 as the next date would put two finishes of one
 * night on two different days. A due date at 00:50 is a different question
 * (when does it close), and the planner answers that one on the calendar.
 *
 * Exported because the local loader picks its window of history, and the day a
 * copy was taken, by this same rule.
 */
export function doneDayOf(doneAt: Instant, rules: PlannerRules): DateKey | null {
  if (maybeInstantMs(doneAt) === null) return null;
  return planningDate(doneAt, rules);
}

/** Is `day` the day `end` or one of the `days - 1` days before it? */
export function withinDays(day: DateKey, end: DateKey, days: number): boolean {
  const back = dayDiff(day, end);
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
 * `doneIds` are the tasks finished in this session (`doneTaskIds` of the plan on
 * screen). Each leaves the open lists, and joins the planned day in Done lately
 * when lately reaches the planned day. Nothing is replanned: the rest keep their
 * order.
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
  // wake is later than the clock. Ordering, "past", "soon" and a lane's next
  // date all read this one, as the planner and Today do.
  const reference = planReference(input.now, input.date, rules);
  const referenceMs = reference.ms;
  const windowMs = rules.hardWindowHours * HOUR_MS;

  // Today's rule: a lane the user does not have is no lane on screen.
  const laneOf = (candidate: Candidate): LaneKey | null => shownLane(candidate.lane, data.lanes);

  const identityOf = (candidate: Candidate) =>
    identityFor(candidate.id, laneOf(candidate), data.tags, data.lanes);

  // A due date is read on its CALENDAR day in the user's zone, which is how the
  // planner decides "closes today" (plan/rank.ts) and how Today words a date. Not
  // `doneDayOf`'s planning day: see the note at the top of this file.
  const whenOf = (dueMs: number | null): QuestItem["when"] => {
    if (dueMs === null) return "none";
    if (dueMs < referenceMs) return "past";
    if (zonedDateKey(dueMs, zone) === input.date) return "today";
    if (dueMs - referenceMs <= windowMs) return "soon";
    return "later";
  };

  // ------------------------------------------------------------- open items
  // The one list both views count: the candidates minus this session's finished.
  const open = input.candidates.filter((candidate) => !doneIds.has(candidate.id));

  const entries: OpenEntry[] = rankCandidates(open, reference.instant, rules, input.date).map(
    ({ candidate }, index) => {
      const dueMs = maybeInstantMs(candidate.due);
      const { title, detail } = splitTitle(candidate.title);
      return {
        dueMs,
        item: {
          id: candidate.id,
          title,
          detail,
          lane: laneOf(candidate),
          identity: identityOf(candidate),
          // Calendar day, as `whenOf` reads it.
          due: dueMs === null ? null : dayAndMonth(zonedDateKey(dueMs, zone)),
          when: whenOf(dueMs),
          hard: candidate.hard,
          rank: index + 1,
        },
      };
    },
  );

  // ------------------------------------------------------------ done lately
  // Lately is the `span` days ending on `end`: the planned day, or the last day
  // the history can speak for when that is earlier. A copy three days old shows
  // the week before it was taken and says so, rather than counting three days
  // nobody can see as three days in which nothing was finished.
  const historyEnd = data.historyThrough;
  const end =
    historyEnd !== null && compareText(historyEnd, input.date) < 0 ? historyEnd : input.date;
  const known = historyEnd !== null && data.historyDays >= span;

  const finished: DoneEntry[] = [];
  const counted = new Set<string>();

  for (const done of data.done) {
    // Planning day, by `doneDayOf`.
    const day = doneDayOf(done.doneAt, rules);
    if (day === null || !withinDays(day, end, span) || counted.has(done.id)) continue;
    counted.add(done.id);
    // The one identity rule, fed this task's own group: `data.tags` covers the
    // open candidates only, and a finished task is not one of them.
    const tags = done.tag === null ? {} : { [done.id]: done.tag };
    finished.push({
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

  // This session's finishes belong to the planned day, so they are part of
  // lately only when lately reaches it.
  if (withinDays(input.date, end, span)) {
    for (const candidate of input.candidates) {
      if (!doneIds.has(candidate.id) || counted.has(candidate.id)) continue;
      counted.add(candidate.id);
      finished.push({
        lane: laneOf(candidate),
        day: input.date,
        ms: null,
        item: {
          id: candidate.id,
          title: splitTitle(candidate.title).title,
          identity: identityOf(candidate),
        },
      });
    }
  }

  // Newest day first. Inside a day, this session's finishes first (they came
  // after anything the source recorded), then the newest instant; a tie is the
  // id, in code point order.
  finished.sort((a, b) => {
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
  for (const entry of finished) {
    const last = days[days.length - 1];
    if (last !== undefined && last.date === entry.day) last.items.push(entry.item);
    else days.push({ date: entry.day, label: dayLabel(entry.day), items: [entry.item] });
  }
  const total = finished.length;

  // ------------------------------------------------------------------ lanes
  // Each lane's count and next date are Today's lane line, called on the same
  // list Today counts. The No lane row (no colour) is the side quests.
  const lines = laneSummary(open, data.lanes, referenceMs, zone);

  const lanes: QuestLane[] = data.lanes.map((lane) => {
    const line = lines.find((entry) => entry.color !== null && entry.key === lane.key);
    const own = entries.filter((entry) => entry.item.lane === lane.key);
    const past = own.filter((entry) => entry.dueMs !== null && entry.dueMs < referenceMs).length;
    const finishedHere = finished.filter((entry) => entry.lane === lane.key).length;
    const openHere = line?.open ?? 0;
    const quiet = openHere === 0 && finishedHere === 0;
    return {
      key: lane.key,
      label: lane.label,
      color: lane.color,
      open: openHere,
      next: own[0]?.item ?? null,
      due: line?.due ?? null,
      past,
      done: known && !quiet ? finishedHere : null,
      quiet,
    };
  });

  const items = entries.map((entry) => entry.item);
  return {
    lanes,
    steps: items.filter((item) => item.lane !== null),
    side: items.filter((item) => item.lane === null),
    done: {
      span,
      days,
      total,
      // total / (span / 7), to one decimal, without dividing by a fraction.
      perWeek: known && total > 0 ? Math.round((total * 70) / span) / 10 : null,
      known,
      through: compareText(end, input.date) < 0 ? dayLabel(end) : null,
    },
    empty: items.length === 0 && total === 0,
  };
}
