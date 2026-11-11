// The calendar, from a local snapshot folder: a read only folder of JSON files
// in, one week of CalendarScreenData out. Nothing is written and nothing is
// saved back, which is what the notice on the screen says.
//
// WHICH DAYS THE COPY CAN SPEAK FOR is the question this file exists to answer
// honestly, and it is NOT "which days have an event on them". A folder holds
// whatever week was exported. Outside that the folder knows nothing, and a day
// the screen cannot speak for must read as unknown rather than as a free day:
// drawn as free, something would be planned over the top of a shift that is
// really there. So the range comes from `snapshot.json` when it says, and
// otherwise from the first and last day the events themselves touch, which is
// the widest claim an older folder can honestly make.
//
// WHAT A SNAPSHOT CANNOT KNOW is stated rather than guessed. There is no
// calendar list read in a folder unless somebody put one there, so without
// `calendars.json` each calendar in the events is named after the group it is
// linked to, by the ONE rule that is safe (`groups.google_calendar_id`, scoped
// to the account the snapshot names), and plainly where none is. Nothing in a
// folder says whether the account may write to a calendar, so an unlisted one is
// not writable. This stage of the calendar is read only anyway.
//
// It reads through the same door as the rest of the folder (./files.ts): one
// read, every path built from the folder and a literal name, and no message ever
// carrying a value out of a file.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { fromEngineEvent, type CalEvent } from "@/app/lib/v2/calendar/types";
import { wholeSecond } from "@/app/lib/v2/engine/tick";
import { dayDiff, maybeInstantMs, planningDate, shiftDateKey } from "@/app/lib/v2/plan/day";
import type { DateKey, Instant } from "@/app/lib/v2/types";
import { normalizeHex } from "@/app/lib/v2/view/appearance";
import { calendarScreenData, eventDays } from "@/app/lib/v2/view/calendar";
import type { CalendarScreenData, ScreenCalendar } from "@/app/lib/v2/view/screen-data";

import {
  readCalendarEvents,
  readCalendars,
  readGroupRows,
  readRules,
  readSnapshotMeta,
  type LocalCalendar,
  type LocalCalendarEvent,
  type LocalGroup,
} from "./files";

/** What a calendar no group of this account is linked to is called. */
const PLAIN_CALENDAR = "Calendar";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date column as it stands, or the day an instant falls on in the zone.
 *
 * The twin of `dateKeyOf` in ./snapshot.ts, which reads the same two spellings
 * for the day. Written out rather than imported because that module imports this
 * one, and a cycle between the two halves of the folder reader would buy nothing.
 */
function dayKeyOf(value: string, timeZone: string): DateKey | null {
  if (DATE_KEY.test(value)) return value;
  const ms = maybeInstantMs(value);
  return ms === null ? null : zonedDateKey(ms, timeZone);
}

/**
 * An all day row as the calendar window holds it: DATE KEYS, the end exclusive,
 * exactly as Google gives them.
 *
 * An export can spell an all day row either way and the day's own reader takes
 * both (`dateKeyOf` in ./snapshot.ts). The window takes only date keys, so left
 * as instants an all day notice would show on the day and vanish from the
 * calendar beside it, which is a disagreement nothing on the screen could
 * explain. A row whose start cannot be read at all is handed on untouched and
 * dropped by the window, as it is dropped by the day.
 */
function asDayKeys(row: LocalCalendarEvent, timeZone: string): LocalCalendarEvent {
  if (!row.allDay) return row;
  const from = dayKeyOf(row.start, timeZone);
  if (from === null) return row;
  return {
    ...row,
    start: from,
    // The same fallback the day uses: an unreadable end is one day long.
    end: dayKeyOf(row.end, timeZone) ?? shiftDateKey(from, 1),
  };
}

/**
 * The calendars of an export that does not list any: one per calendar the events
 * mention, in the order they first appear.
 *
 * A calendar whose id is the one a group of THIS ACCOUNT is linked to takes that
 * group's name and colour, which is the name the user chose for it. The groups
 * were already scoped to the snapshot's owner at the door, so another account's
 * group in the same export can never name anything here. Where two of this
 * account's groups point at one calendar the first in the file wins, and an
 * archived group counts like any other: it is still the user's own name for that
 * calendar.
 */
function namedAfterGroups(
  events: readonly LocalCalendarEvent[],
  groups: readonly LocalGroup[],
): ScreenCalendar[] {
  const linked = new Map<string, LocalGroup>();
  for (const group of groups) {
    const id = group.google_calendar_id;
    if (id === null || id.length === 0 || linked.has(id)) continue;
    if (group.name === null || group.name.trim().length === 0) continue;
    linked.set(id, group);
  }

  const calendars: ScreenCalendar[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.calendarId)) continue;
    seen.add(event.calendarId);
    const group = linked.get(event.calendarId);
    calendars.push({
      id: event.calendarId,
      label: group?.name ?? PLAIN_CALENDAR,
      // A GROUP'S COLOUR IS FREE TEXT in the column it comes from, while the
      // colour in `calendars.json` has to be six hex digits. This one ends up in
      // an inline style on the pane, so it goes through the same door: the two
      // short spellings a person writes by hand are normalised, and anything
      // else becomes no colour at all rather than a style the browser drops.
      color: normalizeHex(group?.color) ?? null,
      // Nothing in a folder says so, and this stage is read only.
      writable: false,
    });
  }
  return calendars;
}

/**
 * The days the events themselves touch, from the first to the last, or null when
 * there are none to go on.
 *
 * Null is the honest answer to an empty calendar file with no range: a folder
 * with no events and nothing saying which days it covers says nothing about any
 * day, and every day of the week then reads as unknown rather than as free.
 */
function rangeOfEvents(
  events: readonly CalEvent[],
  timeZone: string,
): { from: DateKey; to: DateKey } | null {
  let from: DateKey | null = null;
  let to: DateKey | null = null;
  for (const event of events) {
    const days = eventDays(event, timeZone);
    if (days === null) continue;
    if (from === null || dayDiff(days[0], from) > 0) from = days[0];
    if (to === null || dayDiff(to, days[1]) > 0) to = days[1];
  }
  return from === null || to === null ? null : { from, to };
}

/**
 * The snapshot's calendar for a week, or null when the folder has no events
 * file. Null is not an empty calendar: the screen says the calendar is not
 * included, and a week of empty columns would read as seven free days.
 *
 * `now` is the caller's clock and is floored to the whole second, as the day's
 * own loader floors it (see `wholeSecond`), so the two halves of the screen
 * agree about when now is.
 *
 * Throws only `LocalSnapshotError`, for a file that is missing or malformed.
 */
export async function loadLocalCalendar(
  dir: string,
  now: Instant,
  weekParam: string | null,
): Promise<CalendarScreenData | null> {
  const rows = await readCalendarEvents(dir);
  if (rows === null) return null;

  const meta = await readSnapshotMeta(dir);
  // The snapshot's zone wins over anything in the rules document, built in the
  // one spelling where the two cannot disagree, exactly as the day is built.
  const { planner } = await readRules(dir, meta.timeZone);
  const [listed, groups] = await Promise.all([readCalendars(dir), readGroupRows(dir, meta.userId)]);

  const zone = planner.timeZone;
  const calendars: ScreenCalendar[] =
    listed === null ? namedAfterGroups(rows, groups) : listed.map(asScreenCalendar);
  // THE FIRST ENTRY FOR AN ID WINS, the same rule the view reads these by: a
  // folder can list one calendar twice, and `new Map` of the pairs would keep
  // the LAST, so the events on it would take their writability from one entry
  // while the calendar beside them took its name and colour from the other.
  const writable = new Map<string, boolean>();
  for (const calendar of calendars) {
    if (!writable.has(calendar.id)) writable.set(calendar.id, calendar.writable);
  }

  const events = rows.map((row) =>
    fromEngineEvent(asDayKeys(row, zone), {
      editable: writable.get(row.calendarId) ?? false,
      // A folder is a copy, not a connection: there is no etag to match and
      // nothing to write back to.
      etag: null,
      recurring: row.recurring,
    }),
  );

  const at = wholeSecond(now);
  return calendarScreenData({
    timeZone: zone,
    now: at,
    rules: planner,
    events,
    calendars,
    range: meta.calendarRange ?? rangeOfEvents(events, zone),
    wanted: planningDate(at, planner),
    weekParam,
  });
}

function asScreenCalendar(calendar: LocalCalendar): ScreenCalendar {
  return {
    id: calendar.id,
    label: calendar.label,
    color: calendar.color,
    writable: calendar.writable,
  };
}
