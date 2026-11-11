// What is saved, and the parser that reads it back.
//
// A DESK OF LAYOUTS. The saved form is the rail (the four built in layouts and
// up to eight of the user's, in the user's order), which of them are hidden,
// which one is open, and the arrangements the user has made: one per layout per
// screen class. Layouts are live documents. A change is kept as it is made;
// there is no "working" copy beside a "saved" one, and the way back is a reset.
//
// ONE SLOT PER SCREEN CLASS, AND NEVER A LOAN BETWEEN THEM. A layout that works
// on a 1600 pixel screen is the wrong layout on a 1024 pixel one, and the
// phone's is a single stack. So each class keeps its own slot and falls back to
// its OWN default, never to another class's arrangement. A laptop that borrowed
// the desktop's layout was the defect that made this rule explicit.
//
// A LAYOUT NOBODY CHANGED IS NOT STORED (amendment A). A slot exists only while
// its arrangement differs from the layout's default: another shape, something
// maximized, an option set, or a closed pane remembered. `arrangementOf` answers
// the catalog's own frozen default for everything else, so a default improved
// in a later release reaches every desk that never rearranged that layout.
//
// THE FOCUS IS NOT STORED (amendment B). It is where the keyboard is, not part
// of how the desk is arranged. On a load it is the maximized pane, or the tab
// the first leaf is showing.
//
// THE PARSER CANNOT RETURN A BROKEN DESK. The value it reads lives in the
// user's browser, so it can be absent, truncated, written by an older build or
// hand edited. Whatever comes back decides what is on screen, and a screen with
// no pane open has no control on it either, so there is no way out of it. Every
// repair below exists to make that state unreachable:
//
//   not a desk of this version          the empty desk
//   a built in layout missing           put back, with the catalog's title
//   a user layout id that is not u<n>   dropped, and so is a second one
//   more layouts than a desk holds      the ones past the limit dropped
//   every layout hidden                 the first one shown
//   current not a visible layout        the first visible layout
//   a pane the catalog does not know    dropped, and the tree normalized
//   a pane listed twice                 kept in its first place only
//   a tree with nothing left open       that layout's default for that class
//   a tree deeper than the cap          the same, checked while descending so
//                                       a value that points at itself ends
//   ids missing, malformed, repeated    numbered again
//   maximized not open, or not in front dropped
//   an option the catalog does not have dropped, and so is a fallback
//   a phone slot with several leaves    flattened to one
//   a slot equal to its default         not kept (amendment A)
//
// It never clamps a ratio to a workspace, because it has no workspace: the
// layout does that, for drawing, and writes nothing back.
//
// Only allowlists are ever iterated: the catalog's panes and options, the
// screen classes, and the layouts the parser itself accepted. A stored key
// named `__proto__`, `constructor` or `prototype` is not read at all, and
// nothing on Object.prototype can be reached through a value from storage.
//
// Pure. No DOM, no storage, no clock, no randomness: a client reads and writes
// the browser and hands whatever came back to parseTileSet.

import { BUILT_IN_LAYOUTS, MAX_LAYOUTS, PANES, defaultArrangement, defaultTree } from "./catalog";
import {
  EVEN_RATIO,
  flatten,
  hasSoundIds,
  leafOf,
  leavesOf,
  normalize,
  normalizeRatio,
  signature,
  withCanonicalIds,
} from "./tree";
import type {
  Arrangement,
  BuiltInLayoutId,
  LayoutId,
  LayoutMeta,
  PaneId,
  ScreenClass,
  Spot,
  TileNode,
  Zone,
} from "./types";

export interface TileSet {
  version: 1;
  /** The rail's order. Always holds the four built in layouts. */
  layouts: LayoutMeta[];
  hidden: LayoutId[];
  current: LayoutId;
  /** Layout, then class, then the arrangement: ONLY while it differs from that layout's default. */
  slots: Record<LayoutId, Partial<Record<ScreenClass, Arrangement>>>;
}

const TILE_SET_VERSION = 1;

/** The only class keys there are, and the only ones ever read from a value. */
const SCREEN_CLASSES: readonly ScreenClass[] = ["compact", "regular", "wide"];

const ZONES: readonly Zone[] = ["left", "right", "top", "bottom", "centre"];

const KNOWN_PANES: readonly PaneId[] = PANES.map((pane) => pane.id);

const BUILT_IN_IDS: readonly LayoutId[] = BUILT_IN_LAYOUTS.map((meta) => meta.id);

/** Where a layout the desk does not have, or a base that is not built in, falls back to. */
const FIRST_LAYOUT: BuiltInLayoutId = "today";

/** How many layouts of the user's own fit beside the four built in. */
const USER_LAYOUT_ROOM = MAX_LAYOUTS - BUILT_IN_LAYOUTS.length;

/** A user's layout id: `u` and a whole number from one, with no leading zero. */
const USER_LAYOUT_SHAPE = /^u[1-9][0-9]*$/;

/**
 * The largest number a user's layout id may carry. A new id is one more than
 * the largest in use, so an id has to be one the engine can count past, for
 * the reason tree.ts gives for the ids of a tree. Nobody makes a billion
 * layouts; the cap only bounds a hand edited value.
 */
const MAX_LAYOUT_NUMBER = 1_000_000_000;

/**
 * How deep a stored tree may be. Fourteen panes make at most fourteen leaves,
 * and a tree of fourteen leaves is at most fourteen levels deep (all of them in
 * a chain), so this is exactly the deepest tree the engine can build: a saved
 * layout is never thrown away for being deep. Anything deeper is a hand written
 * value, or one that points at itself, and is not descended any further.
 */
const MAX_TREE_DEPTH = KNOWN_PANES.length;

/** The most code points a layout's title keeps. */
const TITLE_MAX_LENGTH = 24;

/** The title a layout gets when nothing usable was typed. */
const UNTITLED = "Layout";

// The range a stored ratio is held in, its four decimals, and the share a split
// falls back to are imported from tree.ts rather than repeated here. Two copies
// could drift, and a stored value outside the engine's own range is exactly the
// thing a load would silently change.

export const EMPTY_TILE_SET: TileSet = Object.freeze({
  version: TILE_SET_VERSION,
  layouts: Object.freeze([...BUILT_IN_LAYOUTS]) as LayoutMeta[],
  hidden: Object.freeze<LayoutId[]>([]) as LayoutId[],
  current: FIRST_LAYOUT,
  slots: Object.freeze({}),
});

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** A plain object, or null. Never an array and never anything else. */
function plain(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The same, but a string is read as the JSON it is meant to be. */
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return plain(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return plain(value);
}

function isBuiltIn(value: unknown): value is BuiltInLayoutId {
  return typeof value === "string" && BUILT_IN_IDS.includes(value);
}

/** The n of a user's layout id `u<n>`, or null for anything else. */
function userNumber(id: string): number | null {
  if (!USER_LAYOUT_SHAPE.test(id)) return null;
  const parsed = Number.parseInt(id.slice(1), 10);
  return Number.isSafeInteger(parsed) && parsed <= MAX_LAYOUT_NUMBER ? parsed : null;
}

function indexOf(set: TileSet, id: LayoutId): number {
  return set.layouts.findIndex((meta) => meta.id === id);
}

function metaOf(set: TileSet, id: LayoutId): LayoutMeta | null {
  const at = indexOf(set, id);
  return at < 0 ? null : set.layouts[at];
}

/** The built in layout a layout starts from. A layout the desk does not have reads as the first. */
function baseOf(set: TileSet, id: LayoutId): BuiltInLayoutId {
  const meta = metaOf(set, id);
  if (meta !== null) return meta.base;
  return isBuiltIn(id) ? id : FIRST_LAYOUT;
}

function isHidden(set: TileSet, id: LayoutId): boolean {
  return set.hidden.includes(id);
}

function visibleCount(set: TileSet): number {
  return set.layouts.filter((meta) => !isHidden(set, meta.id)).length;
}

/** The nearest visible layout before this place on the rail, or null. */
function visibleBefore(set: TileSet, index: number): LayoutId | null {
  for (let at = index - 1; at >= 0; at -= 1) {
    if (!isHidden(set, set.layouts[at].id)) return set.layouts[at].id;
  }
  return null;
}

/** The nearest visible layout after this place on the rail, or null. */
function visibleAfter(set: TileSet, index: number): LayoutId | null {
  for (let at = index + 1; at < set.layouts.length; at += 1) {
    if (!isHidden(set, set.layouts[at].id)) return set.layouts[at].id;
  }
  return null;
}

/** The arrangement stored for this layout and class, or null. Own properties only. */
function slotOf(set: TileSet, layout: LayoutId, cls: ScreenClass): Arrangement | null {
  if (!own(set.slots, layout)) return null;
  const classes = set.slots[layout];
  if (!own(classes, cls)) return null;
  return classes[cls] ?? null;
}

/**
 * Whether an arrangement is its layout's default, and so is not to be stored:
 * the same shape (by signature, so neither the tab in front nor the focus
 * counts), nothing maximized, no option set and no closed pane remembered.
 */
function isDefault(arrangement: Arrangement, fallback: Arrangement): boolean {
  return (
    arrangement.maximized === null &&
    Object.keys(arrangement.options).length === 0 &&
    Object.keys(arrangement.lastSpot).length === 0 &&
    signature(arrangement.tree) === signature(fallback.tree)
  );
}

/**
 * The slots with one layout's record replaced (or removed, for null or an
 * empty record). Built by walking the rail, so a slot can only ever exist for a
 * layout the desk has; every other record comes back by reference.
 */
function slotsWith(
  set: TileSet,
  layout: LayoutId,
  classes: Partial<Record<ScreenClass, Arrangement>> | null,
): TileSet["slots"] {
  const out: TileSet["slots"] = {};
  for (const meta of set.layouts) {
    if (meta.id === layout) {
      if (classes !== null && Object.keys(classes).length > 0) out[meta.id] = classes;
      continue;
    }
    if (own(set.slots, meta.id)) out[meta.id] = set.slots[meta.id];
  }
  return out;
}

/** One class of one layout replaced, or forgotten for null. */
function withSlot(
  set: TileSet,
  layout: LayoutId,
  cls: ScreenClass,
  arrangement: Arrangement | null,
): TileSet {
  const held = own(set.slots, layout) ? set.slots[layout] : null;
  const classes: Partial<Record<ScreenClass, Arrangement>> = {};
  for (const other of SCREEN_CLASSES) {
    if (other === cls) {
      if (arrangement !== null) classes[other] = arrangement;
      continue;
    }
    const kept = held !== null && own(held, other) ? held[other] : undefined;
    if (kept !== undefined) classes[other] = kept;
  }
  return { ...set, slots: slotsWith(set, layout, classes) };
}

// ----------------------------------------------------------------- slots

/**
 * The arrangement of a layout on a screen class: the stored one, or the
 * catalog's default for that layout's base on that class, by reference.
 */
export function arrangementOf(set: TileSet, layout: LayoutId, cls: ScreenClass): Arrangement {
  return slotOf(set, layout, cls) ?? defaultArrangement(cls, baseOf(set, layout));
}

/**
 * Keep an arrangement for one layout on one class. Every other slot comes back
 * as the same object, and so does the set when nothing changes.
 *
 * An arrangement equal to the layout's default removes the slot instead of
 * storing it (amendment A). On the phone the arrangement is flattened first,
 * because the phone has one stack. An arrangement with nothing open is the
 * layout's default tree, keeping its options and remembered spots: a layout
 * cannot be emptied. A layout the desk does not have is refused.
 */
export function withArrangement(
  set: TileSet,
  layout: LayoutId,
  cls: ScreenClass,
  arrangement: Arrangement,
): TileSet {
  const meta = metaOf(set, layout);
  if (meta === null || !SCREEN_CLASSES.includes(cls)) return set;
  const fallback = defaultArrangement(cls, meta.base);
  let next =
    arrangement.tree === null
      ? { ...arrangement, tree: fallback.tree, maximized: null, focus: fallback.focus }
      : arrangement;
  if (cls === "compact") next = flatten(next);
  const stored = slotOf(set, layout, cls);
  if (isDefault(next, fallback)) return stored === null ? set : withSlot(set, layout, cls, null);
  if (stored === next) return set;
  return withSlot(set, layout, cls, next);
}

/** Whether a layout is stored on that class at all, which is what "changed" means. */
export function isChanged(set: TileSet, layout: LayoutId, cls: ScreenClass): boolean {
  return slotOf(set, layout, cls) !== null;
}

/** Forget one class of a layout, or every class for null, so it is its default again. */
export function resetLayout(set: TileSet, layout: LayoutId, cls: ScreenClass | null): TileSet {
  if (!own(set.slots, layout)) return set;
  if (cls === null) return { ...set, slots: slotsWith(set, layout, null) };
  if (slotOf(set, layout, cls) === null) return set;
  return withSlot(set, layout, cls, null);
}

// --------------------------------------------------------------- layouts

/**
 * A title as it is kept: control characters and halves of a surrogate pair
 * standing alone dropped, every run of whitespace one space, trimmed, at most
 * 24 code points (a pair is one code point and is never cut in half), and
 * "Layout" for whatever is left empty.
 *
 * Walked one code unit at a time rather than with a Unicode property pattern,
 * which this project's compile target does not promise.
 */
export function cleanTitle(raw: string): string {
  if (typeof raw !== "string") return UNTITLED;
  let kept = "";
  for (let at = 0; at < raw.length; at += 1) {
    const unit = raw.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = raw.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        kept += raw.slice(at, at + 2);
        at += 1;
      }
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) continue;
    // C0 and C1 controls and DEL, except the ones that are whitespace (tab to
    // carriage return), which the next step turns into a space.
    const control = unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f);
    if (control && !(unit >= 0x09 && unit <= 0x0d)) continue;
    kept += raw[at];
  }
  const spaced = kept.replace(/\s+/g, " ").trim();
  const cut = Array.from(spaced).slice(0, TITLE_MAX_LENGTH).join("").trimEnd();
  return cut.length === 0 ? UNTITLED : cut;
}

/**
 * A new layout of the user's, made from another: id `u<n>` with n one more
 * than the largest in use, the base of the layout it came from, and that
 * layout's arrangement on this class (the other classes start from the base's
 * defaults). It goes at the end of the rail and is opened. Refused when the
 * desk is full or the layout it is made from is not on the desk.
 */
export function addLayout(set: TileSet, title: string, from: LayoutId, cls: ScreenClass): TileSet {
  if (set.layouts.length >= MAX_LAYOUTS) return set;
  const source = metaOf(set, from);
  if (source === null) return set;
  let largest = 0;
  for (const meta of set.layouts) largest = Math.max(largest, userNumber(meta.id) ?? 0);
  const number = largest + 1;
  if (number > MAX_LAYOUT_NUMBER) return set;
  const made: LayoutMeta = { id: `u${number}`, title: cleanTitle(title), base: source.base };
  const grown: TileSet = { ...set, layouts: [...set.layouts, made], current: made.id };
  return withArrangement(grown, made.id, cls, arrangementOf(set, from, cls));
}

/** Rename one of the user's layouts. The built in four keep the catalog's titles. */
export function renameLayout(set: TileSet, id: LayoutId, title: string): TileSet {
  if (isBuiltIn(id)) return set;
  const at = indexOf(set, id);
  if (at < 0) return set;
  const clean = cleanTitle(title);
  if (set.layouts[at].title === clean) return set;
  return {
    ...set,
    layouts: set.layouts.map((meta, index) => (index === at ? { ...meta, title: clean } : meta)),
  };
}

/**
 * Remove one of the user's layouts, with its slots and its place among the
 * hidden. Removing the open one opens the visible layout before it on the rail,
 * or after it when it was first. Refused for a built in layout, and for the
 * last visible layout, which would leave the rail with nothing to open.
 */
export function removeLayout(set: TileSet, id: LayoutId): TileSet {
  if (isBuiltIn(id)) return set;
  const at = indexOf(set, id);
  if (at < 0) return set;
  const hidden = isHidden(set, id);
  if (!hidden && visibleCount(set) < 2) return set;
  const current =
    set.current === id ? (visibleBefore(set, at) ?? visibleAfter(set, at) ?? set.current) : set.current;
  const shrunk: TileSet = {
    ...set,
    layouts: set.layouts.filter((meta) => meta.id !== id),
    hidden: hidden ? set.hidden.filter((other) => other !== id) : set.hidden,
    current,
  };
  return own(set.slots, id) ? { ...shrunk, slots: slotsWith(shrunk, id, null) } : shrunk;
}

/** Move a layout along the rail. The place is clamped, a fraction read as the place before it. */
export function moveLayout(set: TileSet, id: LayoutId, toIndex: number): TileSet {
  if (!Number.isFinite(toIndex)) return set;
  const from = indexOf(set, id);
  if (from < 0) return set;
  const to = clamp(Math.trunc(toIndex), 0, set.layouts.length - 1);
  if (to === from) return set;
  const layouts = set.layouts.filter((_, index) => index !== from);
  layouts.splice(to, 0, set.layouts[from]);
  return { ...set, layouts };
}

/**
 * Hide a layout from the rail, or show it again. The last visible layout is
 * never hidden. Hiding the open one opens the next visible layout, or the
 * nearest one before it when none comes after.
 */
export function setHidden(set: TileSet, id: LayoutId, hidden: boolean): TileSet {
  const at = indexOf(set, id);
  if (at < 0) return set;
  const already = isHidden(set, id);
  if (!hidden) {
    if (!already) return set;
    return { ...set, hidden: set.hidden.filter((other) => other !== id) };
  }
  if (already || visibleCount(set) < 2) return set;
  const current =
    set.current === id ? (visibleAfter(set, at) ?? visibleBefore(set, at) ?? set.current) : set.current;
  return { ...set, hidden: [...set.hidden, id], current };
}

/** Open a layout. Refused for one the desk does not have, and for a hidden one. */
export function setCurrent(set: TileSet, id: LayoutId): TileSet {
  if (set.current === id || indexOf(set, id) < 0 || isHidden(set, id)) return set;
  return { ...set, current: id };
}

// ----------------------------------------------------------- reading a tree

/**
 * `null` for a node there is nothing usable in, and `ok: false` for a value
 * nested past the cap, which is reported all the way up so the WHOLE tree is
 * replaced rather than quietly truncated at the cap.
 */
type ParsedNode = { ok: true; node: TileNode | null } | { ok: false };

const NO_NODE: ParsedNode = { ok: true, node: null };
const TOO_DEEP: ParsedNode = { ok: false };

function parseNode(value: unknown, depth: number, seen: Set<PaneId>): ParsedNode {
  if (depth > MAX_TREE_DEPTH) return TOO_DEEP;
  const stored = plain(value);
  if (stored === null) return NO_NODE;
  const id = typeof stored.id === "string" ? stored.id : "";

  if (stored.kind === "leaf") {
    const listed = Array.isArray(stored.tabs) ? (stored.tabs as unknown[]) : [];
    const tabs: PaneId[] = [];
    for (const tab of listed) {
      if (typeof tab !== "string") continue;
      if (!KNOWN_PANES.includes(tab)) continue;
      // A pane lives in exactly one leaf, so a second listing of it is the one
      // that goes: its first place is the one the user last saw it in.
      if (seen.has(tab)) continue;
      seen.add(tab);
      tabs.push(tab);
    }
    if (tabs.length === 0) return NO_NODE;
    const active =
      typeof stored.active === "string" && tabs.includes(stored.active) ? stored.active : tabs[0];
    return { ok: true, node: { kind: "leaf", id, tabs, active } };
  }

  if (stored.kind !== "split") return NO_NODE;
  const first = parseNode(stored.first, depth + 1, seen);
  if (!first.ok) return TOO_DEEP;
  const second = parseNode(stored.second, depth + 1, seen);
  if (!second.ok) return TOO_DEEP;
  if (first.node === null) return { ok: true, node: second.node };
  if (second.node === null) return { ok: true, node: first.node };
  return {
    ok: true,
    node: {
      kind: "split",
      id,
      dir: stored.dir === "v" ? "v" : "h",
      ratio: typeof stored.ratio === "number" ? stored.ratio : EVEN_RATIO,
      first: first.node,
      second: second.node,
    },
  };
}

/**
 * A stored tree made safe to put on screen: filtered, normalized (which holds
 * every ratio to four decimals) and given ids it could have made itself. Null
 * when nothing survived, or when the value was nested past the cap.
 */
function repairedTree(value: unknown): TileNode | null {
  const parsed = parseNode(value, 1, new Set<PaneId>());
  if (!parsed.ok) return null;
  const tree = normalize(parsed.node);
  if (tree === null) return null;
  // Before anything else looks the tree up by id: two nodes carrying one id
  // would be found and rewritten together.
  return hasSoundIds(tree) ? tree : withCanonicalIds(tree);
}

/** A stored ratio, or null when there is no usable number there at all. */
function heldRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return normalizeRatio(value);
}

function parseLastSpot(value: unknown): Record<PaneId, Spot> {
  const out: Record<PaneId, Spot> = {};
  const stored = plain(value);
  if (stored === null) return out;
  for (const pane of KNOWN_PANES) {
    if (!own(stored, pane)) continue;
    const spot = plain(stored[pane]);
    if (spot === null) continue;
    const beside = spot.beside;
    if (typeof beside !== "string" || !KNOWN_PANES.includes(beside)) continue;
    const zone = spot.zone;
    if (typeof zone !== "string" || !ZONES.includes(zone as Zone)) continue;
    // A spot that is a tab has no divider of its own, so it carries no ratio.
    const ratio = zone === "centre" ? null : heldRatio(spot.ratio);
    out[pane] = { beside, zone: zone as Zone, ratio };
  }
  return out;
}

/** Only the keys and values the catalog declares, and only those that are not the fallback. */
function parseOptions(value: unknown): Record<PaneId, Record<string, string>> {
  const out: Record<PaneId, Record<string, string>> = {};
  const stored = plain(value);
  if (stored === null) return out;
  for (const spec of PANES) {
    if (spec.options.length === 0 || !own(stored, spec.id)) continue;
    const held = plain(stored[spec.id]);
    if (held === null) continue;
    const kept: Record<string, string> = {};
    for (const option of spec.options) {
      if (!own(held, option.key)) continue;
      const chosen = held[option.key];
      if (typeof chosen !== "string" || chosen === option.fallback) continue;
      if (!option.choices.some((candidate) => candidate.value === chosen)) continue;
      kept[option.key] = chosen;
    }
    if (Object.keys(kept).length > 0) out[spec.id] = kept;
  }
  return out;
}

/**
 * One stored slot, repaired, or null when there is nothing to keep: a value
 * that is not an object, or one that comes out equal to the layout's default.
 */
function parseArrangement(
  value: unknown,
  cls: ScreenClass,
  base: BuiltInLayoutId,
): Arrangement | null {
  const stored = plain(value);
  if (stored === null) return null;
  const tree = repairedTree(stored.tree) ?? defaultTree(cls, base);
  // Behaviour 18 and amendment B. A maximize survives only on a pane that is
  // open AND in front of its leaf, because the focus is that pane and the
  // focus must be visible. The tree is not rewritten to suit it: which tab is
  // in front is part of what the user arranged.
  const storedMaximized = stored.maximized;
  const maximizedLeaf =
    typeof storedMaximized === "string" ? leafOf(tree, storedMaximized) : null;
  const maximized =
    maximizedLeaf !== null && maximizedLeaf.active === storedMaximized ? storedMaximized : null;
  const focus = maximized ?? leavesOf(tree)[0]?.active ?? null;
  let arrangement: Arrangement = {
    tree,
    maximized,
    focus,
    lastSpot: parseLastSpot(stored.lastSpot),
    options: parseOptions(stored.options),
  };
  if (cls === "compact") arrangement = flatten(arrangement);
  return isDefault(arrangement, defaultArrangement(cls, base)) ? null : arrangement;
}

function parseLayouts(listed: readonly unknown[]): LayoutMeta[] {
  const out: LayoutMeta[] = [];
  const seen = new Set<LayoutId>();
  let users = 0;
  for (const entry of listed) {
    const stored = plain(entry);
    if (stored === null || typeof stored.id !== "string") continue;
    const id = stored.id;
    if (seen.has(id)) continue;
    const builtIn = BUILT_IN_LAYOUTS.find((meta) => meta.id === id);
    if (builtIn !== undefined) {
      // Whatever was stored, a built in layout's title and base are the catalog's.
      seen.add(id);
      out.push(builtIn);
      continue;
    }
    if (userNumber(id) === null || users >= USER_LAYOUT_ROOM) continue;
    seen.add(id);
    users += 1;
    out.push({
      id,
      title: cleanTitle(typeof stored.title === "string" ? stored.title : ""),
      base: isBuiltIn(stored.base) ? stored.base : FIRST_LAYOUT,
    });
  }
  for (const meta of BUILT_IN_LAYOUTS) {
    if (!seen.has(meta.id)) out.push(meta);
  }
  return out;
}

function parseHidden(listed: readonly unknown[], layouts: readonly LayoutMeta[]): LayoutId[] {
  const known = layouts.map((meta) => meta.id);
  const out: LayoutId[] = [];
  for (const id of listed) {
    if (typeof id !== "string" || !known.includes(id) || out.includes(id)) continue;
    out.push(id);
  }
  // Never every layout: the first on the rail is shown again.
  if (out.length === known.length) return out.filter((id) => id !== known[0]);
  return out;
}

/**
 * Whatever came out of storage, as a desk. A value that is not a desk of this
 * version (the three containers it is made of missing or of the wrong kind
 * included) comes back as the empty desk, which is the whole point: there is
 * one shape the engine understands and everything else is a fresh start.
 */
export function parseTileSet(value: unknown): TileSet {
  const stored = record(value);
  if (stored === null || stored.version !== TILE_SET_VERSION) return EMPTY_TILE_SET;
  if (!Array.isArray(stored.layouts) || !Array.isArray(stored.hidden)) return EMPTY_TILE_SET;
  const storedSlots = plain(stored.slots);
  if (storedSlots === null) return EMPTY_TILE_SET;

  const layouts = parseLayouts(stored.layouts as unknown[]);
  const hidden = parseHidden(stored.hidden as unknown[], layouts);
  const visible = layouts.map((meta) => meta.id).filter((id) => !hidden.includes(id));
  const current =
    typeof stored.current === "string" && visible.includes(stored.current)
      ? stored.current
      : visible[0];

  const slots: TileSet["slots"] = {};
  for (const meta of layouts) {
    if (!own(storedSlots, meta.id)) continue;
    const classes = plain(storedSlots[meta.id]);
    if (classes === null) continue;
    const kept: Partial<Record<ScreenClass, Arrangement>> = {};
    for (const cls of SCREEN_CLASSES) {
      if (!own(classes, cls)) continue;
      const arrangement = parseArrangement(classes[cls], cls, meta.base);
      if (arrangement !== null) kept[cls] = arrangement;
    }
    if (Object.keys(kept).length > 0) slots[meta.id] = kept;
  }
  return { version: TILE_SET_VERSION, layouts, hidden, current, slots };
}

// ---------------------------------------------------------------- writing

function plainTree(node: TileNode | null): unknown {
  if (node === null) return null;
  if (node.kind === "leaf") {
    return { kind: node.kind, id: node.id, tabs: [...node.tabs], active: node.active };
  }
  return {
    kind: node.kind,
    id: node.id,
    dir: node.dir,
    ratio: node.ratio,
    first: plainTree(node.first),
    second: plainTree(node.second),
  };
}

/** One arrangement as it is stored: no focus, and every record walked in the catalog's order. */
function plainArrangement(arrangement: Arrangement): unknown {
  const lastSpot: Record<string, unknown> = {};
  for (const pane of KNOWN_PANES) {
    if (!own(arrangement.lastSpot, pane)) continue;
    const spot = arrangement.lastSpot[pane];
    lastSpot[pane] = { beside: spot.beside, zone: spot.zone, ratio: spot.ratio };
  }
  const options: Record<string, unknown> = {};
  for (const spec of PANES) {
    if (!own(arrangement.options, spec.id)) continue;
    const held = arrangement.options[spec.id];
    const kept: Record<string, string> = {};
    for (const option of spec.options) {
      if (own(held, option.key)) kept[option.key] = held[option.key];
    }
    if (Object.keys(kept).length > 0) options[spec.id] = kept;
  }
  return {
    tree: plainTree(arrangement.tree),
    maximized: arrangement.maximized,
    lastSpot,
    options,
  };
}

/**
 * The text to store. Every object is built here in one fixed order and every
 * record is walked in an order of the engine's own (the rail, the classes, the
 * catalog), so two desks that are equal produce the same text whatever order
 * their keys happened to be written in. That is what lets a caller compare the
 * stored text instead of the state.
 *
 * The focus is left out (amendment B), so a change of focus alone does not
 * change the text; a change of the tab in front does, through the tree.
 */
export function serializeTileSet(set: TileSet): string {
  const slots: Record<string, unknown> = {};
  for (const meta of set.layouts) {
    if (!own(set.slots, meta.id)) continue;
    const held = set.slots[meta.id];
    const classes: Record<string, unknown> = {};
    for (const cls of SCREEN_CLASSES) {
      if (!own(held, cls)) continue;
      const arrangement = held[cls];
      if (arrangement !== undefined) classes[cls] = plainArrangement(arrangement);
    }
    if (Object.keys(classes).length > 0) slots[meta.id] = classes;
  }
  return JSON.stringify({
    version: set.version,
    layouts: set.layouts.map((meta) => ({ id: meta.id, title: meta.title, base: meta.base })),
    hidden: [...set.hidden],
    current: set.current,
    slots,
  });
}
