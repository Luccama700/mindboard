// Task 3, the split tree. The workspace is one tree of splits and tab stacks,
// and every operation on it is a pure function: it returns a NEW arrangement,
// shares whatever it did not change, and returns the SAME object when it
// changes nothing, so a caller can tell a refusal from a move without
// comparing trees.
//
// Amended by PLAN-DESK.md Task 1: every pane can be closed, a pane opens beside
// the largest leaf of a workspace the engine measures itself, ratios are held
// to four decimals, and three operations are new: `moveTab` (a tab's place in
// its own stack), `setOption` with `optionsOf` (a pane's saved view settings),
// and `flatten` (any arrangement as the phone's single stack).
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
  flatten,
  leafOf,
  leavesOf,
  movePane,
  moveTab,
  normalize,
  openPane,
  openPanes,
  optionsOf,
  setOption,
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
} from "@/app/lib/v2/tiles/types";

function spec(id: PaneId, minWidth: number, minHeight: number): PaneSpec {
  return { id, title: id, short: id, group: "day", minWidth, minHeight, options: [] };
}

/**
 * The test's own pane specs, with the catalog's sizes for these five. tree.ts
 * takes specs as an argument so it can be checked without the catalog; the
 * catalog is what it uses when none are given, and that default is pinned
 * separately below.
 */
const SPECS: readonly PaneSpec[] = [
  spec("today", 320, 320),
  spec("calendar", 320, 300),
  spec("status", 230, 150),
  spec("past-due", 230, 150),
  spec("not-today", 230, 150),
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
    options: {},
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

/** What a share is held to: four decimals. */
function fourDecimals(value: number): number {
  return Math.round(value * 10_000) / 10_000;
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

  test("holds a ratio to four decimals", () => {
    const fine = normalize(split("s1", "h", 0.123456, leaf("l2", "today"), leaf("l3", "status")));
    expect((fine as Split).ratio).toBe(0.1235);
    const kept = deepFreeze(split("s1", "h", 0.1235, leaf("l2", "today"), leaf("l3", "status")));
    expect(normalize(kept)).toBe(kept);
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
    expect(out.options).toBe(start.options);
  });
});

// ----------------------------------------------------------------- closePane

describe("closePane", () => {
  test("every pane can be closed, the day included", () => {
    const start = arrangement(stackedPair());
    const out = closePane(start, "today");
    expect(openPanes(out.tree)).toEqual(["status", "past-due", "not-today", "calendar"]);
    expect(out.lastSpot.today).toEqual({ beside: "status", zone: "centre", ratio: null });
  });

  test("is refused for the only pane open, whichever pane it is", () => {
    for (const pane of ["calendar", "today", "ledger"]) {
      const start = arrangement(leaf("l1", pane));
      expect(closePane(start, pane)).toBe(start);
    }
  });

  test("is refused for a pane that is not open, and on an empty tree", () => {
    const start = arrangement(stackedPair());
    expect(closePane(start, "nothing")).toBe(start);
    const nothing = arrangement(null);
    expect(closePane(nothing, "today")).toBe(nothing);
  });

  test("a tab remembers the first other tab of its own leaf, as a tab", () => {
    const out = closePane(arrangement(stackedPair()), "status");
    expect(out.lastSpot.status).toEqual({ beside: "today", zone: "centre", ratio: null });
    expect((leafOf(out.tree, "today") as Leaf).tabs).toEqual(["today", "past-due", "not-today"]);
  });

  test("a lone leaf remembers the side it was on and the split's ratio", () => {
    const out = closePane(arrangement(fourWay()), "not-today");
    expect(out.lastSpot["not-today"]).toEqual({ beside: "past-due", zone: "bottom", ratio: 0.4 });
    expect(signature(out.tree)).toBe("h50(v60([today]|[status])|[past-due])");
  });

  test("remembers the first leaf of a sibling that is itself a split", () => {
    const wide = arrangement(split("s8", "h", 0.29, fourWay(), leaf("l9", "calendar")));
    const closed = closePane(wide, "calendar");
    expect(closed.lastSpot.calendar).toEqual({ beside: "today", zone: "right", ratio: 0.29 });
    expect(signature(closed.tree)).toBe(signature(fourWay()));
  });

  test("clears maximized when it was that pane, and leaves another one alone", () => {
    const start = arrangement(fourWay(), { maximized: "status", focus: "status" });
    expect(closePane(start, "status").maximized).toBeNull();
    expect(closePane(start, "not-today").maximized).toBe("status");
  });

  test("focus moves to the first leaf's active tab only when it was that pane", () => {
    const start = arrangement(fourWay(), { focus: "not-today" });
    expect(closePane(start, "not-today").focus).toBe("today");
    expect(closePane(start, "status").focus).toBe("not-today");
  });

  test("keeps the spots it already had, and the options", () => {
    const start = arrangement(fourWay(), {
      lastSpot: { calendar: { beside: "today", zone: "right", ratio: 0.3 } },
      options: { calendar: { days: "3" } },
    });
    const out = closePane(start, "status");
    expect(out.lastSpot.calendar).toEqual({ beside: "today", zone: "right", ratio: 0.3 });
    expect(out.lastSpot.status).toBeDefined();
    expect(out.options).toBe(start.options);
  });
});

// ------------------------------------------------------------------ openPane

describe("openPane", () => {
  /** A narrow pane on the left and two stacked on the right, the top one by far the largest. */
  function lopsided(): TileNode {
    return split(
      "s1",
      "h",
      0.2,
      leaf("l2", "today"),
      split("s3", "v", 0.7, leaf("l4", "past-due"), leaf("l5", "not-today")),
    );
  }

  test("is a no-op for a pane that is already open", () => {
    const start = arrangement(stackedPair());
    expect(openPane(start, "today", null, SPECS)).toBe(start);
    expect(openPane(start, "today", { width: 1000, height: 600 }, SPECS)).toBe(start);
  });

  test("opening into an empty tree makes it the tree", () => {
    const out = openPane(arrangement(null), "today", null, SPECS);
    expect(out.tree).toEqual(leaf("l1", "today"));
    expect(out.focus).toBe("today");
  });

  test("a remembered spot brings the pane back with the split's old ratio", () => {
    const start = arrangement(
      split("s1", "h", 0.29, split("s2", "v", 0.56, leaf("l3", "not-today", "past-due"), leaf("l4", "today", "status")), leaf("l5", "calendar")),
    );
    const closed = closePane(start, "calendar");
    expect(closed.lastSpot.calendar).toEqual({ beside: "not-today", zone: "right", ratio: 0.29 });
    const back = openPane(closed, "calendar", null, SPECS);
    expect(signature(back.tree)).toBe("v56(h29([not-today,past-due]|[calendar])|[today,status])");
  });

  test("a remembered tab spot brings the pane back as a tab", () => {
    const start = arrangement(stackedPair());
    const closed = closePane(start, "not-today");
    const back = openPane(closed, "not-today", { width: 1000, height: 600 }, SPECS);
    expect(signature(back.tree)).toBe("h50([today,status,past-due,not-today]|[calendar])");
    expect((leafOf(back.tree, "not-today") as Leaf).active).toBe("not-today");
  });

  test("a pane's remembered spot is dropped once it is open, and closing writes it again", () => {
    const start = arrangement(fourWay(), {
      lastSpot: { calendar: { beside: "today", zone: "right", ratio: 0.3 } },
    });
    const closed = closePane(start, "not-today");
    expect(Object.keys(closed.lastSpot).slice().sort()).toEqual(["calendar", "not-today"]);
    const back = openPane(closed, "not-today", null, SPECS);
    expect(back.lastSpot).toEqual({ calendar: { beside: "today", zone: "right", ratio: 0.3 } });
    const again = closePane(back, "not-today");
    expect(again.lastSpot["not-today"]).toEqual(closed.lastSpot["not-today"]);

    // With no spot of its own to come back to, beside the largest leaf: the
    // spot it never had is not there to drop, and the others stay by reference.
    const fresh = openPane(start, "past-due-not-open", null, SPECS);
    expect(fresh.lastSpot).toBe(start.lastSpot);
    const landed = openPane(start, "calendar", { width: 1000, height: 600 }, SPECS);
    expect(landed.lastSpot).toEqual({});
  });

  test("a closed pane moved in drops its spot; an open pane moved keeps every spot by reference", () => {
    const start = arrangement(fourWay(), {
      lastSpot: { calendar: { beside: "today", zone: "right", ratio: 0.3 } },
    });
    const movedIn = movePane(start, "calendar", "l4", "bottom");
    expect(movedIn.lastSpot).toEqual({});
    const movedAround = movePane(start, "today", "l7", "centre");
    expect(movedAround.lastSpot).toBe(start.lastSpot);
  });

  test("opening into an empty tree drops the pane's spot too", () => {
    const start = arrangement(null, {
      lastSpot: {
        today: { beside: "status", zone: "left", ratio: 0.4 },
        ledger: { beside: "status", zone: "left", ratio: 0.4 },
      },
    });
    expect(openPane(start, "today", null, SPECS).lastSpot).toEqual({
      ledger: { beside: "status", zone: "left", ratio: 0.4 },
    });
  });

  test("falls back to the largest leaf of the workspace when the remembered neighbour is gone", () => {
    // At 2000 by 800 the left leaf is 399 wide and the top right one 1595 by 556,
    // the largest by far, and wide enough to open beside.
    const start = arrangement(lopsided(), {
      lastSpot: { calendar: { beside: "nothing-open", zone: "left", ratio: 0.2 } },
    });
    const out = openPane(start, "calendar", { width: 2000, height: 800 }, SPECS);
    expect(signature(out.tree)).toBe("h20([today]|v70(h50([past-due]|[calendar])|[not-today]))");
  });

  test("works the rects out itself, from the workspace it is given", () => {
    const start = arrangement(lopsided());
    const workspace = { width: 2000, height: 800 };
    const rects = layoutTree(start, workspace, SPECS);
    const largest = rects.leaves.reduce((best, rect) =>
      rect.w * rect.h > best.w * best.h ? rect : best,
    );
    expect(largest.leafId).toBe("l4");
    const out = openPane(start, "calendar", workspace, SPECS);
    expect(leafOf(out.tree, "past-due")?.id).toBe("l4");
    expect(signature(out.tree)).toContain("h50([past-due]|[calendar])");
  });

  test("goes right of the largest leaf when it is at least 1.2 times wider than tall, else below", () => {
    const start = arrangement(leaf("l1", "today"));
    expect(signature(openPane(start, "calendar", { width: 120, height: 100 }, SPECS).tree)).toBe(
      "h50([today]|[calendar])",
    );
    expect(signature(openPane(start, "calendar", { width: 119, height: 100 }, SPECS).tree)).toBe(
      "v50([today]|[calendar])",
    );
  });

  test("goes right of the first leaf when there is no workspace at all", () => {
    const out = openPane(arrangement(fourWay()), "calendar", null, SPECS);
    expect(signature(out.tree)).toBe("h50(v60(h50([today]|[calendar])|[status])|v40([past-due]|[not-today]))");
  });

  test("keeps the first of two leaves with equal areas", () => {
    // At 1000 by 600, today (top left) and not-today (bottom right) are both
    // 497 by 356. The first in tree order wins.
    const out = openPane(arrangement(fourWay()), "calendar", { width: 1000, height: 600 }, SPECS);
    expect(signature(out.tree)).toBe("h50(v60(h50([today]|[calendar])|[status])|v40([past-due]|[not-today]))");
  });

  test("measures the layout under a maximize, which the open is about to clear", () => {
    // Status is maximized and so drawn at the whole workspace, but the open
    // clears the maximize: the pane belongs beside the largest leaf of the
    // layout the user is about to see, not beside the one that filled the screen.
    const start = toggleMaximize(arrangement(fourWay(), { focus: "status" }), "status");
    expect(start.maximized).toBe("status");
    const out = openPane(start, "calendar", { width: 1000, height: 600 }, SPECS);
    expect(out.maximized).toBeNull();
    expect(out.focus).toBe("calendar");
    expect(signature(out.tree)).toBe("h50(v60(h50([today]|[calendar])|[status])|v40([past-due]|[not-today]))");
  });

  test("measures with the catalog's sizes when no specs are given", () => {
    const start = arrangement(lopsided());
    const workspace = { width: 2000, height: 800 };
    expect(openPane(start, "calendar", workspace).tree).toEqual(
      openPane(start, "calendar", workspace, SPECS).tree,
    );
  });
});

// ------------------------------------------------------------------ setRatio

describe("setRatio", () => {
  const tree = split("s1", "h", 0.5, leaf("l2", "today"), leaf("l3", "calendar"));

  test("stores the ratio the user dragged, at the size they dragged it", () => {
    const out = setRatio(arrangement(tree), "s1", 0.4, 1472, SPECS);
    expect((out.tree as Split).ratio).toBe(0.4);
  });

  test("clamps to the limits the two minimum sizes allow at that size, held to four decimals", () => {
    const [lo, hi] = shareLimits(tree, 800, SPECS);
    expect(lo).toBeCloseTo(320 / 794, 10);
    expect(hi).toBeCloseTo(1 - 320 / 794, 10);
    expect((setRatio(arrangement(tree), "s1", 0.01, 800, SPECS).tree as Split).ratio).toBe(
      fourDecimals(lo),
    );
    expect((setRatio(arrangement(tree), "s1", 0.99, 800, SPECS).tree as Split).ratio).toBe(
      fourDecimals(hi),
    );
  });

  test("holds a dragged ratio to four decimals", () => {
    const out = setRatio(arrangement(tree), "s1", 0.4123456, 1472, SPECS);
    expect((out.tree as Split).ratio).toBe(0.4123);
    // Within the same fourth decimal it is the ratio the split already has.
    expect(setRatio(out, "s1", 0.41234, 1472, SPECS)).toBe(out);
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
    // A value normalize would change could never survive a save and a load, so
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

  test("clamps with the catalog's sizes when no specs are given", () => {
    const start = arrangement(tree);
    expect(setRatio(start, "s1", 0.01, 800).tree).toEqual(
      setRatio(start, "s1", 0.01, 800, SPECS).tree,
    );
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

// ------------------------------------------------------------------- moveTab

describe("moveTab", () => {
  test("moves a pane to another place in its own stack, keeping the front tab and the focus", () => {
    const start = arrangement(stackedPair(), { focus: "today" });
    const out = moveTab(start, "today", 2);
    const stack = leafOf(out.tree, "today") as Leaf;
    expect(stack.tabs).toEqual(["status", "past-due", "today", "not-today"]);
    expect(stack.active).toBe("today");
    expect(stack.id).toBe("l2");
    expect(out.focus).toBe("today");
    expect((out.tree as Split).second).toBe((start.tree as Split).second);
  });

  test("moving a tab that is behind does not bring it forward", () => {
    const start = arrangement(stackedPair(), { focus: "calendar" });
    const out = moveTab(start, "not-today", 0);
    const stack = leafOf(out.tree, "today") as Leaf;
    expect(stack.tabs).toEqual(["not-today", "today", "status", "past-due"]);
    expect(stack.active).toBe("today");
    expect(out.focus).toBe("calendar");
  });

  test("clamps the index to the stack, and reads a fraction as the place before it", () => {
    const start = arrangement(stackedPair());
    expect((leafOf(moveTab(start, "status", 99).tree, "status") as Leaf).tabs).toEqual([
      "today",
      "past-due",
      "not-today",
      "status",
    ]);
    expect((leafOf(moveTab(start, "past-due", -4).tree, "status") as Leaf).tabs).toEqual([
      "past-due",
      "today",
      "status",
      "not-today",
    ]);
    expect((leafOf(moveTab(start, "not-today", 1.7).tree, "status") as Leaf).tabs).toEqual([
      "today",
      "not-today",
      "status",
      "past-due",
    ]);
  });

  test("returns the same object when nothing moves", () => {
    const start = arrangement(stackedPair());
    expect(moveTab(start, "status", 1)).toBe(start);
    expect(moveTab(start, "today", -3)).toBe(start);
    expect(moveTab(start, "calendar", 4)).toBe(start);
    expect(moveTab(start, "nothing", 0)).toBe(start);
    expect(moveTab(start, "status", Number.NaN)).toBe(start);
    const nothing = arrangement(null);
    expect(moveTab(nothing, "today", 0)).toBe(nothing);
  });

  test("changes the signature, because tab order is part of the arrangement", () => {
    const start = arrangement(stackedPair());
    expect(signature(moveTab(start, "today", 3).tree)).toBe(
      "h50([status,past-due,not-today,today]|[calendar])",
    );
  });
});

// ------------------------------------------------------------------ options

describe("setOption and optionsOf", () => {
  test("optionsOf answers every key the pane declares, the fallback where nothing is stored", () => {
    const start = arrangement(stackedPair());
    expect(optionsOf(start, "calendar")).toEqual({ days: "auto" });
    expect(optionsOf(start, "ledger")).toEqual({ rows: "25" });
    expect(optionsOf(start, "today")).toEqual({});
    expect(optionsOf(start, "nothing")).toEqual({});
  });

  test("setOption stores a choice the catalog offers, and optionsOf reads it back", () => {
    const start = arrangement(stackedPair());
    const out = setOption(start, "calendar", "days", "3");
    expect(out.options).toEqual({ calendar: { days: "3" } });
    expect(optionsOf(out, "calendar")).toEqual({ days: "3" });
    expect(out.tree).toBe(start.tree);
    expect(out.lastSpot).toBe(start.lastSpot);
  });

  test("a pane does not have to be open to keep its options", () => {
    const start = arrangement(stackedPair());
    const out = setOption(start, "ledger", "rows", "50");
    expect(out.options).toEqual({ ledger: { rows: "50" } });
  });

  test("refuses a pane, a key or a choice the catalog does not have", () => {
    const start = arrangement(stackedPair());
    expect(setOption(start, "calendar", "days", "5")).toBe(start);
    expect(setOption(start, "calendar", "rows", "25")).toBe(start);
    expect(setOption(start, "today", "days", "3")).toBe(start);
    expect(setOption(start, "nothing", "days", "3")).toBe(start);
    expect(setOption(start, "__proto__", "days", "3")).toBe(start);
    expect(setOption(start, "calendar", "__proto__", "3")).toBe(start);
    expect(({} as Record<string, unknown>).days).toBeUndefined();
  });

  test("the fallback removes the entry, and the pane's entry with its last one", () => {
    const start = arrangement(stackedPair(), {
      options: { calendar: { days: "7" }, ledger: { rows: "10" } },
    });
    const out = setOption(start, "calendar", "days", "auto");
    expect(out.options).toEqual({ ledger: { rows: "10" } });
    expect(Object.keys(out.options)).toEqual(["ledger"]);
    expect(setOption(out, "ledger", "rows", "25").options).toEqual({});
  });

  test("returns the same object when the value is already what is stored", () => {
    const start = arrangement(stackedPair(), { options: { calendar: { days: "7" } } });
    expect(setOption(start, "calendar", "days", "7")).toBe(start);
    const plain = arrangement(stackedPair());
    expect(setOption(plain, "calendar", "days", "auto")).toBe(plain);
  });

  test("optionsOf reads a stored value the catalog does not offer as the fallback", () => {
    const start = arrangement(stackedPair(), { options: { calendar: { days: "5", extra: "x" } } });
    expect(optionsOf(start, "calendar")).toEqual({ days: "auto" });
  });

  test("takes its own specs when they are given", () => {
    const specs: PaneSpec[] = [
      {
        ...spec("today", 320, 320),
        options: [
          {
            key: "size",
            label: "Size",
            choices: [
              { value: "small", label: "Small" },
              { value: "large", label: "Large" },
            ],
            fallback: "small",
          },
        ],
      },
    ];
    const start = arrangement(stackedPair());
    expect(optionsOf(start, "today", specs)).toEqual({ size: "small" });
    const out = setOption(start, "today", "size", "large", specs);
    expect(optionsOf(out, "today", specs)).toEqual({ size: "large" });
    expect(setOption(start, "calendar", "days", "3", specs)).toBe(start);
  });
});

// ------------------------------------------------------------------ flatten

describe("flatten", () => {
  test("puts every open pane into one leaf, in leaf order, with the focus in front", () => {
    const start = arrangement(fourWay(), { focus: "past-due" });
    const out = flatten(start);
    expect(out.tree).toEqual(activeLeaf("l3", "past-due", "today", "status", "past-due", "not-today"));
    expect(out.focus).toBe("past-due");
    expect(out.lastSpot).toBe(start.lastSpot);
    expect(out.options).toBe(start.options);
  });

  test("with nothing focused the first pane is in front", () => {
    const out = flatten(arrangement(fourWay(), { focus: null }));
    expect((out.tree as Leaf).active).toBe("today");
    expect(out.focus).toBeNull();
  });

  test("clears a maximize, because the phone has nothing to maximize over", () => {
    const start = toggleMaximize(arrangement(fourWay(), { focus: "status" }), "status");
    const out = flatten(start);
    expect(out.maximized).toBeNull();
    expect(out.focus).toBe("status");
    expect((out.tree as Leaf).active).toBe("status");
  });

  test("returns the same object for one leaf with nothing maximized, whatever is in front", () => {
    const one = arrangement(activeLeaf("l4", "status", "today", "status"), { focus: "status" });
    expect(flatten(one)).toBe(one);
    const nothing = arrangement(null);
    expect(flatten(nothing)).toBe(nothing);
  });

  test("a maximized single leaf keeps its tree and loses only the maximize", () => {
    const start = arrangement(leaf("l2", "today", "status"), { maximized: "today", focus: "today" });
    const out = flatten(start);
    expect(out.tree).toBe(start.tree);
    expect(out.maximized).toBeNull();
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
    const out = closePane(start, "calendar");
    expect(out.maximized).toBeNull();
    expect(out.focus).toBe("today");
    expectVisible(out, "closePane of the maximized pane");
  });

  test("closing a tab mate of the maximized pane leaves the maximize alone", () => {
    const out = closePane(maximizedToday(), "status");
    expect(out.maximized).toBe("today");
    expect(out.focus).toBe("today");
    expect((leafOf(out.tree, "today") as Leaf).tabs).toEqual(["today", "past-due", "not-today"]);
    expectVisible(out, "closePane of a tab mate");
  });

  test("opening a pane while something is maximized clears the maximize", () => {
    const start = toggleMaximize(arrangement(fourWay(), { focus: "today" }), "today");
    expect(start.maximized).toBe("today");
    const out = openPane(start, "calendar", null, SPECS);
    expect(out.maximized).toBeNull();
    expect(out.focus).toBe("calendar");
    expectVisible(out, "openPane while maximized");
  });

  test("moving a tab of the maximized leaf keeps the maximize on the pane in front", () => {
    const out = moveTab(maximizedToday(), "today", 3);
    expect(out.maximized).toBe("today");
    expect(out.focus).toBe("today");
    expectVisible(out, "moveTab in the maximized leaf");
  });

  test("every operation keeps the rule, from a maximized start", () => {
    const start = maximizedToday();
    const leafIds = leavesOf(start.tree).map((found) => found.id);
    const outputs: Array<[string, Arrangement]> = [
      ["movePane centre", movePane(start, "calendar", leafIds[0], "centre")],
      ["movePane left", movePane(start, "calendar", leafIds[0], "left")],
      ["movePane split off", movePane(start, "status", leafIds[0], "right")],
      ["closePane", closePane(start, "not-today")],
      ["closePane the maximized pane", closePane(start, "today")],
      ["openPane", openPane(start, "nothing-yet", null, SPECS)],
      ["openPane measured", openPane(start, "lanes", { width: 1200, height: 700 })],
      ["setRatio", setRatio(start, "s1", 0.42, 1472, SPECS)],
      ["equalize", equalize(arrangement(stackedPair(), { focus: "today" }), "s1")],
      ["swapLeaves", swapLeaves(start, leafIds[0], leafIds[1])],
      ["activateTab", activateTab(start, "status")],
      ["cycleTab", cycleTab(start, -1)],
      ["toggleMaximize off", toggleMaximize(start, "today")],
      ["toggleMaximize elsewhere", toggleMaximize(start, "calendar")],
      ["moveTab", moveTab(start, "status", 0)],
      ["setOption", setOption(start, "calendar", "days", "7")],
      ["flatten", flatten(start)],
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
    const start = arrangement(stackedPair(), {
      focus: "today",
      options: { calendar: { days: "3" } },
      lastSpot: { lanes: { beside: "today", zone: "right", ratio: 0.4 } },
    });
    const before = JSON.stringify(start);
    movePane(start, "calendar", "l2", "left");
    closePane(start, "status");
    openPane(start, "nothing-yet", null, SPECS);
    openPane(start, "lanes", { width: 1400, height: 800 });
    setRatio(start, "s1", 0.2, 1000, SPECS);
    equalize(start, "s1");
    swapLeaves(start, "l2", "l3");
    activateTab(start, "status");
    cycleTab(start, 1);
    toggleMaximize(start, "today");
    moveTab(start, "today", 2);
    setOption(start, "calendar", "days", "auto");
    setOption(start, "ledger", "rows", "50");
    optionsOf(start, "calendar");
    flatten(start);
    expect(JSON.stringify(start)).toBe(before);
  });

  test("the result of every operation is already normal", () => {
    const start = arrangement(fourWay(), { focus: "today" });
    const outputs = [
      movePane(start, "calendar", "l3", "left"),
      movePane(start, "not-today", "l3", "centre"),
      closePane(start, "status"),
      openPane(start, "calendar", null, SPECS),
      setRatio(start, "s1", 0.2, 1000, SPECS),
      equalize(start, "s2"),
      swapLeaves(start, "l3", "l7"),
      moveTab(movePane(start, "status", "l3", "centre"), "status", 0),
      flatten(start),
    ];
    for (const out of outputs) expect(normalize(out.tree)).toBe(out.tree);
  });

  test("GAP and minSize are the numbers the layout is built on", () => {
    expect(GAP).toBe(6);
    expect(minSize(leaf("l1", "today", "status"), SPECS)).toEqual({ w: 320, h: 320 });
    expect(minSize(leaf("l1", "today", "status"))).toEqual({ w: 320, h: 320 });
    expect(minSize(leaf("l1", "unknown-pane"), SPECS)).toEqual({ w: 0, h: 0 });
  });
});
