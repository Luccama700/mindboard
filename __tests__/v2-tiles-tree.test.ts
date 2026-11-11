// Task 3, the split tree. The workspace is one tree of splits and tab stacks,
// and every operation on it is a pure function: it returns a NEW arrangement,
// shares whatever it did not change, and returns the SAME object when it
// changes nothing, so a caller can tell a refusal from a move without
// comparing trees.
//
// Two properties carry most of the weight here and are asserted everywhere:
//
//  1. IDS ARE A FUNCTION OF THE TREE. The prototype took ids from a global
//     counter, so the same operations on the same tree gave different trees on
//     a second run and nothing could be compared. Here a new id is one more
//     than the largest number any id in the tree already uses, so the same
//     operation on the same tree always gives the same tree.
//  2. NOTHING MUTATES. Every input is deep frozen before the call. A module
//     under "use strict" throws on an assignment to a frozen object, so a
//     single mutation anywhere fails the test rather than leaking into the
//     caller's state.

import { describe, expect, test } from "vitest";

import {
  activateTab,
  closePane,
  cycleTab,
  equalize,
  leafOf,
  leavesOf,
  movePane,
  normalize,
  openPane,
  openPanes,
  setRatio,
  signature,
  swapLeaves,
  toggleMaximize,
} from "@/app/lib/v2/tiles/tree";
import { GAP, layoutTree, minSize, shareLimits } from "@/app/lib/v2/tiles/geometry";
import type {
  Arrangement,
  Leaf,
  PaneId,
  PaneSpec,
  Split,
  SplitDir,
  TileNode,
  TileRects,
} from "@/app/lib/v2/tiles/types";

/**
 * The test's own pane specs. tree.ts takes specs as an argument precisely so it
 * does not know the catalog, so the unit test does not import it either: the
 * catalog's own numbers are checked in the layout test.
 */
const SPECS: readonly PaneSpec[] = [
  { id: "today", title: "Today", minWidth: 320, minHeight: 320, closable: false },
  { id: "calendar", title: "Calendar", minWidth: 320, minHeight: 300, closable: true },
  { id: "status", title: "Status", minWidth: 230, minHeight: 150, closable: true },
  { id: "past-due", title: "Past their date", minWidth: 230, minHeight: 150, closable: true },
  { id: "not-today", title: "Did not fit today", minWidth: 230, minHeight: 150, closable: true },
];

function leaf(id: string, ...tabs: PaneId[]): Leaf {
  return { kind: "leaf", id, tabs: [...tabs], active: tabs[0] };
}

function activeLeaf(id: string, active: PaneId, ...tabs: PaneId[]): Leaf {
  return { kind: "leaf", id, tabs: [...tabs], active };
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

function arrangement(tree: TileNode | null, over: Partial<Arrangement> = {}): Arrangement {
  const open = openPanes(tree);
  return deepFreeze({
    tree,
    maximized: null,
    focus: open.length === 0 ? null : open[0],
    lastSpot: {},
    ...over,
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

/** The flat pane list that the default regular arrangement uses. */
function stackedPair(): TileNode {
  return split(
    "s1",
    "h",
    0.5,
    leaf("l2", "today", "status", "past-due", "not-today"),
    leaf("l3", "calendar"),
  );
}

/** Four leaves, so there is something for a neighbour or a spot to point at. */
function fourWay(): TileNode {
  return split(
    "s1",
    "h",
    0.5,
    split("s2", "v", 0.6, leaf("l3", "today"), leaf("l4", "status")),
    split("s5", "v", 0.4, leaf("l6", "past-due"), leaf("l7", "not-today")),
  );
}

function ids(node: TileNode | null): string[] {
  if (node === null) return [];
  if (node.kind === "leaf") return [node.id];
  return [node.id, ...ids(node.first), ...ids(node.second)];
}

// ------------------------------------------------------------------ reading

describe("reading a tree", () => {
  test("leavesOf walks first then second, and null has no leaves", () => {
    expect(leavesOf(null)).toEqual([]);
    expect(leavesOf(fourWay()).map((found) => found.id)).toEqual(["l3", "l4", "l6", "l7"]);
  });

  test("leafOf finds the leaf that holds a pane, or null", () => {
    const tree = stackedPair();
    expect(leafOf(tree, "not-today")?.id).toBe("l2");
    expect(leafOf(tree, "calendar")?.id).toBe("l3");
    expect(leafOf(tree, "nothing")).toBeNull();
    expect(leafOf(null, "today")).toBeNull();
  });

  test("openPanes lists every tab of every leaf in tree order", () => {
    expect(openPanes(stackedPair())).toEqual([
      "today",
      "status",
      "past-due",
      "not-today",
      "calendar",
    ]);
    expect(openPanes(null)).toEqual([]);
  });

  test("signature describes the shape and ignores which tab is in front", () => {
    expect(signature(null)).toBe("-");
    expect(signature(leaf("l1", "today", "status"))).toBe("[today,status]");
    expect(signature(activeLeaf("l1", "status", "today", "status"))).toBe("[today,status]");
    expect(signature(stackedPair())).toBe("h50([today,status,past-due,not-today]|[calendar])");
    expect(signature(split("s9", "v", 0.284, leaf("l1", "today"), leaf("l2", "status")))).toBe(
      "v28([today]|[status])",
    );
  });
});

// ---------------------------------------------------------------- normalize

describe("normalize", () => {
  test("drops a leaf with no tabs and the split it leaves behind", () => {
    const empty: Leaf = { kind: "leaf", id: "l3", tabs: [], active: "status" };
    const out = normalize(split("s1", "h", 0.5, leaf("l2", "today"), empty));
    expect(out).toEqual(leaf("l2", "today"));
  });

  test("an empty tree is null", () => {
    expect(normalize(null)).toBeNull();
    expect(normalize({ kind: "leaf", id: "l1", tabs: [], active: "today" })).toBeNull();
    expect(
      normalize(
        split(
          "s1",
          "h",
          0.5,
          { kind: "leaf", id: "l2", tabs: [], active: "today" },
          { kind: "leaf", id: "l3", tabs: [], active: "status" },
        ),
      ),
    ).toBeNull();
  });

  test("clamps a ratio to 0.05 and 0.95 and makes a ratio that is not a number 0.5", () => {
    const low = normalize(split("s1", "h", -4, leaf("l2", "today"), leaf("l3", "status")));
    const high = normalize(split("s1", "h", 9, leaf("l2", "today"), leaf("l3", "status")));
    const broken = normalize(split("s1", "h", Number.NaN, leaf("l2", "today"), leaf("l3", "status")));
    const infinite = normalize(
      split("s1", "h", Number.POSITIVE_INFINITY, leaf("l2", "today"), leaf("l3", "status")),
    );
    expect((low as Split).ratio).toBe(0.05);
    expect((high as Split).ratio).toBe(0.95);
    expect((broken as Split).ratio).toBe(0.5);
    expect((infinite as Split).ratio).toBe(0.5);
  });

  test("an active that is not among the tabs becomes the first tab", () => {
    const out = normalize(activeLeaf("l1", "calendar", "today", "status"));
    expect((out as Leaf).active).toBe("today");
  });

  test("returns the same object when there is nothing to repair", () => {
    const tree = deepFreeze(fourWay());
    expect(normalize(tree)).toBe(tree);
    const one = deepFreeze(leaf("l1", "today"));
    expect(normalize(one)).toBe(one);
  });

  test("shares the branches it did not touch", () => {
    const keep = leaf("l4", "status");
    const tree = deepFreeze(
      split("s1", "h", 40, split("s2", "v", 0.5, leaf("l3", "today"), keep), leaf("l5", "calendar")),
    );
    const out = normalize(tree) as Split;
    expect(out).not.toBe(tree);
    expect(out.ratio).toBe(0.95);
    expect(out.first).toBe(tree.first);
    expect(out.second).toBe(tree.second);
  });
});

// ------------------------------------------------------------------ the ids

describe("ids are a function of the tree", () => {
  test("a new leaf and a new split take one more than the largest number in use", () => {
    const start = arrangement(stackedPair());
    const out = movePane(start, "calendar", "l2", "left");
    expect(ids(out.tree)).toEqual(["s4", "l4", "l2"]);
  });

  test("the same operation on the same tree gives the same ids every time", () => {
    const first = movePane(arrangement(fourWay()), "today", "l7", "bottom");
    const second = movePane(arrangement(fourWay()), "today", "l7", "bottom");
    expect(ids(first.tree)).toEqual(ids(second.tree));
    expect(first.tree).toEqual(second.tree);
  });

  test("ids stay unique over a run of moves", () => {
    let arr = arrangement(fourWay());
    arr = movePane(arr, "today", "l7", "right");
    arr = movePane(arr, "status", "l6", "top");
    arr = movePane(arr, "calendar", "l4", "left");
    const all = ids(arr.tree);
    expect(new Set(all).size).toBe(all.length);
  });

  test("counts an id that is not in the engine's own shape as zero", () => {
    const odd = split("root", "h", 0.5, leaf("left", "today"), leaf("right", "status"));
    const out = movePane(arrangement(odd), "calendar", "right", "bottom");
    expect(ids(out.tree)).toContain("l1");
    expect(ids(out.tree)).toContain("s1");
  });
});

// ------------------------------------------------------------------ movePane

describe("movePane", () => {
  test("centre appends the pane to the target's tabs and makes it active", () => {
    const out = movePane(arrangement(fourWay()), "today", "l7", "centre");
    const landed = leafOf(out.tree, "today") as Leaf;
    expect(landed.id).toBe("l7");
    expect(landed.tabs).toEqual(["not-today", "today"]);
    expect(landed.active).toBe("today");
    expect(leafOf(out.tree, "status")?.id).toBe("l4");
  });

  test("any other zone splits the target in half, the target keeping its own id", () => {
    const start = arrangement(stackedPair());
    for (const [zone, dir, firstTab] of [
      ["left", "h", "calendar"],
      ["right", "h", "today"],
      ["top", "v", "calendar"],
      ["bottom", "v", "today"],
    ] as const) {
      const out = movePane(start, "calendar", "l2", zone);
      const root = out.tree as Split;
      expect(root.kind).toBe("split");
      expect(root.id).toBe("s4");
      expect(root.dir).toBe(dir);
      expect(root.ratio).toBe(0.5);
      expect(leavesOf(root)[0].tabs[0]).toBe(firstTab);
      expect(leafOf(out.tree, "today")?.id).toBe("l2");
    }
  });

  test("splits a tab off its own leaf, and the leaf keeps the rest", () => {
    const out = movePane(arrangement(stackedPair()), "status", "l2", "right");
    expect(signature(out.tree)).toBe("h50(h50([today,past-due,not-today]|[status])|[calendar])");
    expect((leafOf(out.tree, "today") as Leaf).active).toBe("today");
  });

  test("the leaf a pane leaves hands its front place to the next tab", () => {
    const start = arrangement(activeLeaf("l1", "status", "today", "status", "calendar"));
    const out = movePane(start, "status", "l1", "top");
    expect((leafOf(out.tree, "today") as Leaf).active).toBe("today");
  });

  test("refuses a target that does not exist", () => {
    const start = arrangement(fourWay());
    expect(movePane(start, "today", "nowhere", "left")).toBe(start);
    const nothing = arrangement(null);
    expect(movePane(nothing, "today", "l1", "left")).toBe(nothing);
  });

  test("refuses a pane dropped on its own leaf as a tab, or when it is the only tab", () => {
    const tabs = arrangement(stackedPair());
    expect(movePane(tabs, "today", "l2", "centre")).toBe(tabs);
    const alone = arrangement(fourWay());
    expect(movePane(alone, "today", "l3", "centre")).toBe(alone);
    expect(movePane(alone, "today", "l3", "left")).toBe(alone);
  });

  test("clears maximized and focuses the pane that moved", () => {
    const start = arrangement(fourWay(), { maximized: "status", focus: "status" });
    const out = movePane(start, "today", "l7", "centre");
    expect(out.maximized).toBeNull();
    expect(out.focus).toBe("today");
  });

  test("brings a closed pane in at the chosen place", () => {
    const start = arrangement(fourWay());
    expect(openPanes(start.tree)).not.toContain("calendar");
    const out = movePane(start, "calendar", "l4", "bottom");
    expect(leafOf(out.tree, "calendar")?.tabs).toEqual(["calendar"]);
    expect(openPanes(out.tree)).toHaveLength(5);
  });

  test("leaves the branches it did not touch alone", () => {
    const start = arrangement(fourWay());
    const untouched = (start.tree as Split).first;
    const out = movePane(start, "past-due", "l7", "centre");
    expect((out.tree as Split).first).toBe(untouched);
    expect(out.lastSpot).toBe(start.lastSpot);
  });
});

// ----------------------------------------------------------------- closePane

describe("closePane", () => {
  test("is refused for a pane whose spec says it cannot be closed", () => {
    const start = arrangement(stackedPair());
    expect(closePane(start, "today", SPECS)).toBe(start);
  });

  test("is refused for the only pane open", () => {
    const start = arrangement(leaf("l1", "calendar"));
    expect(closePane(start, "calendar", SPECS)).toBe(start);
  });

  test("is refused for a pane that is not open", () => {
    const start = arrangement(stackedPair());
    expect(closePane(start, "nothing", SPECS)).toBe(start);
  });

  test("a tab remembers the first other tab of its own leaf, as a tab", () => {
    const out = closePane(arrangement(stackedPair()), "status", SPECS);
    expect(out.lastSpot.status).toEqual({ beside: "today", zone: "centre", ratio: null });
    expect((leafOf(out.tree, "today") as Leaf).tabs).toEqual(["today", "past-due", "not-today"]);
  });

  test("a lone leaf remembers the side it was on and the split's ratio", () => {
    const out = closePane(arrangement(fourWay()), "not-today", SPECS);
    expect(out.lastSpot["not-today"]).toEqual({ beside: "past-due", zone: "bottom", ratio: 0.4 });
    expect(signature(out.tree)).toBe("h50(v60([today]|[status])|[past-due])");
  });

  test("remembers the first leaf of a sibling that is itself a split", () => {
    const wide = arrangement(split("s8", "h", 0.29, fourWay(), leaf("l9", "calendar")));
    const closed = closePane(wide, "calendar", SPECS);
    expect(closed.lastSpot.calendar).toEqual({ beside: "today", zone: "right", ratio: 0.29 });
    expect(signature(closed.tree)).toBe(signature(fourWay()));
  });

  test("clears maximized when it was that pane, and leaves another one alone", () => {
    const start = arrangement(fourWay(), { maximized: "status", focus: "status" });
    expect(closePane(start, "status", SPECS).maximized).toBeNull();
    expect(closePane(start, "not-today", SPECS).maximized).toBe("status");
  });

  test("focus moves to the first leaf's active tab only when it was that pane", () => {
    const start = arrangement(fourWay(), { focus: "not-today" });
    expect(closePane(start, "not-today", SPECS).focus).toBe("today");
    expect(closePane(start, "status", SPECS).focus).toBe("not-today");
  });

  test("keeps the spots it already had", () => {
    const start = arrangement(fourWay(), {
      lastSpot: { calendar: { beside: "today", zone: "right", ratio: 0.3 } },
    });
    const out = closePane(start, "status", SPECS);
    expect(out.lastSpot.calendar).toEqual({ beside: "today", zone: "right", ratio: 0.3 });
    expect(out.lastSpot.status).toBeDefined();
  });
});

// ------------------------------------------------------------------ openPane

describe("openPane", () => {
  test("is a no-op for a pane that is already open", () => {
    const start = arrangement(stackedPair());
    expect(openPane(start, "today", null)).toBe(start);
  });

  test("opening into an empty tree makes it the tree", () => {
    const out = openPane(arrangement(null), "today", null);
    expect(out.tree).toEqual(leaf("l1", "today"));
    expect(out.focus).toBe("today");
  });

  test("a remembered spot brings the pane back with the split's old ratio", () => {
    const start = arrangement(
      split("s1", "h", 0.29, split("s2", "v", 0.56, leaf("l3", "not-today", "past-due"), leaf("l4", "today", "status")), leaf("l5", "calendar")),
    );
    const closed = closePane(start, "calendar", SPECS);
    expect(closed.lastSpot.calendar).toEqual({ beside: "not-today", zone: "right", ratio: 0.29 });
    const back = openPane(closed, "calendar", null);
    expect(signature(back.tree)).toBe("v56(h29([not-today,past-due]|[calendar])|[today,status])");
  });

  test("a remembered tab spot brings the pane back as a tab", () => {
    const start = arrangement(stackedPair());
    const closed = closePane(start, "not-today", SPECS);
    const back = openPane(closed, "not-today", null);
    expect(signature(back.tree)).toBe("h50([today,status,past-due,not-today]|[calendar])");
    expect((leafOf(back.tree, "not-today") as Leaf).active).toBe("not-today");
  });

  test("falls back to the largest leaf when the remembered neighbour is gone", () => {
    const start = arrangement(fourWay(), {
      lastSpot: { calendar: { beside: "nothing-open", zone: "left", ratio: 0.2 } },
    });
    const rects: TileRects = {
      leaves: [
        { leafId: "l3", x: 0, y: 0, w: 100, h: 100 },
        { leafId: "l4", x: 0, y: 0, w: 100, h: 100 },
        { leafId: "l6", x: 0, y: 0, w: 400, h: 100 },
        { leafId: "l7", x: 0, y: 0, w: 100, h: 100 },
      ],
      dividers: [],
    };
    const out = openPane(start, "calendar", rects);
    expect(signature(out.tree)).toBe(
      "h50(v60([today]|[status])|v40(h50([past-due]|[calendar])|[not-today]))",
    );
  });

  test("goes right of the largest leaf when it is at least 1.2 times wider than tall", () => {
    const start = arrangement(fourWay());
    const wide: TileRects = {
      leaves: [{ leafId: "l3", x: 0, y: 0, w: 120, h: 100 }],
      dividers: [],
    };
    const square: TileRects = {
      leaves: [{ leafId: "l3", x: 0, y: 0, w: 119, h: 100 }],
      dividers: [],
    };
    expect(signature(openPane(start, "calendar", wide).tree)).toContain("h50([today]|[calendar])");
    expect(signature(openPane(start, "calendar", square).tree)).toContain("v50([today]|[calendar])");
  });

  test("goes right of the first leaf when there are no rects at all", () => {
    const out = openPane(arrangement(fourWay()), "calendar", null);
    expect(signature(out.tree)).toBe("h50(v60(h50([today]|[calendar])|[status])|v40([past-due]|[not-today]))");
  });

  test("ignores a leaf that has no rect, and keeps the first of equal areas", () => {
    const rects: TileRects = {
      leaves: [
        { leafId: "l4", x: 0, y: 0, w: 300, h: 100 },
        { leafId: "l7", x: 0, y: 0, w: 300, h: 100 },
      ],
      dividers: [],
    };
    const out = openPane(arrangement(fourWay()), "calendar", rects);
    expect(leafOf(out.tree, "calendar")).not.toBeNull();
    expect(signature(out.tree)).toContain("h50([status]|[calendar])");
  });
});

// ------------------------------------------------------------------ setRatio

describe("setRatio", () => {
  const tree = split("s1", "h", 0.5, leaf("l2", "today"), leaf("l3", "calendar"));

  test("stores the ratio the user dragged, at the size they dragged it", () => {
    const out = setRatio(arrangement(tree), "s1", 0.4, 1472, SPECS);
    expect((out.tree as Split).ratio).toBe(0.4);
  });

  test("clamps to the limits the two minimum sizes allow at that size", () => {
    const [lo, hi] = shareLimits(tree, 800, SPECS);
    expect(lo).toBeCloseTo(320 / 794, 10);
    expect(hi).toBeCloseTo(1 - 320 / 794, 10);
    expect((setRatio(arrangement(tree), "s1", 0.01, 800, SPECS).tree as Split).ratio).toBe(lo);
    expect((setRatio(arrangement(tree), "s1", 0.99, 800, SPECS).tree as Split).ratio).toBe(hi);
  });

  test("falls back to half and half when both sides cannot fit", () => {
    expect(shareLimits(tree, 400, SPECS)).toEqual([0.5, 0.5]);
    expect((setRatio(arrangement(tree), "s1", 0.1, 400, SPECS).tree as Split).ratio).toBe(0.5);
  });

  test("never stores a ratio outside 0.05 to 0.95, however large the workspace", () => {
    const [lo] = shareLimits(tree, 20000, SPECS);
    expect(lo).toBeLessThan(0.05);
    const out = setRatio(arrangement(tree), "s1", 0.001, 20000, SPECS);
    expect((out.tree as Split).ratio).toBe(0.05);
    // A value normalize would clamp could never survive a save and a load, so
    // the drag has to land inside normalize's own range in the first place.
    expect(normalize(out.tree)).toBe(out.tree);
  });

  test("refuses a split that does not exist, a ratio it already has, and a number that is not finite", () => {
    const start = arrangement(tree);
    expect(setRatio(start, "s9", 0.4, 800, SPECS)).toBe(start);
    expect(setRatio(start, "l2", 0.4, 800, SPECS)).toBe(start);
    expect(setRatio(start, "s1", 0.5, 1472, SPECS)).toBe(start);
    expect(setRatio(start, "s1", Number.NaN, 1472, SPECS)).toBe(start);
  });

  test("nothing writes a clamped value back: a small workspace leaves the tree alone", () => {
    const start = arrangement(stackedPair());
    const wide = { width: 896, height: 600 };
    const before = layoutTree(start, wide, SPECS);
    const cramped = layoutTree(start, { width: 200, height: 120 }, SPECS);
    const after = layoutTree(start, wide, SPECS);
    expect(cramped.leaves.every((rect) => rect.w >= 0 && rect.h >= 0)).toBe(true);
    expect(after).toEqual(before);
    expect(start.tree).toEqual(stackedPair());
  });
});

// ------------------------------------------------- equalize and swapLeaves

describe("equalize and swapLeaves", () => {
  test("equalize makes both sides the same share, and refuses what is already even", () => {
    const start = arrangement(split("s1", "h", 0.8, leaf("l2", "today"), leaf("l3", "calendar")));
    expect((equalize(start, "s1").tree as Split).ratio).toBe(0.5);
    const even = arrangement(split("s1", "h", 0.5, leaf("l2", "today"), leaf("l3", "calendar")));
    expect(equalize(even, "s1")).toBe(even);
    expect(equalize(start, "s9")).toBe(start);
  });

  test("swapLeaves exchanges the tabs and the front tab, and nothing else", () => {
    // The focus is on the front tab of its leaf and the maximize is on the
    // focus, because behaviour 18 says every arrangement the engine is given
    // back looks like that, and a fixture that did not would be testing a state
    // the engine cannot produce.
    const start = arrangement(
      split(
        "s1",
        "h",
        0.3,
        activeLeaf("l2", "status", "today", "status"),
        leaf("l3", "calendar", "past-due"),
      ),
      { maximized: "status", focus: "status" },
    );
    const out = swapLeaves(start, "l2", "l3");
    const root = out.tree as Split;
    expect(root.ratio).toBe(0.3);
    expect(root.id).toBe("s1");
    expect(root.first).toEqual(leaf("l2", "calendar", "past-due"));
    expect(root.second).toEqual(activeLeaf("l3", "status", "today", "status"));
    // The panes travelled to the other leaf and the maximize travelled with
    // them, so the workspace still shows the pane the user was looking at.
    expect(out.maximized).toBe("status");
    expect(out.focus).toBe("status");
  });

  test("swapLeaves refuses one leaf with itself and a leaf that does not exist", () => {
    const start = arrangement(stackedPair());
    expect(swapLeaves(start, "l2", "l2")).toBe(start);
    expect(swapLeaves(start, "l2", "l9")).toBe(start);
    expect(swapLeaves(start, "s1", "l2")).toBe(start);
  });
});

// ------------------------------------------------ tabs and maximize

describe("the tab and maximize operations", () => {
  test("activateTab brings a tab forward and focuses it", () => {
    const start = arrangement(stackedPair(), { focus: "calendar" });
    const out = activateTab(start, "past-due");
    expect((leafOf(out.tree, "past-due") as Leaf).active).toBe("past-due");
    expect(out.focus).toBe("past-due");
  });

  test("activateTab on a pane that is already forward and focused changes nothing", () => {
    const start = arrangement(stackedPair(), { focus: "today" });
    expect(activateTab(start, "today")).toBe(start);
    expect(activateTab(start, "nothing")).toBe(start);
  });

  test("activateTab on a pane that is forward but not focused only moves focus", () => {
    const start = arrangement(stackedPair(), { focus: "calendar" });
    const out = activateTab(start, "today");
    expect(out.focus).toBe("today");
    expect(out.tree).toBe(start.tree);
  });

  test("cycleTab walks the focused pane's leaf and wraps both ways", () => {
    let arr = arrangement(stackedPair(), { focus: "today" });
    arr = cycleTab(arr, 1);
    expect(arr.focus).toBe("status");
    arr = cycleTab(arr, -1);
    expect(arr.focus).toBe("today");
    arr = cycleTab(arr, -1);
    expect(arr.focus).toBe("not-today");
    arr = cycleTab(arr, 1);
    expect(arr.focus).toBe("today");
  });

  test("cycleTab refuses a leaf with one tab, and no focus at all", () => {
    const lone = arrangement(fourWay(), { focus: "today" });
    expect(cycleTab(lone, 1)).toBe(lone);
    const unfocused = arrangement(stackedPair(), { focus: null });
    expect(cycleTab(unfocused, 1)).toBe(unfocused);
    const stale = arrangement(stackedPair(), { focus: "nothing" });
    expect(cycleTab(stale, 1)).toBe(stale);
  });

  test("toggleMaximize sets then clears, and refuses a pane that is not open", () => {
    const start = arrangement(stackedPair(), { focus: "today" });
    const maxed = toggleMaximize(start, "today");
    expect(maxed.maximized).toBe("today");
    expect(toggleMaximize(maxed, "today").maximized).toBeNull();
    expect(toggleMaximize(start, "nothing")).toBe(start);
    const nothing = arrangement(null);
    expect(toggleMaximize(nothing, "today")).toBe(nothing);
  });

  test("toggleMaximize moves the maximized pane rather than only clearing it", () => {
    const start = arrangement(stackedPair(), { maximized: "today", focus: "today" });
    expect(toggleMaximize(start, "calendar").maximized).toBe("calendar");
  });
});

// ------------------------------------------------ what is focused can be seen

/** Behaviour 18, both halves, for one arrangement. */
function expectVisible(arr: Arrangement, label: string): void {
  if (arr.focus !== null) {
    const focusLeaf = leafOf(arr.tree, arr.focus);
    expect(focusLeaf === null ? null : focusLeaf.active, `${label}: focus is in front`).toBe(
      arr.focus,
    );
  }
  if (arr.maximized !== null) {
    expect(arr.maximized, `${label}: the maximized pane is the focused one`).toBe(arr.focus);
  }
}

describe("what is focused can be seen", () => {
  /** stackedPair with `today` maximized: the state every case below starts from. */
  function maximizedToday(): Arrangement {
    const start = arrangement(stackedPair(), { focus: "today" });
    const out = toggleMaximize(start, "today");
    expect(out.maximized).toBe("today");
    expect(out.focus).toBe("today");
    return out;
  }

  test("toggleMaximize on a pane that is neither focused nor in front brings it forward", () => {
    const start = arrangement(stackedPair(), { focus: "calendar" });
    const out = toggleMaximize(start, "status");
    expect(out.maximized).toBe("status");
    expect(out.focus).toBe("status");
    expect((leafOf(out.tree, "status") as Leaf).active).toBe("status");
    expectVisible(out, "toggleMaximize on a background tab");
  });

  test("activateTab inside the maximized leaf moves the maximize to that tab", () => {
    const out = activateTab(maximizedToday(), "past-due");
    expect(out.focus).toBe("past-due");
    expect(out.maximized).toBe("past-due");
    expect((leafOf(out.tree, "past-due") as Leaf).active).toBe("past-due");
    expectVisible(out, "activateTab inside the maximized leaf");
  });

  test("activateTab on any other leaf clears the maximize", () => {
    const out = activateTab(maximizedToday(), "calendar");
    expect(out.focus).toBe("calendar");
    expect(out.maximized).toBeNull();
    expectVisible(out, "activateTab outside the maximized leaf");
  });

  test("cycleTab carries the maximize round the leaf it is walking", () => {
    let arr = maximizedToday();
    for (const expected of ["status", "past-due", "not-today", "today"]) {
      arr = cycleTab(arr, 1);
      expect(arr.focus).toBe(expected);
      expect(arr.maximized).toBe(expected);
      expectVisible(arr, `cycleTab to ${expected}`);
    }
    expect(cycleTab(arr, -1).maximized).toBe("not-today");
  });

  test("cycleTab clears a maximize that was never in the leaf it walks", () => {
    // From a conforming state cycleTab cannot leave the maximized leaf, because
    // the focus and the maximize are in the same one. This is the state
    // behaviour 18 was added to rule out, built by hand: the maximize is on
    // `calendar` while the focus is on `today` in another leaf. The first cycle
    // repairs it rather than walking a hidden leaf's tabs.
    const start = arrangement(stackedPair(), { maximized: "calendar", focus: "today" });
    const out = cycleTab(start, 1);
    expect(out.focus).toBe("status");
    expect(out.maximized).toBeNull();
    expectVisible(out, "cycleTab out of a stale maximize");
  });

  test("closing the focused pane while it is maximized clears the maximize", () => {
    const start = toggleMaximize(arrangement(stackedPair(), { focus: "calendar" }), "calendar");
    expect(start.maximized).toBe("calendar");
    const out = closePane(start, "calendar", SPECS);
    expect(out.maximized).toBeNull();
    expect(out.focus).toBe("today");
    expectVisible(out, "closePane of the maximized pane");
  });

  test("closing a tab mate of the maximized pane leaves the maximize alone", () => {
    const out = closePane(maximizedToday(), "status", SPECS);
    expect(out.maximized).toBe("today");
    expect(out.focus).toBe("today");
    expect((leafOf(out.tree, "today") as Leaf).tabs).toEqual(["today", "past-due", "not-today"]);
    expectVisible(out, "closePane of a tab mate");
  });

  test("opening a pane while something is maximized clears the maximize", () => {
    const start = toggleMaximize(arrangement(fourWay(), { focus: "today" }), "today");
    expect(start.maximized).toBe("today");
    const out = openPane(start, "calendar", null);
    expect(out.maximized).toBeNull();
    expect(out.focus).toBe("calendar");
    expectVisible(out, "openPane while maximized");
  });

  test("every operation keeps the rule, from a maximized start", () => {
    const start = maximizedToday();
    const leafIds = leavesOf(start.tree).map((found) => found.id);
    const outputs: Array<[string, Arrangement]> = [
      ["movePane centre", movePane(start, "calendar", leafIds[0], "centre")],
      ["movePane left", movePane(start, "calendar", leafIds[0], "left")],
      ["movePane split off", movePane(start, "status", leafIds[0], "right")],
      ["closePane", closePane(start, "not-today", SPECS)],
      ["openPane", openPane(start, "nothing-yet", null)],
      ["setRatio", setRatio(start, "s1", 0.42, 1472, SPECS)],
      ["equalize", equalize(arrangement(stackedPair(), { focus: "today" }), "s1")],
      ["swapLeaves", swapLeaves(start, leafIds[0], leafIds[1])],
      ["activateTab", activateTab(start, "status")],
      ["cycleTab", cycleTab(start, -1)],
      ["toggleMaximize off", toggleMaximize(start, "today")],
      ["toggleMaximize elsewhere", toggleMaximize(start, "calendar")],
    ];
    for (const [label, out] of outputs) expectVisible(out, label);
  });

  test("a focus that names a pane nobody has open is replaced", () => {
    const out = setRatio(arrangement(stackedPair(), { focus: "ghost" }), "s1", 0.4, 1472, SPECS);
    expect(out.focus).toBe("today");
    expectVisible(out, "setRatio with a stale focus");
  });

  test("a maximize with no focus at all cannot survive", () => {
    const out = setRatio(
      arrangement(stackedPair(), { focus: null, maximized: "today" }),
      "s1",
      0.4,
      1472,
      SPECS,
    );
    expect(out.focus).toBeNull();
    expect(out.maximized).toBeNull();
  });
});

// ------------------------------------------------------------------- purity

describe("every operation is pure", () => {
  test("no operation writes to the arrangement it was given", () => {
    const start = arrangement(stackedPair(), { focus: "today" });
    const before = JSON.stringify(start);
    movePane(start, "calendar", "l2", "left");
    closePane(start, "status", SPECS);
    openPane(start, "nothing-yet", null);
    setRatio(start, "s1", 0.2, 1000, SPECS);
    equalize(start, "s1");
    swapLeaves(start, "l2", "l3");
    activateTab(start, "status");
    cycleTab(start, 1);
    toggleMaximize(start, "today");
    expect(JSON.stringify(start)).toBe(before);
  });

  test("the result of every operation is already normal", () => {
    const start = arrangement(fourWay(), { focus: "today" });
    const outputs = [
      movePane(start, "calendar", "l3", "left"),
      movePane(start, "not-today", "l3", "centre"),
      closePane(start, "status", SPECS),
      openPane(start, "calendar", null),
      setRatio(start, "s1", 0.2, 1000, SPECS),
      equalize(start, "s2"),
      swapLeaves(start, "l3", "l7"),
    ];
    for (const out of outputs) expect(normalize(out.tree)).toBe(out.tree);
  });

  test("GAP and minSize are the numbers the layout is built on", () => {
    expect(GAP).toBe(6);
    expect(minSize(leaf("l1", "today", "status"), SPECS)).toEqual({ w: 320, h: 320 });
    expect(minSize(leaf("l1", "unknown-pane"), SPECS)).toEqual({ w: 0, h: 0 });
  });
});
