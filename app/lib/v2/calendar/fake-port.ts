// A calendar in memory, standing in for Google.
//
// It is the ONLY implementation of `CalendarPort` on this branch: the real
// adapter waits for the security release, so nothing here can reach the
// network. It is deliberately strict about the things that go wrong in
// practice rather than in theory - a stale etag, a calendar that may only be
// read, an event someone else deleted, an event that would end before it
// begins - so the engine's own handling of those is exercised before any of it
// is live.
//
// Every id and etag comes from an injected source, so a test can assert the
// exact value instead of matching a pattern. It hands out copies, never its own
// rows, so a caller cannot change what it holds by writing to what it read.
//
// It keeps what it deletes. `restore` has to bring an event back under its own
// id (port.ts says why), which is only possible for a calendar that remembers.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { maybeInstantMs, shiftDateKey } from "@/app/lib/v2/plan/day";
import { canonicalEvents } from "@/app/lib/v2/calendar/ops";
import {
  CalendarConflictError,
  CalendarMissingError,
  CalendarReadOnlyError,
} from "@/app/lib/v2/calendar/port";
import type { CalendarChanges, CalendarPort, CalendarRange } from "@/app/lib/v2/calendar/port";
import type { CalEvent } from "@/app/lib/v2/calendar/types";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface FakeCalendarOptions {
  /**
   * The zone the range's instants are read in, for deciding which days an all
   * day event's keys fall in. REQUIRED, and it must be the zone the range was
   * built in: a week built in Tokyo and read as UTC days is a week shifted by
   * one day, which is a wrong answer rather than a tolerance.
   */
  timeZone: string;
  events?: readonly CalEvent[];
  /** Calendars the account may only read. Every write to one is refused. */
  readOnlyCalendarIds?: readonly string[];
  /** Injected so a test is deterministic. Defaults to a counter. */
  nextId?: () => string;
  nextEtag?: () => string;
}

function ends(event: CalEvent): { startMs: number; endMs: number } | null {
  const startMs = maybeInstantMs(event.start);
  const endMs = maybeInstantMs(event.end);
  return startMs === null || endMs === null ? null : { startMs, endMs };
}

/**
 * An event the calendar would refuse outright. Not one of the three refusals a
 * caller handles: a backwards event is a fault in whatever built it, so it is
 * raised as one and `commit` lets it through.
 *
 * All day events are only refused when the end is strictly BEFORE the start,
 * because an end equal to the start is what the real read produces when Google
 * sends no end at all (utils/google/calendar.ts:117).
 */
function refuseBackwards(event: CalEvent): void {
  const pair = ends(event);
  if (pair === null) return;
  const backwards = event.allDay
    ? pair.endMs < pair.startMs
    : pair.endMs <= pair.startMs;
  if (backwards) {
    throw new Error("an event cannot end before it starts");
  }
}

export class FakeCalendar implements CalendarPort {
  private readonly rows: CalEvent[];
  private readonly deleted: CalEvent[] = [];
  private readonly readOnly: Set<string>;
  private readonly timeZone: string;
  private readonly nextId: () => string;
  private readonly nextEtag: () => string;

  constructor(options: FakeCalendarOptions) {
    this.rows = (options.events ?? []).map((event) => ({ ...event }));
    this.readOnly = new Set(options.readOnlyCalendarIds ?? []);
    this.timeZone = options.timeZone;
    let ids = 0;
    let etags = 0;
    this.nextId = options.nextId ?? (() => `fake-event-${(ids += 1)}`);
    this.nextEtag = options.nextEtag ?? (() => `fake-etag-${(etags += 1)}`);
  }

  async list(range: CalendarRange): Promise<CalEvent[]> {
    const rows = this.rows.filter((row) => overlaps(row, range, this.timeZone));
    return canonicalEvents(rows).map((row) => this.out(row));
  }

  async insert(event: CalEvent): Promise<CalEvent> {
    if (this.readOnly.has(event.calendarId)) throw new CalendarReadOnlyError(event.id);
    refuseBackwards(event);
    const stored: CalEvent = { ...event, id: this.nextId(), etag: this.nextEtag() };
    this.rows.push(stored);
    return this.out(stored);
  }

  /**
   * The event as this calendar still holds it, under its own id. What the
   * caller passes is used to find it and for nothing else, so a local copy
   * that has lost fields cannot overwrite what is here.
   */
  async restore(event: CalEvent): Promise<CalEvent> {
    const live = this.rows.find((row) => row.id === event.id);
    if (live !== undefined) return this.out(live);
    const index = this.deleted.findIndex((row) => row.id === event.id);
    if (index === -1) throw new CalendarMissingError(event.id);
    // Refused BEFORE it leaves the graveyard: taking it out first lost the row
    // on a refusal, so a second attempt reported it as missing instead.
    if (this.readOnly.has(this.deleted[index].calendarId)) {
      throw new CalendarReadOnlyError(event.id);
    }
    const [row] = this.deleted.splice(index, 1);
    row.etag = this.nextEtag();
    this.rows.push(row);
    return this.out(row);
  }

  async patch(id: string, changes: CalendarChanges, expectEtag: string | null): Promise<CalEvent> {
    const row = this.checked(id, expectEtag);
    const next: CalEvent = {
      ...row,
      start: changes.start ?? row.start,
      end: changes.end ?? row.end,
      title: changes.title ?? row.title,
    };
    refuseBackwards(next);
    Object.assign(row, next, { etag: this.nextEtag() });
    return this.out(row);
  }

  async remove(id: string, expectEtag: string | null): Promise<void> {
    const row = this.checked(id, expectEtag);
    this.rows.splice(this.rows.indexOf(row), 1);
    this.deleted.push(row);
  }

  /**
   * What someone else's edit looks like: the stored event changes and gets a
   * new etag, and nothing told the engine. The next conditional write to it is
   * a conflict.
   */
  changeBehindBack(id: string, changes: CalendarChanges): CalEvent {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new CalendarMissingError(id);
    if (changes.start !== undefined) row.start = changes.start;
    if (changes.end !== undefined) row.end = changes.end;
    if (changes.title !== undefined) row.title = changes.title;
    row.etag = this.nextEtag();
    return this.out(row);
  }

  /** Someone else's deletion. The row is kept, so it can still be restored. */
  removeBehindBack(id: string): void {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new CalendarMissingError(id);
    this.rows.splice(this.rows.indexOf(row), 1);
    this.deleted.push(row);
  }

  /** Everything it holds, in the window's own order. For assertions. */
  snapshot(): CalEvent[] {
    return canonicalEvents(this.rows).map((row) => this.out(row));
  }

  /**
   * A copy, with `editable` told the truth about the calendar it is on. It
   * used to hand out the row's own flag, so an event on a read-only calendar
   * read back as editable and the engine let a write start that only the
   * calendar could refuse.
   */
  private out(row: CalEvent): CalEvent {
    return { ...row, editable: row.editable && !this.readOnly.has(row.calendarId) };
  }

  /**
   * The row a write may touch. Missing first, then whether it may be written to
   * at all, then the etag: being told "you cannot edit this" is more use than
   * being told the version is stale on a calendar that would refuse either way.
   */
  private checked(id: string, expectEtag: string | null): CalEvent {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new CalendarMissingError(id);
    if (this.readOnly.has(row.calendarId) || !row.editable) {
      throw new CalendarReadOnlyError(id);
    }
    if (expectEtag !== null && expectEtag !== row.etag) throw new CalendarConflictError(id);
    return row;
  }
}

function overlaps(event: CalEvent, range: CalendarRange, timeZone: string): boolean {
  const minMs = maybeInstantMs(range.timeMin);
  const maxMs = maybeInstantMs(range.timeMax);
  if (minMs === null || maxMs === null || maxMs <= minMs) return false;

  if (event.allDay) {
    const endExclusive =
      event.end > event.start
        ? event.end
        : DATE_KEY.test(event.start)
          ? shiftDateKey(event.start, 1)
          : event.start;
    // The range's own days, read in the zone rather than sliced out of the
    // text: the same week spelled with "Z" and spelled with Tokyo's offset name
    // the same days, and reading the characters would answer differently for
    // the two. Date keys then compare correctly as text, being fixed width.
    //
    // The LAST day the range touches, not the day its end falls on: a range
    // ending at noon still covers that morning, and an all day event starting
    // that day overlaps it. Taking the end's own day dropped it.
    const from = zonedDateKey(minMs, timeZone);
    const last = zonedDateKey(maxMs - 1, timeZone);
    return event.start <= last && endExclusive > from;
  }
  const pair = ends(event);
  if (pair === null) return false;
  return pair.startMs < maxMs && Math.max(pair.endMs, pair.startMs) > minMs;
}
