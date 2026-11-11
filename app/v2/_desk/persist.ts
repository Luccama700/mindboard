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

function readStored(): string | null {
  try {
    return storage()?.getItem(DESK_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStored(text: string): void {
  try {
    storage()?.setItem(DESK_STORAGE_KEY, text);
  } catch {
    // Full, or refused: the cookie still holds the open layout.
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

/**
 * Loading once, then saving every change of the saved text.
 *
 * The first effect after hydration reads the stored desk and hands the merge
 * to the reducer. What later saves compare with is what is really there: the
 * stored text and the cookie's value, or, with nothing stored, the desk on
 * screen, so a first visit writes nothing. While the set is still the server's
 * own picture and a merge is on its way, nothing is saved: an effect that ran
 * twice in development must not write that picture over the stored desk.
 */
export function useSavedDesk(
  set: TileSet,
  dispatch: (action: TilesAction) => void,
  onTooBig: () => void,
): void {
  const written = useRef<Written | null>(null);
  const painted = useRef<TileSet | null>(null);

  useEffect(() => {
    if (written.current === null) {
      const text = readStored();
      const saved = storedDesk(text);
      const cookie = cookieValue(document.cookie);
      if (saved === null) {
        written.current = { text: serializeTileSet(set), cookie: cookie ?? encodeTileCookie(set) };
      } else {
        written.current = { text, cookie };
        const cls = classNow();
        const shown: readonly ScreenClass[] = cls === null ? ["compact", "regular", "wide"] : [cls];
        painted.current = set;
        dispatch({ type: "replace", set: mergeSaved(set, saved, shown) });
        return;
      }
    }
    if (painted.current !== null) {
      if (set === painted.current) return;
      painted.current = null;
    }
    const step = saveStep(set, written.current);
    written.current = step.written;
    if (step.storage !== null) writeStored(step.storage);
    if (step.cookie !== null) writeCookie(step.cookie);
    if (step.tooBig) onTooBig();
  }, [set, dispatch, onTooBig]);
}
