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

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { feedLine } from "@/app/lib/v2/channel/messages";
import { compareText } from "@/app/lib/v2/plan/day";
import { clockLabel, dayLabel, minutesLabel, sinceLabel } from "@/app/lib/v2/view/format";
import type { TaskTag } from "@/app/lib/v2/view/screen-data";
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
  /**
   * The instant "past its date" is judged from, which is NOT always `now`.
   *
   * REQUIRED, because the planner judges it from the later of `now` and the
   * start of the planned day's window (`dayWindow`, see plan/planner.ts), and
   * the screen has to agree. At 05:00, before wake, the planner already treats
   * an item due at 06:00 as overdue and ranks it last; the screen, reading
   * `now`, listed that same item under "Did not fit today" while its lane line
   * said "next 10 March". One of the two was lying and neither could tell.
   *
   * The caller computes it (today-client.tsx) rather than this function, because
   * the window comes from the planner's own rules and the view model does not
   * import the planner.
   */
  reference: Instant;
  timeZone: string;
  plan: PlanOutput;
  /** Everything already on the day. Timed events become stops, all day ones do not. */
  fixed: FixedEvent[];
  lanes: Array<{ key: LaneKey; label: string; color: string }>;
  /**
   * Everything the planner was offered, placed or not.
   *
   * REQUIRED, and the one source for three things the plan alone cannot say:
   *
   *  - the per-lane summary, a count of what is waiting in each lane and when
   *    the nearest of it closes (`plan.dropped` holds only what the planner
   *    wanted and could not fit, so a lane whose items never got ranked would
   *    read as an empty lane);
   *  - the items whose date has already gone by (`pastDue`);
   *  - the NAMES in "Did not fit today", which the planner reports as ids and a
   *    reason, never as titles.
   *
   * The last one used to be a separate `titles` map the caller built, and a
   * caller who forgot it got a list that was silently short. Deriving it here
   * from the candidates removes the second source rather than guarding it.
   */
  candidates: Candidate[];
  feeds: FeedStatus[];
  feedLabels: Record<string, string>;
  openAsks: Ask[];
  /**
   * How each task presents itself: the name and colour of the group it lives in.
   *
   * REQUIRED, and required on purpose. A tag is the user's own group, so a
   * screen that quietly fell back to the lane's colour when the caller forgot
   * the map would look right and be wrong, and nothing would say so. An empty
   * map is the honest way to say "this source has no groups".
   */
  tags: Record<string, TaskTag>;
  /** One plain sentence about what this data is, shown once near the top, or null. */
  notice: string | null;
  /** The answer the caller holds. null means nobody has said yet. */
  energy: Energy | null;
}

/**
 * A name in two levels.
 *
 * Real titles are long and keep their detail in a trailing parenthetical, so one
 * of them is a paragraph of display type on the lit card and fifteen wrapped
 * lines in a narrow side column. The split is the user's own punctuation, not a
 * truncation: what the thing IS, and the detail about it. `full` is the
 * original, kept whole so it can go in the element's title attribute and
 * nothing is lost.
 */
export interface Titled {
  title: string;
  detail: string | null;
  full: string;
}

/**
 * The split: the detail is what sits inside the LAST parenthetical, and the
 * title is everything before the " (" that opens it.
 *
 * Found by counting back from the end, not forward from the first " (". Taking
 * the first one was wrong for a title with two brackets side by side:
 * "Fix (urgent) the build (CI)" came out as the title "Fix" with the detail
 * "urgent) the build (CI", which is the wrong name on the lit card and a line of
 * nonsense under it. Counting back finds the bracket that actually opens the
 * final ")", so that title is "Fix (urgent) the build" and that detail is "CI",
 * and a nested pair still belongs to the detail ("A (b (c))" is "A" and
 * "b (c)").
 *
 * Brackets that do not balance are not two levels of anything, so
 * "Talk to A (B (C)" stays one title. So does a bracket that is not at the end,
 * one with no space before it, and either half being empty.
 */
export function splitTitle(raw: string): Titled {
  const full = raw.trim();
  const whole: Titled = { title: full, detail: null, full };
  if (!full.endsWith(")")) return whole;

  let depth = 0;
  for (const character of full) {
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) return whole;
    }
  }
  if (depth !== 0) return whole;

  let open = -1;
  depth = 0;
  for (let index = full.length - 1; index >= 0; index -= 1) {
    const character = full[index];
    if (character === ")") depth += 1;
    else if (character === "(") {
      depth -= 1;
      if (depth === 0) {
        open = index;
        break;
      }
    }
  }
  if (open <= 0 || full[open - 1] !== " ") return whole;

  const title = full.slice(0, open - 1).trim();
  const detail = full.slice(open + 1, -1).trim();
  if (title === "" || detail === "") return whole;
  return { title, detail, full };
}

export interface Stop extends Titled {
  id: string;
  source: "fixed" | "block";
  kind: BlockKind | "fixed";
  /** "HH:MM" in the user's zone. */
  start: string;
  end: string;
  /**
   * What this stop belongs to, in the user's own words and colour: the group the
   * task lives in when it has one, otherwise the lane. null for a fixed event,
   * which belongs to a calendar rather than to anything the planner owns.
   *
   * The colour is raw user data and may be anything at all, including a colour
   * far too dark to read on a dark scheme. Only non-text marks may use it as it
   * is; see `identityTokens` in app/lib/v2/view/appearance.ts.
   *
   * `source` is what decides whether the LABEL is printed. A tag is a name the
   * user gave this very task, so it is worth a quiet line under the title; a
   * lane is the planner's own grouping, which the colour on the line already
   * says, so naming it on every stop would be noise on a phone screen.
   */
  identity: { label: string; color: string; source: "tag" | "lane" } | null;
  state: "done" | "skipped" | "past" | "now" | "next" | "later";
  /** "Leave by HH:MM" for a fixed event that carries travel time. */
  leaveBy: string | null;
  /** How long it is and why it is there, in words. May be empty. */
  reason: string;
}

/** One lane, as the side column summarises it. */
export interface LaneLine {
  /** The lane's own key, or "" for the row that counts what has no lane. */
  key: LaneKey;
  label: string;
  /** null for the "No lane" row, which has no colour of its own to wear. */
  color: string | null;
  /** How many of this lane's items are waiting, placed today or not. */
  open: number;
  /**
   * The nearest date still ahead among them, as a day and a month. null when
   * nothing in the lane has one. A date already gone by is NOT reported here:
   * the line reads "next 18 April", and the items whose date has passed have a
   * section of their own (`pastDue`).
   */
  due: string | null;
}

/**
 * One item whose date has already gone by.
 *
 * Some are dead and some are still alive, and nothing on this screen can tell
 * which. So they are listed, with the date they were for, and nothing presses
 * them: deciding them is its own feature. They are kept out of "Did not fit
 * today" so nothing appears twice.
 */
export interface PastDueLine extends Titled {
  id: string;
  /** The group or the lane it belongs to, resolved exactly as a stop's is. */
  identity: { label: string; color: string; source: "tag" | "lane" } | null;
  /** The date it was for, as a day and a month. */
  date: string;
}

export interface TodayView {
  dateLabel: string;
  /** `data.notice`, passed through. Shown once, near the top. */
  notice: string | null;
  allDay: string[];
  stops: Stop[];
  litStopId: string | null;
  energy: { label: string; assumed: boolean; ask: Ask | null };
  notToday: Array<Titled & { reason: string }>;
  /** Items whose date has gone by, most recently overdue first. */
  pastDue: PastDueLine[];
  /** One line per lane that has anything waiting, in the user's lane order. */
  lanes: LaneLine[];
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

/**
 * Why a stop the TICK closed off looks like that. Keys are the tick's own
 * reasons (REASON in app/lib/v2/engine/tick.ts), which is the only explanation
 * a skipped stop has: the planner never writes one, so without these a stop
 * that was struck through said nothing but "Not today" and the user could not
 * tell a day that ended from a question they ignored twice.
 *
 * Written out here rather than imported, so the screen does not pull the engine
 * into its bundle; `__tests__/v2-view-today.test.ts` pins the two lists against
 * each other, so a new tick reason cannot land without copy.
 *
 * Rule 1 at the top of this file still holds for everything else: a reason this
 * map does not name, and that BLOCK_REASON does not name either, goes quiet
 * rather than printing a machine token.
 */
export const SKIPPED_REASON: Record<string, string> = {
  "day ended": "The day ended",
  "slipped twice": "Slipped twice",
  "moved to tomorrow": "Moved to tomorrow",
  dropped: "Dropped",
  "no room later today": "No room later today",
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

/** The rail's destinations, by name, so nothing has to find one by its place in a list. */
const NAV = {
  today: "Today",
  week: "Week",
  quests: "Quests",
  money: "Money",
  desk: "Desk",
} as const;

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
  /** The control that reveals the rest of a long list. `{count}` is the number. */
  showMore: "Show {count} more",
  /** The heading over the items whose date has gone by. */
  pastDueHeading: "Past their date",
  /**
   * The one line under it. It says what is true and promises nothing: there is
   * no control on these rows in this slice, so a sentence inviting the user to
   * say something would point at a tap that does not exist.
   */
  pastDueLine: "These are not planned. They wait for a decision.",
  /** The heading over the per-lane summary. */
  lanesHeading: "Lanes",
  /** The last row of that summary: what belongs to no lane at all. */
  noLane: "No lane",
  /** How many items are waiting in one lane. `{count}` is the number. */
  laneOpen: "{count} open",
  /** When the nearest of them closes. `{day}` is a day and a month. */
  laneDue: "next {day}",
  /** In the order the segmented control shows them: low, ok, good. */
  energyOptions: ["Low", "OK", "Good"],
  feeds: "Feed health",
  // There is no fixed "sample day" line any more: what this data is comes from
  // the source itself, as `notice`, so a real account does not get told it is
  // looking at a sample and the sample still says so.
  navLabel: "Main",
  nav: NAV,
  feedState: {
    alive: "Alive",
    late: "Late",
    failing: "Not answering",
    blind: "Blind",
  } satisfies Record<FeedStatus["state"], string>,
} as const;

/**
 * How many drops are shown before the rest are behind a press. A real account
 * has dozens of open tasks, and a list that long under the day is a wall rather
 * than a statement.
 */
export const NOT_TODAY_VISIBLE = 8;

/** The two copy templates that carry a number, filled. */
export function showMoreLabel(count: number): string {
  return TODAY_COPY.showMore.replace("{count}", String(count));
}

export function laneOpenLabel(count: number): string {
  return TODAY_COPY.laneOpen.replace("{count}", String(count));
}

export function laneDueLabel(day: string): string {
  return TODAY_COPY.laneDue.replace("{day}", day);
}

// --------------------------------------------------------------------- titles

// `plan.dropped` can carry two ids that are NOT candidates: the income block
// and the gym session come from the rules rather than from a task, so they are
// dropped under their own token (plan/planner.ts INCOME_TOKEN and the gym's
// kind). Looking those up in a candidate map finds nothing, and a drop the
// screen cannot name is a drop the user cannot act on, so the names live here.
const PLANNER_OWNED_TITLES: Record<string, string> = {
  income: "Work block",
  gym: "Gym",
};

/**
 * Every candidate by id, plus the two ids the planner drops under its own name.
 * A candidate wins a collision, because a task the user actually wrote beats a
 * default.
 *
 * `buildTodayView` calls this itself on the candidates it is given: an id it
 * still cannot name appears under a generic one, because the user needs to know
 * something was dropped more than they need to know which thing.
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
  const said = `${title} ${TODAY_COPY.acted[action]}.`;
  // Starting something does not move you on: the block you just started is the
  // one still in hand, so a "next" here would name it to itself. The rule lives
  // in this function rather than at the call sites, where it could be missed.
  if (action === "started") return said;
  const tail =
    nextTitle === null ? TODAY_COPY.dayOver : `${TODAY_COPY.next}: ${nextTitle}.`;
  return `${said} ${tail}`;
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

/**
 * "15 April": a date key without its weekday.
 *
 * Taken off `dayLabel` rather than written out again, because the month names
 * live in format.ts for a reason (no Intl long format anywhere on this screen,
 * since Node and the browser punctuate them differently and this screen renders
 * in both). Two copies of the month list is how one of them ends up wrong.
 *
 * Exported so the Quests panes word a date exactly as this screen does.
 */
export function dayAndMonth(date: DateKey): string {
  const [, ...rest] = dayLabel(date).split(" ");
  return rest.join(" ");
}

/**
 * The lane a task is shown under: its own when it is one of the user's lanes,
 * else none.
 *
 * A lane the user does not have cannot be shown, so what claims it belongs to no
 * lane on screen: counted under its own key it appeared on no row at all. Today
 * counts it in "No lane" and the Quests panes list it with the side quests, both
 * through this.
 */
export function shownLane(
  lane: LaneKey | null,
  lanes: ReadonlyArray<{ key: LaneKey }>,
): LaneKey | null {
  if (lane === null) return null;
  return lanes.some((entry) => entry.key === lane) ? lane : null;
}

/**
 * One line per lane that has anything waiting: how much, and when the nearest of
 * it closes. Lanes keep the user's own order and a lane with nothing waiting is
 * left out rather than printed as a zero.
 *
 * `candidates` are the open tasks, a task worked on today included (see
 * `workedTaskIds`). `referenceMs` is the planner's reference instant (see
 * TodayInput.reference), and `timeZone` the user's.
 *
 * EXPORTED SO THERE IS ONE COUNT. The Quests panes show every lane's count and
 * next date too, and they get both by calling this on the same list rather than
 * by counting the same way: two loops that agree today are two loops that can
 * stop agreeing.
 */
export function laneSummary(
  candidates: readonly Candidate[],
  lanes: TodayInput["lanes"],
  referenceMs: number,
  timeZone: string,
): LaneLine[] {
  /** The key the items with no lane at all are counted under. */
  const NO_LANE = "";

  const counts = new Map<LaneKey, { open: number; dueMs: number | null }>();
  for (const candidate of candidates) {
    const key = shownLane(candidate.lane, lanes) ?? NO_LANE;
    const held = counts.get(key) ?? { open: 0, dueMs: null };
    held.open += 1;
    if (candidate.due !== null) {
      const ms = Date.parse(candidate.due);
      // Only dates still ahead: the line says "next", and what has already gone
      // by is reported by `pastDueLines` instead. Ahead of the REFERENCE, which
      // is the planner's own idea of now (see TodayInput.reference).
      const ahead = Number.isFinite(ms) && ms >= referenceMs;
      if (ahead && (held.dueMs === null || ms < held.dueMs)) held.dueMs = ms;
    }
    counts.set(key, held);
  }

  // The zone is the user's, not the process's: a deadline at 23:30 local is that
  // day, and on the UTC process clock it would read as the next one.
  const day = (dueMs: number | null) =>
    dueMs === null ? null : dayAndMonth(zonedDateKey(dueMs, timeZone));

  const lines: LaneLine[] = [];
  for (const lane of lanes) {
    const held = counts.get(lane.key);
    if (held === undefined || held.open === 0) continue;
    lines.push({
      key: lane.key,
      label: lane.label,
      color: lane.color,
      open: held.open,
      due: day(held.dueMs),
    });
  }

  // Last, and only when there is something in it. Half of a real account's open
  // tasks belong to no lane, and before this row they appeared nowhere on the
  // screen at all: not on the line, not in the summary.
  const loose = counts.get(NO_LANE);
  if (loose !== undefined && loose.open > 0) {
    lines.push({
      key: NO_LANE,
      label: TODAY_COPY.noLane,
      color: null,
      open: loose.open,
      due: day(loose.dueMs),
    });
  }
  return lines;
}

/**
 * The items whose date has already gone by, most recently overdue first.
 *
 * An account that has been running a while has open items from days or weeks
 * ago. Some are dead and some are still alive, and neither the planner nor this
 * screen can tell which, so they are collected in one place instead of being
 * buried among fifty rows of what did not fit today.
 *
 * An item that the planner DID place today is left out: it is on the line, and a
 * section that says "these are not planned" must not name it. The tie-break is
 * code point order on the title, never locale order, for the same reason the
 * stops' is: this runs on the server and again in the browser.
 */
function pastDueLines(
  input: TodayInput,
  referenceMs: number,
  identityOf: (candidate: Candidate) => PastDueLine["identity"],
): PastDueLine[] {
  const planned = new Set(
    input.plan.blocks
      .map((block) => block.taskId)
      .filter((taskId): taskId is string => taskId !== null),
  );

  const overdue: Array<{ line: PastDueLine; dueMs: number }> = [];
  for (const candidate of input.candidates) {
    if (candidate.due === null || planned.has(candidate.id)) continue;
    const dueMs = Date.parse(candidate.due);
    if (!Number.isFinite(dueMs) || dueMs >= referenceMs) continue;
    overdue.push({
      dueMs,
      line: {
        id: candidate.id,
        ...splitTitle(candidate.title),
        identity: identityOf(candidate),
        date: dayAndMonth(zonedDateKey(dueMs, input.timeZone)),
      },
    });
  }

  overdue.sort(
    (a, b) => b.dueMs - a.dueMs || compareText(a.line.title, b.line.title),
  );
  return overdue.map((entry) => entry.line);
}

/**
 * The one identity rule, for anything that shows a task: the task's own group,
 * else its lane, else nothing.
 *
 * Exported so every screen that names a task resolves it the same way (the
 * line of the day, the lists, the quests): two copies of this rule would be two
 * colours for one task on one desk.
 *
 * A tag with no label is no identity: it would print an empty line and tint a
 * card with a colour the user cannot name. When two lanes share a key the later
 * one wins, as it always has.
 */
export function identityFor(
  taskId: string | null,
  lane: LaneKey | null,
  tags: Readonly<Record<string, TaskTag>>,
  lanes: ReadonlyArray<{ key: LaneKey; label: string; color: string }>,
): Stop["identity"] {
  if (taskId !== null) {
    const tag = tags[taskId];
    if (tag !== undefined && tag.label.trim() !== "") {
      return { label: tag.label, color: tag.color, source: "tag" };
    }
  }
  if (lane === null) return null;
  let found: Stop["identity"] = null;
  for (const entry of lanes) {
    if (entry.key === lane) found = { label: entry.label, color: entry.color, source: "lane" };
  }
  return found;
}

/**
 * The tasks worked on in the plan being shown: every task with a block in state
 * `done`, whatever the block's kind.
 *
 * WORKED, NOT FINISHED. A done block is a touch ("open it and read it"), a
 * session or fifty minutes of focus on the task, and nothing on this screen can
 * tell one that finished its task from one that did not; the planner itself only
 * treats a done block as having served the task for the day. So a task in this
 * set is still open: it stays in its lane's count and on every list, and the
 * Quests panes mark it as worked on today. Calling it finished would invent a
 * fact.
 */
export function workedTaskIds(plan: Pick<PlanOutput, "blocks">): Set<string> {
  const ids = new Set<string>();
  for (const block of plan.blocks) {
    if (block.state === "done" && block.taskId !== null) ids.add(block.taskId);
  }
  return ids;
}

export function buildTodayView(input: TodayInput): TodayView {
  const { plan, timeZone, now } = input;
  const nowMs = msOf(now);
  // What is lit and what is behind you is the clock. What is PAST ITS DATE is
  // the planner's reference, which before wake is later than the clock.
  const referenceMs = msOf(input.reference);

  const leaveByFixedId = new Map(plan.leaveBy.map((entry) => [entry.fixedId, entry.at]));

  const identityOf = (taskId: string | null, lane: LaneKey | null): Stop["identity"] =>
    identityFor(taskId, lane, input.tags, input.lanes);

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
        ...splitTitle(event.title),
        start: clockLabel(event.start, timeZone),
        end: clockLabel(event.end, timeZone),
        identity: null,
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
        ...splitTitle(KIND_TITLE[block.kind] ?? block.title),
        start: clockLabel(block.start, timeZone),
        end: clockLabel(block.end, timeZone),
        // The group the task lives in wins over the lane: it is the name and the
        // colour the user chose for this very task, where the lane is the
        // planner's own grouping. A task with no group keeps the lane, as before.
        identity: identityOf(block.taskId, block.lane),
        leaveBy: null,
        reason: sentence([
          minutesLabel((endMs - startMs) / 60_000),
          // A skipped stop's reason comes from the tick, not the planner, so it
          // is looked up in its own map first; the planner's reason on the row
          // describes why it was PLANNED, which is no longer the news.
          (block.state === "skipped" ? SKIPPED_REASON[block.reason] : undefined) ??
            KIND_REASON[block.kind] ??
            BLOCK_REASON[block.reason],
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

  const pastDue = pastDueLines(input, referenceMs, (candidate) =>
    identityOf(candidate.id, candidate.lane),
  );
  const overdueIds = new Set(pastDue.map((entry) => entry.id));

  // Nothing is dropped from this list except what the past due section already
  // names, so nothing is listed twice. A name the candidates do not cover
  // becomes a generic one, because "something did not fit and here is why" is
  // the part the user acts on; which thing it was is the detail.
  const titles = droppedTitles(input.candidates);
  const notToday: TodayView["notToday"] = plan.dropped
    .filter((drop) => !overdueIds.has(drop.candidateId))
    .map((drop) => ({
      ...splitTitle(
        titles[drop.candidateId] ??
          PLANNER_OWNED_TITLES[drop.candidateId] ??
          TODAY_COPY.unnamedDrop,
      ),
      reason: DROP_REASON[drop.reason] ?? DROP_REASON_FALLBACK,
    }));

  return {
    dateLabel: dayLabel(input.date),
    notice: input.notice,
    allDay,
    stops,
    litStopId,
    energy: {
      label: plan.energyAssumed ? `${energyWord}, assumed` : energyWord,
      assumed: plan.energyAssumed,
      ask: energyAsk,
    },
    notToday,
    pastDue,
    // Every candidate counts, a task with a done block included: a done block
    // served the task for the day and did not finish it (`workedTaskIds`). The
    // Quests panes call this same function on this same list.
    lanes: laneSummary(input.candidates, input.lanes, referenceMs, input.timeZone),
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
