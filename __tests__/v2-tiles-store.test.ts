// Task 3, what is saved and the parser that reads it back.
//
// WHY THE PARSER IS THE MOST DEFENSIVE THING IN THE ENGINE. A layout lives in
// the user's own browser. The value can be absent, truncated, written by an
// older build, or hand edited, and whatever comes back decides what the screen
// looks like. An earlier layout engine was reviewed and discarded over exactly
// this: it could hand back a state with no pane open, and a screen with nothing
// on it has no control on it either, so there was no way out.
//
// So the parser cannot return a broken screen, and this file pins that as
// arithmetic rather than as care: a pane the catalog does not know is dropped, a
// tree that ends up with nothing open is replaced, the pane that cannot be
// closed is put back, and a saved slot for one screen size never stands in for
// another.
//
// The last block is the one that would catch what the others miss: 400 random
// operations from each of the six defaults, checking every invariant after
// every single step, with a save and a load every twenty five.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  ARRANGEMENTS,
  PANES,
  defaultArrangement,
  defaultTree,
} from "@/app/lib/v2/tiles/catalog";
import { layoutTree, minSize } from "@/app/lib/v2/tiles/geometry";
import {
  EMPTY_TILE_SET,
  applyArrangement,
  classState,
  isEdited,
  parseTileSet,
  resetClass,
  saveOver,
  serializeTileSet,
  withClassState,
} from "@/app/lib/v2/tiles/store";
import type { ClassState, TileSet } from "@/app/lib/v2/tiles/store";
import {
  activateTab,
  closePane,
  cycleTab,
  equalize,
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
import type {
  Arrangement,
  Leaf,
  PaneId,
  Rect,
  ScreenClass,
  Split,
  TileNode,
  Workspace,
  Zone,
} from "@/app/lib/v2/tiles/types";

const CLASSES: ScreenClass[] = ["regular", "wide"];
const ZONES: Zone[] = ["left", "right", "top", "bottom", "centre"];
const PANE_IDS: PaneId[] = PANES.map((pane) => pane.id);
const ID_SHAPE = /^[ls][0-9]+$/;

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = "app/lib/v2/tiles";
const SOURCES = ["types.ts", "tree.ts", "geometry.ts", "catalog.ts", "store.ts", "index.ts"];

function leaf(id: string, ...tabs: PaneId[]): Leaf {
  return { kind: "leaf", id, tabs: [...tabs], active: tabs[0] };
}

function stateOf(cls: ScreenClass, name: string): ClassState {
  return { current: name, working: defaultArrangement(cls, name), saved: {} };
}

/**
 * Used by the sequence test on every step. `saveOver` shares one tree between
 * `saved` and `working`, which is safe only because nothing writes to a tree,
 * and a frozen object under "use strict" throws on the first write that proves
 * otherwise rather than leaking a saved arrangement that quietly changed.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return value;
}

function allIds(node: TileNode | null, out: string[] = []): string[] {
  if (node === null) return out;
  out.push(node.id);
  if (node.kind === "split") {
    allIds(node.first, out);
    allIds(node.second, out);
  }
  return out;
}

function splitIds(node: TileNode | null, out: string[] = []): string[] {
  if (node === null || node.kind === "leaf") return out;
  out.push(node.id);
  splitIds(node.first, out);
  splitIds(node.second, out);
  return out;
}

function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) numbersIn(inner, out);
  }
  return out;
}

function depthOf(node: TileNode | null): number {
  if (node === null) return 0;
  if (node.kind === "leaf") return 1;
  return 1 + Math.max(depthOf(node.first), depthOf(node.second));
}

/** The leaves and dividers cover the workspace exactly, no leaf under its minimum. */
function expectTiling(source: Arrangement, workspace: Workspace, label: string): void {
  const flat: Arrangement = { ...source, maximized: null };
  const rects = layoutTree(flat, workspace, PANES);
  const all: Rect[] = [...rects.leaves, ...rects.dividers];
  let area = 0;
  for (const rect of all) {
    expect(
      rect.w >= 0 && rect.h >= 0 && rect.x >= 0 && rect.y >= 0,
      `${label}: not negative`,
    ).toBe(true);
    area += rect.w * rect.h;
  }
  expect(area, `${label}: covers ${workspace.width}x${workspace.height}`).toBe(
    workspace.width * workspace.height,
  );
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
    if (node === undefined) throw new Error(`${label}: a rect with no leaf`);
    const min = minSize(node, PANES);
    expect(rect.w >= min.w && rect.h >= min.h, `${label}: ${node.id} fits its content`).toBe(true);
  }
}

// -------------------------------------------------------------- the slots

describe("one slot per screen class", () => {
  test("EMPTY_TILE_SET is version one with nothing stored, and cannot be written to", () => {
    expect(EMPTY_TILE_SET).toEqual({ version: 1, classes: {} });
    expect(Object.isFrozen(EMPTY_TILE_SET)).toBe(true);
    expect(Object.isFrozen(EMPTY_TILE_SET.classes)).toBe(true);
  });

  test("classState returns the stored slot, by reference", () => {
    const wide = stateOf("wide", "plan");
    const set = withClassState(EMPTY_TILE_SET, "wide", wide);
    expect(classState(set, "wide")).toBe(wide);
  });

  test("classState falls back to that class's own default and never to another's", () => {
    const set = withClassState(EMPTY_TILE_SET, "wide", stateOf("wide", "backlog"));
    const regular = classState(set, "regular");
    expect(regular.current).toBe("today");
    expect(signature(regular.working.tree)).toBe(signature(defaultTree("regular", "today")));
    expect(regular.saved).toEqual({});
    expect(signature(regular.working.tree)).not.toBe(signature(defaultTree("wide", "today")));
  });

  test("withClassState replaces one slot and leaves the other exactly as it was", () => {
    const wide = stateOf("wide", "plan");
    const regular = stateOf("regular", "today");
    const both = withClassState(withClassState(EMPTY_TILE_SET, "wide", wide), "regular", regular);
    const replaced = withClassState(both, "wide", stateOf("wide", "backlog"));
    expect(replaced.classes.regular).toBe(regular);
    expect(replaced.classes.wide).not.toBe(wide);
    expect(both.classes.wide).toBe(wide);
    expect(withClassState(both, "wide", wide)).toBe(both);
  });

  test("resetClass drops one slot and leaves the other exactly as it was", () => {
    const wide = stateOf("wide", "plan");
    const regular = stateOf("regular", "today");
    const both = withClassState(withClassState(EMPTY_TILE_SET, "wide", wide), "regular", regular);
    const out = resetClass(both, "wide");
    expect(out.classes.wide).toBeUndefined();
    expect(out.classes.regular).toBe(regular);
    expect(classState(out, "wide").current).toBe("today");
    expect(resetClass(out, "wide")).toBe(out);
  });
});

// -------------------------------------------------------------- the parser

describe("parseTileSet cannot return a broken screen", () => {
  test("anything that is not a set of its own version comes back empty", () => {
    for (const value of [
      null,
      undefined,
      0,
      "",
      "not json",
      "[]",
      [],
      true,
      { version: 2, classes: {} },
      { version: "1", classes: {} },
      { classes: {} },
      { version: 1 },
      { version: 1, classes: "no" },
      { version: 1, classes: [] },
    ]) {
      expect(parseTileSet(value), JSON.stringify(value) ?? "undefined").toEqual(EMPTY_TILE_SET);
    }
  });

  test("reads a string as well as an object", () => {
    const set = withClassState(EMPTY_TILE_SET, "wide", stateOf("wide", "plan"));
    expect(parseTileSet(serializeTileSet(set))).toEqual(set);
  });

  test("drops a pane the catalog does not know and normalizes what is left", () => {
    const stored = {
      version: 1,
      classes: {
        regular: {
          current: "today",
          working: {
            tree: {
              kind: "split",
              id: "s1",
              dir: "h",
              ratio: 0.5,
              first: { kind: "leaf", id: "l2", tabs: ["today", "ghost"], active: "ghost" },
              second: { kind: "leaf", id: "l3", tabs: ["gone"], active: "gone" },
            },
            maximized: null,
            focus: "ghost",
            lastSpot: {},
          },
          saved: {},
        },
      },
    };
    const state = classState(parseTileSet(stored), "regular");
    expect(openPanes(state.working.tree)).toEqual(["today"]);
    expect(state.working.focus).toBe("today");
    expect(state.working.tree).toEqual(leaf("l2", "today"));
  });

  test("a pane listed twice keeps its first place", () => {
    const stored = {
      version: 1,
      classes: {
        regular: {
          current: "today",
          working: {
            tree: {
              kind: "split",
              id: "s1",
              dir: "h",
              ratio: 0.5,
              first: { kind: "leaf", id: "l2", tabs: ["today", "status", "today"], active: "today" },
              second: { kind: "leaf", id: "l3", tabs: ["status", "calendar"], active: "status" },
            },
            maximized: null,
            focus: "today",
            lastSpot: {},
          },
          saved: {},
        },
      },
    };
    const state = classState(parseTileSet(stored), "regular");
    expect(openPanes(state.working.tree)).toEqual(["today", "status", "calendar"]);
  });

  test("a tree with nothing open is replaced by that class's default", () => {
    for (const tree of [
      null,
      "nope",
      { kind: "leaf", id: "l1", tabs: [], active: "today" },
      { kind: "leaf", id: "l1", tabs: ["ghost"], active: "ghost" },
      { kind: "split", id: "s1", dir: "h", ratio: 0.5 },
    ]) {
      const state = classState(
        parseTileSet({
          version: 1,
          classes: {
            wide: {
              current: "plan",
              working: { tree, maximized: null, focus: null, lastSpot: {} },
              saved: {},
            },
          },
        }),
        "wide",
      );
      expect(signature(state.working.tree)).toBe(signature(defaultTree("wide", "plan")));
    }
  });

  test("a tree deeper than twelve levels is replaced, and twelve is kept", () => {
    const chain = (levels: number): unknown => {
      let node: unknown = { kind: "leaf", id: "l1", tabs: ["today"], active: "today" };
      for (let step = 0; step < levels; step += 1) {
        node = {
          kind: "split",
          id: `s${step}`,
          dir: "h",
          ratio: 0.5,
          first: node,
          second: { kind: "leaf", id: `k${step}`, tabs: ["calendar"], active: "calendar" },
        };
      }
      return node;
    };
    const read = (tree: unknown): string =>
      signature(
        classState(
          parseTileSet({
            version: 1,
            classes: {
              regular: {
                current: "today",
                working: { tree, maximized: null, focus: null, lastSpot: {} },
                saved: {},
              },
            },
          }),
          "regular",
        ).working.tree,
      );
    expect(read(chain(11))).toBe("h50([today]|[calendar])");
    expect(read(chain(12))).toBe(signature(defaultTree("regular", "today")));
  });

  test("a tree that points at itself is replaced rather than followed forever", () => {
    const cyclic: Record<string, unknown> = {
      kind: "split",
      id: "s1",
      dir: "h",
      ratio: 0.5,
      second: { kind: "leaf", id: "l2", tabs: ["today"], active: "today" },
    };
    cyclic.first = cyclic;
    const state = classState(
      parseTileSet({
        version: 1,
        classes: {
          regular: {
            current: "backlog",
            working: { tree: cyclic, maximized: null, focus: null, lastSpot: {} },
            saved: {},
          },
        },
      }),
      "regular",
    );
    expect(signature(state.working.tree)).toBe(signature(defaultTree("regular", "backlog")));
  });

  test("the pane that cannot be closed is put back where it was remembered", () => {
    const stored = {
      version: 1,
      classes: {
        regular: {
          current: "today",
          working: {
            tree: { kind: "leaf", id: "l1", tabs: ["calendar", "status"], active: "calendar" },
            maximized: null,
            focus: "calendar",
            lastSpot: { today: { beside: "status", zone: "centre", ratio: null } },
          },
          saved: {},
        },
      },
    };
    const state = classState(parseTileSet(stored), "regular");
    expect(openPanes(state.working.tree)).toEqual(["calendar", "status", "today"]);
    expect(state.working.focus).toBe("calendar");
  });

  test("the pane that cannot be closed is put back even with nothing remembered", () => {
    const stored = {
      version: 1,
      classes: {
        wide: {
          current: "today",
          working: {
            tree: { kind: "leaf", id: "l1", tabs: ["calendar"], active: "calendar" },
            maximized: null,
            focus: null,
            lastSpot: {},
          },
          saved: {},
        },
      },
    };
    const state = classState(parseTileSet(stored), "wide");
    expect(openPanes(state.working.tree)).toContain("today");
  });

  test("maximized and focus that name a pane that is not open are repaired", () => {
    const stored = {
      version: 1,
      classes: {
        regular: {
          current: "today",
          working: {
            tree: { kind: "leaf", id: "l1", tabs: ["today", "status"], active: "today" },
            maximized: "calendar",
            focus: "past-due",
            lastSpot: {},
          },
          saved: {},
        },
      },
    };
    const state = classState(parseTileSet(stored), "regular");
    expect(state.working.maximized).toBeNull();
    expect(state.working.focus).toBe("today");
  });

  test("keeps a maximized pane and a focus that are open", () => {
    const stored = {
      version: 1,
      classes: {
        regular: {
          current: "plan",
          working: {
            tree: { kind: "leaf", id: "l1", tabs: ["today", "status"], active: "today" },
            maximized: "status",
            focus: "status",
            lastSpot: {},
          },
          saved: {},
        },
      },
    };
    const state = classState(parseTileSet(stored), "regular");
    expect(state.working.maximized).toBe("status");
    expect(state.working.focus).toBe("status");
  });

  test("saved trees go through the same repair, and an unlisted name is dropped", () => {
    const stored = {
      version: 1,
      classes: {
        regular: {
          current: "plan",
          working: {
            tree: { kind: "leaf", id: "l1", tabs: ["today"], active: "today" },
            maximized: null,
            focus: "today",
            lastSpot: {},
          },
          saved: {
            plan: { kind: "leaf", id: "l1", tabs: ["calendar", "ghost"], active: "ghost" },
            backlog: { kind: "leaf", id: "l1", tabs: ["ghost"], active: "ghost" },
            mine: { kind: "leaf", id: "l1", tabs: ["today"], active: "today" },
          },
        },
      },
    };
    const state = classState(parseTileSet(stored), "regular");
    expect(Object.keys(state.saved).slice().sort()).toEqual(["backlog", "plan"]);
    expect(openPanes(state.saved.plan)).toEqual(["calendar", "today"]);
    expect(signature(state.saved.backlog)).toBe(signature(defaultTree("regular", "backlog")));
  });

  test("current falls back to the first arrangement", () => {
    for (const current of [undefined, null, 7, "mine", "__proto__"]) {
      const state = classState(
        parseTileSet({
          version: 1,
          classes: {
            wide: {
              current,
              working: {
                tree: { kind: "leaf", id: "l1", tabs: ["today"], active: "today" },
                maximized: null,
                focus: "today",
                lastSpot: {},
              },
              saved: {},
            },
          },
        }),
        "wide",
      );
      expect(state.current).toBe(ARRANGEMENTS[0].name);
    }
  });

  test("never clamps a ratio to a workspace, because it has none", () => {
    const stored = {
      version: 1,
      classes: {
        wide: {
          current: "today",
          working: {
            tree: {
              kind: "split",
              id: "s1",
              dir: "h",
              ratio: 0.9,
              first: { kind: "leaf", id: "l2", tabs: ["today"], active: "today" },
              second: { kind: "leaf", id: "l3", tabs: ["calendar"], active: "calendar" },
            },
            maximized: null,
            focus: "today",
            lastSpot: {},
          },
          saved: {},
        },
      },
    };
    const state = classState(parseTileSet(stored), "wide");
    expect((state.working.tree as Split).ratio).toBe(0.9);
  });

  test("repairs a ratio that is out of range or not a number", () => {
    const read = (ratio: unknown): number =>
      (
        classState(
          parseTileSet({
            version: 1,
            classes: {
              wide: {
                current: "today",
                working: {
                  tree: {
                    kind: "split",
                    id: "s1",
                    dir: "h",
                    ratio,
                    first: { kind: "leaf", id: "l2", tabs: ["today"], active: "today" },
                    second: { kind: "leaf", id: "l3", tabs: ["calendar"], active: "calendar" },
                  },
                  maximized: null,
                  focus: "today",
                  lastSpot: {},
                },
                saved: {},
              },
            },
          }),
          "wide",
        ).working.tree as Split
      ).ratio;
    expect(read(4)).toBe(0.95);
    expect(read(-1)).toBe(0.05);
    expect(read("half")).toBe(0.5);
    expect(read(null)).toBe(0.5);
  });

  test("gives a tree with repeated or malformed ids ids of its own", () => {
    const stored = {
      version: 1,
      classes: {
        regular: {
          current: "today",
          working: {
            tree: {
              kind: "split",
              id: "l1",
              dir: "v",
              ratio: 0.4,
              first: { kind: "leaf", id: "l1", tabs: ["today"], active: "today" },
              second: { kind: "leaf", tabs: ["calendar"], active: "calendar" },
            },
            maximized: null,
            focus: "today",
            lastSpot: {},
          },
          saved: {},
        },
      },
    };
    const tree = classState(parseTileSet(stored), "regular").working.tree;
    const ids = allIds(tree);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(ID_SHAPE.test(id)).toBe(true);
    expect((tree as Split).id).toBe("s1");
    expect((tree as Split).ratio).toBe(0.4);
  });

  test("repairs what it was given about where closed panes were", () => {
    const stored = {
      version: 1,
      classes: {
        regular: {
          current: "today",
          working: {
            tree: { kind: "leaf", id: "l1", tabs: ["today", "status"], active: "today" },
            maximized: null,
            focus: "today",
            lastSpot: {
              calendar: { beside: "today", zone: "right", ratio: 0.4 },
              "past-due": { beside: "ghost", zone: "left", ratio: 0.4 },
              "not-today": { beside: "today", zone: "sideways", ratio: 0.4 },
              status: { beside: "today", zone: "centre", ratio: 0.4 },
              today: { beside: "status", zone: "left", ratio: 40 },
              ghost: { beside: "today", zone: "left", ratio: 0.4 },
            },
          },
          saved: {},
        },
      },
    };
    const spots = classState(parseTileSet(stored), "regular").working.lastSpot;
    expect(Object.keys(spots).slice().sort()).toEqual(["calendar", "status", "today"]);
    expect(spots.calendar).toEqual({ beside: "today", zone: "right", ratio: 0.4 });
    expect(spots.status.ratio).toBeNull();
    expect(spots.today.ratio).toBe(0.95);
  });

  test("ignores keys that would reach Object.prototype", () => {
    const hostile = JSON.parse(
      '{"version":1,"classes":{"__proto__":{"polluted":"yes"},"constructor":{"polluted":"yes"},' +
        '"regular":{"current":"today","working":{"tree":{"kind":"leaf","id":"l1","tabs":["today"],' +
        '"active":"today"},"maximized":null,"focus":"today","lastSpot":{"__proto__":{"beside":"today",' +
        '"zone":"left","ratio":0.4},"prototype":{"beside":"today","zone":"left","ratio":0.4}}},' +
        '"saved":{"__proto__":{"kind":"leaf","id":"l1","tabs":["today"],"active":"today"},' +
        '"constructor":{"kind":"leaf","id":"l1","tabs":["today"],"active":"today"}}}}}',
    ) as unknown;
    const set = parseTileSet(hostile);
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(Object.keys(set.classes)).toEqual(["regular"]);
    const state = classState(set, "regular");
    expect(Object.keys(state.saved)).toEqual([]);
    expect(Object.keys(state.working.lastSpot)).toEqual([]);
  });

  test("a malformed slot for one class leaves the other class alone", () => {
    const wide = stateOf("wide", "backlog");
    const stored = {
      version: 1,
      classes: { regular: "broken", wide: JSON.parse(serializeTileSet(withClassState(EMPTY_TILE_SET, "wide", wide))).classes.wide },
    };
    const set = parseTileSet(stored);
    expect(set.classes.regular).toBeUndefined();
    expect(signature(classState(set, "wide").working.tree)).toBe(signature(wide.working.tree));
  });
});

// ------------------------------------------------------------ the round trip

describe("saving and loading", () => {
  test("serializeTileSet writes the same text for equal sets, whatever order they were built in", () => {
    const tree = defaultTree("wide", "today");
    const oneWay: ClassState = {
      current: "plan",
      working: {
        tree,
        maximized: null,
        focus: "today",
        lastSpot: {
          calendar: { beside: "today", zone: "right", ratio: 0.3 },
          status: { beside: "today", zone: "centre", ratio: null },
        },
      },
      saved: { plan: defaultTree("wide", "plan"), today: tree },
    };
    const otherWay: ClassState = {
      current: "plan",
      working: {
        lastSpot: {
          status: { beside: "today", zone: "centre", ratio: null },
          calendar: { beside: "today", zone: "right", ratio: 0.3 },
        },
        focus: "today",
        maximized: null,
        tree,
      },
      saved: { today: tree, plan: defaultTree("wide", "plan") },
    };
    const first = withClassState(EMPTY_TILE_SET, "wide", oneWay);
    const second = withClassState(EMPTY_TILE_SET, "wide", otherWay);
    expect(serializeTileSet(first)).toBe(serializeTileSet(second));
    expect(parseTileSet(serializeTileSet(first))).toEqual(first);
  });

  test("a set the engine made survives a save and a load exactly", () => {
    for (const cls of CLASSES) {
      let state = stateOf(cls, "today");
      state = saveOver(state, "today");
      state = applyArrangement(state, cls, "plan");
      let working = state.working;
      working = closePane(working, "status", PANES);
      working = closePane(working, "past-due", PANES);
      working = movePane(working, "calendar", leavesOf(working.tree)[0].id, "top");
      working = openPane(working, "status", layoutTree(working, { width: 1200, height: 800 }, PANES));
      working = toggleMaximize(working, "status");
      working = activateTab(working, "today");
      state = { ...state, working };
      state = saveOver(state, "plan");
      const set = withClassState(EMPTY_TILE_SET, cls, state);
      expect(parseTileSet(serializeTileSet(set)), cls).toEqual(set);
    }
  });

  test("both slots survive together", () => {
    const set = withClassState(
      withClassState(EMPTY_TILE_SET, "wide", stateOf("wide", "backlog")),
      "regular",
      stateOf("regular", "plan"),
    );
    expect(parseTileSet(serializeTileSet(set))).toEqual(set);
  });
});

// ----------------------------------------------------- the named arrangements

describe("the named arrangements", () => {
  test("applyArrangement loads the saved tree, or the default when none is saved", () => {
    const start = stateOf("wide", "today");
    const planned = applyArrangement(start, "wide", "plan");
    expect(planned.current).toBe("plan");
    expect(signature(planned.working.tree)).toBe(signature(defaultTree("wide", "plan")));

    const mine = movePane(defaultArrangement("wide", "plan"), "calendar", "l3", "centre");
    const saved: ClassState = { ...start, saved: { plan: mine.tree as TileNode } };
    expect(signature(applyArrangement(saved, "wide", "plan").working.tree)).toBe(
      signature(mine.tree),
    );
  });

  test("applyArrangement clears maximized, keeps what it remembers, and refuses a name it does not know", () => {
    const start = stateOf("regular", "today");
    const working = toggleMaximize(closePane(start.working, "status", PANES), "today");
    const state: ClassState = { ...start, working };
    expect(working.maximized).toBe("today");
    expect(Object.keys(working.lastSpot)).toEqual(["status"]);
    const out = applyArrangement(state, "regular", "backlog");
    expect(out.working.maximized).toBeNull();
    expect(out.working.lastSpot).toBe(working.lastSpot);
    expect(applyArrangement(state, "regular", "mine")).toBe(state);
  });

  test("applyArrangement leaves focus on a pane that is open", () => {
    const start = stateOf("wide", "today");
    const state: ClassState = { ...start, working: { ...start.working, focus: "calendar" } };
    expect(applyArrangement(state, "wide", "plan").working.focus).toBe("calendar");
    const stale: ClassState = { ...start, working: { ...start.working, focus: "ghost" } };
    const out = applyArrangement(stale, "wide", "plan");
    expect(openPanes(out.working.tree)).toContain(out.working.focus);
  });

  test("saveOver stores the working tree under a name and makes it current", () => {
    const start = stateOf("wide", "today");
    const working = movePane(start.working, "calendar", "l4", "centre");
    const out = saveOver({ ...start, working }, "backlog");
    expect(out.current).toBe("backlog");
    expect(out.saved.backlog).toBe(working.tree);
    expect(out.saved.today).toBeUndefined();
    expect(saveOver(start, "mine")).toBe(start);
  });

  test("isEdited compares the shape with what is saved, or with the default", () => {
    const start = stateOf("regular", "today");
    expect(isEdited(start, "regular")).toBe(false);

    const moved = { ...start, working: movePane(start.working, "calendar", "l2", "top") };
    expect(isEdited(moved, "regular")).toBe(true);

    const saved = saveOver(moved, "today");
    expect(isEdited(saved, "regular")).toBe(false);

    const again = {
      ...saved,
      working: setRatio(saved.working, (saved.working.tree as Split).id, 0.3, 1200, PANES),
    };
    expect(signature(again.working.tree)).not.toBe(signature(saved.working.tree));
    expect(isEdited(again, "regular")).toBe(true);
  });

  test("bringing a tab forward is not an edit, and resizing is", () => {
    const start = stateOf("wide", "plan");
    const tabbed = { ...start, working: activateTab(start.working, "past-due") };
    expect(isEdited(tabbed, "wide")).toBe(false);
    const resized = {
      ...start,
      working: setRatio(start.working, "s1", 0.42, 1472, PANES),
    };
    expect(isEdited(resized, "wide")).toBe(true);
  });

  test("isEdited reads the class it is given, not the one the tree came from", () => {
    const wide = stateOf("wide", "today");
    expect(isEdited(wide, "wide")).toBe(false);
    expect(isEdited(wide, "regular")).toBe(true);
  });
});

// -------------------------------------------------------------- sequences

/** mulberry32: a seeded generator, so a failure can be run again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function expectSound(arrangement: Arrangement, label: string): void {
  const tree = arrangement.tree;
  expect(tree, `${label}: something is open`).not.toBeNull();
  if (tree === null) return;

  const open = openPanes(tree);
  expect(new Set(open).size, `${label}: every pane in one place`).toBe(open.length);
  expect(open, `${label}: today never closes`).toContain("today");
  for (const found of leavesOf(tree)) {
    expect(found.tabs.length, `${label}: no empty leaf`).toBeGreaterThan(0);
    expect(found.tabs, `${label}: the front tab is one of the tabs`).toContain(found.active);
  }

  const ids = allIds(tree);
  expect(new Set(ids).size, `${label}: ids are unique`).toBe(ids.length);
  const expectShape = (node: TileNode): void => {
    expect(ID_SHAPE.test(node.id), `${label}: ${node.id} is an id`).toBe(true);
    expect(node.id.slice(0, 1), `${label}: ${node.id} matches its kind`).toBe(
      node.kind === "leaf" ? "l" : "s",
    );
    if (node.kind === "leaf") return;
    expect(typeof node.first, `${label}: a split has two children`).toBe("object");
    expect(typeof node.second, `${label}: a split has two children`).toBe("object");
    expectShape(node.first);
    expectShape(node.second);
  };
  expectShape(tree);

  expect(normalize(tree), `${label}: already normal`).toBe(tree);
  if (arrangement.maximized !== null) {
    expect(open, `${label}: a maximized pane is open`).toContain(arrangement.maximized);
  }
  if (arrangement.focus !== null) {
    expect(open, `${label}: a focused pane is open`).toContain(arrangement.focus);
  }
  for (const value of numbersIn(arrangement)) {
    expect(Number.isFinite(value), `${label}: every number is a number`).toBe(true);
  }

  const min = minSize(tree, PANES);
  // Five panes cannot need more than one row or column of them, so the last of
  // these three is above every minimum the sequence can reach: the check is
  // never skipped for being too small.
  expect(min.w, `${label}: within the five pane bound`).toBeLessThanOrEqual(1354);
  expect(min.h, `${label}: within the five pane bound`).toBeLessThanOrEqual(1094);
  for (const workspace of [
    { width: min.w, height: min.h },
    { width: min.w + 211, height: min.h + 97 },
    { width: 1600, height: 1200 },
  ]) {
    expectTiling(arrangement, workspace, label);
  }
}

describe("four hundred operations from every default", () => {
  const STEPS = 400;
  const SAVE_EVERY = 25;

  for (const cls of CLASSES) {
    for (const entry of ARRANGEMENTS) {
      test(`${cls} ${entry.name} stays a workspace`, () => {
        const random = seeded(0x5eed + entry.name.length * 31 + cls.length);
        const pick = <T,>(values: readonly T[]): T =>
          values[Math.min(values.length - 1, Math.floor(random() * values.length))];

        let state: ClassState = deepFreeze(stateOf(cls, entry.name));
        let deepest = 0;
        // What the run actually reached. A sequence test that only ever hit
        // refusals would pass every invariant and prove nothing, so the counts
        // are asserted at the end.
        const reached = { changed: 0, closed: 0, whole: 0, maximized: 0, stacked: 0 };
        expectSound(state.working, `${cls} ${entry.name} step 0`);

        for (let step = 1; step <= STEPS; step += 1) {
          const label = `${cls} ${entry.name} step ${step}`;
          const working = state.working;
          const leafIds = leavesOf(working.tree).map((found) => found.id);
          const splits = splitIds(working.tree);
          const width = pick([400, 896, 1200, 1472, 1920, 3200]);
          const rects = layoutTree(working, { width, height: Math.round(width * 0.6) }, PANES);
          let next = working;
          switch (Math.floor(random() * 9)) {
            case 0:
              next = closePane(working, pick(PANE_IDS), PANES);
              break;
            case 1:
              next = openPane(working, pick(PANE_IDS), random() < 0.2 ? null : rects);
              break;
            case 2:
              next = movePane(working, pick(PANE_IDS), pick(leafIds), pick(ZONES));
              break;
            case 3:
              next =
                splits.length === 0
                  ? working
                  : setRatio(working, pick(splits), random(), width, PANES);
              break;
            case 4:
              next = splits.length === 0 ? working : equalize(working, pick(splits));
              break;
            case 5:
              next = activateTab(working, pick(PANE_IDS));
              break;
            case 6:
              next = cycleTab(working, random() < 0.5 ? 1 : -1);
              break;
            case 7:
              next = toggleMaximize(working, pick(PANE_IDS));
              break;
            default:
              next = swapLeaves(working, pick(leafIds), pick(leafIds));
              break;
          }
          state = deepFreeze({ ...state, working: next });
          expectSound(next, label);
          deepest = Math.max(deepest, depthOf(next.tree));
          if (next !== working) reached.changed += 1;
          const open = openPanes(next.tree).length;
          if (open < PANE_IDS.length) reached.closed += 1;
          if (open === PANE_IDS.length) reached.whole += 1;
          if (next.maximized !== null) reached.maximized += 1;
          if (leavesOf(next.tree).some((found) => found.tabs.length > 1)) reached.stacked += 1;

          if (step % SAVE_EVERY === 0) {
            if (random() < 0.5) state = deepFreeze(saveOver(state, pick(ARRANGEMENTS).name));
            const set: TileSet = withClassState(EMPTY_TILE_SET, cls, state);
            const back = parseTileSet(serializeTileSet(set));
            expect(back, `${label}: survives a save and a load`).toEqual(set);
            state = deepFreeze(classState(back, cls));
            expectSound(state.working, `${label}: after a load`);
          }
        }

        // Five panes can make at most five leaves, so the tree can never be
        // deeper than five. The parser's cap of twelve is defence against a
        // hand edited value, not a limit the engine can reach.
        expect(deepest).toBeLessThanOrEqual(5);
        expect(deepest).toBeGreaterThan(1);
        // The run went somewhere: panes closed, panes came back, something was
        // maximized, and tabs stacked up.
        expect(reached.changed).toBeGreaterThan(STEPS / 4);
        expect(reached.closed).toBeGreaterThan(0);
        expect(reached.whole).toBeGreaterThan(0);
        expect(reached.maximized).toBeGreaterThan(0);
        expect(reached.stacked).toBeGreaterThan(0);
      });
    }
  }
});

// ----------------------------------------------------------------- purity

describe("the engine is pure", () => {
  const read = (name: string): string =>
    readFileSync(path.join(ROOT, SOURCE_DIR, name), "utf8");

  test("the whole engine can be reached through one import", async () => {
    const engine = await import("@/app/lib/v2/tiles");
    expect(engine.GAP).toBe(6);
    expect(engine.PANES.map((pane) => pane.id)).toContain("today");
    expect(engine.ARRANGEMENTS[0].name).toBe("today");
    expect(engine.screenClassFor(1600)).toBe("wide");
    expect(engine.EMPTY_TILE_SET.classes).toEqual({});
    expect(engine.signature(engine.defaultTree("wide", "today"))).toBe(
      signature(defaultTree("wide", "today")),
    );
    const start = engine.defaultArrangement("regular", "today");
    expect(engine.layoutTree(start, { width: 896, height: 600 }, engine.PANES).leaves).toHaveLength(
      2,
    );
    expect(engine.closePane(start, "today", engine.PANES)).toBe(start);
  });

  test("touches no browser, no storage, no clock and no randomness", () => {
    const forbidden = [
      "window.",
      "document.",
      "globalThis",
      "localStorage",
      "sessionStorage",
      "new Date",
      "Date.now",
      "performance.",
      "Math.random",
      "localeCompare",
      "process.",
      "require(",
      "fetch(",
    ];
    for (const name of SOURCES) {
      const source = read(name);
      for (const token of forbidden) {
        expect(source.includes(token), `${name} contains ${token}`).toBe(false);
      }
    }
  });

  test("imports nothing outside its own folder", () => {
    for (const name of SOURCES) {
      const source = read(name);
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        expect(match[1].startsWith("./"), `${name} imports ${match[1]}`).toBe(true);
      }
    }
  });

  test("has no em dash and no en dash anywhere in it", () => {
    for (const name of SOURCES) {
      const source = read(name);
      expect(source.includes("—"), `${name} has an em dash`).toBe(false);
      expect(source.includes("–"), `${name} has an en dash`).toBe(false);
    }
  });
});
