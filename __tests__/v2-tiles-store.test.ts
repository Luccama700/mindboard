// Task 3, what is saved and the parser that reads it back. Amended by
// PLAN-DESK.md Task 1: the saved form is now a desk of layouts (four built in,
// up to eight of the user's), each with one arrangement per screen class, the
// phone included, and three amendments to what is stored:
//
//   A. A layout nobody changed is not stored at all, so a default that changes
//      in a later release reaches everyone who never rearranged it.
//   B. The focus is not stored. It comes back as the maximized pane, or the
//      tab the first leaf is showing.
//   C. Every pane in a stored tree is a catalog pane; anything else is dropped.
//
// WHY THE PARSER IS THE MOST DEFENSIVE THING IN THE ENGINE. A layout lives in
// the user's own browser. The value can be absent, truncated, written by an
// older build, or hand edited, and whatever comes back decides what the screen
// looks like. An earlier layout engine was reviewed and discarded over exactly
// this: it could hand back a state with no pane open, and a screen with nothing
// on it has no control on it either, so there was no way out.
//
// So the parser cannot return a broken desk, and this file pins that as
// arithmetic rather than as care. The last block is the one that would catch
// what the others miss: 400 random operations from every built in layout on
// every screen class, layouts added, renamed, hidden, moved and removed along
// the way, every invariant checked for every layout and class after every
// single step, with a save and a load every twenty five.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BUILT_IN_LAYOUTS,
  MAX_LAYOUTS,
  PANES,
  defaultArrangement,
  defaultTree,
} from "@/app/lib/v2/tiles/catalog";
import { layoutTree, minSize } from "@/app/lib/v2/tiles/geometry";
import {
  EMPTY_TILE_SET,
  addLayout,
  arrangementOf,
  cleanTitle,
  isChanged,
  moveLayout,
  parseTileSet,
  removeLayout,
  renameLayout,
  resetLayout,
  serializeTileSet,
  setCurrent,
  setHidden,
  withArrangement,
} from "@/app/lib/v2/tiles/store";
import type { TileSet } from "@/app/lib/v2/tiles/store";
import {
  activateTab,
  closePane,
  cycleTab,
  equalize,
  leafOf,
  leavesOf,
  movePane,
  moveTab,
  normalize,
  openPane,
  openPanes,
  setOption,
  setRatio,
  signature,
  swapLeaves,
  toggleMaximize,
} from "@/app/lib/v2/tiles/tree";
import type {
  Arrangement,
  BuiltInLayoutId,
  Leaf,
  PaneId,
  ScreenClass,
  Split,
  TileNode,
  Workspace,
  Zone,
} from "@/app/lib/v2/tiles/types";

const CLASSES: ScreenClass[] = ["compact", "regular", "wide"];
const BASES: BuiltInLayoutId[] = ["today", "week", "quests", "money"];
const ZONES: Zone[] = ["left", "right", "top", "bottom", "centre"];
const PANE_IDS: PaneId[] = PANES.map((pane) => pane.id);
const OPTION_PANES = PANES.filter((pane) => pane.options.length > 0);
const ID_SHAPE = /^[ls][0-9]+$/;
const USER_LAYOUT = /^u[1-9][0-9]*$/;

// Built from their code points, not typed in. The walk below covers the six
// engine sources rather than this file, so nothing would have caught a dash
// here: a file whose job is to find a character is the last place that should
// contain one.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = "app/lib/v2/tiles";
const SOURCES = ["types.ts", "tree.ts", "geometry.ts", "catalog.ts", "store.ts", "index.ts"];

function leaf(id: string, ...tabs: PaneId[]): Leaf {
  return { kind: "leaf", id, tabs: [...tabs], active: tabs[0] };
}

/**
 * Used by the sequence test on every step, so a store or tree operation that
 * wrote to a value it was handed throws on the spot (a frozen object under
 * "use strict") rather than leaking into another layout's slot.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return value;
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
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

function splitsOf(node: TileNode | null, out: Split[] = []): Split[] {
  if (node === null || node.kind === "leaf") return out;
  out.push(node);
  splitsOf(node.first, out);
  splitsOf(node.second, out);
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

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * The set as `parseTileSet` hands it back: the same in every way, with each
 * slot's focus set as amendment B sets it, because the focus is not stored.
 */
function asParsed(set: TileSet): TileSet {
  const slots: TileSet["slots"] = {};
  for (const [layout, classes] of Object.entries(set.slots)) {
    const out: Partial<Record<ScreenClass, Arrangement>> = {};
    for (const [cls, arrangement] of Object.entries(classes) as Array<[ScreenClass, Arrangement]>) {
      out[cls] = {
        ...arrangement,
        focus: arrangement.maximized ?? leavesOf(arrangement.tree)[0]?.active ?? null,
      };
    }
    slots[layout] = out;
  }
  return { ...set, slots };
}

/** A stored value of the current version, with the parts a test cares about replaced. */
function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    layouts: BUILT_IN_LAYOUTS.map((meta) => ({ ...meta })),
    hidden: [],
    current: "today",
    slots: {},
    ...over,
  };
}

function slot(tree: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { tree, maximized: null, lastSpot: {}, options: {}, ...over };
}

/** One stored slot, read back through the parser. */
function readSlot(
  value: unknown,
  layout: string = "today",
  cls: ScreenClass = "regular",
): Arrangement {
  return arrangementOf(parseTileSet(stored({ slots: { [layout]: { [cls]: value } } })), layout, cls);
}

function ids(set: TileSet): string[] {
  return set.layouts.map((meta) => meta.id);
}

// ---------------------------------------------------------------- the empty desk

describe("the empty desk", () => {
  test("holds the four built in layouts, hides nothing, opens on Today and stores nothing", () => {
    expect(EMPTY_TILE_SET).toEqual({
      version: 1,
      layouts: [
        { id: "today", title: "Today", base: "today" },
        { id: "week", title: "Week", base: "week" },
        { id: "quests", title: "Quests", base: "quests" },
        { id: "money", title: "Money", base: "money" },
      ],
      hidden: [],
      current: "today",
      slots: {},
    });
  });

  test("cannot be written to", () => {
    expect(isDeepFrozen(EMPTY_TILE_SET)).toBe(true);
  });
});

// --------------------------------------------- amendment A: defaults are not stored

describe("a layout nobody changed is not stored", () => {
  test("arrangementOf answers the catalog's own default object when nothing is stored", () => {
    for (const base of BASES) {
      for (const cls of CLASSES) {
        expect(arrangementOf(EMPTY_TILE_SET, base, cls), `${base} ${cls}`).toBe(
          defaultArrangement(cls, base),
        );
      }
    }
  });

  test("a layout the set does not have reads as the first layout's default", () => {
    expect(arrangementOf(EMPTY_TILE_SET, "u3", "wide")).toBe(defaultArrangement("wide", "today"));
    expect(arrangementOf(EMPTY_TILE_SET, "__proto__", "regular")).toBe(
      defaultArrangement("regular", "today"),
    );
  });

  test("withArrangement stores a change by reference and leaves every other slot alone", () => {
    const changed = closePane(arrangementOf(EMPTY_TILE_SET, "money", "wide"), "hours");
    const set = withArrangement(EMPTY_TILE_SET, "money", "wide", changed);
    expect(arrangementOf(set, "money", "wide")).toBe(changed);
    expect(isChanged(set, "money", "wide")).toBe(true);
    expect(isChanged(set, "money", "regular")).toBe(false);
    expect(arrangementOf(set, "money", "regular")).toBe(defaultArrangement("regular", "money"));

    const more = withArrangement(
      set,
      "today",
      "regular",
      closePane(arrangementOf(set, "today", "regular"), "status"),
    );
    expect(more.slots.money).toBe(set.slots.money);
    expect(more.layouts).toBe(set.layouts);
    expect(more.hidden).toBe(set.hidden);
    expect(more.current).toBe(set.current);
  });

  test("an arrangement equal to its default is not stored, and a stored one that returns to it is removed", () => {
    const wide = arrangementOf(EMPTY_TILE_SET, "today", "wide");
    const moved = setRatio(wide, "s1", 0.4, 1472);
    const set = withArrangement(EMPTY_TILE_SET, "today", "wide", moved);
    expect(isChanged(set, "today", "wide")).toBe(true);

    const back = withArrangement(set, "today", "wide", setRatio(moved, "s1", 0.5, 1472));
    expect(isChanged(back, "today", "wide")).toBe(false);
    expect(back.slots).toEqual({});
    expect(arrangementOf(back, "today", "wide")).toBe(defaultArrangement("wide", "today"));
  });

  test("the same shape is the default whatever is focused or in front", () => {
    const regular = arrangementOf(EMPTY_TILE_SET, "today", "regular");
    const tabbed = activateTab(regular, "past-due");
    expect(tabbed.tree).not.toBe(regular.tree);
    expect(withArrangement(EMPTY_TILE_SET, "today", "regular", tabbed)).toBe(EMPTY_TILE_SET);
    const focused = activateTab(regular, "calendar");
    expect(focused.focus).toBe("calendar");
    expect(withArrangement(EMPTY_TILE_SET, "today", "regular", focused)).toBe(EMPTY_TILE_SET);
  });

  test("a maximize, an option or a remembered spot is a change even on the default shape", () => {
    const start = arrangementOf(EMPTY_TILE_SET, "week", "wide");
    const maxed = toggleMaximize(start, "calendar");
    expect(isChanged(withArrangement(EMPTY_TILE_SET, "week", "wide", maxed), "week", "wide")).toBe(
      true,
    );

    const opted = setOption(start, "calendar", "days", "7");
    expect(isChanged(withArrangement(EMPTY_TILE_SET, "week", "wide", opted), "week", "wide")).toBe(
      true,
    );
    const unset = setOption(opted, "calendar", "days", "auto");
    expect(withArrangement(EMPTY_TILE_SET, "week", "wide", unset)).toBe(EMPTY_TILE_SET);

    const reopened = openPane(closePane(start, "status"), "status", null);
    expect(signature(reopened.tree)).toBe(signature(start.tree));
    expect(Object.keys(reopened.lastSpot)).toEqual(["status"]);
    expect(
      isChanged(withArrangement(EMPTY_TILE_SET, "week", "wide", reopened), "week", "wide"),
    ).toBe(true);
  });

  test("withArrangement returns the same set when nothing changes, and refuses a layout it does not have", () => {
    const changed = closePane(arrangementOf(EMPTY_TILE_SET, "quests", "regular"), "done");
    const set = withArrangement(EMPTY_TILE_SET, "quests", "regular", changed);
    expect(withArrangement(set, "quests", "regular", changed)).toBe(set);
    expect(withArrangement(EMPTY_TILE_SET, "u1", "regular", changed)).toBe(EMPTY_TILE_SET);
    expect(withArrangement(EMPTY_TILE_SET, "__proto__", "regular", changed)).toBe(EMPTY_TILE_SET);
    expect(withArrangement(set, "constructor", "regular", changed)).toBe(set);
    expect(({} as Record<string, unknown>).regular).toBeUndefined();
  });

  test("an arrangement with nothing open is stored as the layout's own default tree", () => {
    const empty: Arrangement = { tree: null, maximized: null, focus: null, lastSpot: {}, options: {} };
    expect(withArrangement(EMPTY_TILE_SET, "money", "regular", empty)).toBe(EMPTY_TILE_SET);
    const set = withArrangement(EMPTY_TILE_SET, "money", "regular", {
      ...empty,
      options: { ledger: { rows: "50" } },
    });
    const kept = arrangementOf(set, "money", "regular");
    expect(kept.tree).toBe(defaultTree("regular", "money"));
    expect(kept.options).toEqual({ ledger: { rows: "50" } });
    expect(kept.focus).toBe("forecast");
  });

  test("isChanged is whether a slot is stored, and nothing else", () => {
    expect(isChanged(EMPTY_TILE_SET, "today", "wide")).toBe(false);
    expect(isChanged(EMPTY_TILE_SET, "u1", "wide")).toBe(false);
    expect(isChanged(EMPTY_TILE_SET, "constructor", "wide")).toBe(false);
  });

  test("a default changed in a later release reaches a desk that never rearranged that layout", () => {
    const set = withArrangement(
      EMPTY_TILE_SET,
      "money",
      "wide",
      closePane(arrangementOf(EMPTY_TILE_SET, "money", "wide"), "ledger"),
    );
    const text = serializeTileSet(set);
    // Nothing about the Today layout is in the text, so whatever the catalog
    // says Today is when the text is read back is what Today will be.
    expect(JSON.parse(text).slots).toEqual({ money: expect.any(Object) });
    const back = parseTileSet(text);
    for (const cls of CLASSES) {
      expect(arrangementOf(back, "today", cls)).toBe(defaultArrangement(cls, "today"));
    }
  });

  test("resetLayout forgets one class, or every class, and only what is stored", () => {
    const regular = closePane(arrangementOf(EMPTY_TILE_SET, "quests", "regular"), "lanes");
    const wide = closePane(arrangementOf(EMPTY_TILE_SET, "quests", "wide"), "lanes");
    const money = closePane(arrangementOf(EMPTY_TILE_SET, "money", "wide"), "ledger");
    let set = withArrangement(EMPTY_TILE_SET, "quests", "regular", regular);
    set = withArrangement(set, "quests", "wide", wide);
    set = withArrangement(set, "money", "wide", money);

    const one = resetLayout(set, "quests", "wide");
    expect(isChanged(one, "quests", "wide")).toBe(false);
    expect(arrangementOf(one, "quests", "regular")).toBe(regular);
    expect(one.slots.money).toBe(set.slots.money);

    const every = resetLayout(set, "quests", null);
    expect(Object.keys(every.slots)).toEqual(["money"]);
    expect(every.slots.money).toBe(set.slots.money);

    expect(resetLayout(every, "quests", null)).toBe(every);
    expect(resetLayout(set, "quests", "compact")).toBe(set);
    expect(resetLayout(set, "u5", null)).toBe(set);
    expect(resetLayout(set, "__proto__", null)).toBe(set);
  });
});

// ------------------------------------------------------------------ the phone

describe("the phone is one leaf", () => {
  test("withArrangement on the compact class stores the arrangement flattened", () => {
    const phone = arrangementOf(EMPTY_TILE_SET, "today", "compact");
    const split = movePane(phone, "today", (phone.tree as Leaf).id, "right");
    expect(leavesOf(split.tree)).toHaveLength(2);
    const set = withArrangement(EMPTY_TILE_SET, "today", "compact", split);
    const kept = arrangementOf(set, "today", "compact");
    expect(kept.tree).toEqual({
      kind: "leaf",
      id: "l1",
      tabs: ["status", "past-due", "not-today", "calendar", "today"],
      active: "today",
    });
    expect(kept.focus).toBe("today");
  });

  test("nothing is ever maximized on the phone", () => {
    const phone = moveTab(arrangementOf(EMPTY_TILE_SET, "money", "compact"), "ledger", 0);
    const maxed = toggleMaximize(phone, "ledger");
    expect(maxed.maximized).toBe("ledger");
    const set = withArrangement(EMPTY_TILE_SET, "money", "compact", maxed);
    expect(arrangementOf(set, "money", "compact").maximized).toBeNull();
    expect(arrangementOf(set, "money", "compact").tree).toBe(maxed.tree);
    expect(arrangementOf(set, "money", "compact").focus).toBe("ledger");
  });

  test("a phone arrangement that only differs from its default by what is in front is not stored", () => {
    const phone = arrangementOf(EMPTY_TILE_SET, "quests", "compact");
    expect(withArrangement(EMPTY_TILE_SET, "quests", "compact", activateTab(phone, "done"))).toBe(
      EMPTY_TILE_SET,
    );
  });
});

// ------------------------------------------------------------------ the layouts

describe("the user's own layouts", () => {
  test("addLayout makes u1 from a layout, with a cleaned title and that layout's base, and makes it current", () => {
    const one = addLayout(EMPTY_TILE_SET, "  Deep   work ", "week", "regular");
    expect(ids(one)).toEqual(["today", "week", "quests", "money", "u1"]);
    expect(one.layouts[4]).toEqual({ id: "u1", title: "Deep work", base: "week" });
    expect(one.current).toBe("u1");
    // The arrangement copied was Week's default, which is the new layout's
    // default too, so nothing is stored.
    expect(one.slots).toEqual({});
    for (const cls of CLASSES) {
      expect(arrangementOf(one, "u1", cls)).toBe(defaultArrangement(cls, "week"));
    }
    expect(one.layouts.slice(0, 4)).toEqual(EMPTY_TILE_SET.layouts);
  });

  test("addLayout copies the arrangement for the class it was asked for, and only that one", () => {
    const changedRegular = closePane(arrangementOf(EMPTY_TILE_SET, "money", "regular"), "hours");
    const changedWide = closePane(arrangementOf(EMPTY_TILE_SET, "money", "wide"), "ledger");
    let set = withArrangement(EMPTY_TILE_SET, "money", "regular", changedRegular);
    set = withArrangement(set, "money", "wide", changedWide);
    set = addLayout(set, "Bills", "money", "regular");
    expect(arrangementOf(set, "u1", "regular")).toBe(changedRegular);
    expect(arrangementOf(set, "u1", "wide")).toBe(defaultArrangement("wide", "money"));
    expect(isChanged(set, "u1", "wide")).toBe(false);
    expect(isChanged(set, "money", "wide")).toBe(true);
  });

  test("a layout made from one of the user's takes its base, and n is one more than the largest in use", () => {
    let set = addLayout(EMPTY_TILE_SET, "First", "quests", "wide");
    set = addLayout(set, "Second", "u1", "wide");
    expect(set.layouts[5]).toEqual({ id: "u2", title: "Second", base: "quests" });
    set = removeLayout(set, "u1");
    set = addLayout(set, "Third", "today", "wide");
    expect(ids(set)).toEqual(["today", "week", "quests", "money", "u2", "u3"]);
    set = removeLayout(set, "u3");
    set = addLayout(set, "Fourth", "today", "wide");
    expect(ids(set)).toEqual(["today", "week", "quests", "money", "u2", "u3"]);
    expect(set.layouts[5].title).toBe("Fourth");
  });

  test("addLayout is refused at the most layouts a desk holds, and from a layout it does not have", () => {
    let set: TileSet = EMPTY_TILE_SET;
    for (let made = 0; made < MAX_LAYOUTS - BUILT_IN_LAYOUTS.length; made += 1) {
      set = addLayout(set, `Layout ${made + 1}`, "today", "regular");
    }
    expect(set.layouts).toHaveLength(MAX_LAYOUTS);
    expect(addLayout(set, "One more", "today", "regular")).toBe(set);
    expect(addLayout(EMPTY_TILE_SET, "Mine", "nothing", "regular")).toBe(EMPTY_TILE_SET);
    expect(addLayout(EMPTY_TILE_SET, "Mine", "__proto__", "regular")).toBe(EMPTY_TILE_SET);
  });

  test("addLayout stores only a cleaned title", () => {
    expect(addLayout(EMPTY_TILE_SET, "\u0000 \t", "today", "wide").layouts[4].title).toBe("Layout");
  });

  test("renameLayout renames one of the user's layouts, cleaned, and nothing else", () => {
    const set = addLayout(EMPTY_TILE_SET, "Focus", "today", "regular");
    const renamed = renameLayout(set, "u1", "  Late\tnight  ");
    expect(renamed.layouts[4]).toEqual({ id: "u1", title: "Late night", base: "today" });
    expect(renamed.slots).toBe(set.slots);
    expect(renameLayout(renamed, "u1", "Late night")).toBe(renamed);
    expect(renameLayout(set, "today", "Mine")).toBe(set);
    expect(renameLayout(set, "u9", "Mine")).toBe(set);
    expect(renameLayout(set, "__proto__", "Mine")).toBe(set);
  });

  test("removeLayout takes the layout, its slots and its place among the hidden", () => {
    let set = addLayout(EMPTY_TILE_SET, "One", "money", "wide");
    set = withArrangement(set, "u1", "wide", closePane(arrangementOf(set, "u1", "wide"), "hours"));
    set = addLayout(set, "Two", "today", "wide");
    set = setHidden(set, "u1", true);
    expect(set.hidden).toEqual(["u1"]);
    const out = removeLayout(set, "u1");
    expect(ids(out)).toEqual(["today", "week", "quests", "money", "u2"]);
    expect(out.hidden).toEqual([]);
    expect(own(out.slots, "u1")).toBe(false);
    expect(out.current).toBe("u2");
  });

  test("removing the current layout moves current to the visible layout before it", () => {
    let set = addLayout(EMPTY_TILE_SET, "One", "today", "regular");
    set = addLayout(set, "Two", "today", "regular");
    expect(set.current).toBe("u2");
    expect(removeLayout(set, "u2").current).toBe("u1");
    const hidden = setHidden(set, "u1", true);
    expect(removeLayout(hidden, "u2").current).toBe("money");
  });

  test("removing the first layout on the rail moves current to the next visible one", () => {
    const set = moveLayout(addLayout(EMPTY_TILE_SET, "One", "today", "regular"), "u1", 0);
    expect(ids(set)[0]).toBe("u1");
    expect(removeLayout(set, "u1").current).toBe("today");
    expect(removeLayout(setHidden(set, "today", true), "u1").current).toBe("week");
  });

  test("only the user's layouts can be removed, and never the last one visible", () => {
    expect(removeLayout(EMPTY_TILE_SET, "today")).toBe(EMPTY_TILE_SET);
    expect(removeLayout(EMPTY_TILE_SET, "u1")).toBe(EMPTY_TILE_SET);
    expect(removeLayout(EMPTY_TILE_SET, "__proto__")).toBe(EMPTY_TILE_SET);
    let set = addLayout(EMPTY_TILE_SET, "Mine", "today", "regular");
    for (const base of BASES) set = setHidden(set, base, true);
    expect(set.hidden).toEqual(["today", "week", "quests", "money"]);
    expect(removeLayout(set, "u1")).toBe(set);
  });

  test("moveLayout moves a layout along the rail and clamps the place", () => {
    expect(ids(moveLayout(EMPTY_TILE_SET, "money", 0))).toEqual(["money", "today", "week", "quests"]);
    expect(ids(moveLayout(EMPTY_TILE_SET, "today", 99))).toEqual(["week", "quests", "money", "today"]);
    expect(ids(moveLayout(EMPTY_TILE_SET, "quests", -3))).toEqual(["quests", "today", "week", "money"]);
    expect(ids(moveLayout(EMPTY_TILE_SET, "today", 1.9))).toEqual(["week", "today", "quests", "money"]);
  });

  test("moveLayout returns the same set when nothing moves", () => {
    expect(moveLayout(EMPTY_TILE_SET, "today", 0)).toBe(EMPTY_TILE_SET);
    expect(moveLayout(EMPTY_TILE_SET, "today", -1)).toBe(EMPTY_TILE_SET);
    expect(moveLayout(EMPTY_TILE_SET, "money", 3)).toBe(EMPTY_TILE_SET);
    expect(moveLayout(EMPTY_TILE_SET, "nothing", 2)).toBe(EMPTY_TILE_SET);
    expect(moveLayout(EMPTY_TILE_SET, "week", Number.NaN)).toBe(EMPTY_TILE_SET);
  });

  test("setHidden hides and shows, and returns the same set when nothing changes", () => {
    const out = setHidden(EMPTY_TILE_SET, "week", true);
    expect(out.hidden).toEqual(["week"]);
    expect(out.current).toBe("today");
    expect(setHidden(out, "week", true)).toBe(out);
    expect(setHidden(out, "week", false).hidden).toEqual([]);
    expect(setHidden(EMPTY_TILE_SET, "week", false)).toBe(EMPTY_TILE_SET);
    expect(setHidden(EMPTY_TILE_SET, "nothing", true)).toBe(EMPTY_TILE_SET);
    expect(setHidden(EMPTY_TILE_SET, "__proto__", true)).toBe(EMPTY_TILE_SET);
  });

  test("setHidden never hides the last layout that is visible", () => {
    let set: TileSet = EMPTY_TILE_SET;
    for (const base of ["week", "quests", "money"]) set = setHidden(set, base, true);
    expect(setHidden(set, "today", true)).toBe(set);
  });

  test("hiding the current layout moves current to the next visible one", () => {
    expect(setHidden(setCurrent(EMPTY_TILE_SET, "week"), "week", true).current).toBe("quests");
    const skip = setHidden(setCurrent(EMPTY_TILE_SET, "week"), "quests", true);
    expect(setHidden(skip, "week", true).current).toBe("money");
    // With nothing visible after it, the nearest visible one before it.
    expect(setHidden(setCurrent(EMPTY_TILE_SET, "money"), "money", true).current).toBe("quests");
  });

  test("setCurrent opens a visible layout, and refuses anything else", () => {
    expect(setCurrent(EMPTY_TILE_SET, "week").current).toBe("week");
    expect(setCurrent(EMPTY_TILE_SET, "today")).toBe(EMPTY_TILE_SET);
    expect(setCurrent(EMPTY_TILE_SET, "nothing")).toBe(EMPTY_TILE_SET);
    expect(setCurrent(EMPTY_TILE_SET, "__proto__")).toBe(EMPTY_TILE_SET);
    const hidden = setHidden(EMPTY_TILE_SET, "money", true);
    expect(setCurrent(hidden, "money")).toBe(hidden);
  });
});

// ------------------------------------------------------------------ cleanTitle

describe("cleanTitle", () => {
  const smile = String.fromCodePoint(0x1f600);

  test("trims, and collapses any run of whitespace to one space", () => {
    expect(cleanTitle("  Deep work  ")).toBe("Deep work");
    expect(cleanTitle("Deep \n\t  work")).toBe("Deep work");
    expect(cleanTitle("Deep  work")).toBe("Deep work");
  });

  test("drops control characters, and a half of a surrogate pair standing alone", () => {
    expect(cleanTitle("Deep\u0000work\u007f\u009b")).toBe("Deepwork");
    expect(cleanTitle("a \u0000 b")).toBe("a b");
    expect(cleanTitle("a\ud800b\udc00c")).toBe("abc");
  });

  test("keeps at most 24 code points, never half a pair, and nothing trailing", () => {
    expect(cleanTitle("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrstuvwx");
    expect(cleanTitle(`${"a".repeat(23)}${smile}b`)).toBe(`${"a".repeat(23)}${smile}`);
    expect(cleanTitle(smile.repeat(30))).toBe(smile.repeat(24));
    expect(cleanTitle(`${"a".repeat(23)} bcd`)).toBe("a".repeat(23));
  });

  test("gives Layout for what is left empty", () => {
    expect(cleanTitle("")).toBe("Layout");
    expect(cleanTitle("   ")).toBe("Layout");
    expect(cleanTitle("\u0000\u0001\t")).toBe("Layout");
    expect(cleanTitle(42 as unknown as string)).toBe("Layout");
  });

  test("leaves a clean title exactly as it is", () => {
    for (const title of ["Today", "Deep work", `Plan ${smile}`]) {
      expect(cleanTitle(title)).toBe(title);
    }
  });
});

// -------------------------------------------------------------- the parser

describe("parseTileSet cannot return a broken desk", () => {
  test("anything that is not a desk of its own version comes back empty", () => {
    for (const value of [
      null,
      undefined,
      0,
      "",
      "not json",
      "[]",
      [],
      true,
      stored({ version: 2 }),
      stored({ version: "1" }),
      stored({ version: undefined }),
      { version: 1 },
      stored({ layouts: "no" }),
      stored({ hidden: "no" }),
      stored({ hidden: undefined }),
      stored({ slots: [] }),
      stored({ slots: "no" }),
      { version: 1, classes: {} },
    ]) {
      expect(parseTileSet(value), JSON.stringify(value) ?? "undefined").toEqual(EMPTY_TILE_SET);
    }
  });

  test("reads a string as well as an object", () => {
    const set = setHidden(addLayout(EMPTY_TILE_SET, "Mine", "week", "wide"), "money", true);
    expect(parseTileSet(serializeTileSet(set))).toEqual(set);
    expect(parseTileSet(JSON.parse(serializeTileSet(set)))).toEqual(set);
  });

  test("the four built in layouts are always there, with the catalog's titles and bases", () => {
    const set = parseTileSet(
      stored({
        layouts: [
          { id: "money", title: "Cash", base: "today" },
          { id: "u1", title: "Mine", base: "week" },
        ],
      }),
    );
    expect(ids(set)).toEqual(["money", "u1", "today", "week", "quests"]);
    expect(set.layouts[0]).toEqual({ id: "money", title: "Money", base: "money" });
    expect(set.layouts[1]).toEqual({ id: "u1", title: "Mine", base: "week" });
  });

  test("the user's layouts keep their order; a bad or repeated id goes; titles are cleaned; a base must be built in", () => {
    const set = parseTileSet(
      stored({
        layouts: [
          { id: "today", title: "Today", base: "today" },
          { id: "u3", title: "  Third  ", base: "quests" },
          { id: "u1", title: "First", base: "nowhere" },
          { id: "u3", title: "Again", base: "today" },
          { id: "today", title: "Again", base: "today" },
          { id: "u0", title: "Zero", base: "today" },
          { id: "u01", title: "Padded", base: "today" },
          { id: "U2", title: "Capital", base: "today" },
          { id: "x1", title: "Other", base: "today" },
          { id: 7, title: "Number", base: "today" },
          { id: "u1000000001", title: "Too large", base: "today" },
          "u4",
          null,
          { id: "u5", title: 5, base: "money" },
          { id: "u6", title: "Six", base: "__proto__" },
          { id: "week", title: "Week", base: "week" },
        ],
      }),
    );
    expect(ids(set)).toEqual(["today", "u3", "u1", "u5", "u6", "week", "quests", "money"]);
    expect(set.layouts[1]).toEqual({ id: "u3", title: "Third", base: "quests" });
    expect(set.layouts[2]).toEqual({ id: "u1", title: "First", base: "today" });
    expect(set.layouts[3]).toEqual({ id: "u5", title: "Layout", base: "money" });
    expect(set.layouts[4]).toEqual({ id: "u6", title: "Six", base: "today" });
  });

  test("anything past twelve layouts is dropped, and the built in four always stay", () => {
    const users = Array.from({ length: 10 }, (_, index) => ({
      id: `u${index + 1}`,
      title: `Layout ${index + 1}`,
      base: "today",
    }));
    const set = parseTileSet(stored({ layouts: users }));
    expect(set.layouts).toHaveLength(MAX_LAYOUTS);
    expect(ids(set)).toEqual([
      "u1",
      "u2",
      "u3",
      "u4",
      "u5",
      "u6",
      "u7",
      "u8",
      "today",
      "week",
      "quests",
      "money",
    ]);
  });

  test("hidden keeps only the layouts there are, once each, and never all of them", () => {
    const some = parseTileSet(
      stored({ hidden: ["week", "nothing", "week", 7, "__proto__", "u9", "money"] }),
    );
    expect(some.hidden).toEqual(["week", "money"]);
    const all = parseTileSet(stored({ hidden: ["money", "today", "week", "quests"] }));
    expect(all.hidden).toEqual(["money", "week", "quests"]);
    expect(all.current).toBe("today");
  });

  test("current falls back to the first visible layout", () => {
    for (const current of [undefined, null, 7, "mine", "__proto__", "u1", "week"]) {
      const set = parseTileSet(stored({ current, hidden: ["today", "week"] }));
      expect(set.current, String(current)).toBe("quests");
    }
    expect(parseTileSet(stored({ current: "money" })).current).toBe("money");
  });

  test("drops a pane the catalog does not know and normalizes what is left", () => {
    const out = readSlot(
      slot({
        kind: "split",
        id: "s1",
        dir: "h",
        ratio: 0.5,
        first: { kind: "leaf", id: "l2", tabs: ["today", "ghost"], active: "ghost" },
        second: { kind: "leaf", id: "l3", tabs: ["gone"], active: "gone" },
      }),
    );
    expect(openPanes(out.tree)).toEqual(["today"]);
    expect(out.focus).toBe("today");
    expect(out.tree).toEqual(leaf("l2", "today"));
  });

  test("a pane listed twice keeps its first place", () => {
    const out = readSlot(
      slot({
        kind: "split",
        id: "s1",
        dir: "h",
        ratio: 0.5,
        first: { kind: "leaf", id: "l2", tabs: ["today", "status", "today"], active: "today" },
        second: { kind: "leaf", id: "l3", tabs: ["status", "calendar"], active: "status" },
      }),
    );
    expect(openPanes(out.tree)).toEqual(["today", "status", "calendar"]);
  });

  test("puts no pane back: every pane can be closed", () => {
    const out = readSlot(
      slot(
        { kind: "leaf", id: "l1", tabs: ["calendar", "status"], active: "calendar" },
        { lastSpot: { today: { beside: "status", zone: "centre", ratio: null } } },
      ),
    );
    expect(openPanes(out.tree)).toEqual(["calendar", "status"]);
    expect(out.lastSpot.today).toEqual({ beside: "status", zone: "centre", ratio: null });
  });

  test("a tree with nothing open is the layout's default, and a default is not stored", () => {
    for (const tree of [
      null,
      "nope",
      { kind: "leaf", id: "l1", tabs: [], active: "today" },
      { kind: "leaf", id: "l1", tabs: ["ghost"], active: "ghost" },
      { kind: "split", id: "s1", dir: "h", ratio: 0.5 },
    ]) {
      const set = parseTileSet(stored({ slots: { week: { wide: slot(tree) } } }));
      expect(isChanged(set, "week", "wide")).toBe(false);
      expect(arrangementOf(set, "week", "wide")).toBe(defaultArrangement("wide", "week"));
    }
    const kept = readSlot(slot(null, { options: { calendar: { days: "7" } } }), "week", "wide");
    expect(kept.tree).toBe(defaultTree("wide", "week"));
    expect(kept.options).toEqual({ calendar: { days: "7" } });
  });

  test("a user's layout with nothing open falls back to its base's default", () => {
    const set = parseTileSet(
      stored({
        layouts: [...BUILT_IN_LAYOUTS, { id: "u2", title: "Mine", base: "money" }],
        slots: { u2: { regular: slot(null) } },
      }),
    );
    expect(arrangementOf(set, "u2", "regular")).toBe(defaultArrangement("regular", "money"));
    expect(arrangementOf(set, "u2", "compact")).toBe(defaultArrangement("compact", "money"));
  });

  test("a tree deeper than the deepest the engine can build is replaced, and that deepest is kept", () => {
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
    // Fourteen panes in a chain are fourteen levels deep, the deepest tree
    // there is; one more level can only be a hand made value.
    const read = (levels: number) => signature(readSlot(slot(chain(levels))).tree);
    expect(read(PANES.length - 1)).toBe("h50([today]|[calendar])");
    expect(read(PANES.length)).toBe(signature(defaultTree("regular", "today")));
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
    const set = parseTileSet(stored({ slots: { quests: { regular: slot(cyclic) } } }));
    expect(arrangementOf(set, "quests", "regular")).toBe(defaultArrangement("regular", "quests"));
  });

  test("the focus is not read: it is the maximized pane, or the tab the first leaf is showing", () => {
    const tree = {
      kind: "split",
      id: "s1",
      dir: "h",
      ratio: 0.5,
      first: { kind: "leaf", id: "l2", tabs: ["today", "status"], active: "status" },
      second: { kind: "leaf", id: "l3", tabs: ["calendar"], active: "calendar" },
    };
    const unfocused = readSlot(slot(tree, { focus: "calendar" }));
    expect(unfocused.focus).toBe("status");
    // The tree is not rewritten to suit a stored focus: which tab is in front
    // is part of what the user arranged.
    expect(((unfocused.tree as Split).first as Leaf).active).toBe("status");

    const maxed = readSlot(slot(tree, { maximized: "calendar" }));
    expect(maxed.maximized).toBe("calendar");
    expect(maxed.focus).toBe("calendar");
  });

  test("a stored maximized pane that is not open, or behind another tab, is dropped", () => {
    const tree = {
      kind: "split",
      id: "s1",
      dir: "h",
      ratio: 0.5,
      first: { kind: "leaf", id: "l2", tabs: ["today", "status"], active: "status" },
      second: { kind: "leaf", id: "l3", tabs: ["calendar"], active: "calendar" },
    };
    for (const maximized of ["today", "ghost", 7, "__proto__"]) {
      const out = readSlot(slot(tree, { maximized }));
      expect(out.maximized, String(maximized)).toBeNull();
      expect(out.focus, String(maximized)).toBe("status");
    }
  });

  test("a slot that is its default once repaired is dropped", () => {
    const raw = JSON.parse(JSON.stringify(defaultTree("regular", "today"))) as {
      first: { active: string };
    };
    raw.first.active = "status";
    const set = parseTileSet(stored({ slots: { today: { regular: slot(raw, { focus: "calendar" }) } } }));
    expect(set.slots).toEqual({});
    expect(arrangementOf(set, "today", "regular")).toBe(defaultArrangement("regular", "today"));
    const maxed = parseTileSet(
      stored({ slots: { today: { regular: slot(raw, { maximized: "calendar" }) } } }),
    );
    expect(isChanged(maxed, "today", "regular")).toBe(true);
  });

  test("a phone slot is flattened, and nothing on it is maximized", () => {
    const tree = {
      kind: "split",
      id: "s1",
      dir: "h",
      ratio: 0.5,
      first: { kind: "leaf", id: "l2", tabs: ["lanes", "steps"], active: "steps" },
      second: { kind: "leaf", id: "l3", tabs: ["done", "side-quests"], active: "done" },
    };
    const maxed = readSlot(slot(tree, { maximized: "done" }), "quests", "compact");
    expect(maxed.tree).toEqual({
      kind: "leaf",
      id: "l2",
      tabs: ["lanes", "steps", "done", "side-quests"],
      active: "done",
    });
    expect(maxed.maximized).toBeNull();
    expect(maxed.focus).toBe("done");
    const plain = readSlot(slot(tree), "quests", "compact");
    expect((plain.tree as Leaf).active).toBe("steps");
  });

  test("options keep only the keys and the values the catalog declares, and never a fallback", () => {
    const out = readSlot(
      slot(
        { kind: "leaf", id: "l1", tabs: ["calendar", "today"], active: "calendar" },
        {
          options: {
            calendar: { days: "3", rows: "10" },
            ledger: { rows: "25" },
            today: { anything: "x" },
            ghost: { days: "3" },
            steps: { group: "lane" },
            forecast: "60",
            done: { span: 28 },
            "side-quests": { sort: "added" },
          },
        },
      ),
    );
    expect(out.options).toEqual({ calendar: { days: "3" }, "side-quests": { sort: "added" } });
  });

  test("never clamps a ratio to a workspace, because it has none", () => {
    const out = readSlot(
      slot({
        kind: "split",
        id: "s1",
        dir: "h",
        ratio: 0.9,
        first: { kind: "leaf", id: "l2", tabs: ["today"], active: "today" },
        second: { kind: "leaf", id: "l3", tabs: ["calendar"], active: "calendar" },
      }),
      "today",
      "wide",
    );
    expect((out.tree as Split).ratio).toBe(0.9);
  });

  test("repairs a ratio that is out of range or not a number, and holds it to four decimals", () => {
    const read = (ratio: unknown): number =>
      (
        readSlot(
          slot({
            kind: "split",
            id: "s1",
            dir: "h",
            ratio,
            first: { kind: "leaf", id: "l2", tabs: ["today"], active: "today" },
            second: { kind: "leaf", id: "l3", tabs: ["calendar"], active: "calendar" },
          }),
          "today",
          "wide",
        ).tree as Split
      ).ratio;
    expect(read(4)).toBe(0.95);
    expect(read(-1)).toBe(0.05);
    expect(read("half")).toBe(0.5);
    expect(read(null)).toBe(0.5);
    expect(read(0.123456)).toBe(0.1235);
    expect(read(0.30000000000000004)).toBe(0.3);
  });

  test("gives a tree with repeated or malformed ids ids of its own", () => {
    const tree = readSlot(
      slot({
        kind: "split",
        id: "l1",
        dir: "v",
        ratio: 0.4,
        first: { kind: "leaf", id: "l1", tabs: ["today"], active: "today" },
        second: { kind: "leaf", tabs: ["calendar"], active: "calendar" },
      }),
    ).tree;
    const all = allIds(tree);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(ID_SHAPE.test(id)).toBe(true);
    expect((tree as Split).id).toBe("s1");
    expect((tree as Split).ratio).toBe(0.4);
  });

  test("an id too large to count past is renumbered on load", () => {
    const huge = "l9007199254740991";
    const loaded = readSlot(
      slot({
        kind: "split",
        id: "s1",
        dir: "h",
        ratio: 0.5,
        first: { kind: "leaf", id: huge, tabs: ["today"], active: "today" },
        second: { kind: "leaf", id: "l2", tabs: ["calendar"], active: "calendar" },
      }),
    );
    expect(allIds(loaded.tree)).not.toContain(huge);

    // The point of the cap: an id the engine cannot count past would make the
    // next two moves mint the same number twice, and two nodes with one id are
    // rewritten together.
    const first = movePane(loaded, "status", leavesOf(loaded.tree)[0].id, "right");
    const second = movePane(first, "past-due", leavesOf(first.tree)[0].id, "bottom");
    const minted = (before: string[], after: string[]) =>
      after.filter((id) => !before.includes(id));
    const one = minted(allIds(loaded.tree), allIds(first.tree));
    const two = minted(allIds(first.tree), allIds(second.tree));
    expect(one.length).toBeGreaterThan(0);
    expect(two.length).toBeGreaterThan(0);
    for (const id of one) expect(two).not.toContain(id);
    const all = allIds(second.tree);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(ID_SHAPE.test(id)).toBe(true);
  });

  test("repairs what it was given about where closed panes were", () => {
    const spots = readSlot(
      slot(
        { kind: "leaf", id: "l1", tabs: ["today", "status"], active: "today" },
        {
          lastSpot: {
            calendar: { beside: "today", zone: "right", ratio: 0.4 },
            "past-due": { beside: "ghost", zone: "left", ratio: 0.4 },
            "not-today": { beside: "today", zone: "sideways", ratio: 0.4 },
            status: { beside: "today", zone: "centre", ratio: 0.4 },
            today: { beside: "status", zone: "left", ratio: 40 },
            ledger: { beside: "today", zone: "top", ratio: 0.123456 },
            ghost: { beside: "today", zone: "left", ratio: 0.4 },
          },
        },
      ),
    ).lastSpot;
    expect(Object.keys(spots).slice().sort()).toEqual(["calendar", "ledger", "status", "today"]);
    expect(spots.calendar).toEqual({ beside: "today", zone: "right", ratio: 0.4 });
    expect(spots.status.ratio).toBeNull();
    expect(spots.today.ratio).toBe(0.95);
    expect(spots.ledger.ratio).toBe(0.1235);
  });

  test("a malformed slot leaves the others alone, and a class or layout there is not is ignored", () => {
    const good = slot({ kind: "leaf", id: "l1", tabs: ["calendar", "today"], active: "calendar" });
    const set = parseTileSet(
      stored({
        slots: {
          today: { regular: "broken", wide: good, tablet: good, phone: good },
          week: 5,
          quests: [],
          u4: { wide: good },
        },
      }),
    );
    expect(Object.keys(set.slots)).toEqual(["today"]);
    expect(Object.keys(set.slots.today)).toEqual(["wide"]);
    expect(openPanes(arrangementOf(set, "today", "wide").tree)).toEqual(["calendar", "today"]);
  });

  test("ignores keys that would reach Object.prototype, anywhere", () => {
    const hostile = JSON.parse(
      '{"version":1,"__proto__":{"polluted":"yes"},' +
        '"layouts":[{"id":"today","title":"Today","base":"today"},' +
        '{"id":"__proto__","title":"x","base":"today"},{"id":"constructor","title":"x","base":"today"},' +
        '{"id":"u1","title":"Mine","base":"__proto__","__proto__":{"polluted":"yes"}}],' +
        '"hidden":["__proto__","constructor","prototype"],"current":"constructor",' +
        '"slots":{"__proto__":{"regular":{"polluted":"yes"}},"constructor":{},"prototype":{},' +
        '"u1":{"__proto__":{"polluted":"yes"},"prototype":{},"wide":{' +
        '"tree":{"kind":"leaf","id":"l1","tabs":["lanes","__proto__","constructor"],"active":"__proto__"},' +
        '"maximized":"__proto__",' +
        '"lastSpot":{"__proto__":{"beside":"lanes","zone":"left","ratio":0.4},' +
        '"prototype":{"beside":"lanes","zone":"left","ratio":0.4}},' +
        '"options":{"__proto__":{"days":"3"},"calendar":{"__proto__":"x","constructor":"y","days":"3"}}}}}}',
    ) as unknown;
    const set = parseTileSet(hostile);
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(ids(set)).toEqual(["today", "u1", "week", "quests", "money"]);
    expect(set.layouts[1]).toEqual({ id: "u1", title: "Mine", base: "today" });
    expect(set.hidden).toEqual([]);
    expect(set.current).toBe("today");
    expect(Object.keys(set.slots)).toEqual(["u1"]);
    expect(Object.keys(set.slots.u1)).toEqual(["wide"]);
    const wide = arrangementOf(set, "u1", "wide");
    expect(wide.tree).toEqual(leaf("l1", "lanes"));
    expect(wide.maximized).toBeNull();
    expect(Object.keys(wide.lastSpot)).toEqual([]);
    expect(wide.options).toEqual({ calendar: { days: "3" } });
    expect(Object.keys(wide.options.calendar)).toEqual(["days"]);
  });
});

// ------------------------------------------------------------ the round trip

describe("saving and loading", () => {
  test("the focus is not in the saved form", () => {
    const set = withArrangement(
      EMPTY_TILE_SET,
      "today",
      "wide",
      activateTab(closePane(arrangementOf(EMPTY_TILE_SET, "today", "wide"), "status"), "calendar"),
    );
    expect(arrangementOf(set, "today", "wide").focus).toBe("calendar");
    expect(serializeTileSet(set)).not.toContain("focus");
    expect(arrangementOf(parseTileSet(serializeTileSet(set)), "today", "wide").focus).toBe("today");
  });

  test("a change of focus alone leaves the text alone, and a change of front tab changes only the active", () => {
    const set = withArrangement(
      EMPTY_TILE_SET,
      "today",
      "regular",
      closePane(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "not-today"),
    );
    const arranged = arrangementOf(set, "today", "regular");
    const text = serializeTileSet(set);

    const focusOnly = withArrangement(set, "today", "regular", activateTab(arranged, "calendar"));
    expect(focusOnly).not.toBe(set);
    expect(serializeTileSet(focusOnly)).toBe(text);

    const front = serializeTileSet(
      withArrangement(set, "today", "regular", activateTab(arranged, "past-due")),
    );
    expect(front).not.toBe(text);
    expect(front.replace('"active":"past-due"', '"active":"today"')).toBe(text);
  });

  test("serializeTileSet writes the same text for equal sets, whatever order they were built in", () => {
    const tree = defaultTree("wide", "today");
    const regular = closePane(defaultArrangement("regular", "today"), "status");
    const phone = moveTab(defaultArrangement("compact", "money"), "ledger", 0);
    const oneWay: Arrangement = {
      tree,
      maximized: null,
      focus: "today",
      lastSpot: {
        calendar: { beside: "today", zone: "right", ratio: 0.3 },
        status: { beside: "today", zone: "centre", ratio: null },
      },
      options: { calendar: { days: "7" }, ledger: { rows: "50" } },
    };
    const otherWay: Arrangement = {
      options: { ledger: { rows: "50" }, calendar: { days: "7" } },
      lastSpot: {
        status: { beside: "today", zone: "centre", ratio: null },
        calendar: { beside: "today", zone: "right", ratio: 0.3 },
      },
      focus: "today",
      maximized: null,
      tree,
    };
    const first: TileSet = {
      version: 1,
      layouts: [...BUILT_IN_LAYOUTS, { id: "u1", title: "Mine", base: "money" }],
      hidden: ["week"],
      current: "u1",
      slots: { today: { wide: oneWay, regular }, money: { compact: phone } },
    };
    const second: TileSet = {
      slots: { money: { compact: phone }, today: { regular, wide: otherWay } },
      current: "u1",
      hidden: ["week"],
      layouts: [...BUILT_IN_LAYOUTS, { base: "money", title: "Mine", id: "u1" }],
      version: 1,
    };
    expect(serializeTileSet(first)).toBe(serializeTileSet(second));
    expect(parseTileSet(serializeTileSet(first))).toEqual(asParsed(first));
  });

  test("a desk the engine made survives a save and a load exactly, the focus as amendment B sets it", () => {
    let set: TileSet = addLayout(EMPTY_TILE_SET, "Deep work", "quests", "wide");
    let wide = arrangementOf(set, "u1", "wide");
    wide = closePane(wide, "past-due");
    wide = setOption(wide, "steps", "group", "group");
    wide = movePane(wide, "ledger", leavesOf(wide.tree)[0].id, "bottom");
    wide = setRatio(wide, "s1", 0.3333333, 1472);
    wide = toggleMaximize(wide, "steps");
    expect(wide.maximized).toBe("steps");
    set = withArrangement(set, "u1", "wide", wide);

    let regular = arrangementOf(set, "u1", "regular");
    regular = moveTab(regular, "done", 0);
    regular = activateTab(regular, "past-due");
    set = withArrangement(set, "u1", "regular", regular);

    let phone = arrangementOf(set, "today", "compact");
    phone = moveTab(phone, "calendar", 0);
    phone = setOption(phone, "calendar", "days", "1");
    set = withArrangement(set, "today", "compact", phone);

    set = setHidden(set, "week", true);
    set = moveLayout(set, "u1", 1);
    set = addLayout(set, "Evening", "u1", "wide");
    set = setCurrent(set, "money");

    expect(Object.keys(set.slots).slice().sort()).toEqual(["today", "u1", "u2"]);
    const back = parseTileSet(serializeTileSet(set));
    expect(back).toEqual(asParsed(set));
    expect(serializeTileSet(back)).toBe(serializeTileSet(set));
  });

  test("the deepest tree the engine can build, every pane in a chain, survives", () => {
    let arranged: Arrangement = {
      tree: leaf("l1", PANE_IDS[0]),
      maximized: null,
      focus: PANE_IDS[0],
      lastSpot: {},
      options: {},
    };
    for (let index = 1; index < PANE_IDS.length; index += 1) {
      const target = leafOf(arranged.tree, PANE_IDS[index - 1]) as Leaf;
      arranged = movePane(arranged, PANE_IDS[index], target.id, "right");
    }
    expect(openPanes(arranged.tree)).toEqual(PANE_IDS);
    expect(depthOf(arranged.tree)).toBe(PANE_IDS.length);
    const set = withArrangement(EMPTY_TILE_SET, "today", "wide", arranged);
    expect(parseTileSet(serializeTileSet(set))).toEqual(asParsed(set));
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

/** The leaves and dividers cover the workspace exactly, no leaf under its minimum. */
function tilingProblems(source: Arrangement, workspace: Workspace, label: string): string[] {
  const problems: string[] = [];
  const flat: Arrangement = { ...source, maximized: null };
  const rects = layoutTree(flat, workspace);
  const all = [...rects.leaves, ...rects.dividers];
  const at = `${label} at ${workspace.width}x${workspace.height}`;
  let area = 0;
  for (const rect of all) {
    if (!(rect.w >= 0 && rect.h >= 0 && rect.x >= 0 && rect.y >= 0)) {
      problems.push(`${at}: a rect is negative`);
    }
    if (rect.x + rect.w > workspace.width || rect.y + rect.h > workspace.height) {
      problems.push(`${at}: a rect is outside`);
    }
    area += rect.w * rect.h;
  }
  if (area !== workspace.width * workspace.height) problems.push(`${at}: covers ${area}`);
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      const overX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overX > 0 && overY > 0) problems.push(`${at}: two rects overlap`);
    }
  }
  const leaves = leavesOf(flat.tree);
  for (const rect of rects.leaves) {
    const node = leaves.find((candidate) => candidate.id === rect.leafId);
    if (node === undefined) {
      problems.push(`${at}: a rect with no leaf`);
      continue;
    }
    const min = minSize(node);
    if (rect.w < min.w || rect.h < min.h) problems.push(`${at}: ${node.id} is under its minimum`);
  }
  return problems;
}

/** Behaviour 16's invariants and both halves of behaviour 18, for one arrangement. */
function arrangementProblems(arranged: Arrangement, cls: ScreenClass, label: string): string[] {
  const problems: string[] = [];
  const say = (what: string) => problems.push(`${label}: ${what}`);
  const tree = arranged.tree;
  if (tree === null) {
    say("nothing is open");
    return problems;
  }
  const open = openPanes(tree);
  if (new Set(open).size !== open.length) say("a pane is open twice");
  for (const pane of open) if (!PANE_IDS.includes(pane)) say(`${pane} is not a catalog pane`);
  for (const found of leavesOf(tree)) {
    if (found.tabs.length === 0) say(`${found.id} is empty`);
    if (!found.tabs.includes(found.active)) say(`${found.id} shows a tab it does not have`);
  }
  const every = allIds(tree);
  if (new Set(every).size !== every.length) say("two nodes share an id");
  const shapes = (node: TileNode): void => {
    if (!ID_SHAPE.test(node.id)) say(`${node.id} is not an id`);
    if (node.id.slice(0, 1) !== (node.kind === "leaf" ? "l" : "s")) say(`${node.id} is the wrong kind`);
    if (node.kind === "leaf") return;
    shapes(node.first);
    shapes(node.second);
  };
  shapes(tree);
  if (normalize(tree) !== tree) say("the tree is not normal");
  for (const found of splitsOf(tree)) {
    if (Math.round(found.ratio * 10_000) / 10_000 !== found.ratio) say(`${found.id} has more than four decimals`);
    if (found.ratio < 0.05 || found.ratio > 0.95) say(`${found.id} is outside the range`);
  }
  if (depthOf(tree) > PANE_IDS.length) say("the tree is deeper than the panes allow");

  if (arranged.focus !== null) {
    const holder = leafOf(tree, arranged.focus);
    if (holder === null) say("the focus is not open");
    else if (holder.active !== arranged.focus) say("the focus is behind another tab");
  }
  if (arranged.maximized !== null && arranged.maximized !== arranged.focus) {
    say("the maximized pane is not the focus");
  }
  if (cls === "compact") {
    if (tree.kind !== "leaf") say("the phone has more than one leaf");
    if (arranged.maximized !== null) say("the phone has something maximized");
  }
  for (const value of numbersIn(arranged)) if (!Number.isFinite(value)) say("a number is not finite");

  for (const [pane, chosen] of Object.entries(arranged.options)) {
    const spec = PANES.find((candidate) => candidate.id === pane);
    if (spec === undefined) {
      say(`options for ${pane}, which has no spec`);
      continue;
    }
    if (Object.keys(chosen).length === 0) say(`an empty options entry for ${pane}`);
    for (const [key, value] of Object.entries(chosen)) {
      const option = spec.options.find((candidate) => candidate.key === key);
      if (option === undefined) say(`${pane} has no option ${key}`);
      else if (!option.choices.some((choice) => choice.value === value)) say(`${pane} ${key} is ${value}`);
      else if (value === option.fallback) say(`${pane} ${key} stores its fallback`);
    }
  }
  for (const [pane, spot] of Object.entries(arranged.lastSpot)) {
    if (!PANE_IDS.includes(pane) || !PANE_IDS.includes(spot.beside)) say(`a spot for ${pane} is not a catalog pane`);
    if (!ZONES.includes(spot.zone)) say(`a spot for ${pane} has no zone`);
  }

  const min = minSize(tree);
  for (const workspace of [
    { width: min.w, height: min.h },
    { width: min.w + 211, height: min.h + 97 },
    { width: Math.max(min.w, 1600), height: Math.max(min.h, 1200) },
  ]) {
    problems.push(...tilingProblems(arranged, workspace, label));
  }
  return problems;
}

/** Whether a stored slot is one amendment A says should not be stored. */
function equalsDefault(arranged: Arrangement, base: BuiltInLayoutId, cls: ScreenClass): boolean {
  return (
    arranged.maximized === null &&
    signature(arranged.tree) === signature(defaultTree(cls, base)) &&
    Object.keys(arranged.options).length === 0 &&
    Object.keys(arranged.lastSpot).length === 0
  );
}

/**
 * Every invariant of the desk, for every layout and every class. An
 * arrangement object is checked once per base and class it is read under:
 * nothing can change it, so a second check would find what the first did.
 */
function deskProblems(
  set: TileSet,
  checked: WeakMap<Arrangement, Set<string>>,
  label: string,
): string[] {
  const problems: string[] = [];
  const say = (what: string) => problems.push(`${label}: ${what}`);
  const layoutIds = ids(set);
  if (new Set(layoutIds).size !== layoutIds.length) say("two layouts share an id");
  if (layoutIds.length > MAX_LAYOUTS) say("more layouts than a desk holds");
  for (const base of BUILT_IN_LAYOUTS) {
    const found = set.layouts.find((meta) => meta.id === base.id);
    if (found === undefined) say(`${base.id} is missing`);
    else if (found.title !== base.title || found.base !== base.base) say(`${base.id} is not the catalog's`);
  }
  for (const meta of set.layouts) {
    if (BASES.includes(meta.id as BuiltInLayoutId)) continue;
    if (!USER_LAYOUT.test(meta.id)) say(`${meta.id} is not a user layout id`);
    if (!BASES.includes(meta.base)) say(`${meta.id} has no built in base`);
    if (cleanTitle(meta.title) !== meta.title) say(`${meta.id} has a title that is not clean`);
  }
  for (const id of set.hidden) if (!layoutIds.includes(id)) say(`${id} is hidden and not a layout`);
  if (new Set(set.hidden).size !== set.hidden.length) say("a layout is hidden twice");
  if (layoutIds.every((id) => set.hidden.includes(id))) say("nothing is visible");
  if (!layoutIds.includes(set.current)) say("current is not a layout");
  if (set.hidden.includes(set.current)) say("current is hidden");

  for (const layout of Object.keys(set.slots)) {
    if (!layoutIds.includes(layout)) say(`a slot for ${layout}, which is not a layout`);
    const classes = Object.keys(set.slots[layout]);
    if (classes.length === 0) say(`an empty slot record for ${layout}`);
    for (const cls of classes) if (!CLASSES.includes(cls as ScreenClass)) say(`${layout} has a class ${cls}`);
  }

  for (const meta of set.layouts) {
    for (const cls of CLASSES) {
      const arranged = arrangementOf(set, meta.id, cls);
      const context = `${meta.base} ${cls}`;
      const seen = checked.get(arranged) ?? new Set<string>();
      if (seen.has(context)) continue;
      problems.push(...arrangementProblems(arranged, cls, `${label} ${meta.id} ${cls}`));
      if (isChanged(set, meta.id, cls) && equalsDefault(arranged, meta.base, cls)) {
        say(`${meta.id} ${cls} is stored and equals its default`);
      }
      seen.add(context);
      checked.set(arranged, seen);
    }
  }
  return problems;
}

describe("four hundred operations from every layout on every screen class", () => {
  const STEPS = 400;
  const SAVE_EVERY = 25;
  const TITLES = [
    "Deep work",
    "  Evening  ",
    "Plan\tthe\nweek",
    "",
    "A long title for a layout of many panes",
    "Errands",
  ];

  for (const startClass of CLASSES) {
    for (const base of BASES) {
      test(`${startClass} ${base} stays a desk`, () => {
        const random = seeded(
          0x5eed + BASES.indexOf(base) * 131 + CLASSES.indexOf(startClass) * 17,
        );
        const pick = <T,>(values: readonly T[]): T =>
          values[Math.min(values.length - 1, Math.floor(random() * values.length))];

        let set: TileSet = deepFreeze(setCurrent(EMPTY_TILE_SET, base));
        let cls: ScreenClass = startClass;
        const checked = new WeakMap<Arrangement, Set<string>>();
        let deepest = 0;
        // What the run actually reached. A sequence test that only ever hit
        // refusals would pass every invariant and prove nothing, so the counts
        // are asserted at the end.
        const reached = {
          arranged: 0,
          closed: 0,
          opened: 0,
          tabMoved: 0,
          optionSet: 0,
          maximized: 0,
          added: 0,
          renamed: 0,
          removed: 0,
          moved: 0,
          hidden: 0,
          unhidden: 0,
          switched: 0,
          reset: 0,
          classChanged: 0,
        };
        const zoneMoves: Record<Zone, number> = { left: 0, right: 0, top: 0, bottom: 0, centre: 0 };
        expect(deskProblems(set, checked, `${startClass} ${base} step 0`)).toEqual([]);

        for (let step = 1; step <= STEPS; step += 1) {
          const label = `${startClass} ${base} step ${step}`;
          const layout = set.current;
          const working = arrangementOf(set, layout, cls);
          const open = openPanes(working.tree);
          const closed = PANE_IDS.filter((pane) => !open.includes(pane));
          const leafIds = leavesOf(working.tree).map((found) => found.id);
          const splits = splitIds(working.tree);
          const width = pick([400, 896, 1200, 1472, 1920, 3200]);
          const workspace = { width, height: Math.round(width * 0.6) };
          const layoutIds = ids(set);
          const userIds = layoutIds.filter((id) => USER_LAYOUT.test(id));
          const somePane = (from: readonly PaneId[]) =>
            from.length > 0 && random() < 0.8 ? pick(from) : pick(PANE_IDS);
          const someLayout = () =>
            userIds.length > 0 && random() < 0.8 ? pick(userIds) : pick([...layoutIds, "u99"]);

          let next: Arrangement | null = null;
          let nextSet: TileSet = set;
          switch (Math.floor(random() * 22)) {
            case 0:
            case 1:
              next = closePane(working, somePane(open));
              if (next !== working) reached.closed += 1;
              break;
            case 2:
            case 3:
              next = openPane(working, somePane(closed), random() < 0.2 ? null : workspace);
              if (next !== working) reached.opened += 1;
              break;
            case 4:
            case 5: {
              // A closed pane half the time: on the phone's single leaf a move
              // into the centre only changes anything for a pane coming in.
              const zone = pick(ZONES);
              const mover = random() < 0.5 ? somePane(open) : somePane(closed);
              next = movePane(working, mover, pick(leafIds), zone);
              if (next.tree !== working.tree) zoneMoves[zone] += 1;
              break;
            }
            case 6:
              next = splits.length === 0 ? working : setRatio(working, pick(splits), random(), width);
              break;
            case 7:
              next = splits.length === 0 ? working : equalize(working, pick(splits));
              break;
            case 8:
              next = activateTab(working, pick(open));
              break;
            case 9:
              next = cycleTab(working, random() < 0.5 ? 1 : -1);
              break;
            case 10:
              next = toggleMaximize(working, pick(open));
              break;
            case 11:
              next = swapLeaves(working, pick(leafIds), pick(leafIds));
              break;
            case 12:
              next = moveTab(working, pick(open), Math.floor(random() * 7) - 1);
              if (next !== working) reached.tabMoved += 1;
              break;
            case 13: {
              const spec = pick(OPTION_PANES);
              const option = spec.options[0];
              next = setOption(working, spec.id, option.key, pick(option.choices).value);
              if (next !== working) reached.optionSet += 1;
              break;
            }
            case 14:
              nextSet = addLayout(set, pick(TITLES), pick(layoutIds), cls);
              if (nextSet !== set) reached.added += 1;
              break;
            case 15:
              nextSet = renameLayout(set, someLayout(), pick(TITLES));
              if (nextSet !== set) reached.renamed += 1;
              break;
            case 16:
              nextSet = removeLayout(set, someLayout());
              if (nextSet !== set) reached.removed += 1;
              break;
            case 17:
              nextSet = moveLayout(
                set,
                pick(layoutIds),
                Math.floor(random() * (layoutIds.length + 2)) - 1,
              );
              if (nextSet !== set) reached.moved += 1;
              break;
            case 18: {
              const hide = set.hidden.length === 0 || random() < 0.5;
              nextSet = setHidden(set, hide ? pick(layoutIds) : pick(set.hidden), hide);
              if (nextSet !== set) {
                if (hide) reached.hidden += 1;
                else reached.unhidden += 1;
              }
              break;
            }
            case 19:
              nextSet = setCurrent(set, pick(layoutIds));
              if (nextSet !== set) reached.switched += 1;
              break;
            case 20:
              nextSet = resetLayout(
                set,
                random() < 0.7 ? layout : pick(layoutIds),
                random() < 0.5 ? null : pick(CLASSES),
              );
              if (nextSet !== set) reached.reset += 1;
              break;
            default: {
              const other = pick(CLASSES);
              if (other !== cls) reached.classChanged += 1;
              cls = other;
              break;
            }
          }
          if (next !== null) {
            nextSet = withArrangement(set, layout, cls, next);
            if (nextSet !== set) reached.arranged += 1;
          }
          set = deepFreeze(nextSet);
          expect(deskProblems(set, checked, label)).toEqual([]);

          for (const classes of Object.values(set.slots)) {
            for (const arranged of Object.values(classes)) {
              if (arranged === undefined) continue;
              deepest = Math.max(deepest, depthOf(arranged.tree));
              if (arranged.maximized !== null) reached.maximized += 1;
            }
          }

          if (step % SAVE_EVERY === 0) {
            const text = serializeTileSet(set);
            const back = parseTileSet(text);
            expect(back, `${label}: survives a save and a load`).toEqual(asParsed(set));
            expect(serializeTileSet(back), `${label}: the same text again`).toBe(text);
            set = deepFreeze(back);
            expect(deskProblems(set, checked, `${label}: after a load`)).toEqual([]);
          }
        }

        expect(deepest).toBeLessThanOrEqual(PANE_IDS.length);
        expect(deepest).toBeGreaterThan(1);
        // The run went somewhere: arrangements were stored, panes closed and
        // came back, tabs moved, options were set, something was maximized,
        // and every layout operation and a change of class happened at least
        // once.
        expect(reached.arranged).toBeGreaterThan(STEPS / 8);
        for (const [what, count] of Object.entries(reached)) {
          expect(count, `${startClass} ${base}: ${what}`).toBeGreaterThan(0);
        }
        // A move into each of the five zones changed the tree at least once,
        // so no zone's docking maths went unexercised.
        for (const zone of ZONES) {
          expect(zoneMoves[zone], `${startClass} ${base}: moves into ${zone}`).toBeGreaterThan(0);
        }
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
    expect(engine.PANES).toHaveLength(14);
    expect(engine.BUILT_IN_LAYOUTS[0].id).toBe("today");
    expect(engine.MAX_LAYOUTS).toBe(12);
    expect(engine.screenClassFor(390)).toBe("compact");
    expect(engine.screenClassFor(1600)).toBe("wide");
    expect(engine.EMPTY_TILE_SET.slots).toEqual({});
    const start = engine.arrangementOf(engine.EMPTY_TILE_SET, "today", "regular");
    expect(start).toBe(engine.defaultArrangement("regular", "today"));
    expect(engine.signature(start.tree)).toBe(signature(defaultTree("regular", "today")));
    expect(engine.layoutTree(start, { width: 896, height: 600 }).leaves).toHaveLength(2);
    expect(engine.flatten(start).tree?.kind).toBe("leaf");
    expect(engine.optionsOf(start, "calendar")).toEqual({ days: "auto" });
    expect(engine.closePane(engine.defaultArrangement("compact", "week"), "calendar").tree).not.toBeNull();
    expect(engine.cleanTitle("  Mine ")).toBe("Mine");
    for (const name of [
      "moveTab",
      "setOption",
      "withArrangement",
      "isChanged",
      "resetLayout",
      "addLayout",
      "renameLayout",
      "removeLayout",
      "moveLayout",
      "setHidden",
      "setCurrent",
      "parseTileSet",
      "serializeTileSet",
    ] as const) {
      expect(typeof engine[name], name).toBe("function");
    }
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
      expect(source.includes(EM_DASH), `${name} has an em dash`).toBe(false);
      expect(source.includes(EN_DASH), `${name} has an en dash`).toBe(false);
    }
  });

  test("the copy a user reads has no dash: titles, labels, the fallback title", () => {
    const strings = [
      ...EMPTY_TILE_SET.layouts.map((meta) => meta.title),
      cleanTitle(""),
      ...PANES.flatMap((pane) => [
        pane.title,
        pane.short,
        ...pane.options.flatMap((option) => [
          option.label,
          ...option.choices.map((choice) => choice.label),
        ]),
      ]),
    ];
    for (const text of strings) {
      expect(text.includes(EM_DASH), text).toBe(false);
      expect(text.includes(EN_DASH), text).toBe(false);
    }
  });
});
