// The one way out of this folder.
//
// Everything else here is pure, and this is the seam the real Google adapter
// will sit behind after the security release. Nothing on this branch
// implements it except the fake (fake-port.ts), so no test and no page can
// reach Google by accident.
//
// The three errors are the only failures a caller is expected to handle, and
// `commit` (ops.ts) turns each into a reason the user can be told. Anything
// else is a fault and is left to propagate.

import type { CalEvent } from "@/app/lib/v2/calendar/types";
import type { Instant } from "@/app/lib/v2/types";

/** Half open, the same shape `listEvents` already takes. */
export interface CalendarRange {
  timeMin: Instant;
  /** Exclusive. */
  timeMax: Instant;
}

/** The fields a patch may change. An absent field is left alone. */
export interface CalendarChanges {
  start?: string;
  end?: string;
  title?: string;
}

/**
 * The event changed since it was read, so the write was refused rather than
 * applied over someone else's edit. `expectEtag` is what the caller believed.
 */
export class CalendarConflictError extends Error {
  constructor(public readonly eventId: string) {
    super("the event changed since it was read");
    this.name = "CalendarConflictError";
  }
}

/** The calendar, or that one event, may only be read. */
export class CalendarReadOnlyError extends Error {
  constructor(public readonly eventId: string) {
    super("that calendar can only be read");
    this.name = "CalendarReadOnlyError";
  }
}

/**
 * No such event any more: deleted elsewhere between the read and the write.
 *
 * Not in the brief's list of two, and added because `commit` has to tell
 * "someone else changed it" from "it is gone" without catching, and therefore
 * hiding, a genuine fault.
 */
export class CalendarMissingError extends Error {
  constructor(public readonly eventId: string) {
    super("that event no longer exists");
    this.name = "CalendarMissingError";
  }
}

export interface CalendarPort {
  /**
   * Every event overlapping the range, from every calendar the account reads,
   * IN CANONICAL ORDER (`canonicalEvents` in ops.ts: by start instant, then by
   * id). That is a requirement on the implementation, not a nicety: the whole
   * engine keeps the list in that order, so a list that arrives in any other
   * one makes `applyOp`'s no-op guarantee and the undo round trip untrue. The
   * existing Google read sorts by the start STRING, which is a different order
   * as soon as two calendars are spelled with different offsets, so the real
   * adapter has to sort rather than pass that through.
   */
  list(range: CalendarRange): Promise<CalEvent[]>;
  /** Create one. The calendar assigns the id and the etag, so both come back. */
  insert(event: CalEvent): Promise<CalEvent>;
  /**
   * Bring back an event that was removed, WITH THE SAME ID.
   *
   * Undoing a deletion cannot go through `insert`: `CalEvent` carries a
   * fraction of what Google holds (no description, no attendees, no reminders,
   * no link to the series an occurrence belongs to), so inserting the local
   * copy would quietly replace the event with a stripped one under a new id,
   * breaking every link to it. An implementation that cannot undelete must
   * raise `CalendarMissingError` rather than insert a copy.
   *
   * The event is passed for identification only. What comes back is whatever
   * the calendar still holds for that id.
   */
  restore(event: CalEvent): Promise<CalEvent>;
  /**
   * Change one. `expectEtag` null writes unconditionally, like a request with
   * no If-Match header; any other value must match what the calendar holds.
   */
  patch(id: string, changes: CalendarChanges, expectEtag: string | null): Promise<CalEvent>;
  remove(id: string, expectEtag: string | null): Promise<void>;
}
