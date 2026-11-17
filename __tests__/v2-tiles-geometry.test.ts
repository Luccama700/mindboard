// Task 3, the layout and the catalog. Amended by PLAN-DESK.md Task 1: the
// catalog now holds fourteen panes in three groups, four built in layouts, and
// twelve default trees, one per layout and screen class, the phone included.
//
// THE PROPERTY THIS FILE EXISTS FOR. A tiled workspace is only tiled if the
// panes and the dividers between them cover it exactly: no overlap, no gap, and
// no leaf under the size its content needs. That is one arithmetic statement,
// and it is checked here against every arrangement the catalog ships and
// against the shapes a user can drag their way into, at sizes from the tree's
// own minimum upwards.
//
// It is checked rather than eyeballed because the failures are invisible at a
// glance: a seam one pixel wide between two panes, a divider drawn over the
// pane beside it, a pane squeezed to 180 pixels where its content needs 230.
// The rounding that causes all three happens in one line of layoutTree.

import { describe, expect, test } from "vitest";

import {
  BUILT_IN_LAYOUTS,
  MAX_LAYOUTS,
  PANES,
  TILES_MIN_WIDTH,
  TILE_COPY,
  WIDE_MIN_WIDTH,
  defaultArrangement,
  defaultTree,
  screenClassFor,
} from "@/app/lib/v2/tiles/catalog";
import {
  GAP,
  drawnShare,
  layoutTree,
  minSize,
  neighbourOf,
  shareLimits,
  zoneAt,
  zoneRect,
} from "@/app/lib/v2/tiles/geometry";
import { leavesOf, openPanes, signature } from "@/app/lib/v2/tiles/tree";
import type {
  Arrangement,
  BuiltInLayoutId,
  Leaf,
  PaneId,
  Rect,
  ScreenClass,
  Split,
  SplitDir,
  TileNode,
  Workspace,
  Zone,
} from "@/app/lib/v2/tiles/types";

/** The workspace each tiled class's defaults are designed to fit. */
const REFERENCE: Record<"regular" | "wide", Workspace> = {
  regular: { width: 896, height: 600 },
  wide: { width: 1472, height: 700 },
};

const CLASSES: ScreenClass[] = ["compact", "regular", "wide"];
const TILED: Array<"regular" | "wide"> = ["regular", "wide"];
const BASES: BuiltInLayoutId[] = ["today", "week", "quests", "money"];

// Built from their code points rather than typed in, so this file does not
// itself contain the characters it is looking for.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

function leaf(id: string, ...tabs: PaneId[]): Leaf {
  return { kind: "leaf", id, tabs: [...tabs], active: tabs[0] };
}

function split(
  id: string,
  dir: SplitDir,
  ratio: number,
  first: TileNode,
  second: TileNode,
): Split {
  return { kind: "split", id, dir, ratio, first, second };
}

function arrangement(tree: TileNode): Arrangement {
  return { tree, maximized: null, focus: openPanes(tree)[0], lastSpot: {}, options: {} };
}

function splitById(node: TileNode, id: string): Split | null {
  if (node.kind === "leaf") return null;
  if (node.id === id) return node;
  return splitById(node.first, id) ?? splitById(node.second, id);
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}

/** Every pane in a line along one direction: the widest or tallest shape they can make. */
function line(dir: SplitDir, panes: readonly PaneId[]): TileNode {
  let next = 1;
  const build = (rest: readonly PaneId[]): TileNode => {
    const number = next;
    next += 1;
    if (rest.length === 1) return leaf(`l${number}`, rest[0]);
    const ratio = 1 / rest.length;
    return split(`s${number}`, dir, ratio, leaf(`l${number + 100}`, rest[0]), build(rest.slice(1)));
  };
  return build(panes);
}

/** All five day panes side by side: the widest shape the stage 1 panes can make. */
function row(): TileNode {
  return split(
    "s1",
    "h",
    0.2,
    leaf("l2", "today"),
    split(
      "s3",
      "h",
      0.3,
      leaf("l4", "status"),
      split(
        "s5",
        "h",
        0.4,
        leaf("l6", "past-due"),
        split("s7", "h", 0.5, leaf("l8", "not-today"), leaf("l9", "calendar")),
      ),
    ),
  );
}

/** The same five stacked, which is the tallest shape they can make. */
function column(): TileNode {
  return split(
    "s1",
    "v",
    0.2,
    leaf("l2", "today"),
    split(
      "s3",
      "v",
      0.3,
      leaf("l4", "status"),
      split(
        "s5",
        "v",
        0.4,
        leaf("l6", "past-due"),
        split("s7", "v", 0.5, leaf("l8", "not-today"), leaf("l9", "calendar")),
      ),
    ),
  );
}

/**
 * The leaf and divider rectangles cover the workspace exactly, and no leaf is
 * under its minimum. `maximized` is cleared first: a maximized pane is given
 * the whole workspace on purpose, which is the one state that is not a tiling.
 */
function expectTiling(
  source: Arrangement,
  workspace: Workspace,
  label: string,
): void {
  const flat: Arrangement = { ...source, maximized: null };
  const rects = layoutTree(flat, workspace, PANES);
  const all: Rect[] = [...rects.leaves, ...rects.dividers];
  let area = 0;
  for (const rect of all) {
    for (const value of [rect.x, rect.y, rect.w, rect.h]) {
      expect(Number.isFinite(value), `${label}: finite`).toBe(true);
    }
    expect(rect.w >= 0 && rect.h >= 0, `${label}: not negative`).toBe(true);
    expect(rect.x >= 0 && rect.y >= 0, `${label}: inside`).toBe(true);
    expect(
      rect.x + rect.w <= workspace.width && rect.y + rect.h <= workspace.height,
      `${label}: inside`,
    ).toBe(true);
    area += rect.w * rect.h;
  }
  expect(area, `${label}: covers the workspace`).toBe(workspace.width * workspace.height);
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      const overX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(overX <= 0 || overY <= 0, `${label}: no overlap`).toBe(true);
    }
  }
  const leaves = leavesOf(flat.tree);
  for (const rect of rects.leaves) {
    const node = leaves.find((candidate) => candidate.id === rect.leafId);
    expect(node, `${label}: every rect belongs to a leaf`).toBeDefined();
    if (node === undefined) continue;
    const min = minSize(node, PANES);
    expect(rect.w >= min.w, `${label}: ${node.id} is wide enough`).toBe(true);
    expect(rect.h >= min.h, `${label}: ${node.id} is tall enough`).toBe(true);
  }
}

// ---------------------------------------------------------------- minimums

describe("minSize", () => {
  test("a leaf takes the largest minimum among its tabs", () => {
    expect(minSize(leaf("l1", "status"), PANES)).toEqual({ w: 230, h: 150 });
    expect(minSize(leaf("l1", "status", "today"), PANES)).toEqual({ w: 320, h: 320 });
    expect(minSize(leaf("l1", "calendar", "status"), PANES)).toEqual({ w: 320, h: 300 });
    expect(minSize(leaf("l1", "steps", "ledger"), PANES)).toEqual({ w: 260, h: 200 });
  });

  test("a split adds along its direction and takes the larger across it", () => {
    const side = split("s1", "h", 0.5, leaf("l2", "today"), leaf("l3", "status"));
    expect(minSize(side, PANES)).toEqual({ w: 320 + 230 + GAP, h: 320 });
    const over = split("s1", "v", 0.5, leaf("l2", "today"), leaf("l3", "status"));
    expect(minSize(over, PANES)).toEqual({ w: 320, h: 320 + 150 + GAP });
  });

  test("five day panes need one row or one column of them", () => {
    expect(minSize(row(), PANES)).toEqual({ w: 1354, h: 320 });
    expect(minSize(column(), PANES)).toEqual({ w: 320, h: 1094 });
  });

  test("all fourteen panes need no more than one row or one column of them", () => {
    const ids = PANES.map((pane) => pane.id);
    expect(minSize(line("h", ids), PANES)).toEqual({ w: 3648, h: 320 });
    expect(minSize(line("v", ids), PANES)).toEqual({ w: 320, h: 2728 });
  });

  test("the catalog is the specs when none are given", () => {
    const side = split("s1", "h", 0.5, leaf("l2", "forecast"), leaf("l3", "ledger"));
    expect(minSize(side)).toEqual(minSize(side, PANES));
    expect(minSize(side)).toEqual({ w: 320 + 260 + GAP, h: 280 });
  });
});

describe("shareLimits", () => {
  const side = split("s1", "h", 0.5, leaf("l2", "today"), leaf("l3", "calendar"));

  test("come from the two children's minimum sizes", () => {
    const [low, high] = shareLimits(side, 1000, PANES);
    expect(low).toBeCloseTo(320 / 994, 12);
    expect(high).toBeCloseTo(1 - 320 / 994, 12);
  });

  test("are half and half when the two cannot both fit", () => {
    expect(shareLimits(side, 640, PANES)).toEqual([0.5, 0.5]);
    expect(shareLimits(side, 0, PANES)).toEqual([0.5, 0.5]);
    expect(shareLimits(side, GAP, PANES)).toEqual([0.5, 0.5]);
    expect(shareLimits(side, Number.NaN, PANES)).toEqual([0.5, 0.5]);
  });

  test("let the first child take exactly its minimum at the tightest fit", () => {
    const tight = 320 + 320 + GAP;
    const [low, high] = shareLimits(side, tight, PANES);
    expect(low).toBeCloseTo(high, 12);
    expect(drawnShare(side, tight, PANES) * (tight - GAP)).toBeCloseTo(320, 6);
  });

  test("the catalog is the specs when none are given", () => {
    expect(shareLimits(side, 1000)).toEqual(shareLimits(side, 1000, PANES));
    expect(drawnShare(side, 700)).toBe(drawnShare(side, 700, PANES));
  });
});

// ---------------------------------------------------------------- the draw

describe("layoutTree", () => {
  test("gives the first child its rounded share, then the gap, then the rest", () => {
    const start = defaultArrangement("wide", "today");
    const rects = layoutTree(start, REFERENCE.wide, PANES);
    const root = rects.dividers.find((divider) => divider.splitId === "s1");
    expect(root).toEqual({
      splitId: "s1",
      dir: "h",
      x: 733,
      y: 0,
      w: GAP,
      h: 700,
      start: 0,
      size: 1472,
    });
    const calendar = rects.leaves.find((rect) => rect.leafId === "l9");
    expect(calendar).toEqual({ leafId: "l9", x: 739, y: 0, w: 733, h: 700 });
  });

  test("the catalog is the specs when none are given", () => {
    const start = defaultArrangement("wide", "money");
    expect(layoutTree(start, REFERENCE.wide)).toEqual(layoutTree(start, REFERENCE.wide, PANES));
  });

  test("an empty tree has no rectangles at all", () => {
    const rects = layoutTree(
      { tree: null, maximized: null, focus: null, lastSpot: {}, options: {} },
      REFERENCE.wide,
      PANES,
    );
    expect(rects).toEqual({ leaves: [], dividers: [] });
  });

  test("a maximized pane takes the whole workspace and the rest keep their places", () => {
    const start = defaultArrangement("wide", "today");
    const flat = layoutTree(start, REFERENCE.wide, PANES);
    const maxed = layoutTree({ ...start, maximized: "status" }, REFERENCE.wide, PANES);
    expect(maxed.leaves.find((rect) => rect.leafId === "l5")).toEqual({
      leafId: "l5",
      x: 0,
      y: 0,
      w: 1472,
      h: 700,
    });
    expect(maxed.dividers).toEqual(flat.dividers);
    for (const rect of flat.leaves) {
      if (rect.leafId === "l5") continue;
      expect(maxed.leaves).toContainEqual(rect);
    }
  });

  test("a maximized pane that is not open changes nothing", () => {
    const start = defaultArrangement("regular", "today");
    expect(layoutTree({ ...start, maximized: "nothing" }, REFERENCE.regular, PANES)).toEqual(
      layoutTree(start, REFERENCE.regular, PANES),
    );
  });

  test("a workspace of nothing, or smaller than the tree, yields no negative and no NaN", () => {
    const start = defaultArrangement("wide", "today");
    for (const workspace of [
      { width: 0, height: 0 },
      { width: 1, height: 1 },
      { width: GAP, height: GAP },
      { width: 200, height: 120 },
      { width: Number.NaN, height: Number.NaN },
      { width: -500, height: -500 },
    ]) {
      const rects = layoutTree(start, workspace, PANES);
      expect(rects.leaves).toHaveLength(5);
      for (const rect of [...rects.leaves, ...rects.dividers]) {
        for (const value of [rect.x, rect.y, rect.w, rect.h]) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  test("laying a tree out on a workspace it does not fit writes nothing back", () => {
    const start = defaultArrangement("wide", "money");
    const before = layoutTree(start, REFERENCE.wide, PANES);
    layoutTree(start, { width: 300, height: 200 }, PANES);
    layoutTree(start, { width: 0, height: 0 }, PANES);
    expect(layoutTree(start, REFERENCE.wide, PANES)).toEqual(before);
    expect(start.tree).toEqual(defaultTree("wide", "money"));
  });
});

describe("the tiling property", () => {
  const ids = PANES.map((pane) => pane.id);
  const shapes: Array<[string, TileNode]> = [
    ["one leaf", leaf("l1", "today")],
    ["one stack", leaf("l1", ...ids)],
    ["five in a row", row()],
    ["five in a column", column()],
    ["fourteen in a row", line("h", ids)],
    ["fourteen in a column", line("v", ids)],
    [
      "mixed",
      split(
        "s1",
        "v",
        0.95,
        split("s2", "h", 0.05, leaf("l3", "today"), leaf("l4", "calendar", "status")),
        split("s5", "h", 0.5, leaf("l6", "past-due"), leaf("l7", "not-today")),
      ),
    ],
  ];

  for (const cls of CLASSES) {
    for (const base of BASES) {
      shapes.push([`${cls} ${base}`, defaultTree(cls, base)]);
    }
  }

  test("every shape tiles every workspace at or above its own minimum", () => {
    for (const [label, tree] of shapes) {
      const start = arrangement(tree);
      const min = minSize(tree, PANES);
      for (const workspace of [
        { width: min.w, height: min.h },
        { width: min.w + 1, height: min.h + 1 },
        { width: min.w + 211, height: min.h + 97 },
        { width: Math.max(min.w, 1600), height: Math.max(min.h, 1200) },
        { width: Math.max(min.w, 3840), height: Math.max(min.h, 2160) },
      ]) {
        expectTiling(start, workspace, `${label} at ${workspace.width}x${workspace.height}`);
      }
    }
  });
});

// ------------------------------------------------------------- the pointer

describe("neighbourOf", () => {
  const rects = layoutTree(defaultArrangement("wide", "today"), REFERENCE.wide, PANES);

  test("finds the leaf that shares the longest edge in that direction", () => {
    expect(neighbourOf(rects, "l4", "right")).toBe("l7");
    expect(neighbourOf(rects, "l4", "down")).toBe("l5");
    expect(neighbourOf(rects, "l5", "up")).toBe("l4");
    expect(neighbourOf(rects, "l7", "down")).toBe("l8");
    expect(neighbourOf(rects, "l7", "left")).toBe("l4");
    expect(neighbourOf(rects, "l9", "left")).toBe("l7");
  });

  test("there is nothing past the edge of the workspace", () => {
    expect(neighbourOf(rects, "l9", "right")).toBeNull();
    expect(neighbourOf(rects, "l4", "left")).toBeNull();
    expect(neighbourOf(rects, "l4", "up")).toBeNull();
  });

  test("a leaf with no rectangle has no neighbour", () => {
    expect(neighbourOf(rects, "nothing", "left")).toBeNull();
    expect(neighbourOf({ leaves: [], dividers: [] }, "l4", "left")).toBeNull();
  });

  test("a leaf that is near but not touching is not a neighbour", () => {
    const apart = {
      leaves: [
        { leafId: "a", x: 0, y: 0, w: 100, h: 100 },
        { leafId: "b", x: 100 + GAP + 3, y: 0, w: 100, h: 100 },
      ],
      dividers: [],
    };
    expect(neighbourOf(apart, "a", "right")).toBeNull();
    const nudged = {
      leaves: [
        { leafId: "a", x: 0, y: 0, w: 100, h: 100 },
        { leafId: "b", x: 100 + GAP + 2, y: 0, w: 100, h: 100 },
      ],
      dividers: [],
    };
    expect(neighbourOf(nudged, "a", "right")).toBe("b");
  });

  test("a leaf that only touches at a corner is not a neighbour", () => {
    const corner = {
      leaves: [
        { leafId: "a", x: 0, y: 0, w: 100, h: 100 },
        { leafId: "b", x: 100 + GAP, y: 100 + GAP, w: 100, h: 100 },
      ],
      dividers: [],
    };
    expect(neighbourOf(corner, "a", "right")).toBeNull();
    expect(neighbourOf(corner, "a", "down")).toBeNull();
  });
});

describe("zoneAt and zoneRect", () => {
  const rect: Rect = { x: 0, y: 0, w: 1000, h: 1000 };

  test("the nearest edge wins inside 27 percent of it", () => {
    expect(zoneAt(rect, 10, 500)).toBe("left");
    expect(zoneAt(rect, 990, 500)).toBe("right");
    expect(zoneAt(rect, 500, 10)).toBe("top");
    expect(zoneAt(rect, 500, 990)).toBe("bottom");
    expect(zoneAt(rect, 269, 500)).toBe("left");
  });

  test("the middle is a tab, and so is anything just past the edge band", () => {
    expect(zoneAt(rect, 500, 500)).toBe("centre");
    expect(zoneAt(rect, 271, 500)).toBe("centre");
    expect(zoneAt(rect, 729, 500)).toBe("centre");
  });

  test("reads the offset of the rectangle, not the workspace", () => {
    expect(zoneAt({ x: 500, y: 500, w: 100, h: 100 }, 505, 550)).toBe("left");
    expect(zoneAt({ x: 500, y: 500, w: 100, h: 100 }, 550, 550)).toBe("centre");
  });

  test("a rectangle with no size, and a point that is not a number, are tabs", () => {
    expect(zoneAt({ x: 0, y: 0, w: 0, h: 0 }, 0, 0)).toBe("centre");
    expect(zoneAt({ x: 0, y: 0, w: 100, h: 0 }, 10, 10)).toBe("centre");
    expect(zoneAt(rect, Number.NaN, Number.NaN)).toBe("centre");
  });

  test("zoneRect is the half on that side, or all of it for a tab", () => {
    const offset: Rect = { x: 10, y: 20, w: 100, h: 60 };
    expect(zoneRect(offset, "left")).toEqual({ x: 10, y: 20, w: 50, h: 60 });
    expect(zoneRect(offset, "right")).toEqual({ x: 60, y: 20, w: 50, h: 60 });
    expect(zoneRect(offset, "top")).toEqual({ x: 10, y: 20, w: 100, h: 30 });
    expect(zoneRect(offset, "bottom")).toEqual({ x: 10, y: 50, w: 100, h: 30 });
    expect(zoneRect(offset, "centre")).toEqual(offset);
  });
});

// ------------------------------------------------------------- the catalog

describe("the catalog", () => {
  test("names the fourteen panes in the order of the plan's table", () => {
    expect(PANES.map((pane) => pane.id)).toEqual([
      "today",
      "status",
      "past-due",
      "not-today",
      "calendar",
      "lanes",
      "steps",
      "side-quests",
      "done",
      "forecast",
      "accounts",
      "coming-up",
      "hours",
      "ledger",
    ]);
  });

  test("each pane has its title, its short label, its group and its minimum size", () => {
    const table = Object.fromEntries(
      PANES.map((pane) => [
        pane.id,
        [pane.title, pane.short, pane.group, pane.minWidth, pane.minHeight],
      ]),
    );
    expect(table).toEqual({
      today: ["The day", "Day", "day", 320, 320],
      status: ["Status", "Status", "day", 230, 150],
      "past-due": ["Past their date", "Past", "day", 230, 150],
      "not-today": ["Did not fit today", "Did not fit", "day", 230, 150],
      calendar: ["Calendar", "Calendar", "day", 320, 300],
      lanes: ["Lanes", "Lanes", "quests", 240, 160],
      steps: ["Steps", "Steps", "quests", 260, 200],
      "side-quests": ["Side quests", "Side", "quests", 240, 160],
      done: ["Done lately", "Done", "quests", 230, 150],
      forecast: ["Forecast", "Forecast", "money", 320, 280],
      accounts: ["Accounts", "Accounts", "money", 230, 150],
      "coming-up": ["Coming up", "Coming up", "money", 230, 150],
      hours: ["Hours", "Hours", "money", 230, 150],
      ledger: ["Transactions", "Recent", "money", 260, 180],
    });
  });

  test("the panes are frozen all the way down, options and choices included", () => {
    expect(isDeepFrozen(PANES)).toBe(true);
    expect(isDeepFrozen(BUILT_IN_LAYOUTS)).toBe(true);
    const calendar = PANES.find((pane) => pane.id === "calendar");
    expect(Object.isFrozen(calendar?.options[0].choices[0])).toBe(true);
  });

  test("the panes have no closable flag any more: every pane can be closed", () => {
    for (const pane of PANES) expect(Object.keys(pane)).not.toContain("closable");
  });

  test("offers exactly the six options of the plan, and nothing on any other pane", () => {
    const offered = Object.fromEntries(
      PANES.filter((pane) => pane.options.length > 0).map((pane) => [
        pane.id,
        pane.options.map((option) => [
          option.key,
          option.choices.map((choice) => choice.value),
          option.fallback,
        ]),
      ]),
    );
    expect(offered).toEqual({
      calendar: [["days", ["auto", "1", "3", "7"], "auto"]],
      steps: [["group", ["none", "group"], "none"]],
      "side-quests": [["sort", ["clock", "added"], "clock"]],
      done: [["span", ["7", "14", "28"], "14"]],
      forecast: [["span", ["14", "30", "60"], "30"]],
      ledger: [["rows", ["10", "25", "50"], "25"]],
    });
  });

  test("every option is well formed: its key, its values, its fallback, its words", () => {
    for (const pane of PANES) {
      const keys = pane.options.map((option) => option.key);
      expect(new Set(keys).size, pane.id).toBe(keys.length);
      for (const option of pane.options) {
        const label = `${pane.id} ${option.key}`;
        expect(/^[a-z][a-z0-9-]*$/.test(option.key), label).toBe(true);
        expect(option.label.trim().length, label).toBeGreaterThan(0);
        const values = option.choices.map((choice) => choice.value);
        expect(new Set(values).size, label).toBe(values.length);
        expect(values, label).toContain(option.fallback);
        for (const choice of option.choices) {
          expect(/^[a-z0-9-]+$/.test(choice.value), `${label} ${choice.value}`).toBe(true);
          expect(choice.label.trim().length, `${label} ${choice.value}`).toBeGreaterThan(0);
        }
      }
    }
  });

  test("lists the four built in layouts in order, each its own base", () => {
    expect(BUILT_IN_LAYOUTS.map((meta) => [meta.id, meta.title, meta.base])).toEqual([
      ["today", "Today", "today"],
      ["week", "Week", "week"],
      ["quests", "Quests", "quests"],
      ["money", "Money", "money"],
    ]);
  });

  test("holds at most twelve layouts, and the widths the classes change at", () => {
    expect(MAX_LAYOUTS).toBe(12);
    expect(TILES_MIN_WIDTH).toBe(1024);
    expect(WIDE_MIN_WIDTH).toBe(1600);
  });

  test("has a word for every drop zone", () => {
    expect(TILE_COPY.zone).toEqual({
      left: "Left of",
      right: "Right of",
      top: "Above",
      bottom: "Below",
      centre: "Make a tab of",
    });
  });

  test("screenClassFor is compact under 1024, regular to 1599 and wide from 1600", () => {
    expect(screenClassFor(0)).toBe("compact");
    expect(screenClassFor(390)).toBe("compact");
    expect(screenClassFor(1023)).toBe("compact");
    expect(screenClassFor(1023.9)).toBe("compact");
    expect(screenClassFor(1024)).toBe("regular");
    expect(screenClassFor(1599)).toBe("regular");
    expect(screenClassFor(1600)).toBe("wide");
    expect(screenClassFor(3840)).toBe("wide");
  });

  test("screenClassFor answers compact for anything that is not a usable width", () => {
    expect(screenClassFor(Number.NaN)).toBe("compact");
    expect(screenClassFor(-1)).toBe("compact");
    expect(screenClassFor(-5000)).toBe("compact");
    expect(screenClassFor(Number.POSITIVE_INFINITY)).toBe("compact");
    expect(screenClassFor(Number.NEGATIVE_INFINITY)).toBe("compact");
  });
});

describe("the twelve default arrangements", () => {
  const expected: Record<ScreenClass, Record<BuiltInLayoutId, string>> = {
    wide: {
      today: "h50(h50(v67([today]|[status])|v50([past-due]|[not-today]))|[calendar])",
      week: "h29(v56([not-today,past-due]|[today,status])|[calendar])",
      quests: "h30(v50([lanes]|[done])|h55([steps]|v50([side-quests]|[past-due])))",
      money: "h52([forecast]|h50(v50([accounts]|[hours])|v55([coming-up]|[ledger])))",
    },
    regular: {
      today: "h50([today,status,past-due,not-today]|[calendar])",
      week: "h30([not-today,past-due,today,status]|[calendar])",
      quests: "h36([lanes]|h50([steps]|[side-quests,past-due,done]))",
      money: "h58([forecast]|v50([accounts,hours]|[coming-up,ledger]))",
    },
    compact: {
      today: "[today,status,past-due,not-today,calendar]",
      week: "[calendar,not-today,past-due]",
      quests: "[lanes,steps,side-quests,past-due,done]",
      money: "[forecast,accounts,coming-up,hours,ledger]",
    },
  };

  test("are the twelve trees of the plan's table", () => {
    for (const cls of CLASSES) {
      for (const base of BASES) {
        expect(signature(defaultTree(cls, base)), `${cls} ${base}`).toBe(expected[cls][base]);
      }
    }
  });

  test("the ratios are the table's own, not rounded to the signature's percent", () => {
    const ratios = (node: TileNode): number[] =>
      node.kind === "leaf" ? [] : [node.ratio, ...ratios(node.first), ...ratios(node.second)];
    expect(ratios(defaultTree("wide", "today"))).toEqual([0.5, 0.5, 0.67, 0.5]);
    expect(ratios(defaultTree("wide", "money"))).toEqual([0.52, 0.5, 0.5, 0.55]);
    expect(ratios(defaultTree("regular", "quests"))).toEqual([0.36, 0.5]);
  });

  test("each opens only catalog panes, each at most once", () => {
    const known = PANES.map((pane) => pane.id);
    for (const cls of CLASSES) {
      for (const base of BASES) {
        const open = openPanes(defaultTree(cls, base));
        expect(new Set(open).size, `${cls} ${base}`).toBe(open.length);
        for (const pane of open) expect(known, `${cls} ${base}`).toContain(pane);
      }
    }
  });

  test("every compact default is one leaf", () => {
    for (const base of BASES) {
      const tree = defaultTree("compact", base);
      expect(tree.kind, base).toBe("leaf");
      expect(leavesOf(tree)).toHaveLength(1);
    }
  });

  test("each tiled default fits its class's reference workspace at the catalog's minimums", () => {
    for (const cls of TILED) {
      for (const base of BASES) {
        const tree = defaultTree(cls, base);
        const min = minSize(tree, PANES);
        const workspace = REFERENCE[cls];
        expect(min.w, `${cls} ${base} width`).toBeLessThanOrEqual(workspace.width);
        expect(min.h, `${cls} ${base} height`).toBeLessThanOrEqual(workspace.height);
        expectTiling(arrangement(tree), workspace, `${cls} ${base}`);
      }
    }
  });

  test("ids are numbered down the tree", () => {
    const root = defaultTree("wide", "week") as Split;
    expect(root.id).toBe("s1");
    expect((root.first as Split).id).toBe("s2");
    expect(leavesOf(root).map((found) => found.id)).toEqual(["l3", "l4", "l5"]);
    expect(defaultTree("compact", "money").id).toBe("l1");
  });

  // Fitting is not the same as drawing as written. A default's stored ratio is
  // what the owner chose; at a given workspace the drawn share is that ratio
  // clamped so neither side goes under its minimum, and at these reference
  // sizes the Week layout has one split on each tiled class that lands on a
  // limit. That is correct behaviour and it is also the first thing that will
  // look wrong to whoever compares the desk against the mock, so it is pinned.
  test("two of the eight tiled defaults draw one split at a limit at the reference size", () => {
    const clamped: string[] = [];
    for (const cls of TILED) {
      for (const base of BASES) {
        const tree = defaultTree(cls, base);
        const rects = layoutTree(defaultArrangement(cls, base), REFERENCE[cls], PANES);
        for (const divider of rects.dividers) {
          const node = splitById(tree, divider.splitId);
          if (node === null) continue;
          if (drawnShare(node, divider.size, PANES) !== node.ratio) {
            clamped.push(`${cls} ${base} ${divider.splitId}`);
          }
        }
      }
    }
    expect(clamped).toEqual(["regular week s1", "wide week s2"]);
  });

  test("a base the catalog does not list falls back to the first layout", () => {
    expect(signature(defaultTree("wide", "nothing" as BuiltInLayoutId))).toBe(expected.wide.today);
    expect(signature(defaultTree("regular", "__proto__" as BuiltInLayoutId))).toBe(
      expected.regular.today,
    );
    expect(defaultArrangement("compact", "constructor" as BuiltInLayoutId)).toBe(
      defaultArrangement("compact", "today"),
    );
  });

  test("defaultArrangement is the same frozen object every call", () => {
    for (const cls of CLASSES) {
      for (const base of BASES) {
        const start = defaultArrangement(cls, base);
        expect(defaultArrangement(cls, base), `${cls} ${base}`).toBe(start);
        expect(isDeepFrozen(start), `${cls} ${base}`).toBe(true);
        expect(defaultTree(cls, base)).toBe(start.tree);
      }
    }
  });

  test("defaultArrangement opens nothing maximized and focuses the front tab of the first leaf", () => {
    for (const cls of CLASSES) {
      for (const base of BASES) {
        const start = defaultArrangement(cls, base);
        expect(start.maximized).toBeNull();
        expect(start.lastSpot).toEqual({});
        expect(start.options).toEqual({});
        expect(start.focus, `${cls} ${base}`).toBe(leavesOf(start.tree)[0].active);
      }
    }
  });
});

describe("the copy", () => {
  test("has no em dash and no en dash in anything a user reads", () => {
    const strings: string[] = [
      ...PANES.map((pane) => pane.title),
      ...PANES.map((pane) => pane.short),
      ...PANES.map((pane) => pane.id),
      ...PANES.flatMap((pane) => pane.options.map((option) => option.label)),
      ...PANES.flatMap((pane) =>
        pane.options.flatMap((option) => option.choices.map((choice) => choice.label)),
      ),
      ...BUILT_IN_LAYOUTS.map((meta) => meta.title),
      ...Object.values(TILE_COPY.zone),
    ];
    expect(strings.length).toBeGreaterThan(60);
    for (const text of strings) {
      expect(text.includes(EM_DASH), text).toBe(false);
      expect(text.includes(EN_DASH), text).toBe(false);
    }
  });

  test("every pane has a title and a short label, and every zone has a word", () => {
    for (const pane of PANES) {
      expect(pane.title.length).toBeGreaterThan(0);
      expect(pane.short.length).toBeGreaterThan(0);
    }
    const zones: Zone[] = ["left", "right", "top", "bottom", "centre"];
    for (const zone of zones) expect(TILE_COPY.zone[zone].length).toBeGreaterThan(0);
  });
});
