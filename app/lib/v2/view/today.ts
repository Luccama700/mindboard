// The Today screen as data. One pure function takes a plan and returns exactly
// what the components render, so the components branch on nothing and every
// rule about what is lit, what is past and what is named is testable.
//
// TWO RULES THIS FILE EXISTS TO HOLD:
//
//  1. No machine token ever reaches the screen. The planner writes short codes
//     ("hard-window", "no-room") because they are stable; this file is the only
//     place that turns them into words, and an unknown code goes quiet rather
//     than printing itself.
//  2. Every static string on the screen lives here, in TODAY_COPY or
//     STOP_STATUS_COPY, not inline in a component. That is what makes the copy
//     rules (no em or en dash, no streaks or points) walkable by a test.
//
// Time: every clock comes from the formatters, which read the instant in the
// given zone. The screen never looks at the process clock.

import { feedLine } from "@/app/lib/v2/channel/messages";
import { compareText } from "@/app/lib/v2/plan/day";
import { clockLabel, dayLabel, minutesLabel, sinceLabel } from "@/app/lib/v2/view/format";
import type {
  Ask,
  BlockKind,
  Candidate,
  DateKey,
  Energy,
  FeedStatus,
  FixedEvent,
  Instant,
  LaneKey,
  PlanOutput,
} from "@/app/lib/v2/types";

export interface TodayInput {
  date: DateKey;
  now: Instant;
  timeZone: string;
  plan: PlanOutput;
  /** Everything already on the day. Timed events become stops, all day ones do not. */
  fixed: FixedEvent[];
  lanes: Array<{ key: LaneKey; label: string; color: string }>;
  feeds: FeedStatus[];
  feedLabels: Record<string, string>;
  openAsks: Ask[];
  /** The answer the caller holds. null means nobody has said yet. */
  energy: Energy | null;
  /**
   * Display names for the ids in `plan.dropped`.
   *
   * REQUIRED, and required on purpose. The planner reports a drop as an id and a
   * reason, never a title, so the caller (which holds the candidates) has to
   * supply the names; `droppedTitles` builds the map. Making it optional meant a
   * caller who forgot it got a "Did not fit today" list that was silently short,
   * which is exactly the class of defect AGENTS.md says to remove by making the
   * argument required so the compiler lists the call sites. An id the map does
   * not name still appears, under a generic name: the user needs to know
   * something was dropped more than they need to know which thing.
   */
  titles: Record<string, string>;
}

export interface Stop {
  id: string;
  source: "fixed" | "block";
  kind: BlockKind | "fixed";
  title: string;
  /** "HH:MM" in the user's zone. */
  start: string;
  end: string;
  lane: { label: string; color: string } | null;
  state: "done" | "skipped" | "past" | "now" | "next" | "later";
  /** "Leave by HH:MM" for a fixed event that carries travel time. */
  leaveBy: string | null;
  /** How long it is and why it is there, in words. May be empty. */
  reason: string;
}

export interface TodayView {
  dateLabel: string;
  allDay: string[];
  stops: Stop[];
  litStopId: string | null;
  energy: { label: string; assumed: boolean; ask: Ask | null };
  notToday: Array<{ title: string; reason: string }>;
  feed: { line: string; dots: Array<{ label: string; state: FeedStatus["state"] }> };
  empty: boolean;
}

// ------------------------------------------------------------------- the words

// A touch block is the same thing whatever sent it: a short "open it, read it,
// put it down" block. The planner labels one `early-touch` and one
// `hard-window` depending on which step asked for it, and "Closes soon" on a 25
// minute block does not tell the user what to do with it. The kind wins.
const KIND_REASON: Partial<Record<BlockKind, string>> = {
  touch: "Open it and read it",
};

// The income block carries no task, so its title is a planner default rather
// than anything the user wrote, and the view is free to name it. It has to: the
// same block is named here when it lands and in PLANNER_OWNED_TITLES when it is
// dropped, and the screen cannot call one thing two names.
const KIND_TITLE: Partial<Record<BlockKind, string>> = {
  income: "Work block",
};

/** Why a block is on the day. Keys are planner reasons (plan/planner.ts REASON). */
const BLOCK_REASON: Record<string, string> = {
  "closes-today": "Closes today",
  "hard-window": "Closes soon",
  "early-touch": "Open it and read it",
  "income-target": "Toward this week's income hours",
  "lane-next": "Next step in this lane",
  "side-quest": "Side quest",
  gym: "One of this week's sessions",
  floor: "The one block you keep",
};

/** Why something is not on the day. Keys are planner reasons (DROPPED). */
const DROP_REASON: Record<string, string> = {
  "no-room": "No room today",
  capacity: "Past today's capacity",
  cap: "Would go over your weekly hours",
  "lane-limit": "Already one block in this lane today",
  mode: "Not on a day this short",
};

const DROP_REASON_FALLBACK = "Not today";

const ENERGY_LABEL: Record<Energy, string> = {
  low: "Low",
  ok: "OK",
  good: "Good",
};

/** The one word a stop wears beside its title. Empty where the shape says it. */
export const STOP_STATUS_COPY: Record<Stop["state"], string> = {
  done: "Done",
  skipped: "Not today",
  past: "",
  now: "Now",
  next: "Next",
  later: "",
};

/** Every static string on the Today screen. */
export const TODAY_COPY = {
  empty: "Nothing planned. Add a task and it lands here.",
  dayOver: "Nothing left on the line.",
  energy: "Energy",
  energyGroup: "Energy today",
  allDay: "All day",
  line: "The line of your day",
  /** The name of a drop whose id the titles map does not cover. */
  unnamedDrop: "Another task",
  /** What a press did, for the status line. Keyed by the state it set. */
  acted: {
    started: "started",
    done: "marked done",
    skipped: "moved off today",
  },
  next: "Next",
  youAreHere: "You are here",
  nextStop: "Next stop",
  now: "Now",
  start: "Start",
  done: "Done",
  /** The button on the lit stop. */
  notToday: "Not today",
  /** The heading over the drops. Deliberately NOT "Not today": that is the
      button's words, and a heading that reads like an action invites a press. */
  notTodayHeading: "Did not fit today",
  /** In the order the segmented control shows them: low, ok, good. */
  energyOptions: ["Low", "OK", "Good"],
  feeds: "Feed health",
  sampleNote: "Sample day. Nothing here is connected.",
  navLabel: "Main",
  navItems: ["Today", "Week", "Quests", "Money"],
  feedState: {
    alive: "Alive",
    late: "Late",
    failing: "Not answering",
    blind: "Blind",
  } satisfies Record<FeedStatus["state"], string>,
} as const;

// --------------------------------------------------------------------- titles

// `plan.dropped` can carry two ids that are NOT candidates: the income block
// and the gym session come from the rules rather than from a task, so they are
// dropped under their own token (plan/planner.ts INCOME_TOKEN and the gym's
// kind). Looking those up in a candidate map finds nothing, and a drop the
// screen cannot name is a drop the user cannot act on, so the names live here
// and `buildTodayView` falls back to them whether or not the caller passed a
// titles map.
const PLANNER_OWNED_TITLES: Record<string, string> = {
  income: "Work block",
  gym: "Gym",
};

/**
 * The map `TodayInput.titles` wants: every candidate by id, plus the two ids the
 * planner drops under its own name. A candidate wins a collision, because a task
 * the user actually wrote beats a default.
 */
export function droppedTitles(candidates: Candidate[]): Record<string, string> {
  const out: Record<string, string> = { ...PLANNER_OWNED_TITLES };
  for (const candidate of candidates) out[candidate.id] = candidate.title;
  return out;
}

/**
 * What a press did and what is next, for the screen's one status line. A
 * keyboard or screen reader user gets no other confirmation: the button they
 * pressed is gone the moment the planner replans.
 */
export function actionLine(
  action: keyof typeof TODAY_COPY.acted,
  title: string,
  nextTitle: string | null,
): string {
  const tail =
    nextTitle === null ? TODAY_COPY.dayOver : `${TODAY_COPY.next}: ${nextTitle}.`;
  return `${title} ${TODAY_COPY.acted[action]}. ${tail}`;
}

// ---------------------------------------------------------------------- stops

interface Entry {
  stop: Omit<Stop, "state">;
  startMs: number;
  endMs: number;
  /** Set for a block only. */
  blockState: "planned" | "started" | "done" | "skipped" | null;
}

function msOf(instant: string): number {
  const ms = Date.parse(instant);
  return Number.isFinite(ms) ? ms : 0;
}

function sentence(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(". ");
}

export function buildTodayView(input: TodayInput): TodayView {
  const { plan, timeZone, now } = input;
  const nowMs = msOf(now);

  const laneById = new Map(
    input.lanes.map((lane) => [lane.key, { label: lane.label, color: lane.color }]),
  );
  const leaveByFixedId = new Map(plan.leaveBy.map((entry) => [entry.fixedId, entry.at]));

  const entries: Entry[] = [];

  for (const event of input.fixed) {
    if (event.allDay) continue;
    const startMs = msOf(event.start);
    // A leave by time is advice about a journey you have either taken or
    // missed, so it goes away the moment the thing it was about has started.
    const leaveAt = startMs > nowMs ? leaveByFixedId.get(event.id) : undefined;
    entries.push({
      startMs,
      endMs: msOf(event.end),
      blockState: null,
      stop: {
        id: event.id,
        source: "fixed",
        kind: "fixed",
        title: event.title,
        start: clockLabel(event.start, timeZone),
        end: clockLabel(event.end, timeZone),
        lane: null,
        leaveBy: leaveAt ? `Leave by ${clockLabel(leaveAt, timeZone)}` : null,
        reason: sentence([event.location, event.countsTowardCap ? "Paid work" : null]),
      },
    });
  }

  for (const block of plan.blocks) {
    const startMs = msOf(block.start);
    const endMs = msOf(block.end);
    entries.push({
      startMs,
      endMs,
      blockState: block.state,
      stop: {
        id: block.id,
        source: "block",
        kind: block.kind,
        title: KIND_TITLE[block.kind] ?? block.title,
        start: clockLabel(block.start, timeZone),
        end: clockLabel(block.end, timeZone),
        lane: block.lane === null ? null : (laneById.get(block.lane) ?? null),
        leaveBy: null,
        reason: sentence([
          minutesLabel((endMs - startMs) / 60_000),
          KIND_REASON[block.kind] ?? BLOCK_REASON[block.reason],
        ]),
      },
    });
  }

  // Start order, then the settled rows, then the id.
  //
  // The settled rule matters because a skipped block's minutes go back to the
  // planner, so the very next plan can place something over them: two rows then
  // share a start, and the struck-through leftover has to sit ABOVE the live one
  // rather than below the lit card as if it came after it.
  //
  // The id tie-break is code point order, never locale order: this runs on the
  // server and again in the browser, whose Intl collations differ, so
  // localeCompare could order two stops that start at the same minute
  // differently in the two renders. That is a hydration mismatch, not a detail.
  const settledRank = (entry: Entry) =>
    entry.blockState === "done" || entry.blockState === "skipped" ? 0 : 1;
  entries.sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    const bySettled = settledRank(a) - settledRank(b);
    if (bySettled !== 0) return bySettled;
    return compareText(a.stop.id, b.stop.id);
  });

  // Behaviour 2. One stop is lit: the one in hand. A block the user started is
  // that stop whatever the clock says, because the clock cannot resolve it for
  // them; otherwise it is the first thing that has not ended yet. A done or
  // skipped block is finished with, so it is never lit, and a day whose every
  // stop is behind it lights nothing.
  const settled = (entry: Entry) =>
    entry.blockState === "done" || entry.blockState === "skipped";
  const open = entries.filter(
    (entry) => !settled(entry) && (entry.blockState === "started" || entry.endMs > nowMs),
  );
  const lit = open.find((entry) => entry.blockState === "started") ?? open[0] ?? null;
  const litStopId = lit === null ? null : lit.stop.id;

  const stops: Stop[] = entries.map((entry) => {
    let state: Stop["state"];
    if (entry.blockState === "done") state = "done";
    else if (entry.blockState === "skipped") state = "skipped";
    else if (entry.stop.id === litStopId) {
      const running =
        entry.blockState === "started" ||
        (entry.startMs <= nowMs && nowMs < entry.endMs);
      state = running ? "now" : "next";
    } else if (entry.endMs <= nowMs) state = "past";
    else state = "later";
    return { ...entry.stop, state };
  });

  const allDay = input.fixed
    .filter((event) => event.allDay)
    .sort((a, b) => msOf(a.start) - msOf(b.start) || compareText(a.title, b.title))
    .map((event) => event.title);

  // The word follows the answer the caller holds; the suffix follows the plan,
  // which is what actually shaped the day.
  const energyWord = ENERGY_LABEL[input.energy ?? plan.energyUsed];
  const energyAsk =
    input.openAsks.find((ask) => ask.kind === "energy" && ask.status === "open") ?? null;

  // Nothing is ever dropped from this list. A name the caller did not supply
  // becomes a generic one, because "something did not fit and here is why" is
  // the part the user acts on; which thing it was is the detail.
  const notToday: TodayView["notToday"] = plan.dropped.map((drop) => ({
    title:
      input.titles[drop.candidateId] ??
      PLANNER_OWNED_TITLES[drop.candidateId] ??
      TODAY_COPY.unnamedDrop,
    reason: DROP_REASON[drop.reason] ?? DROP_REASON_FALLBACK,
  }));

  return {
    dateLabel: dayLabel(input.date),
    allDay,
    stops,
    litStopId,
    energy: {
      label: plan.energyAssumed ? `${energyWord}, assumed` : energyWord,
      assumed: plan.energyAssumed,
      ask: energyAsk,
    },
    notToday,
    feed: {
      line: feedLine(input.feeds, input.feedLabels, (at) =>
        sinceLabel(at, now, timeZone),
      ),
      dots: input.feeds.map((status) => ({
        label: input.feedLabels[status.feed] ?? status.feed,
        state: status.state,
      })),
    },
    empty: stops.length === 0 && allDay.length === 0,
  };
}
