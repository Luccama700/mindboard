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
  serializeTileSet,
  setCurrent,
  setHidden,
  setRatio,
  toggleMaximize,
  withArrangement,
  zoneAt,
  zoneRect,
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
import { dockTarget, type DockTarget } from "@/app/v2/_desk/use-dock-drag";
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

/** jsdom has no PointerEvent: a MouseEvent that carries a pointer's id, kind and primacy. */
class PointerStub extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly pointerType: string;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; isPrimary?: boolean; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

/** Which element holds which pointer, as setPointerCapture leaves it. */
const captured = new Map<Element, number>();

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
  captured.clear();
  Object.assign(Element.prototype, {
    setPointerCapture(this: Element, id: number) {
      captured.set(this, id);
    },
    releasePointerCapture(this: Element, id: number) {
      if (captured.get(this) !== id) return;
      captured.delete(this);
      this.dispatchEvent(new PointerStub("lostpointercapture", { pointerId: id }));
    },
    hasPointerCapture(this: Element, id: number) {
      return captured.get(this) === id;
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "matchMedia");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
    Reflect.deleteProperty(Element.prototype, name);
  }
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
    if (next !== null && changes({ type: "move", cls, pane, leafId: next, zone, layout: set.current })) out.push(dir);
  }
  for (const other of openPanes(arrangement.tree)) {
    if (other === pane) continue;
    const holder = leafOf(arrangement.tree, other);
    if (holder !== null && changes({ type: "move", cls, pane, leafId: holder.id, zone: "centre", layout: set.current })) {
      out.push(`tab:${other}`);
    }
  }
  if (leaf.tabs.length > 1) out.push("split");
  if (changes({ type: "maximize", cls, pane })) out.push("maximize");
  if (changes({ type: "close", cls, pane })) out.push("close");
  for (const meta of set.layouts) {
    if (meta.id === set.current || set.hidden.includes(meta.id)) continue;
    if (changes({ type: "sendPane", cls, pane, to: meta.id, workspace, layout: set.current })) out.push(`send:${meta.id}`);
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

  test("offers nothing on the phone, whose way to arrange the stack is its own list", () => {
    for (const pane of openPanes(arrangementOf(EMPTY_TILE_SET, "today", "compact").tree)) {
      expect(paneMenuItems(EMPTY_TILE_SET, "compact", pane, null), pane).toEqual([]);
    }
  });

  test("Move to layout is one change: closed here, opened there on the class on screen, and the desk stays here", () => {
    const set = EMPTY_TILE_SET;
    const after = applied(set, "regular", { type: "sendPane", cls: "regular", pane: "calendar", to: "money", workspace: REGULAR, layout: "today" }).set;
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
    expect(tilesReducer(state, { type: "sendPane", cls: "regular", pane: "calendar", to: "week", workspace: REGULAR, layout: "today" })).toBe(state);
    expect(tilesReducer(state, { type: "sendPane", cls: "regular", pane: "calendar", to: "nowhere", workspace: REGULAR, layout: "today" })).toBe(state);
    expect(tilesReducer(state, { type: "sendPane", cls: "regular", pane: "calendar", to: "today", workspace: REGULAR, layout: "today" })).toBe(state);
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
      // Drawn on the tiled classes the frame is displayed in, never the phone's.
      expect(frame.querySelector(".v2-frame-tools")?.getAttribute("data-in")).toBe(
        (frame.dataset.shown ?? "").split(" ").filter((cls) => cls === "regular" || cls === "wide").join(" "),
      );
    }
  });

  test("on the phone a frame has no header row and no menu: the pane's content sits where it did", () => {
    stubMedia(390);
    stubStage();
    const container = drawDesk();
    const front = arrangementOf(EMPTY_TILE_SET, "today", "compact").tree;
    const pane = front?.kind === "leaf" ? front.active : "";
    const frame = frameOf(container, pane);
    // Nothing in the header is drawn or reachable there: every control sits
    // inside something drawn for tiled classes only, and the h2 is read, not seen.
    const header = frame.querySelector(":scope > header") as HTMLElement;
    for (const control of Array.from(header.querySelectorAll<HTMLElement>("button, [tabindex]"))) {
      expect(control.closest("[data-in]")?.getAttribute("data-in")?.split(" ") ?? [], control.className).not.toContain(
        "compact",
      );
    }
    expect(header.querySelector("h2")?.className).toBe("v2-hidden");
    // The stylesheet's phone block keeps the header at nothing and draws no tools.
    const media = "(width < 1024px)";
    expect(declsIn("[data-v2-root] .v2-frame-head", media)).toEqual({ "min-height": "0", padding: "0" });
    expect(declsIn("[data-v2-root] .v2-frame-tools", null).display).toBe("none");
    SHEET.walkRules((rule) => {
      if (!rule.selectors.some((selector) => /v2-frame-(tools|menu)/.test(selector))) return;
      const block = rule.parent?.type === "atrule" ? (rule.parent as AtRule).params : null;
      if (block === null || block === "(hover: none)") return;
      expect([REGULAR_BLOCK, WIDE_BLOCK], `${rule.selector} in ${block}`).toContain(block);
    });
    // And the pane menu is not reachable on the phone.
    expect(paneMenuItems(EMPTY_TILE_SET, "compact", pane, null)).toEqual([]);
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

  test("closes when the set is replaced (another tab's write merged in): no item acts on ids held from before", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    // A first change, so this tab has written and takes other tabs' writes in.
    pick(container, "calendar", DESK_COPY.moveLeft);
    openMenu(container, "calendar");
    expect(menuOf(container, "calendar").hidden).toBe(false);
    const theirs = withArrangement(
      saved(),
      "money",
      "regular",
      closePane(arrangementOf(saved(), "money", "regular"), "hours"),
    );
    // What the other tab does: write storage, and every other tab is told.
    window.localStorage.setItem(DESK_STORAGE_KEY, serializeTileSet(theirs));
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: DESK_STORAGE_KEY,
          newValue: serializeTileSet(theirs),
          oldValue: null,
          storageArea: window.localStorage,
        }),
      );
    });
    // The merge took the other tab's Money in, and the open menu is gone.
    expect(leafOf(arrangementOf(saved(), "money", "regular").tree, "hours")).toBeNull();
    expect(menuOf(container, "calendar").hidden).toBe(true);
    expect(itemsOf(container, "calendar")).toHaveLength(0);
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

  test("a menu left open across a change of layout closes, and what it held would change nothing there", () => {
    stubMedia(1366);
    stubStage();
    const container = drawDesk();
    openMenu(container, "calendar");
    const held = paneMenuItems(EMPTY_TILE_SET, "regular", "calendar", REGULAR).find((item) => item.id === "left");
    // Back or Forward to Week while the menu is open: the calendar is drawn on
    // Week too, so only the set it was opened on can tell it is stale.
    window.history.pushState(null, "", "/v2/desk?layout=week");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const desk = saved();
    expect(desk.current).toBe("week");
    expect(leafOf(arrangementOf(desk, "week", "regular").tree, "calendar")).not.toBeNull();
    expect(menuOf(container, "calendar").hidden).toBe(true);
    expect(itemsOf(container, "calendar")).toHaveLength(0);
    // And the item it held, Today's leaf id and all, is refused on Week.
    const state: TilesState = { set: desk, cls: "regular" };
    expect(tilesReducer(state, held?.action as TilesAction)).toBe(state);
  });
});

// ============================================================ the stylesheet

const DESK_CSS = readFileSync(path.join(ROOT, "app/v2/desk.css"), "utf8");
const SHEET = postcss.parse(DESK_CSS, { from: "app/v2/desk.css" });
const REGULAR_BLOCK = "(1024px <= width < 1600px)";
const WIDE_BLOCK = "(min-width: 1600px)";

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

// ============================================================ behaviour 2: the drag

const POINTER = 3;

/** One pointer event at a client point, a mouse with its button held unless it is a release. */
function pointerAt(
  type: string,
  target: EventTarget,
  x: number,
  y: number,
  extra: MouseEventInit & { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {},
) {
  const event = new PointerStub(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
    pointerId: POINTER,
    ...extra,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const headerOf = (container: HTMLElement, pane: string) =>
  frameOf(container, pane).querySelector(":scope > header") as HTMLElement;

/** The drop overlay: on the stage only while a pane is up. */
const overlayOf = (container: HTMLElement) => stageOf(container).querySelector<HTMLElement>(":scope > .v2-dock");

/** A leaf's rectangle as the engine lays the arrangement out on the workspace the stage computes. */
function leafRect(arrangement: Arrangement, pane: string, workspace: Workspace) {
  const leaf = leafOf(arrangement.tree, pane);
  const rect = layoutTree(arrangement, workspace).leaves.find((candidate) => candidate.leafId === leaf?.id);
  if (rect === undefined) throw new Error(`${pane} is not open`);
  return rect;
}

/** A point inside a rectangle, at fractions of its width and height. */
const inside = (rect: { x: number; y: number; w: number; h: number }, fx: number, fy: number) => ({
  x: rect.x + rect.w * fx,
  y: rect.y + rect.h * fy,
});

/** Presses a pane's header at its middle and moves it past the threshold: the drag is up. */
function lift(container: HTMLElement, pane: string) {
  const header = headerOf(container, pane);
  const rect = leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), pane, REGULAR);
  const start = { x: rect.x + rect.w / 2, y: rect.y + 10 };
  pointerAt("pointerdown", header, start.x, start.y);
  pointerAt("pointermove", header, start.x + 8, start.y);
  return header;
}

const framePlays = () => plays.filter((play) => (play.frame as HTMLElement).classList.contains("v2-frame"));
const overlayPlays = () => plays.filter((play) => (play.frame as HTMLElement).classList.contains("v2-dock"));

describe("where a drop lands (behaviour 2)", () => {
  const set = EMPTY_TILE_SET;
  const arrangement = arrangementOf(set, "today", "regular");
  const calendar = leafRect(arrangement, "calendar", REGULAR);
  const tabs = leafRect(arrangement, "today", REGULAR);

  test("is the engine's zone of the leaf under the point, its part of the leaf, and the words for it", () => {
    const zones = new Set<Zone>();
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.05, 0.5],
      [0.95, 0.5],
      [0.5, 0.05],
      [0.5, 0.95],
    ]) {
      const { x, y } = inside(calendar, fx, fy);
      const target = dockTarget(set, "regular", "today", REGULAR, x, y);
      const zone = zoneAt(calendar, x, y);
      zones.add(zone);
      expect(target, `${fx} ${fy}`).toEqual({
        leafId: calendar.leafId,
        zone,
        over: "calendar",
        box: zoneRect(calendar, zone),
        words: `${TILE_COPY.zone[zone]} ${titleOf("calendar")}`,
        said:
          zone === "centre"
            ? deskLine(DESK_COPY.paneTabbed, { pane: "The day", first: "Calendar" })
            : deskLine(
                {
                  left: DESK_COPY.paneDockedLeft,
                  right: DESK_COPY.paneDockedRight,
                  top: DESK_COPY.paneDockedTop,
                  bottom: DESK_COPY.paneDockedBottom,
                }[zone],
                { pane: "The day", first: "Calendar" },
              ),
        action: { type: "move", cls: "regular", pane: "today", leafId: calendar.leafId, zone, layout: "today" },
      });
      expect(applied(set, "regular", target?.action as TilesAction).set).toEqual(
        withArrangement(set, "today", "regular", movePane(arrangement, "today", calendar.leafId, zone)),
      );
    }
    expect(zones.size).toBe(5);
  });

  test("is nothing on the pane's own leaf, in a gap, outside the workspace, or for a pane that is not open", () => {
    const own = inside(tabs, 0.5, 0.5);
    expect(dockTarget(set, "regular", "today", REGULAR, own.x, own.y)).toBeNull();
    // Its own frame's edge too, where the engine itself would split a stack:
    // a drop on its own frame is no drop.
    const edge = inside(tabs, 0.03, 0.5);
    expect(zoneAt(tabs, edge.x, edge.y)).toBe("left");
    expect(movePane(arrangement, "today", tabs.leafId, "left")).not.toBe(arrangement);
    expect(dockTarget(set, "regular", "today", REGULAR, edge.x, edge.y)).toBeNull();
    // A background tab's own leaf is its own too: a drop there changes nothing.
    expect(dockTarget(set, "regular", "status", REGULAR, own.x, own.y)).toBeNull();
    expect(dockTarget(set, "regular", "today", REGULAR, tabs.x + tabs.w + 3, 300)).toBeNull();
    expect(dockTarget(set, "regular", "today", REGULAR, REGULAR.width + 40, 300)).toBeNull();
    expect(dockTarget(set, "regular", "today", REGULAR, 300, -1)).toBeNull();
    const onCalendar = inside(calendar, 0.5, 0.5);
    expect(dockTarget(set, "regular", "lanes", REGULAR, onCalendar.x, onCalendar.y)).toBeNull();
  });

  test("under a maximize, only the pane that fills the desk can be dropped on", () => {
    const filled = withArrangement(set, "today", "regular", toggleMaximize(arrangement, "calendar"));
    // Where the stack of four would be is the calendar now.
    const where = inside(tabs, 0.5, 0.5);
    const target = dockTarget(filled, "regular", "status", REGULAR, where.x, where.y);
    expect(target?.over).toBe("calendar");
    expect(target?.box).toEqual(
      zoneRect({ x: 0, y: 0, w: REGULAR.width, h: REGULAR.height }, zoneAt({ x: 0, y: 0, w: REGULAR.width, h: REGULAR.height }, where.x, where.y)),
    );
  });
});

describe("the drag (behaviour 2)", () => {
  test("a press is a press until it travels 6px; then the pane is up, its frame dims, and the pointer is held", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const header = headerOf(container, "today");
    pointerAt("pointerdown", header, 100, 10);
    pointerAt("pointermove", header, 103, 14);
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    expect(frameOf(container, "today").hasAttribute("data-lifted")).toBe(false);
    expect(captured.has(header)).toBe(false);
    pointerAt("pointermove", header, 106, 10);
    expect(stageOf(container).getAttribute("data-dock")).toBe("today");
    expect(frameOf(container, "today").hasAttribute("data-lifted")).toBe(true);
    expect(captured.get(header)).toBe(POINTER);
    // The divider's own attribute is not this one.
    expect(stageOf(container).hasAttribute("data-drag")).toBe(false);
    expectNoRemount();
  });

  test("aims at the zone under the pointer: the overlay sits on the engine's part of the leaf, says what a release does, and fades in once per zone", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const header = lift(container, "today");
    const calendar = leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "calendar", REGULAR);
    const overlay = overlayOf(container) as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.hasAttribute("data-zone")).toBe(false);

    const middle = inside(calendar, 0.5, 0.5);
    pointerAt("pointermove", header, middle.x, middle.y);
    const centre = dockTarget(EMPTY_TILE_SET, "regular", "today", REGULAR, middle.x, middle.y) as DockTarget;
    expect(overlay.getAttribute("data-zone")).toBe("centre");
    expect(overlay.getAttribute("data-target")).toBe("calendar");
    expect(overlay.querySelector(".v2-dock-words")?.textContent).toBe(centre.words);
    expect([overlay.style.left, overlay.style.top, overlay.style.width, overlay.style.height]).toEqual(
      [centre.box.x, centre.box.y, centre.box.w, centre.box.h].map((value) => `${value}px`),
    );
    expect(overlayPlays()).toHaveLength(1);
    expect(overlayPlays()[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(overlayPlays()[0].options).toMatchObject({ duration: READ.quick, easing: READ.ease });

    // Within the same zone it stays put: no slide after the pointer, no new fade.
    const nearby = inside(calendar, 0.52, 0.48);
    pointerAt("pointermove", header, nearby.x, nearby.y);
    expect(overlayPlays()).toHaveLength(1);
    expect(overlay.style.left).toBe(`${centre.box.x}px`);

    // Another zone: it moves there by fading in again.
    const edge = inside(calendar, 0.05, 0.5);
    pointerAt("pointermove", header, edge.x, edge.y);
    const left = dockTarget(EMPTY_TILE_SET, "regular", "today", REGULAR, edge.x, edge.y) as DockTarget;
    expect(overlay.getAttribute("data-zone")).toBe("left");
    expect(overlay.querySelector(".v2-dock-words")?.textContent).toBe(left.words);
    expect(overlay.style.width).toBe(`${left.box.w}px`);
    expect(overlayPlays()).toHaveLength(2);
    expect(overlayPlays()[0].cancelled).toBe(true);

    // Its own leaf, or a gap: no overlay at all.
    pointerAt("pointermove", header, 40, 300);
    expect(overlay.hasAttribute("data-zone")).toBe(false);
  });

  test("a release on a zone is one movePane, played with the same glide; everything the drag wrote is gone, and the focus follows the pane", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const header = lift(container, "today");
    const arrangement = arrangementOf(EMPTY_TILE_SET, "today", "regular");
    const calendar = leafRect(arrangement, "calendar", REGULAR);
    const edge = inside(calendar, 0.05, 0.5);
    pointerAt("pointermove", header, edge.x, edge.y);
    const before = shownBoxes(container, "regular");
    pointerAt("pointerup", header, edge.x, edge.y);
    expect(arrangementOf(saved(), "today", "regular").tree).toEqual(
      movePane(arrangement, "today", calendar.leafId, "left").tree,
    );
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    expect(frameOf(container, "today").hasAttribute("data-lifted")).toBe(false);
    expect(overlayOf(container)).toBeNull();
    expect(captured.has(header)).toBe(false);
    // The glide: frames play from where they were, by translation, at the standard pace.
    const after = shownBoxes(container, "regular");
    expect(framePlays().length).toBeGreaterThan(0);
    for (const play of framePlays()) {
      const pane = paneOfPlay(play);
      if (!before.has(pane)) continue;
      expect(offsetOf(play.keyframes)).toEqual({
        x: (before.get(pane)?.left as number) - (after.get(pane)?.left as number),
        y: (before.get(pane)?.top as number) - (after.get(pane)?.top as number),
      });
      expect(play.options.duration).toBe(READ.std);
    }
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneDockedLeft, { pane: "The day", first: "Calendar" }));
    expect(document.activeElement).toBe(menuButtonOf(container, "today"));
    expectNoRemount();
  });

  test("Escape puts everything back with no motion, and the release after it does nothing", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    // Before it travels a press is a press: Escape is not its to take.
    const pressed = headerOf(container, "today");
    pointerAt("pointerdown", pressed, 100, 10);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(false);
    pointerAt("pointerup", pressed, 100, 10);

    const header = lift(container, "today");
    const calendar = leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "calendar", REGULAR);
    const middle = inside(calendar, 0.5, 0.5);
    pointerAt("pointermove", header, middle.x, middle.y);
    key(document.body, "Escape");
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    expect(frameOf(container, "today").hasAttribute("data-lifted")).toBe(false);
    expect(overlayOf(container)).toBeNull();
    expect(captured.has(header)).toBe(false);
    pointerAt("pointerup", header, middle.x, middle.y);
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
    expect(framePlays()).toHaveLength(0);
  });

  test("a release in a gap or outside the workspace cancels", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const tabs = leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "today", REGULAR);
    for (const [x, y] of [
      [tabs.x + tabs.w + 3, 300],
      [REGULAR.width + 50, 300],
    ]) {
      const header = lift(container, "today");
      pointerAt("pointermove", header, x, y);
      pointerAt("pointerup", header, x, y);
      expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    }
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
    expect(framePlays()).toHaveLength(0);
  });

  test("a cancelled pointer and a lost capture both cancel", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const calendar = leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "calendar", REGULAR);
    const middle = inside(calendar, 0.5, 0.5);
    for (const ending of ["pointercancel", "lostpointercapture"]) {
      const header = lift(container, "today");
      pointerAt("pointermove", header, middle.x, middle.y);
      pointerAt(ending, header, middle.x, middle.y);
      expect(stageOf(container).hasAttribute("data-dock"), ending).toBe(false);
      expect(overlayOf(container), ending).toBeNull();
      pointerAt("pointerup", header, middle.x, middle.y);
    }
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });

  test("a drag can die: the next press ends it and starts afresh, a move with no button held ends it, a modifier alone never does", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    lift(container, "today");
    // A missed release: the next press finds it, ends it without a drop, and is a press of its own.
    const calendarHeader = headerOf(container, "calendar");
    pointerAt("pointerdown", calendarHeader, 900, 10, { pointerId: 4 });
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    expect(frameOf(container, "today").hasAttribute("data-lifted")).toBe(false);
    pointerAt("pointermove", calendarHeader, 920, 10, { pointerId: 4 });
    expect(stageOf(container).getAttribute("data-dock")).toBe("calendar");
    // Modifiers on their own, and keys that do nothing, leave it be.
    for (const name of ["Shift", "Control", "Alt", "Meta", "a"]) {
      key(document.body, name);
      expect(stageOf(container).getAttribute("data-dock"), name).toBe("calendar");
    }
    // A move with no button held: the release was missed.
    pointerAt("pointermove", calendarHeader, 940, 10, { pointerId: 4, buttons: 0 });
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    // A press on something that is no handle (a pane's body) ends one too.
    lift(container, "today");
    expect(stageOf(container).hasAttribute("data-dock")).toBe(true);
    pointerAt("pointerdown", frameOf(container, "calendar").querySelector(".v2-pane-body") as Element, 900, 300, {
      pointerId: 5,
    });
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    expect(overlayOf(container)).toBeNull();
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });

  test("nothing drags on a touch pointer, with another button, or from a control in the header", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const header = headerOf(container, "today");
    const tryFrom = (target: Element, extra: Parameters<typeof pointerAt>[4] = {}) => {
      pointerAt("pointerdown", target, 100, 10, extra);
      pointerAt("pointermove", target, 140, 30, extra);
      const up = stageOf(container).hasAttribute("data-dock");
      pointerAt("pointerup", target, 140, 30, extra);
      return up;
    };
    expect(tryFrom(header, { pointerType: "touch" })).toBe(false);
    expect(tryFrom(header, { button: 2 })).toBe(false);
    expect(tryFrom(header, { isPrimary: false })).toBe(false);
    for (const selector of [".v2-frame-menu-button", ".v2-frame-max", '.v2-frame-close[data-close="status"]']) {
      expect(tryFrom(header.querySelector(selector) as Element), selector).toBe(false);
    }
    // A pen does, from the title.
    expect(tryFrom(header.querySelector(".v2-frame-name") as Element, { pointerType: "pen" })).toBe(true);
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });

  test("a tab is a handle for its own pane; a click on a tab still switches; a tab dragged and let go does not also switch", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const tab = headerOf(container, "today").querySelector('[role="tab"][data-tab="status"]') as HTMLElement;
    pointerAt("pointerdown", tab, 60, 10);
    pointerAt("pointermove", tab, 80, 10);
    expect(stageOf(container).getAttribute("data-dock")).toBe("status");
    expect(captured.get(tab)).toBe(POINTER);
    // Let go in a gap: nothing moves, and the click that follows is not a press on the tab.
    const tabs = leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "today", REGULAR);
    pointerAt("pointerup", tab, tabs.x + tabs.w + 3, 300);
    act(() => {
      fireEvent.click(tab);
    });
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
    expect(frameOf(container, "today").dataset.shown).toContain("regular");
    // A click with no travel is a click: Status comes to the front.
    pointerAt("pointerdown", tab, 60, 10);
    pointerAt("pointerup", tab, 61, 10);
    act(() => {
      fireEvent.click(tab);
    });
    expect(frameOf(container, "status").dataset.shown).toContain("regular");
  });

  test("a tab dragged, cancelled with Escape and let go a moment later over itself is not switched to", async () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const tab = headerOf(container, "today").querySelector('[role="tab"][data-tab="status"]') as HTMLElement;
    pointerAt("pointerdown", tab, 60, 10);
    pointerAt("pointermove", tab, 80, 10);
    expect(stageOf(container).getAttribute("data-dock")).toBe("status");
    key(document.body, "Escape");
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    // The button is still held: the release, and its click, come in a later task.
    await new Promise((resolve) => window.setTimeout(resolve, 5));
    pointerAt("pointerup", tab, 62, 10);
    act(() => {
      fireEvent.click(tab);
    });
    expect(frameOf(container, "today").dataset.shown).toContain("regular");
    expect(frameOf(container, "status").dataset.shown ?? "").not.toContain("regular");
    // And the next click is a click again.
    pointerAt("pointerdown", tab, 60, 10);
    pointerAt("pointerup", tab, 60, 10);
    act(() => {
      fireEvent.click(tab);
    });
    expect(frameOf(container, "status").dataset.shown).toContain("regular");
  });

  test("a double click on the header still maximizes: a press that does not travel is never a drag", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const header = headerOf(container, "calendar");
    for (let press = 0; press < 2; press += 1) {
      pointerAt("pointerdown", header, 900, 10);
      pointerAt("pointermove", header, 902, 11);
      pointerAt("pointerup", header, 902, 11);
    }
    act(() => {
      fireEvent.doubleClick(header);
    });
    expect(arrangementOf(saved(), "today", "regular").maximized).toBe("calendar");
  });

  test("its own leaf shows nothing and a release there does nothing", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const header = lift(container, "calendar");
    const own = inside(leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "calendar", REGULAR), 0.1, 0.5);
    pointerAt("pointermove", header, own.x, own.y);
    expect(overlayOf(container)?.hasAttribute("data-zone")).toBe(false);
    pointerAt("pointerup", header, own.x, own.y);
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
    // A pane of a stack on its own frame's edge, where the engine would split it off: nothing too.
    const stack = lift(container, "today");
    const edge = inside(leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "today", REGULAR), 0.03, 0.5);
    pointerAt("pointermove", stack, edge.x, edge.y);
    expect(overlayOf(container)?.hasAttribute("data-zone")).toBe(false);
    pointerAt("pointerup", stack, edge.x, edge.y);
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });

  test("belongs to its layout and class: a switch under it ends it, and nothing lands on the other layout", () => {
    const media = stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const container = drawDesk();
    const calendar = leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "calendar", REGULAR);
    const middle = inside(calendar, 0.05, 0.5);
    let header = lift(container, "today");
    pointerAt("pointermove", header, middle.x, middle.y);
    window.history.pushState(null, "", "/v2/desk?layout=week");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    expect(overlayOf(container)).toBeNull();
    const weekBefore = arrangementOf(saved(), "week", "regular");
    pointerAt("pointerup", header, middle.x, middle.y);
    expect(arrangementOf(saved(), "week", "regular")).toEqual(weekBefore);
    expect(arrangementOf(saved(), "today", "regular")).toEqual(arrangementOf(EMPTY_TILE_SET, "today", "regular"));

    // Back on Today: a change of class under a drag ends it too.
    window.history.pushState(null, "", "/v2/desk?layout=today");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    header = lift(container, "today");
    expect(stageOf(container).hasAttribute("data-dock")).toBe(true);
    media.resize(2000);
    expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
    pointerAt("pointerup", header, middle.x, middle.y);
    expect(arrangementOf(saved(), "today", "wide")).toEqual(arrangementOf(EMPTY_TILE_SET, "today", "wide"));
  });

  test("unmounting mid drag takes its attribute and its overlay off the stage, and leaves nothing listening", () => {
    stubMedia(1366);
    stubStage();
    stubBoxesAndMotion();
    const { container, unmount } = render(
      createElement(DeskClient, { data: sampleDesk(null), initial: EMPTY_TILE_SET, date: null }),
    );
    const header = lift(container, "today");
    const calendar = leafRect(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "calendar", REGULAR);
    const middle = inside(calendar, 0.5, 0.5);
    pointerAt("pointermove", header, middle.x, middle.y);
    const stage = stageOf(container);
    expect(overlayOf(container)).not.toBeNull();
    const frame = frameOf(container, "today");
    unmount();
    expect(stage.hasAttribute("data-dock")).toBe(false);
    expect(stage.querySelector(".v2-dock")).toBeNull();
    expect(frame.hasAttribute("data-lifted")).toBe(false);
    expect(captured.has(header)).toBe(false);
    // Nothing is left listening: a move and a release reach no drag.
    expect(() => {
      pointerAt("pointermove", document.body, middle.x + 20, middle.y);
      pointerAt("pointerup", document.body, middle.x + 20, middle.y);
    }).not.toThrow();
  });
});

describe("the drop overlay and the handles in the stylesheet", () => {
  test("the overlay is drawn only while a drag aims at a drop, quietly: the accent at low alpha, a hairline, the frame's radius, never in the pointer's way", () => {
    const base = declsIn("[data-v2-root] .v2-dock", null);
    expect(base.display).toBe("none");
    expect(base.position).toBe("absolute");
    expect(base["pointer-events"]).toBe("none");
    expect(base["border-radius"]).toBe(declsIn("[data-v2-root] .v2-frame", null)["border-radius"]);
    expect(base.border).toBe("1px solid var(--v2-accent)");
    expect(base.background).toMatch(/^color-mix\(in srgb, var\(--v2-accent\) \d+%, transparent\)$/);
    expect(Number(base["z-index"])).toBeGreaterThan(Number(declsIn("[data-v2-root] .v2-frame-menu-list", null)["z-index"]));
    expect(declsIn('[data-v2-root] .v2-desk-stage[data-dock] > .v2-dock[data-zone]', null).display).toBe("block");
    const words = declsIn("[data-v2-root] .v2-dock-words", null);
    expect(words["font-size"] ?? words.font).toBeDefined();
    expect(declsIn("[data-v2-root] .v2-frame[data-lifted]", null).opacity).toBeDefined();
  });

  test("the header is the handle on a fine pointer, and nothing is selected while a pane is carried", () => {
    expect(declsIn("[data-v2-root] .v2-frame-head", "(pointer: fine)").cursor).toBe("grab");
    const carried = declsIn("[data-v2-root] .v2-desk-stage[data-dock]", null);
    expect(carried["user-select"]).toBe("none");
    expect(carried.cursor).toBe("grabbing");
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
    "a hundred seeded moves, through the menu and by drag, across layouts and classes, mount every body once",
    () => {
      const media = stubMedia(1366);
      stubStage();
      stubBoxesAndMotion();
      const container = drawDesk();
      const random = seeded(11);
      const widths: Record<ScreenClass, number> = { compact: 390, regular: 1366, wide: 2000 };
      let cls: ScreenClass = "regular";
      let moves = 0;
      let drops = 0;
      for (let step = 0; step < 100; step += 1) {
        if (step % 10 === 9) {
          // Another layout, from the rail (the phone's sheet holds the same anchors).
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
        if (cls === "compact") {
          // The phone has no menu and no drag: its bar.
          const tabs = Array.from(container.querySelectorAll<HTMLElement>('.v2-desk-bar [role="tab"]'));
          act(() => {
            fireEvent.click(tabs[Math.floor(random() * tabs.length)]);
          });
          moves += 1;
          continue;
        }
        // A drag from the frame's header to a seeded point of another leaf
        // drawn now (none under a maximize), read off the desk as saved.
        const desk = saved();
        const arrangement = arrangementOf(desk, desk.current, cls);
        const own = leafOf(arrangement.tree, pane)?.id;
        const others =
          arrangement.maximized === null
            ? layoutTree(arrangement, SIZE[cls]).leaves.filter((rect) => rect.leafId !== own)
            : [];
        if (others.length > 0 && random() < 0.45) {
          const header = headerOf(container, pane);
          pointerAt("pointerdown", header, 10, 10);
          pointerAt("pointermove", header, 30, 10);
          const rect = others[Math.floor(random() * others.length)];
          const x = rect.x + rect.w * (0.03 + 0.94 * random());
          const y = rect.y + rect.h * (0.03 + 0.94 * random());
          pointerAt("pointermove", header, x, y);
          const aimed = overlayOf(container)?.getAttribute("data-zone") ?? null;
          pointerAt("pointerup", header, x, y);
          expect(stageOf(container).hasAttribute("data-dock")).toBe(false);
          expect(overlayOf(container)).toBeNull();
          if (aimed !== null) drops += 1;
          moves += 1;
          continue;
        }
        const items = openMenu(container, pane);
        if (items.length === 0) {
          key(menuOf(container, pane), "Escape");
          continue;
        }
        const item = items[Math.floor(random() * items.length)];
        act(() => {
          fireEvent.click(item);
        });
        moves += 1;
      }
      expect(moves).toBeGreaterThan(80);
      expect(drops).toBeGreaterThan(10);
      expect(plays.length).toBeGreaterThan(0);
      expectNoRemount();
    },
    90_000,
  );
});
