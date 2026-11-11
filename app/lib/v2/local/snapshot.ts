// The Today screen on a local snapshot of an account's own data: a read only
// folder of JSON files in, one TodayScreenData out. Nothing is written and
// nothing is saved back, which is what the notice on the screen says.
//
// IT IS THE SAME ENGINE, FED FROM A FOLDER. Candidates come from
// `tasksToCandidates` and the day's fixed things from `toFixedEvents`, the two
// functions the live tick uses, so what the owner looks at is his own data
// through the real planner rather than through a second implementation of it.
// The rules of the live read are kept as well: the calendar is narrowed to the
// planning day before the two are merged (an event elsewhere in the week must
// not take over a task's slot today), a task that became one of the day's fixed
// events is not offered again, and the week's capped hours count the union of
// the spans so two records of the same shift count once.
//
// WHAT A SNAPSHOT CANNOT KNOW is stated rather than guessed: there are no
// engine blocks, no answers and no feed runs in a folder, so `existing` is
// empty, the energy question is open and unanswered, `feeds` is empty, and
// `incomeHoursElsewhere` and `gymSessionsDone` are 0.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { energyAsk } from "@/app/lib/v2/asks/builders";
import { openAsk } from "@/app/lib/v2/asks/lifecycle";
import {
  tasksToCandidates,
  toFixedEvents,
  unionHours,
  type EngineCalendarEvent,
  type EngineTaskRow,
} from "@/app/lib/v2/engine/sources";
import { fixedTaskId, wholeSecond } from "@/app/lib/v2/engine/tick";
import { weekStartKey } from "@/app/lib/v2/plan/cap";
import {
  dayBounds,
  dayDiff,
  maybeInstantMs,
  minutesToMs,
  planningDate,
  shiftDateKey,
  type MsInterval,
} from "@/app/lib/v2/plan/day";
import type { EngineUser } from "@/app/lib/v2/store/types";
import type {
  Candidate,
  DateKey,
  FixedEvent,
  Instant,
  PlanInput,
  PlannerRules,
} from "@/app/lib/v2/types";
import { clockLabel, dayLabel } from "@/app/lib/v2/view/format";
import type {
  CalendarScreenData,
  TaskTag,
  TodayScreenData,
} from "@/app/lib/v2/view/screen-data";

import { localCalendarFrom, type FolderSoFar } from "./calendar";

import {
  LocalSnapshotError,
  groupTag,
  isRealDateKey,
  readCalendarEvents,
  readGroupRows,
  readIncomeCalendarIds,
  readRules,
  readSnapshotMeta,
  readTaskRows,
  type LocalGroup,
  type SnapshotMeta,
} from "./files";

export { LocalSnapshotError, SNAPSHOT_FILES } from "./files";

/** How far the `date` parameter may move the day, in either direction. */
const DATE_PARAM_DAYS = 14;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The folder when local mode is allowed, else null. Pure: it reads two
 * variables and touches no disk, so the gate itself is testable.
 *
 * The path has to be absolute, for the same reason the file names are literals:
 * a relative path would be resolved against whatever the working directory of
 * the server happens to be. Both spellings of absolute are taken, because this
 * is written on Windows and deployed on Linux.
 */
export function localSnapshotDir(env: {
  V2_LOCAL_SNAPSHOT?: string;
  VERCEL_ENV?: string;
}): string | null {
  if (env.VERCEL_ENV === "production") return null;
  const dir = (env.V2_LOCAL_SNAPSHOT ?? "").trim();
  if (dir.length === 0) return null;
  const absolute = dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("\\\\");
  return absolute ? dir : null;
}

/**
 * The day to plan: the one `now` falls on, or the asked-for day when it is a
 * real date within a fortnight. Anything else is ignored rather than refused,
 * because the parameter is in a URL and a bad one must not cost the screen.
 */
function plannedDate(now: Instant, rules: PlannerRules, dateParam: string | null): DateKey {
  const today = planningDate(now, rules);
  if (dateParam === null || !isRealDateKey(dateParam)) return today;
  return Math.abs(dayDiff(today, dateParam)) <= DATE_PARAM_DAYS ? dateParam : today;
}

/** A date column as it stands, an instant as the day it falls on in the zone. */
function dateKeyOf(value: string, timeZone: string): DateKey | null {
  if (DATE_ONLY.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? zonedDateKey(ms, timeZone) : null;
}

/**
 * The instants an event covers, read the way `toFixedEvents` reads it: an all
 * day event spans whole local days, a timed one carries its own offset. Null
 * for a pair that cannot be read, which is also how `toFixedEvents` drops it.
 */
function eventSpan(event: EngineCalendarEvent, timeZone: string): MsInterval | null {
  if (event.allDay) {
    const from = dateKeyOf(event.start, timeZone);
    if (from === null) return null;
    const to = dateKeyOf(event.end, timeZone) ?? shiftDateKey(from, 1);
    return {
      startMs: minutesToMs(from, 0, timeZone),
      endMs: minutesToMs(to, 0, timeZone),
    };
  }
  const startMs = maybeInstantMs(event.start);
  const endMs = maybeInstantMs(event.end);
  return startMs === null || endMs === null ? null : { startMs, endMs };
}

function fixedSpan(event: FixedEvent): MsInterval | null {
  const startMs = maybeInstantMs(event.start);
  const endMs = maybeInstantMs(event.end);
  return startMs === null || endMs === null ? null : { startMs, endMs };
}

/**
 * Is this fixed thing on the day, by the rule the live read judges it by?
 *
 * The two halves differ, and the difference matters once a day a night. A
 * CALENDAR event belongs to every day it touches, because that is what the
 * calendar window returns. A TASK's own slot belongs to the one day its START
 * falls on (the engine's `taskOnDay`): a task timed for 23:50 with half an hour
 * on it runs past midnight, and on an overlap rule it would come back the next
 * morning as a stop that has already ended and, worse, be withheld from that
 * day's candidates because something on the day already stood for it.
 */
function onFixedDay(event: FixedEvent, bounds: MsInterval): boolean {
  const span = fixedSpan(event);
  if (span === null) return false;
  if (event.source !== "task") return onDay(span, bounds);
  return span.startMs >= bounds.startMs && span.startMs < bounds.endMs;
}

/**
 * Is any of this on the day? Strictly, at both ends: an all day event ends at
 * the next local midnight, which is exactly where the following day begins, so
 * yesterday's notice is not today's.
 */
function onDay(span: MsInterval | null, bounds: MsInterval): boolean {
  return span !== null && span.startMs < bounds.endMs && span.endMs > bounds.startMs;
}

/** The parts of a span that fall outside one day. */
function outside(span: MsInterval, dayStartMs: number, dayEndMs: number): MsInterval[] {
  const parts: MsInterval[] = [];
  if (span.startMs < dayStartMs) {
    parts.push({ startMs: span.startMs, endMs: Math.min(span.endMs, dayStartMs) });
  }
  if (span.endMs > dayEndMs) {
    parts.push({ startMs: Math.max(span.startMs, dayEndMs), endMs: span.endMs });
  }
  return parts.filter((part) => part.endMs > part.startMs);
}

/**
 * The capped hours already on the OTHER six days of the planning day's week:
 * the timed events on the cap calendars, clipped to Monday to Sunday, minus the
 * planning day's own bounds, counted as a union so two records of one shift
 * count once. All day events are skipped, as the live read skips them: a day
 * long marker is not a day of work.
 *
 * A folder with no calendar reports 0 rather than a full week. The live engine
 * fails closed there, because an unreadable calendar might be hiding a shift;
 * here the absence is a known fact about the snapshot, and the notice says so.
 */
function capHoursElsewhere(
  events: EngineCalendarEvent[],
  capCalendarIds: Set<string>,
  date: DateKey,
  rules: PlannerRules,
): number {
  const zone = rules.timeZone;
  const monday = weekStartKey(date);
  const weekFromMs = minutesToMs(monday, 0, zone);
  const weekToMs = minutesToMs(shiftDateKey(monday, 7), 0, zone);
  const day = dayBounds(date, rules);

  const spans: MsInterval[] = [];
  for (const event of events) {
    if (event.allDay || !capCalendarIds.has(event.calendarId)) continue;
    const span = eventSpan(event, zone);
    if (span === null || span.endMs <= span.startMs) continue;
    const startMs = Math.max(span.startMs, weekFromMs);
    const endMs = Math.min(span.endMs, weekToMs);
    if (endMs <= startMs) continue;
    spans.push(...outside({ startMs, endMs }, day.startMs, day.endMs));
  }
  return unionHours(spans);
}

/**
 * Each candidate's group, as a name and the colour the user chose for it. A
 * task with no group has no tag, and so does one whose group has no name or no
 * colour: the screen derives a readable text colour from this, and it cannot do
 * that with an empty string.
 */
function tagsFor(
  candidates: Candidate[],
  tasks: EngineTaskRow[],
  groups: LocalGroup[],
): Record<string, TaskTag> {
  const byGroup = new Map<string, TaskTag>();
  for (const group of groups) {
    const tag = groupTag(group);
    if (tag !== null) byGroup.set(group.id, tag);
  }
  const groupOfTask = new Map(tasks.map((task) => [task.id, task.group_id]));

  const tags: Record<string, TaskTag> = {};
  for (const candidate of candidates) {
    const groupId = groupOfTask.get(candidate.id) ?? null;
    if (groupId === null) continue;
    const tag = byGroup.get(groupId);
    if (tag !== undefined) tags[candidate.id] = { ...tag };
  }
  return tags;
}

/** What the notice adds when the folder holds no calendar file at all. */
const NO_CALENDAR = "Calendar not included.";

/**
 * One sentence: what this data is, and that nothing is saved. Then, when the
 * calendar is not on the screen, one more saying why: `calendarNote` is either
 * NO_CALENDAR or the message of the file that could not be read, which names the
 * file and never a value out of it (see LocalSnapshotError).
 *
 * Both pages build their notice here, so they cannot come to describe the same
 * folder in two different ways.
 */
function noticeFor(meta: SnapshotMeta, calendarNote: string | null): string {
  const day = dayLabel(zonedDateKey(Date.parse(meta.takenAt), meta.timeZone));
  const when = `${day} ${clockLabel(meta.takenAt, meta.timeZone)}`;
  const notice = `Your data as of ${when}. A local copy: nothing you tap is saved.`;
  return calendarNote === null ? notice : `${notice} ${calendarNote}`;
}

/**
 * The screen's data, from the folder. `now` is the caller's clock and is
 * floored to the whole second here, because sub-second precision is poison
 * downstream (see `wholeSecond`).
 *
 * `weekParam` is the calendar's own `week` parameter. The calendar shows that
 * week when it is one the folder can speak for, and otherwise the week of the
 * PLANNED day, which the `date` parameter may have moved: a calendar showing a
 * different week from the day next to it is worse than no calendar.
 *
 * Every file is read once. The calendar beside the day is built from the same
 * reads, and only `calendars.json` is the calendar's own.
 *
 * Throws only `LocalSnapshotError`, for a file that is missing or malformed.
 * One file is the exception: `calendars.json` is optional and the day never
 * reads it, so a bad one costs the day nothing. The day renders with no
 * calendar and its notice names the file.
 */
export async function loadLocalToday(
  dir: string,
  now: Instant,
  dateParam: string | null,
  weekParam: string | null = null,
): Promise<TodayScreenData> {
  const meta = await readSnapshotMeta(dir);
  // The snapshot's zone wins over anything in the rules document, and the
  // planner's rules are built in the one spelling where the two cannot
  // disagree, so everything below reads the same clock.
  const { document, planner } = await readRules(dir, meta.timeZone);
  const zone = planner.timeZone;

  const [tasks, groups, incomeCalendarIds, calendarRows] = await Promise.all([
    readTaskRows(dir, meta.userId),
    readGroupRows(dir, meta.userId),
    readIncomeCalendarIds(dir, meta.userId),
    readCalendarEvents(dir),
  ]);
  const events = calendarRows ?? [];

  const at = wholeSecond(now);
  const date = plannedDate(at, planner, dateParam);
  const bounds = dayBounds(date, planner);
  const capCalendarIds = new Set([...meta.capCalendarIds, ...incomeCalendarIds]);

  const fixed = toFixedEvents(
    events.filter((event) => onDay(eventSpan(event, zone), bounds)),
    tasks,
    capCalendarIds,
    zone,
  ).filter((event) => onFixedDay(event, bounds));

  // A task that already has a slot today is on the day once, as a fixed event.
  // Left in the candidate list, the planner would book a second block for work
  // that is already placed.
  const scheduled = new Set(
    fixed.map(fixedTaskId).filter((id): id is string => id !== null),
  );
  const user: EngineUser = { userId: meta.userId, timeZone: zone, rules: document };
  const candidates = tasksToCandidates(tasks, user, new Set<string>()).filter(
    (candidate) => !scheduled.has(candidate.id),
  );

  const input: PlanInput = {
    date,
    now: at,
    rules: planner,
    energy: null,
    mode: "normal",
    fixed,
    candidates,
    week: {
      capHoursElsewhere: capHoursElsewhere(events, capCalendarIds, date, planner),
      incomeHoursElsewhere: 0,
      gymSessionsDone: 0,
    },
    existing: [],
  };

  // The real ask, so the three options on the screen are the real ones and
  // answering one replans the day.
  const { ask } = openAsk(
    energyAsk(date, meta.userId, planner, at),
    [],
    () => `energy-${date}`,
  );

  const beside =
    calendarRows === null
      ? { calendar: null, note: NO_CALENDAR }
      : await calendarBeside(
          dir,
          { meta, planner, groups, rows: calendarRows },
          at,
          date,
          weekParam,
        );

  return {
    input,
    lanes: document.lanes.map((lane) => ({
      key: lane.key,
      label: lane.label,
      color: lane.color,
    })),
    feeds: [],
    feedLabels: { ...document.feedLabels },
    openAsks: [ask],
    tags: tagsFor(candidates, tasks, groups),
    notice: noticeFor(meta, beside.note),
    calendar: beside.calendar,
  };
}

/**
 * The week beside the day, from the same reads and the same clock, with the
 * PLANNED day as the day it wants (see `localCalendarFrom`).
 *
 * The one place a bad file does not take the day down: what can fail here is
 * `calendars.json`, which the day never reads. It comes back as the sentence the
 * notice adds instead, which is the error's own message: a literal file name
 * and a fixed phrase. Anything else still throws.
 */
async function calendarBeside(
  dir: string,
  read: FolderSoFar,
  at: Instant,
  date: DateKey,
  weekParam: string | null,
): Promise<{ calendar: CalendarScreenData | null; note: string | null }> {
  try {
    return { calendar: await localCalendarFrom(dir, read, at, date, weekParam), note: null };
  } catch (error) {
    if (error instanceof LocalSnapshotError) return { calendar: null, note: error.message };
    throw error;
  }
}

/** What the Week page shows: the week, and the same notice Today gives. */
export interface LocalWeek {
  /** null when the folder holds no calendar file, which the page says in words. */
  calendar: CalendarScreenData | null;
  notice: string;
}

/**
 * The Week page's data, from the folder: one week of calendar and the notice.
 *
 * The day marked today is the PLANNING date for `now`, the same day the Today
 * screen plans for the same request, so the two pages agree on the column.
 *
 * Unlike Today, a bad calendar file is the page's error: the calendar is all
 * this page has to show. Throws only `LocalSnapshotError`.
 */
export async function loadLocalWeek(
  dir: string,
  now: Instant,
  weekParam: string | null,
): Promise<LocalWeek> {
  const meta = await readSnapshotMeta(dir);
  const rows = await readCalendarEvents(dir);
  if (rows === null) return { calendar: null, notice: noticeFor(meta, NO_CALENDAR) };

  // The snapshot's zone wins over anything in the rules document, built in the
  // one spelling where the two cannot disagree, exactly as the day is built.
  const { planner } = await readRules(dir, meta.timeZone);
  const groups = await readGroupRows(dir, meta.userId);
  const at = wholeSecond(now);
  const calendar = await localCalendarFrom(
    dir,
    { meta, planner, groups, rows },
    at,
    planningDate(at, planner),
    weekParam,
  );
  return { calendar, notice: noticeFor(meta, null) };
}
