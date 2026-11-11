// Task 3, the layout and the catalog.
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
  ARRANGEMENTS,
  PANES,
  TILE_COPY,
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

/** The workspace each class's defaults are designed to fit. */
const REFERENCE: Record<ScreenClass, Workspace> = {
  regular: { width: 896, height: 600 },
  wide: { width: 1472, height: 700 },
};

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
  return { tree, maximized: null, focus: openPanes(tree)[0], lastSpot: {} };
}

function splitById(node: TileNode, id: string): Split | null {
  if (node.kind === "leaf") return null;
  if (node.id === id) return node;
  return splitById(node.first, id) ?? splitById(node.second, id);
}

/** All five panes side by side: the widest shape five panes can make. */
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
  });

  test("a split adds along its direction and takes the larger across it", () => {
    const side = split("s1", "h", 0.5, leaf("l2", "today"), leaf("l3", "status"));
    expect(minSize(side, PANES)).toEqual({ w: 320 + 230 + GAP, h: 320 });
    const over = split("s1", "v", 0.5, leaf("l2", "today"), leaf("l3", "status"));
    expect(minSize(over, PANES)).toEqual({ w: 320, h: 320 + 150 + GAP });
  });

  test("five panes cannot need more than one row or one column of them", () => {
    expect(minSize(row(), PANES)).toEqual({ w: 1354, h: 320 });
    expect(minSize(column(), PANES)).toEqual({ w: 320, h: 1094 });
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

  test("an empty tree has no rectangles at all", () => {
    const rects = layoutTree(
      { tree: null, maximized: null, focus: null, lastSpot: {} },
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
    const start = defaultArrangement("wide", "backlog");
    const before = layoutTree(start, REFERENCE.wide, PANES);
    layoutTree(start, { width: 300, height: 200 }, PANES);
    layoutTree(start, { width: 0, height: 0 }, PANES);
    expect(layoutTree(start, REFERENCE.wide, PANES)).toEqual(before);
    expect(start.tree).toEqual(defaultTree("wide", "backlog"));
  });
});

describe("the tiling property", () => {
  const shapes: Array<[string, TileNode]> = [
    ["one leaf", leaf("l1", "today")],
    ["one stack", leaf("l1", "today", "status", "past-due", "not-today", "calendar")],
    ["five in a row", row()],
    ["five in a column", column()],
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

  for (const [cls, names] of [
    ["regular", ARRANGEMENTS.map((entry) => entry.name)],
    ["wide", ARRANGEMENTS.map((entry) => entry.name)],
  ] as Array<[ScreenClass, string[]]>) {
    for (const name of names) {
      shapes.push([`${cls} ${name}`, defaultTree(cls, name)]);
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
        { width: 1600, height: 1200 },
        { width: 3840, height: 2160 },
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
  test("names the five panes, and only today cannot be closed", () => {
    expect(PANES.map((pane) => pane.id)).toEqual([
      "today",
      "calendar",
      "status",
      "past-due",
      "not-today",
    ]);
    expect(PANES.filter((pane) => !pane.closable).map((pane) => pane.id)).toEqual(["today"]);
  });

  test("the minimum sizes are the ones the defaults were measured against", () => {
    const sizes = Object.fromEntries(
      PANES.map((pane) => [pane.id, [pane.minWidth, pane.minHeight]]),
    );
    expect(sizes).toEqual({
      today: [320, 320],
      calendar: [320, 300],
      status: [230, 150],
      "past-due": [230, 150],
      "not-today": [230, 150],
    });
  });

  test("lists the three arrangements in order", () => {
    expect(ARRANGEMENTS.map((entry) => [entry.name, entry.title])).toEqual([
      ["today", "Today"],
      ["plan", "Plan the week"],
      ["backlog", "Clear the backlog"],
    ]);
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

  test("screenClassFor has no tiles under 1024 and goes wide at 1600", () => {
    expect(screenClassFor(0)).toBeNull();
    expect(screenClassFor(390)).toBeNull();
    expect(screenClassFor(1023)).toBeNull();
    expect(screenClassFor(1024)).toBe("regular");
    expect(screenClassFor(1599)).toBe("regular");
    expect(screenClassFor(1600)).toBe("wide");
    expect(screenClassFor(3840)).toBe("wide");
    expect(screenClassFor(Number.NaN)).toBeNull();
    expect(screenClassFor(-1)).toBeNull();
  });
});

describe("the six default arrangements", () => {
  const expected: Record<ScreenClass, Record<string, string>> = {
    wide: {
      today: "h50(h50(v67([today]|[status])|v50([past-due]|[not-today]))|[calendar])",
      plan: "h29(v56([not-today,past-due]|[today,status])|[calendar])",
      backlog: "h25(v65([today]|[status])|h80(h50([past-due]|[not-today])|[calendar]))",
    },
    regular: {
      today: "h50([today,status,past-due,not-today]|[calendar])",
      plan: "h30([not-today,past-due,today,status]|[calendar])",
      backlog: "h72(h50([past-due]|[not-today])|[calendar,today,status])",
    },
  };

  test("are the six trees the shell was designed around", () => {
    for (const cls of ["regular", "wide"] as ScreenClass[]) {
      for (const entry of ARRANGEMENTS) {
        expect(signature(defaultTree(cls, entry.name)), `${cls} ${entry.name}`).toBe(
          expected[cls][entry.name],
        );
      }
    }
  });

  test("each opens every pane exactly once", () => {
    for (const cls of ["regular", "wide"] as ScreenClass[]) {
      for (const entry of ARRANGEMENTS) {
        const open = openPanes(defaultTree(cls, entry.name));
        expect(open.slice().sort(), `${cls} ${entry.name}`).toEqual(
          PANES.map((pane) => pane.id).slice().sort(),
        );
      }
    }
  });

  test("each fits its class's reference workspace at the catalog's minimums", () => {
    for (const cls of ["regular", "wide"] as ScreenClass[]) {
      for (const entry of ARRANGEMENTS) {
        const tree = defaultTree(cls, entry.name);
        const min = minSize(tree, PANES);
        const workspace = REFERENCE[cls];
        expect(min.w, `${cls} ${entry.name} width`).toBeLessThanOrEqual(workspace.width);
        expect(min.h, `${cls} ${entry.name} height`).toBeLessThanOrEqual(workspace.height);
        expectTiling(arrangement(tree), workspace, `${cls} ${entry.name}`);
      }
    }
  });

  test("ids are numbered down the tree, so two builds give the same tree", () => {
    expect(defaultTree("wide", "plan")).toEqual(defaultTree("wide", "plan"));
    const root = defaultTree("wide", "plan") as Split;
    expect(root.id).toBe("s1");
    expect((root.first as Split).id).toBe("s2");
    expect(leavesOf(root).map((found) => found.id)).toEqual(["l3", "l4", "l5"]);
  });

  // Fitting is not the same as drawing as written. A default's stored ratio is
  // what the owner chose; at a given workspace the drawn share is that ratio
  // clamped so neither side goes under its minimum, and at these reference
  // sizes four of the six defaults have one split that lands on a limit. That
  // is correct behaviour and it is also the first thing that will look wrong to
  // whoever compares the shell against the mock, so it is written down here.
  test("four of the six draw one split at a limit at the reference size", () => {
    const clamped: string[] = [];
    for (const cls of ["regular", "wide"] as ScreenClass[]) {
      for (const entry of ARRANGEMENTS) {
        const rects = layoutTree(
          defaultArrangement(cls, entry.name),
          REFERENCE[cls],
          PANES,
        );
        for (const divider of rects.dividers) {
          const node = splitById(defaultTree(cls, entry.name), divider.splitId);
          if (node === null) continue;
          if (drawnShare(node, divider.size, PANES) !== node.ratio) {
            clamped.push(`${cls} ${entry.name} ${divider.splitId}`);
          }
        }
      }
    }
    expect(clamped).toEqual([
      "regular plan s1",
      "regular backlog s1",
      "wide plan s2",
      "wide backlog s5",
    ]);
  });

  test("a name the catalog does not list falls back to the first arrangement", () => {
    expect(signature(defaultTree("wide", "nothing"))).toBe(expected.wide.today);
    expect(signature(defaultTree("regular", "__proto__"))).toBe(expected.regular.today);
  });

  test("defaultArrangement opens nothing maximized and focuses a pane that is open", () => {
    for (const cls of ["regular", "wide"] as ScreenClass[]) {
      for (const entry of ARRANGEMENTS) {
        const start = defaultArrangement(cls, entry.name);
        expect(start.maximized).toBeNull();
        expect(start.lastSpot).toEqual({});
        expect(openPanes(start.tree)).toContain(start.focus);
      }
    }
  });
});

describe("the copy", () => {
  test("has no em dash and no en dash in anything a user reads", () => {
    const strings: string[] = [
      ...PANES.map((pane) => pane.title),
      ...PANES.map((pane) => pane.id),
      ...ARRANGEMENTS.map((entry) => entry.title),
      ...Object.values(TILE_COPY.zone),
    ];
    for (const text of strings) {
      expect(text.includes(EM_DASH), text).toBe(false);
      expect(text.includes(EN_DASH), text).toBe(false);
    }
  });

  test("every pane has a title and every zone has a word", () => {
    for (const pane of PANES) expect(pane.title.length).toBeGreaterThan(0);
    const zones: Zone[] = ["left", "right", "top", "bottom", "centre"];
    for (const zone of zones) expect(TILE_COPY.zone[zone].length).toBeGreaterThan(0);
  });
});
