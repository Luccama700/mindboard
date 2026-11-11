// What is saved, and the parser that reads it back.
//
// ONE SLOT PER SCREEN SIZE, AND NEVER A LOAN BETWEEN THEM. A layout that works
// on a 1600 pixel screen is the wrong layout on a 1024 pixel one: the same tree
// that reads as three columns on the first is three slivers on the second. So
// each screen class keeps its own slot and falls back to its OWN default, never
// to the other class's saved state. A laptop that borrowed the desktop's layout
// was the defect that made this rule explicit.
//
// THE PARSER CANNOT RETURN A BROKEN SCREEN. The value it reads lives in the
// user's browser, so it can be absent, truncated, written by an older build or
// hand edited. Whatever comes back decides what is on screen, and a screen with
// no pane open has no control on it either, so there is no way out of it. Every
// repair below exists to make that state unreachable:
//
//   a pane the catalog does not know   dropped, and the tree normalized
//   a pane listed twice               kept in its first place only
//   a tree with nothing left open     replaced by that class's default
//   a tree deeper than the cap        replaced, checked while descending so a
//                                     value that points at itself terminates
//   the pane that cannot be closed    put back where it was remembered
//   ids missing, malformed, repeated  numbered again
//   maximized or focus not open       null, and the first pane that is open
//   a saved name nobody offers        dropped
//
// It never clamps a ratio to a workspace, because it has no workspace: the
// layout does that, for drawing, and writes nothing back.
//
// Only the allowlists below are ever iterated, so a stored key named
// `__proto__`, `constructor` or `prototype` is not read at all and nothing on
// Object.prototype can be reached through a value from storage.
//
// Pure. No DOM, no storage, no clock, no randomness: a client reads and writes
// the browser and hands whatever came back to parseTileSet.

import { ARRANGEMENTS, PANES, defaultArrangement, defaultTree } from "./catalog";
import {
  hasSoundIds,
  leafOf,
  leavesOf,
  normalize,
  openPane,
  openPanes,
  signature,
  withCanonicalIds,
} from "./tree";
import type { Arrangement, PaneId, ScreenClass, Spot, TileNode, Zone } from "./types";

/** One screen class's whole state: what is current, what is on screen, what is kept. */
export interface ClassState {
  current: string;
  working: Arrangement;
  saved: Record<string, TileNode>;
}

export interface TileSet {
  version: 1;
  classes: Partial<Record<ScreenClass, ClassState>>;
}

const TILE_SET_VERSION = 1;

/** The only class keys there are, and the only ones ever read from a value. */
const SCREEN_CLASSES: readonly ScreenClass[] = ["regular", "wide"];

const ZONES: readonly Zone[] = ["left", "right", "top", "bottom", "centre"];

const KNOWN_PANES: readonly PaneId[] = PANES.map((pane) => pane.id);

const ARRANGEMENT_NAMES: readonly string[] = ARRANGEMENTS.map((entry) => entry.name);

/**
 * How deep a stored tree may be. Five panes can make at most five leaves and so
 * at most five levels, so this is not a limit on anything the engine can build:
 * it is what stops a hand written value, or one that points at itself, from
 * being descended forever.
 */
const MAX_TREE_DEPTH = 12;

/** The range a stored ratio is held in, the same one normalize uses. */
const RATIO_MIN = 0.05;
const RATIO_MAX = 0.95;
const EVEN_RATIO = 0.5;

export const EMPTY_TILE_SET: TileSet = Object.freeze({
  version: TILE_SET_VERSION,
  classes: Object.freeze({}),
});

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function heldRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, value));
}

function arrangementName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return ARRANGEMENT_NAMES.includes(value) ? value : null;
}

// ----------------------------------------------------------- reading a tree

/**
 * `null` for a node there is nothing usable in, and `ok: false` for a value
 * nested past the cap, which is reported all the way up so the WHOLE tree is
 * replaced rather than quietly truncated at the twelfth level.
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
 * A stored tree made safe to put on screen: filtered, normalized, given ids it
 * could have made itself, and holding every pane that cannot be closed. A tree
 * nothing survived in is that arrangement's default.
 */
function repairedTree(
  value: unknown,
  cls: ScreenClass,
  name: string,
  lastSpot: Record<PaneId, Spot>,
): TileNode {
  const parsed = parseNode(value, 1, new Set<PaneId>());
  let tree = parsed.ok ? normalize(parsed.node) : null;
  if (tree === null) return defaultTree(cls, name);
  // Before anything else looks the tree up by id: two nodes carrying one id
  // would be found and rewritten together.
  if (!hasSoundIds(tree)) tree = withCanonicalIds(tree);

  let arrangement: Arrangement = { tree, maximized: null, focus: null, lastSpot };
  for (const spec of PANES) {
    if (spec.closable) continue;
    if (arrangement.tree !== null && leafOf(arrangement.tree, spec.id) !== null) continue;
    arrangement = openPane(arrangement, spec.id, null);
  }
  return arrangement.tree ?? defaultTree(cls, name);
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

function parseClassState(value: unknown, cls: ScreenClass): ClassState | null {
  const stored = plain(value);
  if (stored === null) return null;
  const current = arrangementName(stored.current) ?? ARRANGEMENTS[0].name;
  const working = plain(stored.working);
  const lastSpot = parseLastSpot(working === null ? null : working.lastSpot);
  const tree = repairedTree(working === null ? null : working.tree, cls, current, lastSpot);
  const open = openPanes(tree);

  const storedMaximized = working === null ? null : working.maximized;
  const maximized =
    typeof storedMaximized === "string" && open.includes(storedMaximized) ? storedMaximized : null;
  const storedFocus = working === null ? null : working.focus;
  const focus =
    typeof storedFocus === "string" && open.includes(storedFocus) ? storedFocus : (open[0] ?? null);

  const saved: Record<string, TileNode> = {};
  const storedSaved = plain(stored.saved);
  if (storedSaved !== null) {
    for (const name of ARRANGEMENT_NAMES) {
      if (!own(storedSaved, name)) continue;
      saved[name] = repairedTree(storedSaved[name], cls, name, lastSpot);
    }
  }

  return { current, working: { tree, maximized, focus, lastSpot }, saved };
}

/**
 * Whatever came out of storage, as a set. A value that is not a set of this
 * version comes back empty, which is the whole point: there is one shape the
 * engine understands and everything else is a fresh start.
 */
export function parseTileSet(value: unknown): TileSet {
  const stored = record(value);
  if (stored === null) return EMPTY_TILE_SET;
  if (stored.version !== TILE_SET_VERSION) return EMPTY_TILE_SET;
  const classes = plain(stored.classes);
  if (classes === null) return EMPTY_TILE_SET;
  const out: Partial<Record<ScreenClass, ClassState>> = {};
  for (const cls of SCREEN_CLASSES) {
    if (!own(classes, cls)) continue;
    const state = parseClassState(classes[cls], cls);
    // A slot nothing could be read from is left unstored, which is exactly the
    // state a screen class starts in: classState hands back its default.
    if (state !== null) out[cls] = state;
  }
  return { version: TILE_SET_VERSION, classes: out };
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

/**
 * The text to store. Every object is built here in one fixed order and every
 * record is walked in the catalog's order, so two sets that are equal produce
 * the same text whatever order their keys happened to be written in. That is
 * what lets a caller compare the stored text instead of the state.
 */
export function serializeTileSet(set: TileSet): string {
  const classes: Record<string, unknown> = {};
  for (const cls of SCREEN_CLASSES) {
    const state = set.classes[cls];
    if (state === undefined) continue;
    const lastSpot: Record<string, unknown> = {};
    for (const pane of KNOWN_PANES) {
      if (!own(state.working.lastSpot, pane)) continue;
      const spot = state.working.lastSpot[pane];
      lastSpot[pane] = { beside: spot.beside, zone: spot.zone, ratio: spot.ratio };
    }
    const saved: Record<string, unknown> = {};
    for (const name of ARRANGEMENT_NAMES) {
      if (!own(state.saved, name)) continue;
      saved[name] = plainTree(state.saved[name]);
    }
    classes[cls] = {
      current: state.current,
      working: {
        tree: plainTree(state.working.tree),
        maximized: state.working.maximized,
        focus: state.working.focus,
        lastSpot,
      },
      saved,
    };
  }
  return JSON.stringify({ version: set.version, classes });
}

// ----------------------------------------------------------------- slots

/** The stored slot for this screen class, or that class's own default. */
export function classState(set: TileSet, cls: ScreenClass): ClassState {
  const stored = set.classes[cls];
  if (stored !== undefined) return stored;
  const name = ARRANGEMENTS[0].name;
  return { current: name, working: defaultArrangement(cls, name), saved: {} };
}

/** One slot replaced. Every other slot comes back as the same object. */
export function withClassState(set: TileSet, cls: ScreenClass, state: ClassState): TileSet {
  if (set.classes[cls] === state) return set;
  return { version: TILE_SET_VERSION, classes: { ...set.classes, [cls]: state } };
}

/** One slot forgotten, so that class starts from its default again. */
export function resetClass(set: TileSet, cls: ScreenClass): TileSet {
  if (set.classes[cls] === undefined) return set;
  const classes: Partial<Record<ScreenClass, ClassState>> = {};
  for (const other of SCREEN_CLASSES) {
    if (other === cls) continue;
    const state = set.classes[other];
    if (state !== undefined) classes[other] = state;
  }
  return { version: TILE_SET_VERSION, classes };
}

// ------------------------------------------------------ named arrangements

/**
 * Switch to a named arrangement: its saved tree if there is one, its default if
 * not. Nothing stays maximized, because the layout underneath it has changed,
 * and where closed panes were is kept: that is the user's history, not the
 * arrangement's.
 *
 * Focus stays where it was when that pane is still open, so switching does not
 * move the keyboard out from under the user.
 */
export function applyArrangement(
  state: ClassState,
  cls: ScreenClass,
  name: string,
): ClassState {
  const known = arrangementName(name);
  if (known === null) return state;
  const tree = own(state.saved, known) ? state.saved[known] : defaultTree(cls, known);
  const open = openPanes(tree);
  const held = state.working.focus;
  const focus =
    held !== null && open.includes(held) ? held : (leavesOf(tree)[0]?.active ?? null);
  return {
    current: known,
    working: { tree, maximized: null, focus, lastSpot: state.working.lastSpot },
    saved: state.saved,
  };
}

/**
 * Keep what is on screen under a name. The tree is shared with the working
 * arrangement rather than copied, which is safe because every operation builds
 * a new tree instead of writing to this one.
 */
export function saveOver(state: ClassState, name: string): ClassState {
  const known = arrangementName(name);
  if (known === null) return state;
  const tree = state.working.tree;
  if (tree === null) return state;
  if (state.current === known && state.saved[known] === tree) return state;
  return { current: known, working: state.working, saved: { ...state.saved, [known]: tree } };
}

/**
 * Whether what is on screen differs from the arrangement it is called. Compared
 * by shape, so bringing a tab forward is not an edit and moving a divider is.
 */
export function isEdited(state: ClassState, cls: ScreenClass): boolean {
  const name = arrangementName(state.current) ?? ARRANGEMENTS[0].name;
  const reference = own(state.saved, name) ? state.saved[name] : defaultTree(cls, name);
  return signature(state.working.tree) !== signature(reference);
}
