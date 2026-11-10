// What an edit does to the list in front of the user, how it is taken back,
// and what happens when it reaches the calendar.
//
// THE SPLIT IS THE POINT. `applyOp` is pure and optimistic: it rewrites the
// list immediately so a drag feels instant, and it does NOT check an etag,
// because the only thing that can judge an etag is the calendar. `commit` is
// the one function that talks to the port, and it reports the three ways a
// write can be refused rather than throwing them at the UI.
//
// COMMIT RETURNS A DESCRIPTION, NOT A LIST. It used to return the whole list,
// built from the snapshot it was given, and two commits in flight then
// overwrote each other: the second one's answer carried the first one's event
// with its pre-commit etag, so the next conditional edit of that event failed
// as a false conflict, and if the first had been refused the second's answer
// showed its event at a time the calendar did not have it. A description of
// what happened to ONE event, applied by `settle` to whatever the list is now,
// cannot do that.
//
// CANONICAL ORDER IS THE CONTRACT. `canonicalEvents` is the order the port is
// required to return (port.ts), the order `applyOp` and `settle` return, and
// therefore the order a caller must hold its list in. `applyOp`'s promise to
// return the same array when nothing changes is only true for an input that is
// already in it; everything that produces a list for this engine, including
// the port, is required to be.

import { compareText, maybeInstantMs } from "@/app/lib/v2/plan/day";
import { isDraftId } from "@/app/lib/v2/calendar/edit";
import {
  CalendarConflictError,
  CalendarMissingError,
  CalendarReadOnlyError,
} from "@/app/lib/v2/calendar/port";
import type { CalendarChanges, CalendarPort } from "@/app/lib/v2/calendar/port";
import type { CalEvent } from "@/app/lib/v2/calendar/types";
import type { Instant } from "@/app/lib/v2/types";

/**
 * One edit. `expectEtag` is what the event carried when the user began, so a
 * write that would land on top of someone else's change is refused instead.
 *
 * `restore` is how a deletion is undone: it is NOT a create, because the
 * calendar has to bring back the same event under the same id rather than
 * insert the stripped local copy (see `CalendarPort.restore`).
 */
export type CalendarOp =
  | { kind: "create"; event: CalEvent }
  | { kind: "restore"; event: CalEvent }
  | { kind: "move"; id: string; start: Instant; end: Instant; expectEtag: string | null }
  | { kind: "rename"; id: string; title: string; expectEtag: string | null }
  | { kind: "remove"; id: string; expectEtag: string | null };

/** Why a write did not happen. Every one of these is the user's to resolve. */
export type CommitFailure = "conflict" | "read-only" | "missing";

/**
 * What one commit did to one event, or what to do about it having failed.
 * `settle` applies it to the list as it stands, however much else has changed
 * since the commit was sent.
 */
export type CalendarChange =
  | { kind: "replace"; id: string; event: CalEvent }
  | { kind: "remove"; id: string }
  | { kind: "none" };

export type CommitResult =
  | { ok: true; change: CalendarChange }
  | { ok: false; reason: CommitFailure; revert: CalendarChange };

/**
 * The order the window holds events in: by start, then by id.
 *
 * By the INSTANT, not by the text, so two calendars whose events are spelled
 * with different offsets still sort by when they happen. An all day event's
 * date key parses as UTC midnight, which is a stable place for it.
 */
export function canonicalEvents(events: readonly CalEvent[]): CalEvent[] {
  return [...events].sort((a, b) => startOf(a) - startOf(b) || compareText(a.id, b.id));
}

function startOf(event: CalEvent): number {
  return maybeInstantMs(event.start) ?? Number.POSITIVE_INFINITY;
}

const WHOLE_SECOND = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+(.*)$/;

/**
 * An instant without its fraction of a second, as text, so the offset it was
 * written with is kept. The engine floors every instant it builds, but an op
 * can be built from anything, and a fraction of a second here would come back
 * from the calendar rounded and read as a change nobody made (`zonedIso` once
 * produced "+08:60" from exactly this).
 */
function wholeSecond(value: string): string {
  return value.replace(WHOLE_SECOND, "$1$2");
}

function flooredEvent(event: CalEvent): CalEvent {
  return { ...event, start: wholeSecond(event.start), end: wholeSecond(event.end) };
}

/** The event op would leave behind, or null when it would change nothing. */
function changedEvent(before: CalEvent, op: CalendarOp): CalEvent | null {
  if (op.kind === "move") {
    const start = wholeSecond(op.start);
    const end = wholeSecond(op.end);
    if (before.start === start && before.end === end) return null;
    return { ...before, start, end };
  }
  if (op.kind === "rename") {
    if (before.title === op.title) return null;
    return { ...before, title: op.title };
  }
  return null;
}

/** The event that op is about, when the list holds it and it may be edited. */
function target(events: readonly CalEvent[], op: CalendarOp): CalEvent | null {
  if (op.kind === "create" || op.kind === "restore") {
    if (!op.event.editable) return null;
    return events.some((event) => event.id === op.event.id) ? null : op.event;
  }
  const found = events.find((event) => event.id === op.id);
  if (found === undefined || !found.editable) return null;
  return found;
}

/**
 * The list as it looks the instant the user lets go.
 *
 * An op that would change nothing returns the SAME array, so a caller can tell
 * a no-op by identity: an id the list does not hold, an event nobody may edit,
 * a create of an id already there, or a move or rename to the value the event
 * already has. That guarantee needs the input to be in canonical order, which
 * is this engine's contract for every list (see the head of this file).
 */
export function applyOp(events: readonly CalEvent[], op: CalendarOp): CalEvent[] {
  const found = target(events, op);
  if (found === null) return events as CalEvent[];
  if (op.kind === "create" || op.kind === "restore") {
    return canonicalEvents([...events, flooredEvent(op.event)]);
  }
  if (op.kind === "remove") {
    return canonicalEvents(events.filter((event) => event.id !== op.id));
  }
  const changed = changedEvent(found, op);
  if (changed === null) return events as CalEvent[];
  return canonicalEvents(events.map((event) => (event.id === op.id ? changed : event)));
}

/**
 * The op that undoes this one against that list, or null when applying it
 * would change nothing.
 *
 * It must be built BEFORE the op is applied: it carries the values the event
 * had, and the etag it had, so an undo that reaches the calendar is refused if
 * the event has moved on since. After a successful `commit` both have changed,
 * and a created event's id has too, so a caller keeping an undo stack must
 * re-aim it using the `change` that came back.
 */
export function invertOp(eventsBefore: readonly CalEvent[], op: CalendarOp): CalendarOp | null {
  const before = target(eventsBefore, op);
  if (before === null) return null;
  switch (op.kind) {
    case "create":
    case "restore":
      return { kind: "remove", id: op.event.id, expectEtag: op.event.etag };
    case "remove":
      return { kind: "restore", event: { ...before } };
    default: {
      const changed = changedEvent(before, op);
      if (changed === null) return null;
      if (op.kind === "move") {
        return {
          kind: "move",
          id: op.id,
          start: before.start,
          end: before.end,
          expectEtag: before.etag,
        };
      }
      return { kind: "rename", id: op.id, title: before.title, expectEtag: before.etag };
    }
  }
}

/**
 * Apply what one commit reported to the list as it stands now.
 *
 * This is the only thing that should write a commit's outcome into a list. It
 * touches one event, so two commits in flight settle independently and in
 * either order, and it returns the same array when there is nothing to do.
 */
export function settle(events: readonly CalEvent[], change: CalendarChange): CalEvent[] {
  if (change.kind === "none") return events as CalEvent[];
  if (change.kind === "remove") {
    const rest = events.filter((event) => event.id !== change.id);
    return rest.length === events.length ? (events as CalEvent[]) : canonicalEvents(rest);
  }
  const real = change.event.id;
  const rest = events.filter((event) => event.id !== change.id && event.id !== real);
  return canonicalEvents([...rest, flooredEvent(change.event)]);
}

/**
 * Send one op to the calendar.
 *
 * For `move`, `rename` and `remove`, `events` IS THE LIST AS IT WAS BEFORE THE
 * OP: that is where the event's own values are read from, so committing a
 * `remove` against a list it has already been taken out of reports `missing`
 * and the event would stay in Google forever. A `move` or `rename` committed
 * against the optimistic list is still sent, but its `revert` then carries the
 * values the op had just written rather than the ones it replaced, so a
 * refusal would put the optimistic change back instead of undoing it.
 * `create` and `restore` carry their event with them and do not consult the
 * list at all, so either one may be passed.
 *
 * TWO RULES FOR THE CALLER, neither of which this function can enforce:
 *   - Commits on the SAME event must be serialised. Two conditional writes to
 *     one event cannot both be in flight: the second was built against an etag
 *     the first has already replaced.
 *   - An edit to a draft while its create is in flight is applied locally
 *     only. It never reaches the calendar, and the created event will come
 *     back without it.
 *
 * On success `change` says what the calendar did, including the real id a
 * draft's id became. On refusal `revert` says what to do about the optimistic
 * change that is already on screen: put the old values back for a conflict or
 * a refusal, and take the event off the list when it turns out to be gone.
 * Both are for `settle`, never for the caller to interpret.
 *
 * Anything other than the three refusals is a fault and is left to propagate:
 * a network failure must not look like a conflict, because the write may well
 * have landed.
 */
export async function commit(
  port: CalendarPort,
  events: readonly CalEvent[],
  op: CalendarOp,
): Promise<CommitResult> {
  if (op.kind === "create" || op.kind === "restore") {
    const event = flooredEvent(op.event);
    if (!event.editable) {
      return { ok: false, reason: "read-only", revert: { kind: "remove", id: event.id } };
    }
    // A draft that was taken back has never been anywhere: restoring it is the
    // list's business alone.
    if (op.kind === "restore" && isDraftId(event.id)) {
      return { ok: true, change: { kind: "replace", id: event.id, event } };
    }
    try {
      const server = op.kind === "create" ? await port.insert(event) : await port.restore(event);
      return { ok: true, change: { kind: "replace", id: event.id, event: server } };
    } catch (error) {
      const reason = refusal(error);
      if (reason === null) throw error;
      return { ok: false, reason, revert: { kind: "remove", id: event.id } };
    }
  }

  // Presence first, then whether it is a draft. In that order an undo still
  // aimed at a draft id whose create has already landed reports `missing`,
  // rather than silently succeeding against a list that no longer holds it.
  const before = events.find((event) => event.id === op.id);
  if (before === undefined) return { ok: false, reason: "missing", revert: { kind: "none" } };
  if (!before.editable) {
    return { ok: false, reason: "read-only", revert: { kind: "none" } };
  }
  const restore: CalendarChange = { kind: "replace", id: op.id, event: before };

  // A draft has never been anywhere, so every edit to one is local. The port
  // must never see a draft id: Google would answer "not found", and before
  // this check that was reported as a failure the user could do nothing about.
  if (isDraftId(op.id)) {
    if (op.kind === "remove") return { ok: true, change: { kind: "remove", id: op.id } };
    const changed = changedEvent(before, op);
    return changed === null
      ? { ok: true, change: { kind: "none" } }
      : { ok: true, change: { kind: "replace", id: op.id, event: changed } };
  }
  // A real id is sent even when the values look unchanged against THIS list.
  // Skipping the write when they match was a quiet way to lose an edit: a
  // caller that passed the optimistic list by mistake would be told the commit
  // succeeded while nothing had been sent, which is the defect that made a
  // refused create leave its draft on screen, in a harder place to see.

  try {
    if (op.kind === "remove") {
      await port.remove(op.id, op.expectEtag);
      return { ok: true, change: { kind: "remove", id: op.id } };
    }
    const changes: CalendarChanges =
      op.kind === "move"
        ? { start: wholeSecond(op.start), end: wholeSecond(op.end) }
        : { title: op.title };
    const server = await port.patch(op.id, changes, op.expectEtag);
    return { ok: true, change: { kind: "replace", id: op.id, event: server } };
  } catch (error) {
    // Deleting something that is already gone is the outcome that was asked
    // for. Reporting it as a failure left the ghost on the list, where the only
    // thing the user could do was try to delete it again.
    if (op.kind === "remove" && error instanceof CalendarMissingError) {
      return { ok: true, change: { kind: "remove", id: op.id } };
    }
    const reason = refusal(error);
    if (reason === null) throw error;
    // An event nobody else can see any more is taken off the list; a conflict
    // or a refusal leaves it where it was, for the caller to re-read.
    return {
      ok: false,
      reason,
      revert: reason === "missing" ? { kind: "remove", id: op.id } : restore,
    };
  }
}

function refusal(error: unknown): CommitFailure | null {
  if (error instanceof CalendarConflictError) return "conflict";
  if (error instanceof CalendarReadOnlyError) return "read-only";
  if (error instanceof CalendarMissingError) return "missing";
  return null;
}
