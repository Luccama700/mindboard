// What there is to arrange: the fourteen panes and the view options they offer,
// the four built in layouts, and the tree each of them starts from on each
// screen class.
//
// WHY THE DEFAULTS ARE DATA AND NOT A LAYOUT ALGORITHM. There is no general
// answer to "where should these panes go": the right first arrangement depends
// on what the user came to do, which is the whole reason there are four layouts
// rather than one. So each is written out, and the test asserts the only things
// that can be checked rather than decided: every pane in it is a catalog pane
// open at most once, the tree fits its screen class at the minimum sizes below,
// and the phone's is one stack.
//
// THE DEFAULTS ARE FROZEN AND THERE IS ONE OF EACH. `defaultArrangement` hands
// back the same object every time it is asked the same question, which is what
// lets the store answer "nothing is stored for this layout" with the default
// itself, and lets a caller see by identity that a layout is untouched.
//
// This module imports nothing but the types, so geometry.ts and tree.ts can
// both default their `specs` to the catalog without an import cycle.
//
// Pure. No DOM, no storage, no clock, no randomness.

import type {
  Arrangement,
  BuiltInLayoutId,
  LayoutMeta,
  PaneId,
  PaneOption,
  PaneSpec,
  ScreenClass,
  SplitDir,
  TileNode,
  Zone,
} from "./types";

/** What a pane needs before its content stops making sense. */
const SIDE_MIN_WIDTH = 230;
const SIDE_MIN_HEIGHT = 150;
const DAY_MIN_WIDTH = 320;
const DAY_MIN_HEIGHT = 320;
const CALENDAR_MIN_WIDTH = 320;
const CALENDAR_MIN_HEIGHT = 300;
const LANES_MIN_WIDTH = 240;
const LANES_MIN_HEIGHT = 160;
const STEPS_MIN_WIDTH = 260;
const STEPS_MIN_HEIGHT = 200;
const FORECAST_MIN_WIDTH = 320;
const FORECAST_MIN_HEIGHT = 280;
const LEDGER_MIN_WIDTH = 260;
const LEDGER_MIN_HEIGHT = 180;

/** Below this the desk is the phone's: one pane at a time, from the bottom bar. */
export const TILES_MIN_WIDTH = 1024;

/** From here a third column is worth having. */
export const WIDE_MIN_WIDTH = 1600;

/** The most layouts a desk holds: the four built in and eight of the user's. */
export const MAX_LAYOUTS = 12;

// ------------------------------------------------------------ the options

function choice(value: string, label: string): { value: string; label: string } {
  return { value, label };
}

const CALENDAR_DAYS: PaneOption = {
  key: "days",
  label: "Days",
  choices: [
    choice("auto", "Automatic"),
    choice("1", "1 day"),
    choice("3", "3 days"),
    choice("7", "7 days"),
  ],
  fallback: "auto",
};

const STEPS_GROUP: PaneOption = {
  key: "group",
  label: "Group by",
  choices: [choice("none", "Nothing"), choice("group", "Lane")],
  fallback: "none",
};

const SIDE_QUESTS_SORT: PaneOption = {
  key: "sort",
  label: "Sort by",
  choices: [choice("clock", "Clock"), choice("added", "Date added")],
  fallback: "clock",
};

const DONE_SPAN: PaneOption = {
  key: "span",
  label: "Show",
  choices: [choice("7", "7 days"), choice("14", "14 days"), choice("28", "28 days")],
  fallback: "14",
};

const FORECAST_SPAN: PaneOption = {
  key: "span",
  label: "Show",
  choices: [choice("14", "14 days"), choice("30", "30 days"), choice("60", "60 days")],
  fallback: "30",
};

const LEDGER_ROWS: PaneOption = {
  key: "rows",
  label: "Show",
  choices: [choice("10", "10 rows"), choice("25", "25 rows"), choice("50", "50 rows")],
  fallback: "25",
};

// ------------------------------------------------------------- the panes

function pane(
  id: PaneId,
  title: string,
  short: string,
  group: PaneSpec["group"],
  minWidth: number,
  minHeight: number,
  options: readonly PaneOption[] = [],
): PaneSpec {
  return { id, title, short, group, minWidth, minHeight, options };
}

/**
 * The panes, in the order the pane list shows them. Every one of them can be
 * closed: a layout is kept from being emptied by refusing to close the LAST
 * pane open, whichever it is, not by protecting one pane in every layout.
 */
export const PANES: readonly PaneSpec[] = [
  pane("today", "The day", "Day", "day", DAY_MIN_WIDTH, DAY_MIN_HEIGHT),
  pane("status", "Status", "Status", "day", SIDE_MIN_WIDTH, SIDE_MIN_HEIGHT),
  pane("past-due", "Past their date", "Past", "day", SIDE_MIN_WIDTH, SIDE_MIN_HEIGHT),
  pane("not-today", "Did not fit today", "Did not fit", "day", SIDE_MIN_WIDTH, SIDE_MIN_HEIGHT),
  pane("calendar", "Calendar", "Calendar", "day", CALENDAR_MIN_WIDTH, CALENDAR_MIN_HEIGHT, [
    CALENDAR_DAYS,
  ]),
  pane("lanes", "Lanes", "Lanes", "quests", LANES_MIN_WIDTH, LANES_MIN_HEIGHT),
  pane("steps", "Steps", "Steps", "quests", STEPS_MIN_WIDTH, STEPS_MIN_HEIGHT, [STEPS_GROUP]),
  pane("side-quests", "Side quests", "Side", "quests", LANES_MIN_WIDTH, LANES_MIN_HEIGHT, [
    SIDE_QUESTS_SORT,
  ]),
  pane("done", "Done lately", "Done", "quests", SIDE_MIN_WIDTH, SIDE_MIN_HEIGHT, [DONE_SPAN]),
  pane("forecast", "Forecast", "Forecast", "money", FORECAST_MIN_WIDTH, FORECAST_MIN_HEIGHT, [
    FORECAST_SPAN,
  ]),
  pane("accounts", "Accounts", "Accounts", "money", SIDE_MIN_WIDTH, SIDE_MIN_HEIGHT),
  pane("coming-up", "Coming up", "Coming up", "money", SIDE_MIN_WIDTH, SIDE_MIN_HEIGHT),
  pane("hours", "Hours", "Hours", "money", SIDE_MIN_WIDTH, SIDE_MIN_HEIGHT),
  pane("ledger", "Transactions", "Recent", "money", LEDGER_MIN_WIDTH, LEDGER_MIN_HEIGHT, [
    LEDGER_ROWS,
  ]),
];

// ------------------------------------------------------------ the layouts

function layout(id: BuiltInLayoutId, title: string): LayoutMeta {
  return Object.freeze({ id, title, base: id });
}

/** The four layouts every desk has, in the rail's first order. Each is its own base. */
export const BUILT_IN_LAYOUTS: readonly LayoutMeta[] = Object.freeze([
  layout("today", "Today"),
  layout("week", "Week"),
  layout("quests", "Quests"),
  layout("money", "Money"),
]);

const FIRST_LAYOUT: BuiltInLayoutId = "today";

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

/**
 * The class a workspace of this width is. Never null: anything that is not a
 * usable width (not a number, negative, infinite) is read as the smallest
 * screen, because the phone's single stack is the arrangement that works at
 * any size.
 */
export function screenClassFor(width: number): ScreenClass {
  if (!Number.isFinite(width) || width < TILES_MIN_WIDTH) return "compact";
  return width >= WIDE_MIN_WIDTH ? "wide" : "regular";
}

// -------------------------------------------------------------- the trees

/**
 * A default is written as a shape with no ids, and the ids are put on while it
 * is built: numbered down the tree from one, so a stored layout can be
 * compared with it and a parsed one keeps the same ids.
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

/** The tab the first leaf shows, which is where a fresh layout's focus starts. */
function firstFront(node: TileNode): PaneId {
  return node.kind === "leaf" ? node.active : firstFront(node.first);
}

/**
 * The twelve trees, the plan's table written out. Wide screens break the side
 * lists out; regular screens have room for two or three columns, so they ride
 * as tabs; the phone has one stack, in the order its bar shows them.
 */
const DEFAULT_SHAPES: Record<ScreenClass, Record<BuiltInLayoutId, Shape>> = {
  wide: {
    today: beside(
      0.5,
      beside(
        0.5,
        above(0.67, stack("today"), stack("status")),
        above(0.5, stack("past-due"), stack("not-today")),
      ),
      stack("calendar"),
    ),
    week: beside(
      0.29,
      above(0.56, stack("not-today", "past-due"), stack("today", "status")),
      stack("calendar"),
    ),
    quests: beside(
      0.3,
      above(0.5, stack("lanes"), stack("done")),
      beside(0.55, stack("steps"), above(0.5, stack("side-quests"), stack("past-due"))),
    ),
    money: beside(
      0.52,
      stack("forecast"),
      beside(
        0.5,
        above(0.5, stack("accounts"), stack("hours")),
        above(0.55, stack("coming-up"), stack("ledger")),
      ),
    ),
  },
  regular: {
    today: beside(0.5, stack("today", "status", "past-due", "not-today"), stack("calendar")),
    week: beside(0.3, stack("not-today", "past-due", "today", "status"), stack("calendar")),
    quests: beside(
      0.36,
      stack("lanes"),
      beside(0.5, stack("steps"), stack("side-quests", "past-due", "done")),
    ),
    money: beside(
      0.58,
      stack("forecast"),
      above(0.5, stack("accounts", "hours"), stack("coming-up", "ledger")),
    ),
  },
  compact: {
    today: stack("today", "status", "past-due", "not-today", "calendar"),
    week: stack("calendar", "not-today", "past-due"),
    quests: stack("lanes", "steps", "side-quests", "past-due", "done"),
    money: stack("forecast", "accounts", "coming-up", "hours", "ledger"),
  },
};

const SCREEN_CLASSES: readonly ScreenClass[] = ["compact", "regular", "wide"];

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

function buildDefaults(): Record<ScreenClass, Record<BuiltInLayoutId, Arrangement>> {
  const out = {} as Record<ScreenClass, Record<BuiltInLayoutId, Arrangement>>;
  for (const cls of SCREEN_CLASSES) {
    const byLayout = {} as Record<BuiltInLayoutId, Arrangement>;
    for (const meta of BUILT_IN_LAYOUTS) {
      const tree = build(DEFAULT_SHAPES[cls][meta.base], { value: 1 });
      byLayout[meta.base] = deepFreeze({
        tree,
        maximized: null,
        focus: firstFront(tree),
        lastSpot: {},
        options: {},
      });
    }
    out[cls] = byLayout;
  }
  return out;
}

/** Built once, when the module loads, and handed out by reference ever after. */
const DEFAULTS = buildDefaults();

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * The default arrangement of a built in layout on a screen class: the SAME
 * frozen object every call. A base or a class the catalog does not list falls
 * back to the first layout and the regular class, so a value from anywhere
 * still gets a layout that can be drawn.
 */
export function defaultArrangement(cls: ScreenClass, base: BuiltInLayoutId): Arrangement {
  const byLayout = own(DEFAULTS, cls) ? DEFAULTS[cls] : DEFAULTS.regular;
  return own(byLayout, base) ? byLayout[base] : byLayout[FIRST_LAYOUT];
}

/** The default arrangement's tree, the same frozen object every call. */
export function defaultTree(cls: ScreenClass, base: BuiltInLayoutId): TileNode {
  // Every default is built from a shape with at least one tab, so it has a tree.
  return defaultArrangement(cls, base).tree as TileNode;
}
