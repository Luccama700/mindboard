// Where the desk is kept: the whole set in this browser's storage, and the open
// layout in a cookie the server reads to paint the first frame.
//
// NOTHING LEAVES THE BROWSER. Storage is the browser's own; the cookie is
// written by the page itself (`document.cookie`) and is read only by this app's
// own server, on this machine. No server action, no route, no request.
//
// STORAGE IS THE DESK; THE COOKIE IS A PICTURE OF THE FIRST FRAME. The cookie
// carries the rail and the open layout's arrangements, nothing else (no other
// layout, no remembered spot), because it must fit in a request header. So on a
// load the server paints from the cookie, and then the stored desk replaces
// everything the cookie could not carry: every other layout, the other classes,
// the spots. The one thing kept from the server is what is on screen: the open
// layout's arrangement for the class being shown, when the cookie carried one
// and it draws differently from the stored one. A cookie that carried nothing
// for it (a link to another layout than the one the cookie was written on, or
// no cookie at all) painted a default that nobody chose, and the stored desk
// wins there: keeping that default would write it over the arrangement the
// owner made, at the next save.
//
// A SAVE IS A CHANGE OF THE SAVED TEXT. A move of focus makes a new set and the
// same text, and writes nothing. What was last written is compared with what
// would be written now, both for storage and for the cookie.

import { useEffect, useRef } from "react";

import {
  EMPTY_TILE_SET,
  TILE_COOKIE,
  arrangementOf,
  encodeArrangement,
  encodeTileCookie,
  isChanged,
  parseTileSet,
  serializeTileSet,
  setCurrent,
  withArrangement,
  type ScreenClass,
  type TileSet,
} from "@/app/lib/v2/tiles";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import { classNow, type TilesAction } from "./use-tiles";

/** Where the whole desk is kept in this browser's storage. */
export const DESK_STORAGE_KEY = "mb-v2-desk";

/** A year, in seconds: how long the cookie lasts after its last write. */
export const DESK_COOKIE_AGE = 31_536_000;

/** The cookie as `document.cookie` is given it. Its value never needs escaping (see cookie.ts). */
export function deskCookie(value: string, secure: boolean): string {
  const attributes = [`Path=/v2`, `Max-Age=${DESK_COOKIE_AGE}`, "SameSite=Lax"];
  if (secure) attributes.push("Secure");
  return [`${TILE_COOKIE}=${value}`, ...attributes].join("; ");
}

/** The desk cookie's value in a `document.cookie` string, or null. */
export function cookieValue(cookies: string): string | null {
  for (const part of cookies.split(";")) {
    const pair = part.trim();
    if (pair.startsWith(`${TILE_COOKIE}=`)) return pair.slice(TILE_COOKIE.length + 1);
  }
  return null;
}

/**
 * The desk after a load: the stored desk, opened on the layout the server
 * painted, with the server's arrangement kept for each class in `shown` where
 * the cookie carried one that draws differently (see the head of this file).
 * When the stored desk cannot show the painted layout (it has no such layout,
 * or it is hidden there), the stored desk is the answer as it is.
 *
 * WHY STORAGE WINS UNLESS THE COOKIE CARRIED THE ARRANGEMENT (ruled in Task 10;
 * do not "fix" it back to keeping whatever the server painted). Where the
 * cookie carried nothing for this layout and class, the server painted a
 * default nobody chose (a link to another layout than the one the cookie was
 * written on, or no cookie at all), and keeping it would write that default
 * over the owner's own arrangement at the next save. One jump on load is the
 * smaller loss.
 */
export function mergeSaved(painted: TileSet, saved: TileSet, shown: readonly ScreenClass[]): TileSet {
  const layout = painted.current;
  let merged = setCurrent(saved, layout);
  if (merged.current !== layout) return merged;
  for (const cls of shown) {
    if (!isChanged(painted, layout, cls)) continue;
    const onScreen = arrangementOf(painted, layout, cls);
    if (encodeArrangement(onScreen) === encodeArrangement(arrangementOf(merged, layout, cls))) continue;
    merged = withArrangement(merged, layout, cls, onScreen);
  }
  return merged;
}

/** What is written: the storage text and the cookie value, each null when nothing was. */
export interface Written {
  text: string | null;
  cookie: string | null;
}

/** One save: what to write now, and whether the cookie could not carry the desk. */
export interface SaveStep {
  storage: string | null;
  cookie: string | null;
  tooBig: boolean;
  written: Written;
}

/**
 * What saving this set writes, after `last` was written: the storage text when
 * it differs, and the cookie when its value differs and fits. A desk the cookie
 * cannot carry keeps the cookie there was, and says so (`tooBig`) when there was
 * a change to save. A set whose saved text and cookie are both what was written
 * (a move of focus) writes nothing.
 */
export function saveStep(set: TileSet, last: Written): SaveStep {
  const text = serializeTileSet(set);
  const cookie = encodeTileCookie(set);
  const changedText = text !== last.text;
  return {
    storage: changedText ? text : null,
    cookie: cookie !== null && cookie !== last.cookie ? cookie : null,
    tooBig: cookie === null && changedText,
    written: { text, cookie: cookie ?? last.cookie },
  };
}

/** The browser's storage, or null where it cannot be reached (a blocked or private context). */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** What storage holds for the desk. A read that throws (a blocked or private window) is nothing stored. */
function readStored(): string | null {
  try {
    return storage()?.getItem(DESK_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Whether the text was stored. A full or refused storage answers false; nothing is swallowed. */
function writeStored(text: string): boolean {
  try {
    const area = storage();
    if (area === null) return false;
    area.setItem(DESK_STORAGE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

function writeCookie(value: string): void {
  document.cookie = deskCookie(value, window.location.protocol === "https:");
}

/**
 * The stored desk, or null when there is none. A value the parser cannot read
 * at all comes back as the empty desk itself, and is read as none: merging the
 * server's picture into an empty desk would drop the layouts the cookie holds.
 */
function storedDesk(text: string | null): TileSet | null {
  if (text === null) return null;
  const saved = parseTileSet(text);
  return saved === EMPTY_TILE_SET ? null : saved;
}

/** The classes whose arrangement is on screen: the one the window is, or all three before it says. */
function shownClasses(): readonly ScreenClass[] {
  const cls = classNow();
  return cls === null ? ["compact", "regular", "wide"] : [cls];
}

/**
 * Loading once, then saving every change of the saved text, with other tabs of
 * the same desk in mind.
 *
 * THE LOAD. The first effect after hydration reads the stored desk and hands
 * the merge to the reducer. What later saves compare with is what is really
 * there: the stored text and the cookie's value, or, with nothing stored, the
 * desk on screen, so a first visit writes nothing. While the set is still the
 * server's own picture and a merge is on its way, nothing is saved: an effect
 * that ran twice in development must not write that picture over the stored
 * desk.
 *
 * ANOTHER TAB. Each tab holds the desk it loaded, and a save writes the whole
 * set, so a tab that knew nothing of another's changes would write its old desk
 * over them. Two guards, because the browser's `storage` event can come late or
 * not at all (a tab asleep in the background):
 *   - the event: another tab's desk is taken in at once (`mergeSaved`, so this
 *     tab keeps its open layout and the arrangement on screen), and recorded as
 *     what this tab last wrote, so it does not write it straight back (two tabs
 *     on two layouts would otherwise answer each other forever);
 *   - before every write, storage is read again; when it holds anything but the
 *     text this tab last wrote or read, another tab got there first, and the
 *     same merge is made before writing, so the old desk is never written.
 *
 * A WRITE THAT FAILS IS NOT DONE. When storage is full or refuses, what was
 * last written stays as it was, so the next change tries again, the cookie is
 * left as it was too (a cookie newer than storage would paint a desk the load
 * then throws away), and `onNotSaved` is told once, until a write succeeds.
 */
export function useSavedDesk(
  set: TileSet,
  dispatch: (action: TilesAction) => void,
  onTooBig: () => void,
  onNotSaved?: (sentence: string) => void,
): void {
  const written = useRef<Written | null>(null);
  const painted = useRef<TileSet | null>(null);
  /** The text this tab last wrote to storage or read from it. */
  const seen = useRef<string | null>(null);
  const latest = useRef(set);
  const failing = useRef(false);
  // Held, not depended on: the desk may hand a new function every render.
  const notSaved = useRef(onNotSaved);

  useEffect(() => {
    latest.current = set;
    notSaved.current = onNotSaved;
  });

  // Another tab wrote: take its desk in, and record it as written here.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DESK_STORAGE_KEY || event.newValue === null) return;
      if (event.storageArea !== null && event.storageArea !== storage()) return;
      const before = written.current;
      if (before === null || event.newValue === seen.current) return;
      const theirs = storedDesk(event.newValue);
      if (theirs === null) return;
      const merged = mergeSaved(latest.current, theirs, shownClasses());
      seen.current = event.newValue;
      written.current = { text: serializeTileSet(merged), cookie: encodeTileCookie(merged) ?? before.cookie };
      painted.current = null;
      dispatch({ type: "replace", set: merged });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [dispatch]);

  useEffect(() => {
    if (written.current === null) {
      const text = readStored();
      const saved = storedDesk(text);
      const cookie = cookieValue(document.cookie);
      seen.current = text;
      if (saved === null) {
        written.current = { text: serializeTileSet(set), cookie: cookie ?? encodeTileCookie(set) };
      } else {
        written.current = { text, cookie };
        painted.current = set;
        dispatch({ type: "replace", set: mergeSaved(set, saved, shownClasses()) });
        return;
      }
    }
    if (painted.current !== null) {
      if (set === painted.current) return;
      painted.current = null;
    }

    // Another tab may have written since this one last wrote or read.
    let next = set;
    let last = written.current;
    const there = readStored();
    if (there !== null && there !== seen.current) {
      const theirs = storedDesk(there);
      if (theirs !== null) {
        next = mergeSaved(set, theirs, shownClasses());
        seen.current = there;
        last = { text: there, cookie: last.cookie };
      }
    }

    const step = saveStep(next, last);
    if (step.storage !== null) {
      if (!writeStored(step.storage)) {
        if (!failing.current) {
          failing.current = true;
          notSaved.current?.(DESK_COPY.notSavedHere);
        }
        // What another tab wrote is on screen here even so: this tab must not
        // try again with the desk it had before.
        if (next !== set) dispatch({ type: "replace", set: next });
        return;
      }
      failing.current = false;
      seen.current = step.storage;
    }
    written.current = step.written;
    if (step.cookie !== null) writeCookie(step.cookie);
    if (step.tooBig) onTooBig();
    if (next !== set) dispatch({ type: "replace", set: next });
  }, [set, dispatch, onTooBig]);
}
