// PLAN-DESK.md Task 8: the saved form the server reads.
//
// The server draws the first paint, so it has to know the layout before any
// script runs, and the only thing a request carries that the browser wrote is a
// cookie. The whole desk does not fit one, so the cookie carries the rail and
// the open layout only, in a compact text, and the rest stays in the browser's
// own storage. This file pins that text: the grammar of one arrangement
// (codec.ts) and the cookie around it (cookie.ts).
//
// Nothing is trusted on the way back in. Every expectation about what a decode
// returns is derived from the engine's own calls (repairArrangement,
// parseTileSet, withCanonicalIds) rather than written out, so the file does not
// care which side of "is this the default" a front tab change falls on.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { BUILT_IN_LAYOUTS, MAX_LAYOUTS, PANES, defaultArrangement } from "@/app/lib/v2/tiles/catalog";
import { decodeArrangement, encodeArrangement, readArrangement } from "@/app/lib/v2/tiles/codec";
import {
  TILE_COOKIE,
  TILE_COOKIE_MAX,
  decodeTileCookie,
  encodeTileCookie,
} from "@/app/lib/v2/tiles/cookie";
import {
  EMPTY_TILE_SET,
  MAX_TREE_DEPTH,
  addLayout,
  arrangementOf,
  cleanTitle,
  isChanged,
  moveLayout,
  parseTileSet,
  removeLayout,
  renameLayout,
  repairArrangement,
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
  flatten,
  hasSoundIds,
  leafOf,
  leavesOf,
  movePane,
  moveTab,
  openPane,
  openPanes,
  setOption,
  setRatio,
  signature,
  swapLeaves,
  toggleMaximize,
  withCanonicalIds,
} from "@/app/lib/v2/tiles/tree";
import type {
  Arrangement,
  BuiltInLayoutId,
  Leaf,
  PaneId,
  ScreenClass,
  TileNode,
  Zone,
} from "@/app/lib/v2/tiles/types";

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = "app/lib/v2/tiles";
const SOURCES = ["codec.ts", "cookie.ts"];

const PANE_IDS: readonly PaneId[] = PANES.map((pane) => pane.id);
const OPTION_PANES = PANES.filter((pane) => pane.options.length > 0);
const CLASSES: readonly ScreenClass[] = ["compact", "regular", "wide"];
const BASES: readonly BuiltInLayoutId[] = ["today", "week", "quests", "money"];
const ZONES: readonly Zone[] = ["left", "right", "top", "bottom", "centre"];

/** The characters an arrangement may be written in. */
const ARRANGEMENT_TEXT = /^[a-z0-9()~*._-]*$/;
/** The same, and what the cookie adds around it: the field mark, the escape and a title's letters. */
const COOKIE_TEXT = /^[A-Za-z0-9()~*._!'-]*$/;

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

function picker(random: () => number): <T>(values: readonly T[]) => T {
  return <T,>(values: readonly T[]): T =>
    values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function depthOf(node: TileNode | null): number {
  if (node === null) return 0;
  if (node.kind === "leaf") return 1;
  return 1 + Math.max(depthOf(node.first), depthOf(node.second));
}

function splitIdsOf(node: TileNode | null, out: string[] = []): string[] {
  if (node === null || node.kind === "leaf") return out;
  out.push(node.id);
  splitIdsOf(node.first, out);
  splitIdsOf(node.second, out);
  return out;
}

function fronts(node: TileNode | null): PaneId[] {
  return leavesOf(node).map((found) => found.active);
}

function ratiosOf(node: TileNode | null, out: number[] = []): number[] {
  if (node === null || node.kind === "leaf") return out;
  out.push(node.ratio);
  ratiosOf(node.first, out);
  ratiosOf(node.second, out);
  return out;
}

/** An arrangement of one leaf holding one pane: where a chain starts. */
function single(pane: PaneId): Arrangement {
  return {
    tree: { kind: "leaf", id: "l1", tabs: [pane], active: pane },
    maximized: null,
    focus: pane,
    lastSpot: {},
    options: {},
  };
}

/** Every pane in a leaf of its own, each one to the right of the last: the deepest tree there is. */
function chainOf(panes: readonly PaneId[]): Arrangement {
  let arranged = single(panes[0]);
  for (let index = 1; index < panes.length; index += 1) {
    const target = leafOf(arranged.tree, panes[index - 1]) as Leaf;
    arranged = movePane(arranged, panes[index], target.id, "right");
  }
  return arranged;
}

/** A plain tree of `levels` levels, a chain of splits, for the depth limit. */
function deepText(levels: number): string {
  let text = "";
  for (let level = 1; level < levels; level += 1) text += `h5000(${PANE_IDS[(level - 1) % PANE_IDS.length]}*)`;
  return `${text}(${PANE_IDS[(levels - 1) % PANE_IDS.length]}*)`;
}

/**
 * An arrangement the engine produced: a default, and then a run of the
 * engine's own operations on it. The phone's is flattened, as the store does.
 */
function engineArrangement(random: () => number, cls: ScreenClass, base: BuiltInLayoutId): Arrangement {
  const pick = picker(random);
  let arranged = defaultArrangement(cls, base);
  const steps = Math.floor(random() * 40);
  for (let step = 0; step < steps; step += 1) {
    const open = openPanes(arranged.tree);
    const closed = PANE_IDS.filter((pane) => !open.includes(pane));
    const leafIds = leavesOf(arranged.tree).map((found) => found.id);
    const splits = splitIdsOf(arranged.tree);
    const width = pick([1100, 1440, 1920, 2560]);
    switch (Math.floor(random() * 12)) {
      case 0:
        arranged = closePane(arranged, pick(open));
        break;
      case 1:
        if (closed.length > 0) arranged = openPane(arranged, pick(closed), { width, height: 900 });
        break;
      case 2:
      case 3:
        arranged = movePane(arranged, pick(random() < 0.5 && closed.length > 0 ? closed : open), pick(leafIds), pick(ZONES));
        break;
      case 4:
        if (splits.length > 0) arranged = setRatio(arranged, pick(splits), random(), width);
        break;
      case 5:
        if (splits.length > 0) arranged = equalize(arranged, pick(splits));
        break;
      case 6:
        arranged = activateTab(arranged, pick(open));
        break;
      case 7:
        arranged = cycleTab(arranged, random() < 0.5 ? 1 : -1);
        break;
      case 8:
        arranged = toggleMaximize(arranged, pick(open));
        break;
      case 9:
        arranged = swapLeaves(arranged, pick(leafIds), pick(leafIds));
        break;
      case 10:
        arranged = moveTab(arranged, pick(open), Math.floor(random() * 6) - 1);
        break;
      default: {
        const spec = pick(OPTION_PANES);
        const option = spec.options[0];
        arranged = setOption(arranged, spec.id, option.key, pick(option.choices).value);
        break;
      }
    }
  }
  return cls === "compact" ? flatten(arranged) : arranged;
}

/** What a decode must answer for an arrangement: the engine's repair of it, with ids minted again. */
function asDecoded(arranged: Arrangement): Arrangement {
  const tree = arranged.tree === null ? null : withCanonicalIds(arranged.tree);
  return {
    tree,
    maximized: arranged.maximized,
    focus: arranged.maximized ?? leavesOf(tree)[0]?.active ?? null,
    lastSpot: {},
    options: arranged.options,
  };
}

const TITLES = [
  "Deep work",
  "Café plans",
  "\u{1F680} launch",
  "<script>alert(1)</script>",
  "a!b~c.d_e'f",
  "  Evening  ",
  "",
  "x".repeat(40),
  "日本語",
];

/** A desk the engine produced: layouts added, renamed, moved, hidden and arranged. */
function engineSet(random: () => number): TileSet {
  const pick = picker(random);
  let set: TileSet = EMPTY_TILE_SET;
  const steps = 10 + Math.floor(random() * 60);
  for (let step = 0; step < steps; step += 1) {
    const ids = set.layouts.map((meta) => meta.id);
    const users = ids.filter((id) => !BASES.includes(id as BuiltInLayoutId));
    const cls = pick(CLASSES);
    switch (Math.floor(random() * 10)) {
      case 0:
      case 1:
      case 2:
      case 3: {
        const layout = random() < 0.7 ? set.current : pick(ids);
        const meta = set.layouts.find((candidate) => candidate.id === layout);
        const base = meta === undefined ? "today" : meta.base;
        set = withArrangement(set, layout, cls, engineArrangement(random, cls, base));
        break;
      }
      case 4:
        set = addLayout(set, pick(TITLES), pick(ids), cls);
        break;
      case 5:
        if (users.length > 0) set = renameLayout(set, pick(users), pick(TITLES));
        break;
      case 6:
        if (users.length > 0) set = removeLayout(set, pick(users));
        break;
      case 7:
        set = moveLayout(set, pick(ids), Math.floor(random() * ids.length));
        break;
      case 8:
        set = setHidden(set, pick(ids), random() < 0.6);
        break;
      default:
        set = random() < 0.8 ? setCurrent(set, pick(ids)) : resetLayout(set, set.current, null);
        break;
    }
  }
  return set;
}

/**
 * What the cookie must give back for a desk, from the engine's own calls: the
 * rail, and only the open layout's slots, without the remembered spots the
 * grammar does not carry, through the parser (which sets every focus and drops
 * every slot that is now the default), with ids minted again in pre-order.
 */
function asCookieDecoded(set: TileSet): TileSet {
  const kept: TileSet["slots"] = {};
  if (own(set.slots, set.current)) {
    const classes: Partial<Record<ScreenClass, Arrangement>> = {};
    for (const cls of CLASSES) {
      const held = own(set.slots[set.current], cls) ? set.slots[set.current][cls] : undefined;
      if (held !== undefined) classes[cls] = { ...held, lastSpot: {} };
    }
    kept[set.current] = classes;
  }
  const parsed = parseTileSet(serializeTileSet({ ...set, slots: kept }));
  const slots: TileSet["slots"] = {};
  for (const [layout, classes] of Object.entries(parsed.slots)) {
    const out: Partial<Record<ScreenClass, Arrangement>> = {};
    for (const [cls, arranged] of Object.entries(classes) as Array<[ScreenClass, Arrangement]>) {
      out[cls] = { ...arranged, tree: arranged.tree === null ? null : withCanonicalIds(arranged.tree) };
    }
    slots[layout] = out;
  }
  return { ...parsed, slots };
}

// ----------------------------------------------------------- the grammar

describe("one arrangement as text", () => {
  test("a default tree: splits with four digit ratios, leaves with the front tab starred", () => {
    expect(encodeArrangement(defaultArrangement("regular", "today"))).toBe(
      "h5000(today*~status~past-due~not-today)(calendar*)",
    );
    expect(encodeArrangement(defaultArrangement("wide", "today"))).toBe(
      "h5000h5000v6700(today*)(status*)v5000(past-due*)(not-today*)(calendar*)",
    );
    expect(encodeArrangement(defaultArrangement("compact", "week"))).toBe(
      "(calendar*~not-today~past-due)",
    );
  });

  test("tabs, a maximized pane and options, panes and keys in sorted order", () => {
    let arranged = defaultArrangement("regular", "quests");
    arranged = activateTab(arranged, "done");
    arranged = toggleMaximize(arranged, "done");
    arranged = setOption(arranged, "steps", "group", "group");
    arranged = setOption(arranged, "done", "span", "28");
    arranged = setOption(arranged, "calendar", "days", "7");
    expect(encodeArrangement(arranged)).toBe(
      "h3600(lanes*)h5000(steps*)(side-quests~past-due~done*)_m.done" +
        "_o.calendar.days.7_o.done.span.28_o.steps.group.group",
    );
  });

  test("keys within a pane are sorted too, whatever order they were stored in", () => {
    const arranged: Arrangement = {
      ...defaultArrangement("compact", "money"),
      options: { ledger: { zeta: "1", alpha: "2" }, forecast: { span: "60" } },
    };
    expect(encodeArrangement(arranged)).toBe(
      "(forecast*~accounts~coming-up~hours~ledger)_o.forecast.span.60_o.ledger.alpha.2_o.ledger.zeta.1",
    );
  });

  test("an empty tree is ()", () => {
    const empty: Arrangement = { tree: null, maximized: null, focus: null, lastSpot: {}, options: {} };
    expect(encodeArrangement(empty)).toBe("()");
    expect(encodeArrangement({ ...empty, options: { calendar: { days: "7" } } })).toBe("()_o.calendar.days.7");
  });

  test("a ratio is the share times ten thousand in four digits, at both ends of its range", () => {
    const two = (ratio: number): Arrangement => ({
      tree: {
        kind: "split",
        id: "s1",
        dir: "v",
        ratio,
        first: { kind: "leaf", id: "l2", tabs: ["today"], active: "today" },
        second: { kind: "leaf", id: "l3", tabs: ["status"], active: "status" },
      },
      maximized: null,
      focus: "today",
      lastSpot: {},
      options: {},
    });
    expect(encodeArrangement(two(0.05))).toBe("v0500(today*)(status*)");
    expect(encodeArrangement(two(0.95))).toBe("v9500(today*)(status*)");
    expect(encodeArrangement(two(0.3333))).toBe("v3333(today*)(status*)");
    expect(encodeArrangement(two(0.29))).toBe("v2900(today*)(status*)");
    // Not a value the engine holds, so held to the engine's range first.
    expect(encodeArrangement(two(Number.NaN))).toBe("v5000(today*)(status*)");
    expect(encodeArrangement(two(2))).toBe("v9500(today*)(status*)");
  });

  test("lastSpot and focus are not written", () => {
    const closed = closePane(defaultArrangement("wide", "money"), "hours");
    expect(Object.keys(closed.lastSpot)).toEqual(["hours"]);
    const refocused = activateTab(closed, "ledger");
    expect(encodeArrangement(refocused)).toBe(encodeArrangement({ ...refocused, focus: null, lastSpot: {} }));
    expect(encodeArrangement(refocused).includes("hours")).toBe(false);
  });

  test("only the grammar's characters appear, and a cookie writer escapes none of them", () => {
    const random = seeded(0xc0de);
    for (let index = 0; index < 600; index += 1) {
      const cls = CLASSES[index % CLASSES.length];
      const text = encodeArrangement(engineArrangement(random, cls, BASES[index % BASES.length]));
      expect(text, text).toMatch(ARRANGEMENT_TEXT);
      expect(encodeURIComponent(text)).toBe(text);
    }
  });

  test("a value the engine never makes is still written in the grammar's characters", () => {
    const odd: Arrangement = {
      tree: {
        kind: "split",
        id: "s1",
        dir: "h",
        ratio: 0.5,
        first: { kind: "leaf", id: "l2", tabs: ["Not A Pane", "today"], active: "Not A Pane" },
        second: { kind: "leaf", id: "l3", tabs: ["<b>"], active: "<b>" },
      },
      maximized: "x y",
      focus: null,
      lastSpot: {},
      options: { "a b": { c: "d" }, calendar: { "k!": "7", days: "x y" } },
    };
    const text = encodeArrangement(odd);
    expect(text).toBe("h5000(today)()");
    expect(text).toMatch(ARRANGEMENT_TEXT);
  });

  test("a tree deeper than the limit is cut where the reader would stop, so what is written can be read", () => {
    let node: TileNode = { kind: "leaf", id: "l99", tabs: ["today"], active: "today" };
    for (let level = 0; level < MAX_TREE_DEPTH + 4; level += 1) {
      node = {
        kind: "split",
        id: `s${level}`,
        dir: "h",
        ratio: 0.5,
        first: { kind: "leaf", id: `l${level}`, tabs: [PANE_IDS[level % PANE_IDS.length]], active: PANE_IDS[level % PANE_IDS.length] },
        second: node,
      };
    }
    const text = encodeArrangement({ tree: node, maximized: null, focus: null, lastSpot: {}, options: {} });
    expect(text).toMatch(ARRANGEMENT_TEXT);
    const back = decodeArrangement(text);
    expect(back).not.toBeNull();
    expect(depthOf((back as Arrangement).tree)).toBeLessThanOrEqual(MAX_TREE_DEPTH);
  });
});

// ------------------------------------------------------------ round trip

describe("an arrangement survives being written and read", () => {
  test("for thousands of arrangements the engine made, on every class", () => {
    const random = seeded(0x7a11);
    let maximized = 0;
    let withOptions = 0;
    let backTabs = 0;
    for (let index = 0; index < 3000; index += 1) {
      const cls = CLASSES[index % CLASSES.length];
      const base = BASES[Math.floor(index / CLASSES.length) % BASES.length];
      const arranged = engineArrangement(random, cls, base);
      const text = encodeArrangement(arranged);
      const back = decodeArrangement(text);
      expect(back, text).not.toBeNull();
      const decoded = back as Arrangement;
      expect(signature(decoded.tree), text).toBe(signature(arranged.tree));
      expect(decoded.maximized, text).toBe(arranged.maximized);
      expect(decoded.options, text).toEqual(arranged.options);
      expect(fronts(decoded.tree), text).toEqual(fronts(arranged.tree));
      expect(ratiosOf(decoded.tree), text).toEqual(ratiosOf(arranged.tree));
      expect(decoded, text).toEqual(asDecoded(arranged));
      expect(hasSoundIds(decoded.tree), text).toBe(true);
      expect(encodeArrangement(decoded), text).toBe(text);
      if (arranged.maximized !== null) maximized += 1;
      if (Object.keys(arranged.options).length > 0) withOptions += 1;
      if (leavesOf(arranged.tree).some((found) => found.active !== found.tabs[0])) backTabs += 1;
    }
    // The run reached what the round trip is about.
    expect(maximized).toBeGreaterThan(100);
    expect(withOptions).toBeGreaterThan(100);
    expect(backTabs).toBeGreaterThan(100);
  });

  test("the deepest tree the engine can build, every pane in a chain, comes back", () => {
    const chain = chainOf(PANE_IDS);
    expect(depthOf(chain.tree)).toBe(PANE_IDS.length);
    expect(depthOf(chain.tree)).toBe(MAX_TREE_DEPTH);
    const back = decodeArrangement(encodeArrangement(chain));
    expect(back).toEqual(asDecoded(chain));
  });

  test("ids are minted again down the tree, as the engine numbers a default", () => {
    const back = decodeArrangement(encodeArrangement(defaultArrangement("wide", "money")));
    expect(back?.tree).toEqual(defaultArrangement("wide", "money").tree);
  });

  test("the empty tree reads back as an arrangement with nothing open", () => {
    expect(decodeArrangement("()")).toEqual({
      tree: null,
      maximized: null,
      focus: null,
      lastSpot: {},
      options: {},
    });
    expect(decodeArrangement("()_o.calendar.days.7")?.options).toEqual({ calendar: { days: "7" } });
  });

  test("the focus is the maximized pane, or the tab the first leaf shows", () => {
    expect(decodeArrangement("h5000(today~status*)(calendar*)")?.focus).toBe("status");
    expect(decodeArrangement("h5000(today~status*)(calendar*)_m.calendar")?.focus).toBe("calendar");
  });
});

// ------------------------------------------------------------- tolerance

describe("reading any string", () => {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789()~*._-";

  function check(text: string): Arrangement | null {
    let back: Arrangement | null = null;
    expect(() => {
      back = decodeArrangement(text);
    }, text).not.toThrow();
    if (back === null) return null;
    const decoded = back as Arrangement;
    const open = openPanes(decoded.tree);
    for (const pane of open) expect(PANE_IDS, text).toContain(pane);
    expect(new Set(open).size, text).toBe(open.length);
    expect(depthOf(decoded.tree), text).toBeLessThanOrEqual(MAX_TREE_DEPTH);
    expect(hasSoundIds(decoded.tree), text).toBe(true);
    if (decoded.maximized !== null) expect(open, text).toContain(decoded.maximized);
    for (const pane of Object.keys(decoded.options)) expect(PANE_IDS, text).toContain(pane);
    return decoded;
  }

  test("ten thousand seeded strings over the grammar's own characters", () => {
    const random = seeded(0xa1fa);
    const pick = picker(random);
    const letters = [...ALPHABET];
    const valid: string[] = [];
    const seedRandom = seeded(0xbeef);
    for (let index = 0; index < 200; index += 1) {
      valid.push(encodeArrangement(engineArrangement(seedRandom, CLASSES[index % 3], BASES[index % 4])));
    }
    let read = 0;
    for (let index = 0; index < 10_000; index += 1) {
      let text = "";
      if (index % 2 === 0) {
        const length = Math.floor(random() * 80);
        for (let at = 0; at < length; at += 1) text += pick(letters);
      } else {
        // A real text with a few characters changed, so the reader is pushed
        // down the grammar rather than turned away at the first character.
        const chars = [...pick(valid)];
        const edits = 1 + Math.floor(random() * 4);
        for (let edit = 0; edit < edits; edit += 1) {
          const at = Math.floor(random() * (chars.length + 1));
          const kind = Math.floor(random() * 3);
          if (kind === 0) chars.splice(at, 1);
          else if (kind === 1) chars.splice(at, 0, pick(letters));
          else chars[at] = pick(letters);
        }
        text = chars.join("");
      }
      if (check(text) !== null) read += 1;
    }
    // Some of what was read were arrangements, so the checks above ran.
    expect(read).toBeGreaterThan(500);
  });

  test("a thousand seeded strings over all of ASCII", () => {
    const random = seeded(0xa5c1);
    for (let index = 0; index < 1000; index += 1) {
      const length = Math.floor(random() * 120);
      let text = "";
      for (let at = 0; at < length; at += 1) text += String.fromCharCode(Math.floor(random() * 128));
      check(text);
    }
  });

  test("the reader stops at the engine's depth: the limit is read and one past it is not", () => {
    expect(depthOf(check(deepText(MAX_TREE_DEPTH))?.tree ?? null)).toBe(MAX_TREE_DEPTH);
    expect(decodeArrangement(deepText(MAX_TREE_DEPTH + 1))).toBeNull();
    const nested = `${"h5000".repeat(200_000)}(today*)`;
    expect(() => decodeArrangement(nested)).not.toThrow();
    expect(decodeArrangement(nested)).toBeNull();
  });

  test("a pane the catalog does not know is dropped, as the parser drops it", () => {
    expect(check("h5000(nope*)(today*)")?.tree).toEqual({ kind: "leaf", id: "l1", tabs: ["today"], active: "today" });
    expect(check("(nope*~status)")?.tree).toEqual({ kind: "leaf", id: "l1", tabs: ["status"], active: "status" });
    expect(check("(zzz*)")?.tree).toBeNull();
    expect(check("(today*)_m.nope")?.maximized).toBeNull();
    expect(check("(today*)_o.nope.days.7_o.calendar.nope.7_o.calendar.days.9")?.options).toEqual({});
  });

  test("a pane listed twice keeps its first place", () => {
    expect(check("h5000(today*)(status~today*)")?.tree).toEqual({
      kind: "split",
      id: "s1",
      dir: "h",
      ratio: 0.5,
      first: { kind: "leaf", id: "l2", tabs: ["today"], active: "today" },
      second: { kind: "leaf", id: "l3", tabs: ["status"], active: "status" },
    });
  });

  test("a maximize stays only on a pane that is open and in front", () => {
    expect(check("h5000(today*~status)(calendar*)_m.status")?.maximized).toBeNull();
    expect(check("h5000(today*~status)(calendar*)_m.today")?.maximized).toBe("today");
  });

  test("an option given twice keeps the first, and only options the catalog has survive", () => {
    expect(check("(calendar*)_o.calendar.days.7_o.calendar.days.3")?.options).toEqual({ calendar: { days: "7" } });
    expect(check("(calendar*)_o.calendar.days.auto")?.options).toEqual({});
  });

  test("text that is not in the grammar is null", () => {
    for (const text of [
      "",
      "(",
      ")",
      "today",
      "(today*",
      "(today**)",
      "(today*~status*)",
      "(today~)",
      "(~today)",
      "(today*)(status*)",
      "h500(today*)(status*)",
      "h50000(today*)(status*)",
      "x5000(today*)(status*)",
      "h5000(today*)",
      "(today*)_",
      "(today*)_m",
      "(today*)_m.",
      "(today*)_m.today_m.today",
      "(today*)_o.calendar.days.7_m.today",
      "(today*)_o.calendar.days",
      "(today*)_o.calendar..7",
      "(today*)_x.today",
      "(today*) ",
      "(Today*)",
      "(to day*)",
    ]) {
      expect(decodeArrangement(text), JSON.stringify(text)).toBeNull();
    }
  });

  test("the words Object.prototype has are just words", () => {
    const back = check("(today*)_o.constructor.prototype.x_o.today.constructor.y_o.calendar.constructor.z");
    expect(back?.options).toEqual({});
    const read = readArrangement("(today*)_o.constructor.prototype.x");
    expect(read).not.toBeNull();
    const options = (read as { options: Record<string, unknown> }).options;
    expect(own(options, "constructor")).toBe(true);
    expect(Object.getPrototypeOf(options)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test("anything that is not a string is null", () => {
    expect(decodeArrangement(undefined as unknown as string)).toBeNull();
    expect(decodeArrangement(42 as unknown as string)).toBeNull();
  });
});

describe("the reader hands the engine a plain value and nothing more", () => {
  test("ids are not invented, and the repair is the engine's", () => {
    const text = "h5000(today~status*)(calendar*)_m.calendar_o.calendar.days.7";
    const read = readArrangement(text);
    expect(read).toEqual({
      tree: {
        kind: "split",
        dir: "h",
        ratio: 0.5,
        first: { kind: "leaf", tabs: ["today", "status"], active: "status" },
        second: { kind: "leaf", tabs: ["calendar"], active: "calendar" },
      },
      maximized: "calendar",
      lastSpot: {},
      options: { calendar: { days: "7" } },
    });
    expect(decodeArrangement(text)).toEqual(repairArrangement(read));
  });

  test("a leaf with no star names no front tab", () => {
    expect(readArrangement("(today~status)")).toEqual({
      tree: { kind: "leaf", tabs: ["today", "status"] },
      maximized: null,
      lastSpot: {},
      options: {},
    });
  });
});

// ------------------------------------------------------------ the cookie

describe("the cookie", () => {
  test("its name and its ceiling", () => {
    expect(TILE_COOKIE).toBe("mb-v2-desk");
    expect(TILE_COOKIE_MAX).toBe(3800);
  });

  test("an untouched desk: the version, the rail, nothing hidden, the open layout, no arrangement", () => {
    expect(encodeTileCookie(EMPTY_TILE_SET)).toBe("1!today~week~quests~money!!today!!!");
  });

  test("a layout of the user's, a hidden one, and the open layout rearranged on one class", () => {
    let set = addLayout(EMPTY_TILE_SET, "Deep work", "quests", "regular");
    set = withArrangement(set, "u1", "regular", closePane(arrangementOf(set, "u1", "regular"), "past-due"));
    set = setHidden(set, "week", true);
    expect(set.current).toBe("u1");
    expect(encodeTileCookie(set)).toBe(
      "1!today~week~quests~money~u1.quests.Deep'20work!week!u1!!h3600(lanes*)h5000(steps*)(side-quests*~done)!",
    );
  });

  test("a title keeps its letters and digits and writes every other byte of its UTF-8 as ' and two hex digits", () => {
    const titled = (title: string): string | null => {
      const set = renameLayout(addLayout(EMPTY_TILE_SET, "x", "today", "wide"), "u1", title);
      return encodeTileCookie(set);
    };
    expect(titled("Café 2")).toContain("~u1.today.Caf'c3'a9'202!");
    expect(titled("\u{1F680}")).toContain("~u1.today.'f0'9f'9a'80!");
    expect(titled("a!b~c.d_e'f")).toContain("~u1.today.a'21b'7ec'2ed'5fe'27f!");
    expect(titled("<script>")).toContain("~u1.today.'3cscript'3e!");
  });

  test("fields joined by !, starting with the version, in the characters a cookie carries as they are", () => {
    const random = seeded(0xf1e1d);
    for (let index = 0; index < 300; index += 1) {
      const text = encodeTileCookie(engineSet(random));
      expect(text).not.toBeNull();
      const value = text as string;
      expect(value.startsWith("1!")).toBe(true);
      expect(value.split("!")).toHaveLength(7);
      expect(value).toMatch(COOKIE_TEXT);
      expect(encodeURIComponent(value)).toBe(value);
    }
  });

  test("an arrangement is written for a class exactly when the engine says it changed", () => {
    const random = seeded(0x5107);
    let written = 0;
    let blank = 0;
    for (let index = 0; index < 300; index += 1) {
      const set = engineSet(random);
      const fields = (encodeTileCookie(set) as string).split("!");
      CLASSES.forEach((cls, at) => {
        const field = fields[4 + at];
        if (isChanged(set, set.current, cls)) {
          expect(field).toBe(encodeArrangement(arrangementOf(set, set.current, cls)));
          written += 1;
        } else {
          expect(field).toBe("");
          blank += 1;
        }
      });
    }
    expect(written).toBeGreaterThan(50);
    expect(blank).toBeGreaterThan(50);
  });

  test("the other layouts' arrangements are left out on purpose", () => {
    let set = withArrangement(EMPTY_TILE_SET, "money", "wide", closePane(defaultArrangement("wide", "money"), "hours"));
    set = withArrangement(set, "today", "wide", closePane(defaultArrangement("wide", "today"), "status"));
    expect(set.current).toBe("today");
    const text = encodeTileCookie(set) as string;
    expect(text.includes("not-today")).toBe(true);
    expect(text.includes("forecast")).toBe(false);
    expect(Object.keys(decodeTileCookie(text).slots)).toEqual(["today"]);
  });
});

describe("the worst case fits", () => {
  test("twelve layouts, the longest titles and ids, the open one rearranged on every class with every option set", () => {
    const longest = "\u{1F680}".repeat(24);
    expect(cleanTitle(longest)).toBe(longest);
    const users = [1_000_000_000, 999_999_999, 999_999_998, 999_999_997, 999_999_996, 999_999_995, 999_999_994, 999_999_993];
    expect(BUILT_IN_LAYOUTS.length + users.length).toBe(MAX_LAYOUTS);
    let set = parseTileSet({
      version: 1,
      layouts: [
        ...BUILT_IN_LAYOUTS.map((meta) => ({ ...meta })),
        ...users.map((number) => ({ id: `u${number}`, title: longest, base: "quests" })),
      ],
      hidden: [],
      current: "u1000000000",
      slots: {},
    });
    expect(set.layouts).toHaveLength(MAX_LAYOUTS);
    for (const meta of set.layouts) if (meta.id !== set.current) set = setHidden(set, meta.id, true);
    expect(set.hidden).toHaveLength(MAX_LAYOUTS - 1);

    // Every option at its longest choice that is not the fallback.
    const everyOption = (arranged: Arrangement): Arrangement => {
      let out = arranged;
      for (const spec of OPTION_PANES) {
        for (const option of spec.options) {
          const longestChoice = option.choices
            .map((candidate) => candidate.value)
            .filter((value) => value !== option.fallback)
            .reduce((best, value) => (value.length > best.length ? value : best), "");
          out = setOption(out, spec.id, option.key, longestChoice);
        }
      }
      return out;
    };
    // Every pane in a leaf of its own, the longest named one maximized.
    const longestPane = PANE_IDS.reduce((best, pane) => (pane.length > best.length ? pane : best), "");
    const spread = everyOption(toggleMaximize(chainOf(PANE_IDS), longestPane));
    set = withArrangement(set, set.current, "wide", spread);
    set = withArrangement(set, set.current, "regular", spread);
    set = withArrangement(set, set.current, "compact", everyOption(flatten(chainOf(PANE_IDS))));
    for (const cls of CLASSES) expect(isChanged(set, set.current, cls)).toBe(true);

    const text = encodeTileCookie(set);
    expect(text).not.toBeNull();
    const value = text as string;
    // The measured size, pinned so a change to the encoding shows up here.
    expect(value.length).toBe(3489);
    expect(value.length).toBeLessThan(TILE_COOKIE_MAX);
    expect(decodeTileCookie(value)).toEqual(asCookieDecoded(set));
  });

  test("a desk that would not fit answers null", () => {
    const huge: TileSet = {
      ...EMPTY_TILE_SET,
      layouts: [...EMPTY_TILE_SET.layouts, { id: "u1", title: "\u{1F680}".repeat(400), base: "today" }],
    };
    expect(encodeTileCookie(huge)).toBeNull();
  });

  test("a desk with an id the cookie cannot spell answers null rather than writing it", () => {
    expect(encodeTileCookie({ ...EMPTY_TILE_SET, current: "a b" })).toBeNull();
    expect(encodeTileCookie({ ...EMPTY_TILE_SET, hidden: ["x!y"] })).toBeNull();
    expect(
      encodeTileCookie({
        ...EMPTY_TILE_SET,
        layouts: [...EMPTY_TILE_SET.layouts, { id: "U1", title: "x", base: "today" }],
      }),
    ).toBeNull();
  });
});

// ------------------------------------------------------- reading the cookie

describe("reading the cookie is the engine's parser", () => {
  test("a desk comes back as its rail and only the open layout's slots, every focus as the parser sets it", () => {
    const random = seeded(0xdec0de);
    let withSlots = 0;
    let withUsers = 0;
    for (let index = 0; index < 400; index += 1) {
      const set = engineSet(random);
      const text = encodeTileCookie(set) as string;
      const back = decodeTileCookie(text);
      expect(back, text).toEqual(asCookieDecoded(set));
      expect(back.layouts, text).toEqual(set.layouts);
      expect(back.hidden, text).toEqual(set.hidden);
      expect(back.current, text).toBe(set.current);
      for (const layout of Object.keys(back.slots)) expect(layout, text).toBe(set.current);
      // A desk read from the cookie is one the cookie gives back unchanged.
      expect(decodeTileCookie(encodeTileCookie(back) as string), text).toEqual(back);
      if (Object.keys(back.slots).length > 0) withSlots += 1;
      if (set.layouts.length > BUILT_IN_LAYOUTS.length) withUsers += 1;
    }
    expect(withSlots).toBeGreaterThan(50);
    expect(withUsers).toBeGreaterThan(50);
  });

  test("a title comes back as the parser cleans it", () => {
    const set = addLayout(EMPTY_TILE_SET, "<script>alert(1)</script>", "today", "wide");
    const back = decodeTileCookie(encodeTileCookie(set) as string);
    expect(back.layouts[4]).toEqual({ id: "u1", title: cleanTitle("<script>alert(1)</script>"), base: "today" });
    const raw = decodeTileCookie("1!today~week~quests~money~u1.today.'09a'00b'0a!!u1!!!");
    expect(raw.layouts[4].title).toBe(cleanTitle("\ta\u0000b\n"));
  });

  test("a hand written cookie is repaired by the parser, not trusted", () => {
    const back = decodeTileCookie("1!money~u7.week.Mine~u7.today.Again~nope!quests~zzz~quests!u7!(nope*)!h5000(today*)(today*)!");
    expect(back).toEqual(
      parseTileSet({
        version: 1,
        layouts: [{ id: "money" }, { id: "u7", base: "week", title: "Mine" }, { id: "u7", base: "today", title: "Again" }, { id: "nope" }],
        hidden: ["quests", "zzz", "quests"],
        current: "u7",
        slots: {
          u7: {
            compact: { tree: { kind: "leaf", tabs: ["nope"], active: "nope" }, maximized: null, lastSpot: {}, options: {} },
            regular: {
              tree: {
                kind: "split",
                dir: "h",
                ratio: 0.5,
                first: { kind: "leaf", tabs: ["today"], active: "today" },
                second: { kind: "leaf", tabs: ["today"], active: "today" },
              },
              maximized: null,
              lastSpot: {},
              options: {},
            },
          },
        },
      }),
    );
    expect(back.layouts.map((meta) => meta.id)).toEqual(["money", "u7", "today", "week", "quests"]);
  });

  test("anything malformed, oversized or of another version is the empty desk", () => {
    const good = encodeTileCookie(addLayout(EMPTY_TILE_SET, "Mine", "today", "wide")) as string;
    expect(decodeTileCookie(good)).not.toBe(EMPTY_TILE_SET);
    for (const value of [
      undefined,
      "",
      "1",
      "1!",
      "2!today~week~quests~money!!today!!!",
      "0!today~week~quests~money!!today!!!",
      "01!today~week~quests~money!!today!!!",
      "1!today~week~quests~money!!today!!",
      "1!today~week~quests~money!!today!!!!",
      "1!today~week~quests~money!!!!!",
      "1!today~~week!!today!!!",
      "1!today~week~quests~money~u1.today!!today!!!",
      "1!today~week~quests~money~u1.today.a.b!!today!!!",
      "1!today~week~quests~money~u1.today.a b!!today!!!",
      "1!today~week~quests~money~u1.today.a'2!!today!!!",
      "1!today~week~quests~money~u1.today.a'zz!!today!!!",
      "1!today~week~quests~money~u1.today.'c3!!today!!!",
      "1!today~week~quests~money~u1.today.'c0'80!!today!!!",
      "1!today~week~quests~money~u1.today.'ed'a0'80!!today!!!",
      "1!today~week~quests~money~u1.today.'f4'90'80'80!!today!!!",
      "1!today~week~quests~money~u1.today.'80!!today!!!",
      "1!Today~week~quests~money!!today!!!",
      "1!today~week~quests~money!~!today!!!",
      "1!today~week~quests~money!!to day!!!",
      "1!today~week~quests~money!!today!(today*!!",
      "1!today~week~quests~money!!today!!h5000(today*)!",
      `1!today~week~quests~money!!today!!!${"x".repeat(TILE_COOKIE_MAX)}`,
      good.replace("1!", "1 !"),
    ]) {
      expect(decodeTileCookie(value), JSON.stringify(value)).toBe(EMPTY_TILE_SET);
    }
  });

  test("markup, script and style text, __proto__ and 100 KB of noise come back as the empty desk", () => {
    const random = seeded(0x10ad);
    let noise = "";
    for (let at = 0; at < 100_000; at += 1) noise += String.fromCharCode(32 + Math.floor(random() * 95));
    for (const value of [
      "<script>alert(1)</script>",
      '"><img src=x onerror=alert(1)>',
      "1!today~week~quests~money!!today!!!<script>",
      "</style><style>body{display:none}</style>",
      "1!today~week~quests~money!!today!(today*)}body{display:none!!",
      "1!today~week~quests~money!!today!(today*);background:url(javascript:alert(1))!!",
      "expression(alert(1))",
      "1!__proto__!!__proto__!!!",
      "1!today~week~quests~money~__proto__.today.x!!today!!!",
      '{"version":1,"layouts":[],"hidden":[],"current":"today","slots":{}}',
      "1!today~week~quests~money!!constructor!(today*)_o.__proto__.x.y!!",
      noise,
      `1!${noise}`,
    ]) {
      expect(decodeTileCookie(value), value.slice(0, 80)).toBe(EMPTY_TILE_SET);
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("the words Object.prototype has, where a token may stand, are only words to the parser", () => {
    const back = decodeTileCookie("1!today~week~quests~money~constructor~prototype!constructor!constructor!!(today*)_o.constructor.prototype.x!");
    expect(back.layouts.map((meta) => meta.id)).toEqual(["today", "week", "quests", "money"]);
    expect(back.hidden).toEqual([]);
    expect(back.current).toBe("today");
    expect(back.slots).toEqual({});
    expect(Object.getPrototypeOf(back.slots)).toBe(Object.prototype);
  });
});

// ------------------------------------------------------------------ purity

describe("the codec and the cookie are pure", () => {
  const read = (name: string): string => readFileSync(path.join(ROOT, SOURCE_DIR, name), "utf8");

  test("they can be reached through the engine's one import", async () => {
    const engine = await import("@/app/lib/v2/tiles");
    expect(engine.TILE_COOKIE).toBe("mb-v2-desk");
    expect(engine.TILE_COOKIE_MAX).toBe(3800);
    for (const name of [
      "encodeArrangement",
      "decodeArrangement",
      "readArrangement",
      "encodeTileCookie",
      "decodeTileCookie",
    ] as const) {
      expect(typeof engine[name], name).toBe("function");
    }
  });

  test("touch no browser, no storage, no clock and no randomness", () => {
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
      "TextEncoder",
      "TextDecoder",
    ];
    for (const name of SOURCES) {
      const source = read(name);
      for (const token of forbidden) {
        expect(source.includes(token), `${name} contains ${token}`).toBe(false);
      }
    }
  });

  test("import nothing outside the engine's own folder", () => {
    for (const name of SOURCES) {
      const source = read(name);
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      expect(imports.length, name).toBeGreaterThan(0);
      for (const specifier of imports) expect(specifier.startsWith("./"), `${name} imports ${specifier}`).toBe(true);
    }
  });

  test("have no em dash and no en dash anywhere in them", () => {
    for (const name of [...SOURCES, "index.ts"]) {
      const source = read(name);
      expect(source.includes(EM_DASH), `${name} has an em dash`).toBe(false);
      expect(source.includes(EN_DASH), `${name} has an en dash`).toBe(false);
    }
  });
});
