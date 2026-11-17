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
  addLayout,
  arrangementOf,
  encodeArrangement,
  encodeTileCookie,
  isChanged,
  parseTileSet,
  serializeTileSet,
  setCurrent,
  withArrangement,
  type Arrangement,
  type LayoutId,
  type LayoutMeta,
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

const CLASSES: readonly ScreenClass[] = ["compact", "regular", "wide"];

function metaIn(set: TileSet, id: LayoutId): LayoutMeta | null {
  return set.layouts.find((meta) => meta.id === id) ?? null;
}

/** Whether a layout's arrangement on a class draws the same in two desks (ids aside). */
function drawsSame(a: TileSet, b: TileSet, id: LayoutId, cls: ScreenClass): boolean {
  return encodeArrangement(arrangementOf(a, id, cls)) === encodeArrangement(arrangementOf(b, id, cls));
}

/** One layout of the merged desk: its id there, its name, where each class comes from, and whether it is hidden. */
interface Kept {
  id: LayoutId;
  title: string;
  base: LayoutMeta["base"];
  slot: (cls: ScreenClass) => Arrangement;
  hidden: boolean;
}

/** The plain value the engine's parser reads a desk from, for these layouts. */
function deskValue(kept: readonly Kept[], hidden: readonly LayoutId[], current: LayoutId): unknown {
  return {
    version: EMPTY_TILE_SET.version,
    layouts: kept.map((entry) => ({ id: entry.id, title: entry.title, base: entry.base })),
    hidden,
    current,
    slots: Object.fromEntries(
      kept.map((entry) => [entry.id, Object.fromEntries(CLASSES.map((cls) => [cls, entry.slot(cls)]))]),
    ),
  };
}

/**
 * The id the engine gives the next layout made on a desk holding these
 * layouts, or null when that desk is full: `addLayout`'s own numbering, asked
 * of the desk itself rather than worked out here.
 */
function nextLayoutId(kept: readonly Kept[]): LayoutId | null {
  const desk = parseTileSet(deskValue(kept, [], kept[0]?.id ?? EMPTY_TILE_SET.current));
  const grown = addLayout(desk, "", desk.layouts[0].id, "regular");
  return grown === desk ? null : grown.layouts[grown.layouts.length - 1].id;
}

/**
 * The desk after another tab wrote while this one held `mine`, both grown from
 * `base` (the last desk this tab wrote or read). The open layout stays this
 * tab's own view (it is the tab's address, not something the owner arranged);
 * everything else follows the rule below.
 *
 * A three-way merge, field by field, because taking either desk whole loses the
 * other's changes and a union brings deleted layouts back: for the rail (each
 * layout's name, its place, whether it is hidden) and for each layout's each
 * class, the layout on screen included, this tab's value where THIS TAB changed
 * it since the base, and the stored one otherwise, so the screen may change
 * under the owner for his own action in his other tab. A layout missing on one
 * side is deleted there (one this tab still changed survives a deletion it never
 * saw), a layout both sides made with the same id is kept twice, this tab's
 * renumbered by the engine, and the one loss left is an arrangement both tabs
 * changed since the base, where this tab's wins because it is what he is
 * looking at.
 */
export function mergeThree(base: TileSet, mine: TileSet, theirs: TileSet): TileSet {
  const renamedHere = (id: LayoutId) => {
    const here = metaIn(mine, id);
    const before = metaIn(base, id);
    return here !== null && before !== null && (here.title !== before.title || here.base !== before.base);
  };
  const hiddenHere = (set: TileSet, id: LayoutId) => set.hidden.includes(id);
  const hidChangedHere = (id: LayoutId) => hiddenHere(mine, id) !== hiddenHere(base, id);
  const touchedHere = (id: LayoutId) =>
    renamedHere(id) || hidChangedHere(id) || CLASSES.some((cls) => !drawsSame(mine, base, id, cls));

  const kept: Kept[] = [];
  const clashes: LayoutMeta[] = [];
  for (const meta of theirs.layouts) {
    const id = meta.id;
    const here = metaIn(mine, id);
    if (metaIn(base, id) !== null) {
      if (here === null) continue; // deleted here
      const named = renamedHere(id) ? here : meta;
      kept.push({
        id,
        title: named.title,
        base: named.base,
        slot: (cls) => (drawsSame(mine, base, id, cls) ? arrangementOf(theirs, id, cls) : arrangementOf(mine, id, cls)),
        hidden: hidChangedHere(id) ? hiddenHere(mine, id) : hiddenHere(theirs, id),
      });
      continue;
    }
    kept.push({
      id,
      title: meta.title,
      base: meta.base,
      slot: (cls) => arrangementOf(theirs, id, cls),
      hidden: hiddenHere(theirs, id),
    });
    if (here !== null) clashes.push(here); // made on both sides
  }
  for (const meta of mine.layouts) {
    if (metaIn(theirs, meta.id) !== null) continue;
    if (metaIn(base, meta.id) !== null && !touchedHere(meta.id)) continue; // deleted there, untouched here
    kept.push({
      id: meta.id,
      title: meta.title,
      base: meta.base,
      slot: (cls) => arrangementOf(mine, meta.id, cls),
      hidden: hiddenHere(mine, meta.id),
    });
  }
  const moved = new Map<LayoutId, LayoutId>();
  for (const meta of clashes) {
    const id = nextLayoutId(kept);
    if (id === null) continue; // the desk is full: the stored one stays
    moved.set(meta.id, id);
    kept.push({
      id,
      title: meta.title,
      base: meta.base,
      slot: (cls) => arrangementOf(mine, meta.id, cls),
      hidden: hiddenHere(mine, meta.id),
    });
  }

  // The rail's order: this tab's when it moved a layout, the stored one otherwise.
  const common = (a: TileSet, b: TileSet) => a.layouts.map((meta) => meta.id).filter((id) => metaIn(b, id) !== null);
  const reordered = common(mine, base).join(" ") !== common(base, mine).join(" ");
  const order = (reordered ? mine : theirs).layouts.map((meta) => meta.id);
  const rank = (id: LayoutId) => {
    const at = order.indexOf(id);
    return at < 0 ? Number.POSITIVE_INFINITY : at;
  };
  const ordered = kept
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => rank(a.entry.id) - rank(b.entry.id) || a.at - b.at)
    .map(({ entry }) => entry);

  const hiddenIds = ordered.filter((entry) => entry.hidden).map((entry) => entry.id);
  const hidden = [
    ...theirs.hidden.filter((id) => hiddenIds.includes(id)),
    ...hiddenIds.filter((id) => !theirs.hidden.includes(id)),
  ];

  // The open layout is this tab's own, under its new id when renumbered, while it can still be shown.
  const open = moved.get(mine.current) ?? mine.current;
  const showable = ordered.some((entry) => entry.id === open && !entry.hidden);
  return parseTileSet(deskValue(ordered, hidden, showable ? open : theirs.current));
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

/**
 * Whether storage holds a desk written by a NEWER version of this code:
 * readable JSON, an object, whose `version` is a number greater than this
 * build's. Such a desk is not "nothing stored": this build cannot read it, and
 * must not write over it either (it is the owner's latest). Anything else that
 * is not this build's desk (a version as a string, null, lower, or missing; not
 * JSON at all) counts as nothing stored, and is written over at the next change.
 */
export function otherVersion(text: string | null): boolean {
  if (text === null) return false;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (!Object.hasOwn(value, "version")) return false;
    const version = (value as { version: unknown }).version;
    return typeof version === "number" && version > EMPTY_TILE_SET.version;
  } catch {
    return false;
  }
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
 *   - the event: another tab's desk is taken in at once (`mergeThree` against
 *     the base this tab holds, so it keeps its own changes and its open layout,
 *     and takes the other's everywhere else, the arrangement on screen
 *     included), and recorded as what this tab last wrote, so it does not write
 *     it straight back (two tabs on two layouts would otherwise answer each
 *     other forever);
 *   - before every write, storage is read again; when it holds anything but the
 *     text this tab last wrote or read, another tab got there first, and the
 *     same merge is made before writing, so neither tab's changes are lost.
 *
 * A WRITE THAT FAILS IS NOT DONE. When storage is full or refuses, what was
 * last written stays as it was, so the next change tries again, the cookie is
 * left as it was too (a cookie newer than storage would paint a desk the load
 * then throws away), and `onNotSaved` is told once, until a write succeeds.
 *
 * A DESK FROM A NEWER VERSION IS LEFT ALONE. When storage holds a desk of
 * another version (`otherVersion`), at the load, in an event or at the read
 * before a write, this session writes neither storage nor the cookie again, and
 * `onNotSaved` is told once, at the first change that is not saved.
 */
export function useSavedDesk(
  set: TileSet,
  dispatch: (action: TilesAction) => void,
  onTooBig: () => void,
  onNotSaved?: (sentence: string) => void,
): void {
  const written = useRef<Written | null>(null);
  const painted = useRef<TileSet | null>(null);
  /** The text this tab last wrote to storage or read from it, and that desk: the base of a merge. */
  const seen = useRef<string | null>(null);
  const base = useRef<TileSet | null>(null);
  const latest = useRef(set);
  const failing = useRef(false);
  /** Storage holds another version's desk: nothing is written this session. */
  const frozen = useRef(false);
  const frozenSaid = useRef(false);
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
      if (otherVersion(event.newValue)) {
        frozen.current = true;
        seen.current = event.newValue;
        return;
      }
      const theirs = storedDesk(event.newValue);
      if (theirs === null) return;
      const merged = mergeThree(base.current ?? theirs, latest.current, theirs);
      seen.current = event.newValue;
      base.current = theirs;
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
      frozen.current = otherVersion(text);
      const saved = storedDesk(text);
      const cookie = cookieValue(document.cookie);
      seen.current = text;
      // With nothing stored, what this tab and any other started from is the desk the server painted.
      base.current = saved ?? set;
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
    if (there !== seen.current && otherVersion(there)) frozen.current = true;
    if (frozen.current) {
      // A change that would have been saved: said once, and nothing written.
      if (saveStep(set, last).storage !== null && !frozenSaid.current) {
        frozenSaid.current = true;
        notSaved.current?.(DESK_COPY.savedByNewer);
      }
      return;
    }
    if (there !== null && there !== seen.current) {
      const theirs = storedDesk(there);
      if (theirs !== null) {
        next = mergeThree(base.current ?? theirs, set, theirs);
        seen.current = there;
        base.current = theirs;
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
      base.current = next;
    }
    written.current = step.written;
    if (step.cookie !== null) writeCookie(step.cookie);
    if (step.tooBig) onTooBig();
    if (next !== set) dispatch({ type: "replace", set: next });
  }, [set, dispatch, onTooBig]);
}
