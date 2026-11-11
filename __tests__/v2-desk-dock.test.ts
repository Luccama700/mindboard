// PLAN-DESK Task 11: the pane menu (behaviour 1), motion (behaviours 3 and 4),
// and no remounts across a hundred moves (behaviour 5).
//
// WHAT IS NOT PINNED HERE. jsdom lays nothing out and has no Web Animations
// API. So the stage's extents and the motion tokens are stubbed as a browser
// computes them, a frame's box is a stand-in that changes whenever the frame's
// or the stage's style changes, and `flipRunner.animate` is a spy that hands
// back a fake animation. What is pinned is every decision: which frames play,
// from what offset, with what duration, delay and easing, what is cancelled
// and when, and what is skipped. How it looks is the controller's capture.
//
// EVERY BODY IS COUNTED, as in the other desk tests: a remount anywhere shows
// up as a second mount.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";

import postcss, { type AtRule, type Container, type Declaration, type Rule } from "postcss";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const counts = vi.hoisted(() => ({
  mounted: new Map<string, number>(),
  unmounted: new Map<string, number>(),
}));

vi.mock("@/app/v2/_desk/pane-registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/v2/_desk/pane-registry")>();
  const react = await import("react");
  type Props = { options: Readonly<Record<string, string>> };
  const made = new Map<string, (props: Props) => ReactElement>();
  const bump = (map: Map<string, number>, id: string) => map.set(id, (map.get(id) ?? 0) + 1);
  return {
    ...real,
    paneBody(id: string) {
      const held = made.get(id);
      if (held !== undefined) return held;
      const inner = real.paneBody(id);
      const Counted = (props: Props) => {
        react.useEffect(() => {
          bump(counts.mounted, id);
          return () => {
            bump(counts.unmounted, id);
          };
        }, []);
        return react.createElement(inner, props);
      };
      made.set(id, Counted);
      return Counted;
    },
  };
});

import { sampleDesk } from "@/app/lib/v2/fixtures/sample-desk";
import {
  BUILT_IN_LAYOUTS,
  EMPTY_TILE_SET,
  PANES,
  TILE_COPY,
  arrangementOf,
  closePane,
  layoutTree,
  leafOf,
  leavesOf,
  movePane,
  neighbourOf,
  openPane,
  openPanes,
  parseTileSet,
  setCurrent,
  setHidden,
  setRatio,
  toggleMaximize,
  withArrangement,
  type Arrangement,
  type Direction,
  type ScreenClass,
  type TileSet,
  type Workspace,
  type Zone,
} from "@/app/lib/v2/tiles";
import { DESK_COPY, deskLine } from "@/app/lib/v2/view/desk";
import { DeskClient } from "@/app/v2/_desk/desk-client";
import {
  FLIP_FALLBACK,
  flipKeyframes,
  flipRunner,
  msOf,
  planFlip,
  staggerStep,
  type FlipBox,
  type FlipTimes,
} from "@/app/v2/_desk/flip";
import { paneMenuItems, type PaneMenuItem } from "@/app/v2/_desk/pane-menu";
import type { TiledClass } from "@/app/v2/_desk/pane-frame";
import { DESK_STORAGE_KEY } from "@/app/v2/_desk/persist";
import { tilesReducer, type TilesAction, type TilesState } from "@/app/v2/_desk/use-tiles";

const ROOT = path.resolve(__dirname, "..");

// A desk render costs about half a second in jsdom, and the full suite runs
// some 150 files at once: the default 5 s is too close for a test that renders
// and presses several times.
vi.setConfig({ testTimeout: 15_000 });

const PANE_IDS = PANES.map((pane) => pane.id);
const titleOf = (pane: string) => PANES.find((spec) => spec.id === pane)?.title ?? pane;

/** The workspace each class computes on the stage, as getComputedStyle serializes a registered length. */
const WIDE: Workspace = { width: 1472, height: 700 };
const REGULAR: Workspace = { width: 1226, height: 750 };
const SIZE: Record<TiledClass, Workspace> = { regular: REGULAR, wide: WIDE };

/** The motion tokens as the stage computes them: none of them the fallback, so a read is seen. */
const TOKENS: Record<string, string> = {
  "--v2-quick": "150ms",
  "--v2-std": " 300ms",
  "--v2-slow": "0.6s",
  "--v2-ease": " cubic-bezier(0.3, 0, 0, 1)",
};
const READ: FlipTimes = { quick: 150, std: 300, slow: 600, ease: "cubic-bezier(0.3, 0, 0, 1)" };

// ------------------------------------------------------------------ the window

const REDUCE = "(prefers-reduced-motion: reduce)";

/**
 * `(min-width: Npx)` against a width the test sets, with listeners told of a
 * change, and the reduced motion query against a flag the test sets.
 */
function stubMedia(width: number) {
  const listeners = new Set<() => void>();
  const state = { width, reduce: false };
  const matchMedia = (query: string): MediaQueryList => {
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.NaN);
    return {
      media: query,
      get matches() {
        if (query === REDUCE) return state.reduce;
        return state.width >= min;
      },
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
  return {
    resize(next: number) {
      state.width = next;
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
    reduce(on: boolean) {
      state.reduce = on;
    },
  };
}

const realComputedStyle = window.getComputedStyle.bind(window);

/** The stage's two extents per class and the motion tokens, as a browser that applied the sheet computes them. */
function stubStage(tokens: Record<string, string> | null = TOKENS) {
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    const style = realComputedStyle(element, pseudo);
    if (!element.classList.contains("v2-desk-stage")) return style;
    return new Proxy(style, {
      get(target, key) {
        if (key === "getPropertyValue") {
          return (name: string) => {
            const asked = /^--v2-(regular|wide)-(w|h)$/.exec(name);
            if (asked !== null) {
              const size = SIZE[asked[1] as TiledClass];
              return `${asked[2] === "w" ? size.width : size.height}px`;
            }
            if (tokens !== null && Object.hasOwn(tokens, name)) return tokens[name];
            return target.getPropertyValue(name);
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  });
}

class ReportingObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    this.callback();
  }
  unobserve() {}
  disconnect() {}
}

// ------------------------------------------------------------ boxes and plays

/**
 * A frame's box as a browser would lay it out, stood in for: one box per
 * distinct pair of the frame's own style and the stage's, so a frame whose
 * place did not change keeps its box and one whose place changed gets another.
 */
const laidOut = new Map<string, { left: number; top: number; width: number; height: number }>();

function layoutBoxOf(frame: Element) {
  const key = `${frame.getAttribute("style")}|${frame.parentElement?.getAttribute("style")}`;
  let box = laidOut.get(key);
  if (box === undefined) {
    const n = laidOut.size;
    box = { left: 100 + 53 * n, top: 20 + 31 * n, width: 300 + n, height: 200 + n };
    laidOut.set(key, box);
  }
  return box;
}

interface FakeAnimation {
  frame: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
  cancel(): void;
}

const plays: FakeAnimation[] = [];
const live = new Map<Element, FakeAnimation>();

/** The offset a move's first keyframe starts from. */
function offsetOf(keyframes: Keyframe[]): { x: number; y: number } | null {
  const match = /^translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)$/.exec(String(keyframes[0]?.transform ?? ""));
  return match === null ? null : { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * Where a frame is DRAWN: its laid out box, moved halfway back along a move
 * that is still running, as a browser reports a box under a transform.
 */
function drawnBoxOf(frame: Element) {
  const box = layoutBoxOf(frame);
  const running = live.get(frame);
  const offset = running !== undefined && !running.cancelled ? offsetOf(running.keyframes) : null;
  if (offset === null) return box;
  return { ...box, left: box.left + offset.x / 2, top: box.top + offset.y / 2 };
}

function stubBoxesAndMotion() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = this.classList.contains("v2-frame") ? drawnBoxOf(this) : { left: 0, top: 0, width: 0, height: 0 };
    return {
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    } as DOMRect;
  });
  return vi.spyOn(flipRunner, "animate").mockImplementation((frame, keyframes, options) => {
    const fake: FakeAnimation = {
      frame,
      keyframes,
      options,
      cancelled: false,
      cancel() {
        fake.cancelled = true;
      },
    };
    plays.push(fake);
    live.set(frame, fake);
    return fake as unknown as Animation;
  });
}

beforeEach(() => {
  counts.mounted.clear();
  counts.unmounted.clear();
  laidOut.clear();
  plays.length = 0;
  live.clear();
  window.localStorage.clear();
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/v2; Max-Age=0`;
  }
  window.history.replaceState(null, "", "/v2/desk");
  vi.stubGlobal("ResizeObserver", ReportingObserver);
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "matchMedia");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// --------------------------------------------------------------- the desk

function drawDesk(initial: TileSet = EMPTY_TILE_SET) {
  return render(createElement(DeskClient, { data: sampleDesk(null), initial, date: null })).container;
}

const frameOf = (container: HTMLElement, pane: string) =>
  container.querySelector(`section.v2-frame[data-pane="${pane}"]`) as HTMLElement;

const stageOf = (container: HTMLElement) => container.querySelector(".v2-desk-stage") as HTMLElement;

const menuButtonOf = (container: HTMLElement, pane: string) =>
  frameOf(container, pane).querySelector(":scope > header .v2-frame-menu-button") as HTMLButtonElement;

const menuOf = (container: HTMLElement, pane: string) =>
  frameOf(container, pane).querySelector(':scope > header [role="menu"]') as HTMLElement;

const itemsOf = (container: HTMLElement, pane: string) =>
  Array.from(menuOf(container, pane).querySelectorAll<HTMLElement>(':scope > [role="menuitem"]'));

const spoken = (container: HTMLElement) => container.querySelector('[role="status"]')?.textContent ?? "";

const saved = (): TileSet => parseTileSet(window.localStorage.getItem(DESK_STORAGE_KEY));

function openMenu(container: HTMLElement, pane: string) {
  act(() => {
    fireEvent.click(menuButtonOf(container, pane));
  });
  return itemsOf(container, pane);
}

function pick(container: HTMLElement, pane: string, label: string) {
  const item = openMenu(container, pane).find((candidate) => candidate.textContent === label);
  if (item === undefined) throw new Error(`${pane} offers no "${label}"`);
  act(() => {
    fireEvent.click(item);
  });
}

function key(element: Element, name: string) {
  act(() => {
    fireEvent.keyDown(element, { key: name });
  });
}

function expectNoRemount() {
  for (const pane of PANE_IDS) {
    expect(counts.mounted.get(pane), pane).toBe(1);
    expect(counts.unmounted.get(pane) ?? 0, pane).toBe(0);
  }
}

// ------------------------------------------------------------ the engine's side

const DIRECTIONS: ReadonlyArray<{ dir: Direction; zone: Zone }> = [
  { dir: "left", zone: "left" },
  { dir: "right", zone: "right" },
  { dir: "up", zone: "top" },
  { dir: "down", zone: "bottom" },
];

/** What the reducer makes of an action on a desk, through the engine. */
const applied = (set: TileSet, cls: ScreenClass, action: TilesAction) => tilesReducer({ set, cls }, action);

const itemIds = (items: PaneMenuItem[]) => items.map((item) => item.id);

/**
 * Every change a drag could make to one pane, worked out from the engine alone
 * and kept only where the engine's answer differs from the desk now. This is
 * the list the menu must match, item for item.
 */
function engineCandidates(set: TileSet, cls: TiledClass, pane: string, workspace: Workspace): string[] {
  const state: TilesState = { set, cls };
  const arrangement = arrangementOf(set, set.current, cls);
  const leaf = leafOf(arrangement.tree, pane);
  if (leaf === null) return [];
  const out: string[] = [];
  const changes = (action: TilesAction) => tilesReducer(state, action) !== state;
  const rects = layoutTree({ ...arrangement, maximized: null }, workspace);
  for (const { dir, zone } of DIRECTIONS) {
    const next = neighbourOf(rects, leaf.id, dir);
    if (next !== null && changes({ type: "move", cls, pane, leafId: next, zone })) out.push(dir);
  }
  for (const other of openPanes(arrangement.tree)) {
    if (other === pane) continue;
    const holder = leafOf(arrangement.tree, other);
    if (holder !== null && changes({ type: "move", cls, pane, leafId: holder.id, zone: "centre" })) {
      out.push(`tab:${other}`);
    }
  }
  if (leaf.tabs.length > 1) out.push("split");
  if (changes({ type: "maximize", cls, pane })) out.push("maximize");
  if (changes({ type: "close", cls, pane })) out.push("close");
  for (const meta of set.layouts) {
    if (meta.id === set.current || set.hidden.includes(meta.id)) continue;
    if (changes({ type: "sendPane", cls, pane, to: meta.id, workspace })) out.push(`send:${meta.id}`);
  }
  return out;
}

// ============================================================ behaviour 1: items

describe("what the pane menu offers (behaviour 1)", () => {
  test("every change the engine would make for every open pane, on every layout and tiled class, and nothing that changes nothing", () => {
    let checked = 0;
    for (const meta of BUILT_IN_LAYOUTS) {
      const set = setCurrent(EMPTY_TILE_SET, meta.id);
      for (const cls of ["regular", "wide"] as const) {
        for (const pane of openPanes(arrangementOf(set, meta.id, cls).tree)) {
          const items = paneMenuItems(set, cls, pane, SIZE[cls]);
          expect(itemIds(items), `${meta.id} ${cls} ${pane}`).toEqual(engineCandidates(set, cls, pane, SIZE[cls]));
          for (const item of items) {
            expect(item.action, item.id).not.toBeNull();
            expect(applied(set, cls, item.action as TilesAction).set, `${pane} ${item.id}`).not.toBe(set);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("names each item in plain words, and says what happened in one sentence", () => {
    const set = EMPTY_TILE_SET;
    const items = paneMenuItems(set, "regular", "calendar", REGULAR);
    const arrangement = arrangementOf(set, "today", "regular");
    const tabs = leafOf(arrangement.tree, "today")?.id as string;
    // Regular Today is tabs(today, status, past-due, not-today) beside the calendar.
    expect(itemIds(items)).toEqual([
      "left",
      "tab:today",
      "tab:status",
      "tab:past-due",
      "tab:not-today",
      "maximize",
      "close",
      "send:quests",
      "send:money",
    ]);
    const by = (id: string) => items.find((item) => item.id === id) as PaneMenuItem;
    expect(by("left").label).toBe(DESK_COPY.moveLeft);
    expect(by("left").said).toBe(deskLine(DESK_COPY.paneMovedLeft, { pane: "Calendar" }));
    expect(by("left").action).toEqual({
      type: "move",
      cls: "regular",
      pane: "calendar",
      leafId: tabs,
      zone: "left",
      layout: "today",
    });
    // Every item carries the layout it was worked out on; its class is its own.
    for (const item of items) expect((item.action as { layout?: string }).layout, item.id).toBe(set.current);
    expect(by("tab:status").label).toBe(`${TILE_COPY.zone.centre} ${titleOf("status")}`);
    expect(by("tab:status").said).toBe(deskLine(DESK_COPY.paneTabbed, { pane: "Calendar", first: "Status" }));
    expect(by("maximize").label).toBe(DESK_COPY.maximize);
    expect(by("maximize").said).toBe(deskLine(DESK_COPY.paneMaximized, { pane: "Calendar" }));
    expect(by("close").label).toBe(DESK_COPY.close);
    expect(by("close").said).toBe(deskLine(DESK_COPY.paneClosed, { pane: "Calendar" }));
    expect(by("send:money").label).toBe(deskLine(DESK_COPY.sendTo, { layout: "Money" }));
    expect(by("send:money").said).toBe(deskLine(DESK_COPY.paneSent, { pane: "Calendar", layout: "Money" }));
    // Week already shows the calendar on this class: a move there is no move.
    expect(openPane(arrangementOf(set, "week", "regular"), "calendar", REGULAR)).toBe(
      arrangementOf(set, "week", "regular"),
    );
  });

  test("a move is movePane on that side of the neighbour the engine finds", () => {
    const set = EMPTY_TILE_SET;
    const arrangement = arrangementOf(set, "today", "regular");
    const item = paneMenuItems(set, "regular", "calendar", REGULAR).find((candidate) => candidate.id === "left");
    const next = neighbourOf(layoutTree(arrangement, REGULAR), leafOf(arrangement.tree, "calendar")?.id as string, "left");
    expect(applied(set, "regular", item?.action as TilesAction).set).toEqual(
      withArrangement(set, "today", "regular", movePane(arrangement, "calendar", next as string, "left")),
    );
  });

  test("splits a tab off along the longer side of its own leaf", () => {
    const set = EMPTY_TILE_SET;
    const arrangement = arrangementOf(set, "today", "regular");
    const leaf = leafOf(arrangement.tree, "status");
    const rect = layoutTree(arrangement, REGULAR).leaves.find((candidate) => candidate.leafId === leaf?.id);
    const zone: Zone = (rect?.w ?? 0) >= (rect?.h ?? 0) ? "right" : "bottom";
    const split = paneMenuItems(set, "regular", "status", REGULAR).find((item) => item.id === "split");
    expect(split?.label).toBe(DESK_COPY.splitOff);
    expect(split?.said).toBe(deskLine(DESK_COPY.paneSplit, { pane: "Status" }));
    expect(split?.action).toEqual({ type: "move", cls: "regular", pane: "status", leafId: leaf?.id, zone, layout: "today" });
    // A pane alone in its leaf has nothing to split off.
    expect(itemIds(paneMenuItems(set, "regular", "calendar", REGULAR))).not.toContain("split");
  });

  test("offers Restore on the pane that fills the desk, and never a layout that is hidden", () => {
    let set = EMPTY_TILE_SET;
    set = withArrangement(set, "today", "wide", toggleMaximize(arrangementOf(set, "today", "wide"), "status"));
    set = setHidden(set, "money", true);
    const items = paneMenuItems(set, "wide", "status", WIDE);
    const size = items.find((item) => item.id === "maximize");
    expect(size?.label).toBe(DESK_COPY.restore);
    expect(size?.said).toBe(deskLine(DESK_COPY.paneRestored, { pane: "Status" }));
    expect(itemIds(items)).not.toContain("send:money");
    expect(itemIds(items)).toContain("send:quests");
    // Neighbours are those of the layout as arranged, under the maximize.
    expect(itemIds(items)).toEqual(engineCandidates(set, "wide", "status", WIDE));
    expect(itemIds(items)).toContain("right");
  });

  test("without a computed workspace a tiled class offers nothing that needs a size", () => {
    const ids = itemIds(paneMenuItems(EMPTY_TILE_SET, "regular", "calendar", null));
    expect(ids).toEqual(["tab:today", "tab:status", "tab:past-due", "tab:not-today", "maximize", "close"]);
  });

  test("on the phone, only a move to another layout and the way to the list that arranges the stack", () => {
    const set = EMPTY_TILE_SET;
    const items = paneMenuItems(set, "compact", "status", null);
    const expected = BUILT_IN_LAYOUTS.filter((meta) => meta.id !== "today")
      .filter((meta) => leafOf(arrangementOf(set, meta.id, "compact").tree, "status") === null)
      .map((meta) => `send:${meta.id}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(itemIds(items)).toEqual([...expected, "arrange"]);
    const arrange = items.at(-1) as PaneMenuItem;
    expect(arrange.action).toBeNull();
    expect(arrange.label).toBe(DESK_COPY.arrangePanesName);
    // The last pane in a layout cannot leave it.
    let alone = setCurrent(set, "week");
    let compact = arrangementOf(alone, "week", "compact");
    for (const pane of openPanes(compact.tree).slice(1)) compact = closePane(compact, pane);
    alone = withArrangement(alone, "week", "compact", compact);
    const last = openPanes(compact.tree)[0];
    expect(itemIds(paneMenuItems(alone, "compact", last, null))).toEqual(["arrange"]);
  });

  test("Move to layout is one change: closed here, opened there on the class on screen, and the desk stays here", () => {
    const set = EMPTY_TILE_SET;
    const after = applied(set, "regular", { type: "sendPane", cls: "regular", pane: "calendar", to: "money", workspace: REGULAR }).set;
    expect(after.current).toBe("today");
    expect(arrangementOf(after, "today", "regular")).toEqual(closePane(arrangementOf(set, "today", "regular"), "calendar"));
    expect(arrangementOf(after, "money", "regular")).toEqual(
      openPane(arrangementOf(set, "money", "regular"), "calendar", REGULAR),
    );
    // Every other class of both layouts is untouched.
    for (const layout of ["today", "money"]) {
      for (const cls of ["compact", "wide"] as const) {
        expect(arrangementOf(after, layout, cls)).toBe(arrangementOf(set, layout, cls));
      }
    }
    // Already there, or the last pane here, or a layout the desk lacks: nothing.
    const state: TilesState = { set, cls: "regular" };
    expect(tilesReducer(state, { type: "sendPane", cls: "regular", pane: "calendar", to: "week", workspace: REGULAR })).toBe(state);
    expect(tilesReducer(state, { type: "sendPane", cls: "regular", pane: "calendar", to: "nowhere", workspace: REGULAR })).toBe(state);
    expect(tilesReducer(state, { type: "sendPane", cls: "regular", pane: "calendar", to: "today", workspace: REGULAR })).toBe(state);
  });
});

// ============================================================ behaviour 1: the menu

describe("the pane menu (behaviour 1)", () => {
  test("is one button in each frame's header tools, drawn where the frame is, its menu closed and empty", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    for (const pane of PANE_IDS) {
      const frame = frameOf(container, pane);
      const button = menuButtonOf(container, pane);
      expect(button.parentElement?.closest(".v2-frame-tools")?.parentElement?.tagName, pane).toBe("HEADER");
      expect(button.getAttribute("aria-haspopup")).toBe("menu");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-label")).toBe(deskLine(DESK_COPY.paneMenu, { pane: titleOf(pane) }));
      const menu = menuOf(container, pane);
      expect(button.getAttribute("aria-controls")).toBe(menu.id);
      expect(menu.getAttribute("aria-labelledby")).toBe(button.id);
      expect(menu.hidden).toBe(true);
      expect(menu.children).toHaveLength(0);
      // Drawn wherever the frame is displayed, the phone included.
      expect(frame.querySelector(".v2-frame-tools")?.getAttribute("data-in")).toBe(frame.dataset.shown);
      // Maximize stays a tiled control.
      expect(frame.querySelector(".v2-frame-max")?.getAttribute("data-in")).toBe(
        (frame.dataset.shown ?? "").split(" ").filter((cls) => cls !== "compact" && cls !== "").join(" "),
      );
    }
  });

  test("opens on a press with the focus on its first item; the arrows wrap, Home and End go to the ends, a letter jumps", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    const items = openMenu(container, "calendar");
    expect(menuButtonOf(container, "calendar").getAttribute("aria-expanded")).toBe("true");
    expect(menuOf(container, "calendar").hidden).toBe(false);
    expect(items.map((item) => item.textContent)).toEqual(
      paneMenuItems(EMPTY_TILE_SET, "regular", "calendar", REGULAR).map((item) => item.label),
    );
    for (const item of items) {
      expect(item.getAttribute("role")).toBe("menuitem");
      expect(item.tabIndex).toBe(-1);
    }
    expect(document.activeElement).toBe(items[0]);
    const menu = menuOf(container, "calendar");
    key(menu, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key(menu, "ArrowUp");
    key(menu, "ArrowUp");
    expect(document.activeElement).toBe(items.at(-1));
    key(menu, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    key(menu, "End");
    expect(document.activeElement).toBe(items.at(-1));
    key(menu, "Home");
    expect(document.activeElement).toBe(items[0]);
    // A letter: the next item after the focus that starts with it, wrapping;
    // a letter nothing starts with leaves the focus where it is.
    const next = (letter: string) => {
      const from = items.indexOf(document.activeElement as HTMLElement);
      for (let step = 1; step <= items.length; step += 1) {
        const item = items[(from + step) % items.length];
        if (item.textContent?.toLowerCase().startsWith(letter)) return item;
      }
      return items[from];
    };
    for (const letter of ["c", "M", "m", "m", "C"]) {
      const expected = next(letter.toLowerCase());
      key(menu, letter);
      expect(document.activeElement, letter).toBe(expected);
    }
    expect(document.activeElement?.textContent).toBe(DESK_COPY.close);
    const held = document.activeElement;
    key(menu, "z");
    expect(document.activeElement).toBe(held);
  });

  test("Escape closes it with the focus back on its button; so does Tab; a press outside closes it", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    openMenu(container, "calendar");
    key(menuOf(container, "calendar"), "Escape");
    expect(menuOf(container, "calendar").hidden).toBe(true);
    expect(document.activeElement).toBe(menuButtonOf(container, "calendar"));

    openMenu(container, "calendar");
    key(menuOf(container, "calendar"), "Tab");
    expect(menuOf(container, "calendar").hidden).toBe(true);
    expect(document.activeElement).toBe(menuButtonOf(container, "calendar"));

    openMenu(container, "calendar");
    act(() => {
      fireEvent.pointerDown(frameOf(container, "today").querySelector(".v2-pane-body") as HTMLElement);
    });
    expect(menuOf(container, "calendar").hidden).toBe(true);
    // A second press on the button closes what the first opened.
    openMenu(container, "calendar");
    act(() => {
      fireEvent.click(menuButtonOf(container, "calendar"));
    });
    expect(menuOf(container, "calendar").hidden).toBe(true);
  });

  test("ArrowDown on the button opens it on the first item, ArrowUp on the last", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    key(menuButtonOf(container, "calendar"), "ArrowDown");
    expect(document.activeElement).toBe(itemsOf(container, "calendar")[0]);
    key(menuOf(container, "calendar"), "Escape");
    key(menuButtonOf(container, "calendar"), "ArrowUp");
    expect(document.activeElement).toBe(itemsOf(container, "calendar").at(-1));
  });

  test("a move is one engine call; the focus follows the pane to its menu button and the live region says so", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    const set = EMPTY_TILE_SET;
    const expected = applied(set, "regular", paneMenuItems(set, "regular", "calendar", REGULAR)[0].action as TilesAction).set;
    pick(container, "calendar", DESK_COPY.moveLeft);
    expect(arrangementOf(saved(), "today", "regular").tree).toEqual(arrangementOf(expected, "today", "regular").tree);
    expect(menuOf(container, "calendar").hidden).toBe(true);
    expect(document.activeElement).toBe(menuButtonOf(container, "calendar"));
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneMovedLeft, { pane: "Calendar" }));

    // Made a tab of Status: in front of Status's leaf, the focus still on its button.
    pick(container, "calendar", `${TILE_COPY.zone.centre} ${titleOf("status")}`);
    const leaf = leafOf(arrangementOf(saved(), "today", "regular").tree, "calendar");
    expect(leaf?.tabs).toContain("status");
    expect(leaf?.active).toBe("calendar");
    expect(document.activeElement).toBe(menuButtonOf(container, "calendar"));
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneTabbed, { pane: "Calendar", first: "Status" }));

    // Split off again.
    pick(container, "calendar", DESK_COPY.splitOff);
    expect(leafOf(arrangementOf(saved(), "today", "regular").tree, "calendar")?.tabs).toEqual(["calendar"]);
    expect(document.activeElement).toBe(menuButtonOf(container, "calendar"));
    expectNoRemount();
  });

  test("maximize and restore from the menu", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    pick(container, "calendar", DESK_COPY.maximize);
    expect(arrangementOf(saved(), "today", "regular").maximized).toBe("calendar");
    expect(document.activeElement).toBe(menuButtonOf(container, "calendar"));
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneMaximized, { pane: "Calendar" }));
    pick(container, "calendar", DESK_COPY.restore);
    expect(arrangementOf(saved(), "today", "regular").maximized).toBeNull();
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneRestored, { pane: "Calendar" }));
  });

  test("Close and Move to layout send the focus to the menu button of the pane the engine focuses", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    pick(container, "calendar", deskLine(DESK_COPY.sendTo, { layout: "Money" }));
    const now = saved();
    expect(now.current).toBe("today");
    expect(leafOf(arrangementOf(now, "today", "regular").tree, "calendar")).toBeNull();
    expect(leafOf(arrangementOf(now, "money", "regular").tree, "calendar")).not.toBeNull();
    expect((container.querySelector(".v2-desk") as HTMLElement).dataset.layout).toBe("today");
    const focused = arrangementOf(now, "today", "regular").focus as string;
    expect(document.activeElement).toBe(menuButtonOf(container, focused));
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneSent, { pane: "Calendar", layout: "Money" }));

    pick(container, "today", DESK_COPY.close);
    const closed = arrangementOf(saved(), "today", "regular");
    expect(leafOf(closed.tree, "today")).toBeNull();
    expect(closed.focus).not.toBe("today");
    expect(document.activeElement).toBe(menuButtonOf(container, closed.focus as string));
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneClosed, { pane: "The day" }));
    expectNoRemount();
  });

  test("on the phone it moves the pane in front to another layout, and its last item opens the existing list", () => {
    stubMedia(390);
    stubStage();
    const container = drawDesk();
    const front = arrangementOf(EMPTY_TILE_SET, "today", "compact").tree;
    const pane = front?.kind === "leaf" ? front.active : "";
    const items = openMenu(container, pane);
    expect(items.map((item) => item.textContent)).toEqual(
      paneMenuItems(EMPTY_TILE_SET, "compact", pane, null).map((item) => item.label),
    );
    act(() => {
      fireEvent.click(items.at(-1) as HTMLElement);
    });
    const toggle = container.querySelector(".v2-desk-bar .v2-desk-arrange-toggle") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    expect(menuOf(container, pane).hidden).toBe(true);

    pick(container, pane, deskLine(DESK_COPY.sendTo, { layout: "Money" }));
    expect(leafOf(arrangementOf(saved(), "today", "compact").tree, pane)).toBeNull();
    expect(leafOf(arrangementOf(saved(), "money", "compact").tree, pane)).not.toBeNull();
  });

  test("a double click on the menu does not maximize the pane", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    openMenu(container, "calendar");
    act(() => {
      fireEvent.doubleClick(menuOf(container, "calendar"));
    });
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
    expect(frameOf(container, "today").hasAttribute("inert")).toBe(false);
  });
});

// ============================================================ what an action was worked out on

describe("an action carries the layout it was worked out on", () => {
  const today = arrangementOf(EMPTY_TILE_SET, "today", "wide");
  const rootOf = (arrangement: Arrangement) => {
    if (arrangement.tree?.kind !== "split") throw new Error("a split at the root");
    return arrangement.tree;
  };
  const start: TilesState = { set: EMPTY_TILE_SET, cls: "wide" };
  const ratio: TilesAction = {
    type: "ratio",
    cls: "wide",
    splitId: rootOf(today).id,
    ratio: 0.6,
    size: WIDE.width,
    layout: "today",
  };

  test("a ratio measured on one layout, dispatched after a switch, changes nothing", () => {
    // On the layout it was measured on, it is the engine's call.
    expect(tilesReducer(start, ratio)).not.toBe(start);
    // Week is on screen now, and its root split carries the same id.
    const week = tilesReducer(start, { type: "layout", id: "week" });
    expect(week.set.current).toBe("week");
    expect(rootOf(arrangementOf(week.set, "week", "wide")).id).toBe(rootOf(today).id);
    expect(tilesReducer(week, ratio)).toBe(week);
    expect(tilesReducer(week, { type: "equalize", cls: "wide", splitId: rootOf(today).id, layout: "today" })).toBe(week);
    // So is a menu's move worked out on Today, and a move to another layout.
    const tabs = leafOf(today.tree, "today")?.id as string;
    expect(
      tilesReducer(week, { type: "move", cls: "wide", pane: "calendar", leafId: tabs, zone: "left", layout: "today" }),
    ).toBe(week);
    expect(
      tilesReducer(week, { type: "sendPane", cls: "wide", pane: "calendar", to: "money", workspace: WIDE, layout: "today" }),
    ).toBe(week);
    // The same action naming Week is taken.
    expect(tilesReducer(week, { ...ratio, layout: "week" })).not.toBe(week);
  });

  test("the same ratio, after a merge brought in an equal arrangement as a new object, still applies", () => {
    // A write from another tab that draws the same is merged as the other tab's object.
    const merged = tilesReducer(start, {
      type: "replace",
      set: withArrangement(EMPTY_TILE_SET, "today", "wide", structuredClone(today)),
    });
    const held = arrangementOf(merged.set, "today", "wide");
    expect(held).not.toBe(today);
    expect(held).toEqual(today);
    const after = tilesReducer(merged, ratio);
    expect(after).not.toBe(merged);
    expect(rootOf(arrangementOf(after.set, "today", "wide")).ratio).toBe(
      rootOf(setRatio(held, rootOf(held).id, 0.6, WIDE.width)).ratio,
    );
  });

  test("a divider's change carries the arrangement it is drawn on, and lands", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    const divider = container.querySelector('.v2-divider[data-class="regular"][data-split="1"]') as HTMLElement;
    const before = arrangementOf(EMPTY_TILE_SET, "today", "regular");
    key(divider, "ArrowRight");
    const after = arrangementOf(saved(), "today", "regular");
    expect(after.tree?.kind === "split" && after.tree.ratio).not.toBe(before.tree?.kind === "split" && before.tree.ratio);
    key(divider, "Enter");
    const evened = arrangementOf(saved(), "today", "regular");
    expect(evened.tree?.kind === "split" && evened.tree.ratio).toBe(0.5);
  });

  test("a pick from a menu left open across a change of layout changes nothing", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    openMenu(container, "calendar");
    // Back or Forward to Week while the menu is open: the calendar is drawn on
    // Week too, so the menu stays, holding Today's leaf ids.
    window.history.pushState(null, "", "/v2/desk?layout=week");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect((container.querySelector(".v2-desk") as HTMLElement).dataset.layout).toBe("week");
    const items = itemsOf(container, "calendar");
    const left = items.find((item) => item.dataset.item === "left");
    expect(left).toBeDefined();
    const weekBefore = arrangementOf(saved(), "week", "regular");
    act(() => {
      fireEvent.click(left as HTMLElement);
    });
    expect(arrangementOf(saved(), "week", "regular")).toEqual(weekBefore);
    expect(arrangementOf(saved(), "today", "regular")).toEqual(arrangementOf(EMPTY_TILE_SET, "today", "regular"));
    expect(spoken(container)).not.toBe(deskLine(DESK_COPY.paneMovedLeft, { pane: "Calendar" }));
  });
});

// ============================================================ the stylesheet

const DESK_CSS = readFileSync(path.join(ROOT, "app/v2/desk.css"), "utf8");
const SHEET = postcss.parse(DESK_CSS, { from: "app/v2/desk.css" });

/** The first rule with this selector directly in the first media block of that query, or at the top level. */
function declsIn(selector: string, media: string | null): Record<string, string> {
  const parent: Container | undefined =
    media === null
      ? SHEET
      : ((SHEET.nodes ?? []).find(
          (node) => node.type === "atrule" && (node as AtRule).name === "media" && (node as AtRule).params === media,
        ) as AtRule | undefined);
  const rule = (parent?.nodes ?? []).find(
    (node): node is Rule => node.type === "rule" && (node as Rule).selectors.includes(selector),
  );
  if (rule === undefined) throw new Error(`no rule ${selector} in ${media ?? "the top level"}`);
  const out: Record<string, string> = {};
  rule.walkDecls((decl: Declaration) => {
    out[decl.prop] = decl.value;
  });
  return out;
}

describe("where the menu is drawn", () => {
  test("inside its frame: absolutely placed against the frame, under the header, held to the frame and to the window, scrolling inside", () => {
    const frame = declsIn("[data-v2-root] .v2-frame", null);
    expect(frame.position).toBe("absolute");
    expect(frame.overflow).toBe("hidden");
    const list = declsIn("[data-v2-root] .v2-frame-menu-list", null);
    expect(list.position).toBe("absolute");
    // Above anything a pane body raises: no frame is a stacking context.
    const raised: number[] = [];
    postcss.parse(readFileSync(path.join(ROOT, "app/v2/calendar.css"), "utf8")).walkDecls("z-index", (decl) => {
      raised.push(Number(decl.value));
    });
    expect(raised.length).toBeGreaterThan(0);
    expect(Number(list["z-index"])).toBeGreaterThan(Math.max(...raised));
    expect(list.right).toBe("6px");
    expect(list.top).toBe("36px");
    expect(list["max-width"]).toBe("calc(100% - 12px)");
    expect(list["max-height"]).toBe("min(calc(100% - 42px), calc(100dvh - 24px))");
    expect(list["overflow-y"]).toBe("auto");
    expect(declsIn("[data-v2-root] .v2-frame-menu-list[hidden]", null).display).toBe("none");
    // On the phone the header is the 44px row the button needs.
    const phone = declsIn("[data-v2-root] .v2-frame-menu-list", "(width < 1024px)");
    expect(phone.top).toBe("48px");
    expect(phone["max-height"]).toBe("min(calc(100% - 54px), calc(100dvh - 24px))");
  });

  test("nothing between the menu and its frame is positioned, so the frame is what it is placed against", () => {
    const between = [".v2-frame-head", ".v2-frame-tools", ".v2-frame-menu"].map((name) => `[data-v2-root] ${name}`);
    SHEET.walkRules((rule) => {
      for (const selector of rule.selectors) {
        if (!between.some((name) => selector === name || selector.startsWith(`${name}[`))) continue;
        rule.walkDecls("position", (decl) => {
          throw new Error(`${selector} is positioned: ${decl.value}`);
        });
      }
    });
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    const menu = menuOf(container, "calendar");
    const chain: string[] = [];
    for (let at = menu.parentElement; at !== null && !at.classList.contains("v2-frame"); at = at.parentElement) {
      chain.push(at.className);
    }
    expect(chain).toEqual(["v2-frame-menu", "v2-frame-tools", "v2-frame-head"]);
  });

  test("its button is quiet until the header is hovered or holds the focus, and always drawn on a touch screen or while open", () => {
    expect(declsIn("[data-v2-root] .v2-frame-menu-button", null).opacity).toBe("0");
    for (const selector of [
      "[data-v2-root] .v2-frame-head:hover .v2-frame-menu-button",
      "[data-v2-root] .v2-frame-head:focus-within .v2-frame-menu-button",
      '[data-v2-root] .v2-frame-menu-button[aria-expanded="true"]',
    ]) {
      expect(declsIn(selector, null).opacity, selector).toBe("1");
    }
    expect(declsIn("[data-v2-root] .v2-frame-menu-button", "(hover: none)").opacity).toBe("1");
    // The touch rule has the base rule's weight, so it must come after it to win.
    const at = (found: (node: postcss.ChildNode) => boolean) => (SHEET.nodes ?? []).findIndex(found);
    const base = at((node) => node.type === "rule" && node.selectors.includes("[data-v2-root] .v2-frame-menu-button"));
    const touch = at((node) => node.type === "atrule" && node.name === "media" && node.params === "(hover: none)");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(base).toBeLessThan(touch);
  });

  test("the phone draws the header's tools for the menu, never maximize", () => {
    const media = "(width < 1024px)";
    expect(declsIn('[data-v2-root] .v2-frame-tools[data-in~="compact"]', media).display).toBe("flex");
    expect(declsIn("[data-v2-root] .v2-frame-max", media).display).toBe("none");
    const button = declsIn("[data-v2-root] .v2-frame-menu-button", media);
    expect(button.width).toBe("44px");
    expect(button.height).toBe("44px");
    expect(declsIn("[data-v2-root] .v2-frame-menu-item", media)["min-height"]).toBe("44px");
  });
});

// ============================================================ behaviour 3: the plan

/** Each displayed pane's box on a workspace, as the engine lays the arrangement out. */
function boxesOf(arrangement: Arrangement, workspace: Workspace): Map<string, FlipBox> {
  const out = new Map<string, FlipBox>();
  const rects = layoutTree(arrangement, workspace);
  const maximized = arrangement.maximized === null ? null : leafOf(arrangement.tree, arrangement.maximized);
  for (const leaf of leavesOf(arrangement.tree)) {
    if (maximized !== null && leaf.id !== maximized.id) continue;
    const rect = rects.leaves.find((candidate) => candidate.leafId === leaf.id);
    if (rect === undefined) continue;
    out.set(leaf.active, { left: rect.x, top: rect.y, width: rect.w, height: rect.h, opacity: 1 });
  }
  return out;
}

describe("planning a glide (behaviour 3)", () => {
  test("a change of arrangement plays each frame that moved from its old box, over the standard duration, with no delay", () => {
    const before = arrangementOf(EMPTY_TILE_SET, "today", "wide");
    const leaf = leafOf(before.tree, "calendar")?.id as string;
    const after = movePane(before, "status", leaf, "left");
    const was = boxesOf(before, WIDE);
    const now = boxesOf(after, WIDE);
    const planned = planFlip(was, now, "arrange", READ);
    const moved = [...now.keys()].filter(
      (pane) => was.has(pane) && (was.get(pane)?.left !== now.get(pane)?.left || was.get(pane)?.top !== now.get(pane)?.top),
    );
    expect(moved.length).toBeGreaterThan(0);
    expect(planned.filter((play) => play.kind === "move").map((play) => play.pane).sort()).toEqual(moved.sort());
    for (const play of planned.filter((candidate) => candidate.kind === "move")) {
      const from = was.get(play.pane) as FlipBox;
      const to = now.get(play.pane) as FlipBox;
      expect(play.dx).toBe(from.left - to.left);
      expect(play.dy).toBe(from.top - to.top);
      expect(play.duration).toBe(READ.std);
      expect(play.delay).toBe(0);
    }
  });

  test("moves by translation alone and never scales: a frame takes its new size at once", () => {
    const keyframes = flipKeyframes({ pane: "a", kind: "move", dx: -120.5, dy: 30, opacity: 1, duration: 1, delay: 0 });
    expect(keyframes).toEqual([{ transform: "translate(-120.5px, 30px)" }, { transform: "none" }]);
    const faded = flipKeyframes({ pane: "a", kind: "appear", dx: 0, dy: 0, opacity: 0, duration: 1, delay: 0 });
    expect(faded).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    for (const frame of [...keyframes, ...faded]) {
      for (const property of Object.keys(frame)) expect(["transform", "opacity"]).toContain(property);
      expect(String(frame.transform ?? "")).not.toMatch(/scale|matrix|rotate|skew/);
    }
  });

  test("a pane that appears fades in from nothing, quickly; one that disappears plays nothing", () => {
    const was = new Map<string, FlipBox>([
      ["a", { left: 0, top: 0, width: 10, height: 10, opacity: 1 }],
      ["gone", { left: 20, top: 0, width: 10, height: 10, opacity: 1 }],
    ]);
    const now = new Map<string, FlipBox>([
      ["a", { left: 0, top: 0, width: 30, height: 10, opacity: 1 }],
      ["new", { left: 40, top: 0, width: 10, height: 10, opacity: 1 }],
    ]);
    expect(planFlip(was, now, "arrange", READ)).toEqual([
      { pane: "new", kind: "appear", dx: 0, dy: 0, opacity: 0, duration: READ.quick, delay: 0 },
    ]);
  });

  test("a change of layout: the slow duration for what travels, quick for what arrives, staggered in reading order with what travels first", () => {
    const box = (left: number, top: number): FlipBox => ({ left, top, width: 10, height: 10, opacity: 1 });
    const was = new Map([
      ["b", box(500, 500)],
      ["a", box(500, 500)],
      ["c", box(500, 500)],
    ]);
    const now = new Map([
      ["c", box(300, 0)],
      ["n2", box(0, 300)],
      ["a", box(0, 0)],
      ["n1", box(0, 0)],
      ["b", box(0, 300)],
    ]);
    const planned = planFlip(was, now, "layout", READ);
    expect(planned.map((play) => [play.pane, play.kind, play.duration, play.delay])).toEqual([
      ["a", "move", READ.slow, 0],
      ["c", "move", READ.slow, 40],
      ["b", "move", READ.slow, 80],
      ["n1", "appear", READ.quick, 120],
      ["n2", "appear", READ.quick, 160],
    ]);
  });

  test("the stagger is at most 40 ms a frame and 200 ms in all", () => {
    expect(staggerStep(0)).toBe(0);
    expect(staggerStep(1)).toBe(0);
    expect(staggerStep(6)).toBe(40);
    for (let count = 2; count <= 14; count += 1) {
      expect(staggerStep(count)).toBeLessThanOrEqual(40);
      expect(staggerStep(count) * (count - 1)).toBeLessThanOrEqual(200 + 1e-9);
    }
    expect(staggerStep(14) * 13).toBeCloseTo(200);
  });

  test("an interrupted fade goes on from the opacity it is drawn at", () => {
    const was = new Map([["a", { left: 5, top: 0, width: 10, height: 10, opacity: 0.4 }]]);
    const now = new Map([["a", { left: 5, top: 0, width: 10, height: 10, opacity: 1 }]]);
    const [play] = planFlip(was, now, "arrange", READ);
    expect(play).toMatchObject({ kind: "move", dx: 0, dy: 0, opacity: 0.4 });
    expect(flipKeyframes(play)).toEqual([
      { transform: "translate(0px, 0px)", opacity: 0.4 },
      { transform: "none", opacity: 1 },
    ]);
  });

  test("reads a duration token as milliseconds, with the fallback when it does not parse", () => {
    expect(msOf("280ms", 1)).toBe(280);
    expect(msOf(" 0.5s ", 1)).toBe(500);
    expect(msOf(".25s", 1)).toBe(250);
    expect(msOf("", 7)).toBe(7);
    expect(msOf("fast", 7)).toBe(7);
    expect(msOf("-3ms", 7)).toBe(7);
    expect(FLIP_FALLBACK).toEqual({ quick: 140, std: 280, slow: 520, ease: "cubic-bezier(0.2, 0, 0, 1)" });
  });
});

// ============================================================ behaviours 3 and 4 on the desk

/** Each displayed frame's laid out box on this class, read as the stand in reads it. */
function shownBoxes(container: HTMLElement, cls: ScreenClass) {
  const out = new Map<string, { left: number; top: number }>();
  for (const frame of Array.from(container.querySelectorAll<HTMLElement>("section.v2-frame"))) {
    if ((frame.dataset.shown ?? "").split(" ").includes(cls)) out.set(frame.dataset.pane as string, layoutBoxOf(frame));
  }
  return out;
}

const paneOfPlay = (play: FakeAnimation) => (play.frame as HTMLElement).dataset.pane as string;

describe("the glide on the desk (behaviours 3 and 4)", () => {
  test("a move from the menu plays every displayed frame that moved from its old box, with the tokens the stage computes", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const before = shownBoxes(container, "regular");
    pick(container, "calendar", DESK_COPY.moveLeft);
    const after = shownBoxes(container, "regular");
    const expected = [...after.entries()]
      .filter(([pane, box]) => before.has(pane) && (before.get(pane)?.left !== box.left || before.get(pane)?.top !== box.top))
      .map(([pane]) => pane);
    expect(expected.length).toBeGreaterThan(0);
    expect(plays.map(paneOfPlay).sort()).toEqual(expected.sort());
    for (const play of plays) {
      const pane = paneOfPlay(play);
      const from = before.get(pane) as { left: number; top: number };
      const to = after.get(pane) as { left: number; top: number };
      expect(offsetOf(play.keyframes)).toEqual({ x: from.left - to.left, y: from.top - to.top });
      expect(play.options).toEqual({ duration: READ.std, delay: 0, easing: READ.ease, fill: "backwards" });
    }
    // The animation leaves nothing on the frame, and nothing is made unpressable.
    for (const pane of PANE_IDS) {
      const frame = frameOf(container, pane);
      expect(frame.style.transform).toBe("");
      expect(frame.style.opacity).toBe("");
      expect(frame.style.pointerEvents).toBe("");
    }
    expect(frameOf(container, "calendar").hasAttribute("inert")).toBe(false);
  });

  test("a change of layout from the rail plays slowly and staggered, what arrives fading in after what travels", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const before = shownBoxes(container, "regular");
    act(() => {
      fireEvent.click(within(container.querySelector(".v2-desk-rail") as HTMLElement).getByRole("link", { name: "Week" }));
    });
    const after = shownBoxes(container, "regular");
    expect(plays.length).toBeGreaterThan(0);
    const step = staggerStep(plays.length);
    plays.forEach((play, index) => {
      const pane = paneOfPlay(play);
      expect(play.options.delay, pane).toBeCloseTo(index * step);
      expect(play.options.fill).toBe("backwards");
      if (before.has(pane)) {
        expect(play.options.duration).toBe(READ.slow);
        expect(offsetOf(play.keyframes)).toEqual({
          x: (before.get(pane)?.left as number) - (after.get(pane)?.left as number),
          y: (before.get(pane)?.top as number) - (after.get(pane)?.top as number),
        });
      } else {
        expect(play.options.duration).toBe(READ.quick);
        expect(play.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      }
    });
    const kinds = plays.map((play) => before.has(paneOfPlay(play)));
    expect(kinds).toEqual([...kinds].sort((a, b) => Number(b) - Number(a)));
    expectNoRemount();
  });

  test("a second change during the first starts each frame from where it is drawn, and cancels the first before reading where it lands", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    pick(container, "calendar", DESK_COPY.moveLeft);
    const first = [...plays];
    expect(first.length).toBeGreaterThan(0);
    const drawn = new Map(first.map((play) => [paneOfPlay(play), drawnBoxOf(play.frame)]));
    plays.length = 0;
    pick(container, "calendar", DESK_COPY.moveRight);
    for (const play of first) expect(play.cancelled, paneOfPlay(play)).toBe(true);
    const after = shownBoxes(container, "regular");
    let interrupted = 0;
    for (const play of plays) {
      const pane = paneOfPlay(play);
      const from = drawn.get(pane);
      if (from === undefined) continue;
      interrupted += 1;
      const to = after.get(pane) as { left: number; top: number };
      expect(offsetOf(play.keyframes), pane).toEqual({ x: from.left - to.left, y: from.top - to.top });
    }
    expect(interrupted).toBeGreaterThan(0);
  });

  test("nothing plays under reduced motion, asked at the moment of each change", () => {
    const media = stubMedia(1366);
    stubStage();
    const animate = stubBoxesAndMotion();
    const container = drawDesk();
    media.reduce(true);
    pick(container, "calendar", DESK_COPY.moveLeft);
    expect(leafOf(arrangementOf(saved(), "today", "regular").tree, "calendar")).not.toBeNull();
    expect(animate).not.toHaveBeenCalled();
    media.reduce(false);
    pick(container, "calendar", DESK_COPY.moveRight);
    expect(animate).toHaveBeenCalled();
  });

  test("nothing plays on the first paint, on a change of class, while a divider is dragged, or for a divider's ratio", () => {
    const media = stubMedia(1366);
    stubStage();
    const animate = stubBoxesAndMotion();
    const container = drawDesk();
    expect(animate).not.toHaveBeenCalled();
    media.resize(2000);
    media.resize(1366);
    expect(animate).not.toHaveBeenCalled();

    const stage = stageOf(container);
    stage.setAttribute("data-drag", "h");
    pick(container, "calendar", DESK_COPY.moveLeft);
    expect(leafOf(arrangementOf(saved(), "today", "regular").tree, "calendar")).not.toBeNull();
    expect(animate).not.toHaveBeenCalled();
    stage.removeAttribute("data-drag");

    const divider = container.querySelector('.v2-divider[data-class="regular"][data-split="1"]') as HTMLElement;
    key(divider, "ArrowRight");
    key(divider, "Enter");
    expect(animate).not.toHaveBeenCalled();
  });

  test("a tab brought to the front fades in, quickly", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    act(() => {
      fireEvent.click(frameOf(container, "today").querySelector('[role="tab"][data-tab="status"]') as HTMLElement);
    });
    expect(plays.map(paneOfPlay)).toEqual(["status"]);
    expect(plays[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(plays[0].options).toMatchObject({ duration: READ.quick, delay: 0 });
  });

  test("falls back to its own numbers when the tokens cannot be read", () => {
    stubMedia(1366);
    stubStage(null);
    stubBoxesAndMotion();
    const container = drawDesk();
    pick(container, "calendar", DESK_COPY.moveLeft);
    expect(plays.length).toBeGreaterThan(0);
    for (const play of plays) {
      expect(play.options).toMatchObject({ duration: FLIP_FALLBACK.std, easing: FLIP_FALLBACK.ease });
    }
  });
});

// ============================================================ behaviour 5

/** A small seeded generator, so a failing run can be replayed. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("no remounts (behaviour 5)", () => {
  test(
    "a hundred seeded moves through the menu, across layouts and classes, mount every body once",
    () => {
      const media = stubMedia(1366);
      stubStage();
      stubBoxesAndMotion();
      const container = drawDesk();
      const random = seeded(11);
      const widths: Record<ScreenClass, number> = { compact: 390, regular: 1366, wide: 2000 };
      let cls: ScreenClass = "regular";
      let moves = 0;
      for (let step = 0; step < 100; step += 1) {
        if (step % 17 === 16) {
          const classes: ScreenClass[] = ["regular", "wide", "compact"];
          cls = classes[Math.floor(random() * classes.length)];
          media.resize(widths[cls]);
        }
        const shown = Array.from(container.querySelectorAll<HTMLElement>("section.v2-frame")).filter((frame) =>
          (frame.dataset.shown ?? "").split(" ").includes(cls),
        );
        const frame = shown[Math.floor(random() * shown.length)];
        const pane = frame.dataset.pane as string;
        const items = openMenu(container, pane).filter((item) => item.dataset.item !== "arrange");
        if (items.length === 0) {
          key(menuOf(container, pane), "Escape");
          continue;
        }
        const item = items[Math.floor(random() * items.length)];
        act(() => {
          fireEvent.click(item);
        });
        moves += 1;
        if (step % 10 === 9) {
          const layouts = BUILT_IN_LAYOUTS.map((meta) => meta.title);
          const link = within(container.querySelector(cls === "compact" ? ".v2-desk-menu" : ".v2-desk-rail") as HTMLElement)
            .getAllByRole("link", { hidden: true })
            .find((anchor) => anchor.textContent?.startsWith(layouts[Math.floor(random() * layouts.length)]));
          if (link !== undefined) {
            act(() => {
              fireEvent.click(link);
            });
          }
        }
      }
      expect(moves).toBeGreaterThan(80);
      expect(plays.length).toBeGreaterThan(0);
      expectNoRemount();
    },
    90_000,
  );
});
