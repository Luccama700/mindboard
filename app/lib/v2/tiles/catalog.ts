// What there is to arrange: the five panes, the three named arrangements, and
// the tree each of them starts from on each screen size.
//
// WHY THE DEFAULTS ARE DATA AND NOT A LAYOUT ALGORITHM. There is no general
// answer to "where should five panes go": the right first arrangement depends
// on what the user came to do, which is the whole reason there are three of
// them rather than one. So each is written out, and the test asserts the only
// two things that can be checked rather than decided: every pane is open
// exactly once, and the tree fits its screen class at the minimum sizes below.
//
// Pure. No DOM, no storage, no clock, no randomness.

import { leavesOf } from "./tree";
import type {
  Arrangement,
  PaneId,
  PaneSpec,
  ScreenClass,
  SplitDir,
  TileNode,
  Zone,
} from "./types";

const TODAY: PaneId = "today";
const CALENDAR: PaneId = "calendar";
const STATUS: PaneId = "status";
const PAST_DUE: PaneId = "past-due";
const NOT_TODAY: PaneId = "not-today";

/** What a pane needs before its content stops making sense. */
const SIDE_MIN_WIDTH = 230;
const SIDE_MIN_HEIGHT = 150;
const TODAY_MIN_WIDTH = 320;
const TODAY_MIN_HEIGHT = 320;
const CALENDAR_MIN_WIDTH = 320;
const CALENDAR_MIN_HEIGHT = 300;

/**
 * Below this there are no tiles at all: the phone gets one pane at a time, and
 * `screenClassFor` says so by answering null.
 */
export const TILES_MIN_WIDTH = 1024;

/** From here a third column is worth having. */
export const WIDE_MIN_WIDTH = 1600;

/**
 * The panes, in the order a rail would list them.
 *
 * Today cannot be closed. It is the one pane the screen is about, and a
 * workspace with everything shut is a state the user has no way out of.
 */
export const PANES: readonly PaneSpec[] = [
  {
    id: TODAY,
    title: "Today",
    minWidth: TODAY_MIN_WIDTH,
    minHeight: TODAY_MIN_HEIGHT,
    closable: false,
  },
  {
    id: CALENDAR,
    title: "Calendar",
    minWidth: CALENDAR_MIN_WIDTH,
    minHeight: CALENDAR_MIN_HEIGHT,
    closable: true,
  },
  {
    id: STATUS,
    title: "Status",
    minWidth: SIDE_MIN_WIDTH,
    minHeight: SIDE_MIN_HEIGHT,
    closable: true,
  },
  {
    id: PAST_DUE,
    title: "Past their date",
    minWidth: SIDE_MIN_WIDTH,
    minHeight: SIDE_MIN_HEIGHT,
    closable: true,
  },
  {
    id: NOT_TODAY,
    title: "Did not fit today",
    minWidth: SIDE_MIN_WIDTH,
    minHeight: SIDE_MIN_HEIGHT,
    closable: true,
  },
];

/** The named arrangements, in the order a rail would offer them. */
export const ARRANGEMENTS: readonly [
  { name: "today"; title: "Today" },
  { name: "plan"; title: "Plan the week" },
  { name: "backlog"; title: "Clear the backlog" },
] = [
  { name: "today", title: "Today" },
  { name: "plan", title: "Plan the week" },
  { name: "backlog", title: "Clear the backlog" },
];

/**
 * What a drop reads as while it is being made. Each word is followed by the
 * name of the pane being dropped onto, so they are prefixes and carry no
 * trailing space of their own.
 */
export const TILE_COPY: { zone: Record<Zone, string> } = {
  zone: {
    left: "Left of",
    right: "Right of",
    top: "Above",
    bottom: "Below",
    centre: "Make a tab of",
  },
};

export function screenClassFor(width: number): ScreenClass | null {
  if (!Number.isFinite(width) || width < TILES_MIN_WIDTH) return null;
  return width >= WIDE_MIN_WIDTH ? "wide" : "regular";
}

// -------------------------------------------------------------- the trees

/**
 * A default is written as a shape with no ids, and the ids are put on while it
 * is built: numbered down the tree from one, so two builds of the same default
 * give the same tree and a saved layout can be compared with it.
 */
interface StackShape {
  tabs: readonly PaneId[];
}

interface SplitShape {
  dir: SplitDir;
  ratio: number;
  first: Shape;
  second: Shape;
}

type Shape = StackShape | SplitShape;

function stack(...tabs: PaneId[]): StackShape {
  return { tabs };
}

function beside(ratio: number, first: Shape, second: Shape): SplitShape {
  return { dir: "h", ratio, first, second };
}

function above(ratio: number, first: Shape, second: Shape): SplitShape {
  return { dir: "v", ratio, first, second };
}

function build(shape: Shape, next: { value: number }): TileNode {
  const number = next.value;
  next.value += 1;
  if ("tabs" in shape) {
    return { kind: "leaf", id: `l${number}`, tabs: [...shape.tabs], active: shape.tabs[0] };
  }
  return {
    kind: "split",
    id: `s${number}`,
    dir: shape.dir,
    ratio: shape.ratio,
    first: build(shape.first, next),
    second: build(shape.second, next),
  };
}

/**
 * The six trees. Regular screens have room for two columns, so the side lists
 * ride as tabs; wide screens break them out.
 */
const DEFAULT_SHAPES: Record<ScreenClass, Record<string, Shape>> = {
  wide: {
    today: beside(
      0.5,
      beside(
        0.5,
        above(0.67, stack(TODAY), stack(STATUS)),
        above(0.5, stack(PAST_DUE), stack(NOT_TODAY)),
      ),
      stack(CALENDAR),
    ),
    plan: beside(
      0.29,
      above(0.56, stack(NOT_TODAY, PAST_DUE), stack(TODAY, STATUS)),
      stack(CALENDAR),
    ),
    backlog: beside(
      0.25,
      above(0.65, stack(TODAY), stack(STATUS)),
      beside(0.8, beside(0.5, stack(PAST_DUE), stack(NOT_TODAY)), stack(CALENDAR)),
    ),
  },
  regular: {
    today: beside(0.5, stack(TODAY, STATUS, PAST_DUE, NOT_TODAY), stack(CALENDAR)),
    plan: beside(0.3, stack(NOT_TODAY, PAST_DUE, TODAY, STATUS), stack(CALENDAR)),
    backlog: beside(
      0.72,
      beside(0.5, stack(PAST_DUE), stack(NOT_TODAY)),
      stack(CALENDAR, TODAY, STATUS),
    ),
  },
};

/** A name the catalog does not list falls back to the first arrangement. */
export function defaultTree(cls: ScreenClass, name: string): TileNode {
  const shapes = DEFAULT_SHAPES[cls];
  const shape = Object.prototype.hasOwnProperty.call(shapes, name)
    ? shapes[name]
    : shapes[ARRANGEMENTS[0].name];
  return build(shape, { value: 1 });
}

export function defaultArrangement(cls: ScreenClass, name: string): Arrangement {
  const tree = defaultTree(cls, name);
  return { tree, maximized: null, focus: leavesOf(tree)[0].active, lastSpot: {} };
}
