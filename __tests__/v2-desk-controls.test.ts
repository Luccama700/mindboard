// PLAN-DESK Task 10, parts A and B: the desk starts to move, and keeps what it
// was given. A divider that drags and takes keys (behaviour 1), tabs (2), close
// and reopen from the rail (3), maximize (4), saving and loading (7), focus and
// the announcer (8), tab order (9), a reload painted from the cookie (10), and
// the review of Task 9 folded in.
//
// WHAT IS NOT PINNED HERE. jsdom lays nothing out and computes no registered
// property, so the stage's extents are stubbed as the browser serializes them
// ("1472px"), the pointer is a MouseEvent with a pointer id, and where a frame
// lands is the controller's capture. Every expected value below is the
// engine's own answer for the same input, never a number worked out here.
//
// EVERY BODY IS COUNTED, as in v2-desk-workspace.test.ts: a remount anywhere
// shows up as a second mount.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Profiler, createElement, type ComponentType, type ReactElement } from "react";
import type { Root } from "react-dom/client";

import postcss, { type AtRule, type Container, type Declaration, type Rule } from "postcss";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const counts = vi.hoisted(() => ({
  mounted: new Map<string, number>(),
  unmounted: new Map<string, number>(),
}));

// The request the page is rendered for: its host, and the desk's cookie.
const request = vi.hoisted(() => ({ host: "127.0.0.1:3111", cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? request.host : null),
    }),
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "mb-v2-desk" && request.cookie !== undefined ? { name, value: request.cookie } : undefined,
    }),
}));

// A desk too large for the cookie cannot be built from the engine (its worst
// case fits), so the encoder is made to answer null on demand.
const cookieJam = vi.hoisted(() => ({ full: false }));
vi.mock("@/app/lib/v2/tiles/cookie", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/lib/v2/tiles/cookie")>();
  return {
    ...real,
    encodeTileCookie: (set: Parameters<typeof real.encodeTileCookie>[0]) =>
      cookieJam.full ? null : real.encodeTileCookie(set),
  };
});

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
  EMPTY_TILE_SET,
  PANES,
  TILE_COOKIE,
  arrangementOf,
  closePane,
  decodeTileCookie,
  drawnShare,
  encodeArrangement,
  encodeTileCookie,
  equalize,
  isChanged,
  layoutTree,
  leafOf,
  normalizeRatio,
  openPane,
  parseTileSet,
  ratioText,
  serializeTileSet,
  setCurrent,
  setRatio,
  shareLimits,
  toggleMaximize,
  withArrangement,
  type Arrangement,
  type ScreenClass,
  type Split,
  type TileNode,
  type TileSet,
  type Workspace,
} from "@/app/lib/v2/tiles";
import { DESK_COPY, deskLine } from "@/app/lib/v2/view/desk";
import { DeskClient } from "@/app/v2/_desk/desk-client";
import { splitNode } from "@/app/v2/_desk/divider";
import { PaneBox } from "@/app/v2/_desk/pane-box";
import { frameId, type TiledClass } from "@/app/v2/_desk/pane-frame";
import {
  DESK_COOKIE_AGE,
  DESK_STORAGE_KEY,
  cookieValue,
  deskCookie,
  mergeSaved,
  saveStep,
} from "@/app/v2/_desk/persist";
import { deskHref, tilesReducer, type TilesState } from "@/app/v2/_desk/use-tiles";
import DeskPage from "@/app/v2/desk/page";

const ROOT = path.resolve(__dirname, "..");
const PANE_IDS = PANES.map((pane) => pane.id);
const titleOf = (pane: string) => PANES.find((spec) => spec.id === pane)?.title ?? pane;

// ------------------------------------------------------------------ the window

/** `(min-width: Npx)` against a width the test sets, with listeners told of a change. */
function stubMedia(width: number, onRead?: () => void) {
  const listeners = new Set<() => void>();
  const state = { width };
  const matchMedia = (query: string): MediaQueryList => {
    onRead?.();
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.NaN);
    return {
      media: query,
      get matches() {
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
  };
}

/** The workspace each class computes on the stage, as getComputedStyle serializes a registered length. */
const WIDE: Workspace = { width: 1472, height: 700 };
const REGULAR: Workspace = { width: 1226, height: 750 };

const realComputedStyle = window.getComputedStyle.bind(window);

/**
 * The stage's two extent properties per class, as a browser that applied the
 * registration computes them. null: as a browser that has not (the declared
 * text comes back, which `workspaceFromComputed` refuses).
 */
function stubExtents(sizes: Partial<Record<TiledClass, Workspace>> | null) {
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    const style = realComputedStyle(element, pseudo);
    if (!element.classList.contains("v2-desk-stage")) return style;
    return new Proxy(style, {
      get(target, key) {
        if (key === "getPropertyValue") {
          return (name: string) => {
            const asked = /^--v2-(regular|wide)-(w|h)$/.exec(name);
            if (asked === null) return target.getPropertyValue(name);
            const size = sizes?.[asked[1] as TiledClass];
            if (size === undefined) return "round(down, 100cqw, 1px)";
            return `${asked[2] === "w" ? size.width : size.height}px`;
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  });
}

/** A ResizeObserver that reports once, as a browser does when it starts observing. */
class ReportingObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    this.callback();
  }
  unobserve() {}
  disconnect() {}
}

/** jsdom has no PointerEvent: a MouseEvent that carries a pointer's id and kind. */
class PointerStub extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; isPrimary?: boolean } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
    this.pointerType = "mouse";
  }
}

const captured = new Map<Element, number>();

beforeEach(() => {
  counts.mounted.clear();
  counts.unmounted.clear();
  request.host = "127.0.0.1:3111";
  request.cookie = undefined;
  cookieJam.full = false;
  window.localStorage.clear();
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/v2; Max-Age=0`;
  }
  window.history.replaceState(null, "", "/v2/desk");
  vi.stubGlobal("ResizeObserver", ReportingObserver);
  if (typeof window.PointerEvent === "undefined") vi.stubGlobal("PointerEvent", PointerStub);
  captured.clear();
  Object.assign(Element.prototype, {
    setPointerCapture(this: Element, id: number) {
      captured.set(this, id);
    },
    releasePointerCapture(this: Element) {
      captured.delete(this);
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
  vi.unstubAllEnvs();
  for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
    Reflect.deleteProperty(Element.prototype, name);
  }
});

function pointer(type: string, element: Element, init: MouseEventInit & { pointerId?: number }) {
  const event = new PointerStub(type, { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

// --------------------------------------------------------------- the desk

interface Drawn {
  container: HTMLElement;
  commits: { count: number };
}

function drawDesk(initial: TileSet = EMPTY_TILE_SET, extra: { date?: string | null; week?: string | null; home?: string } = {}): Drawn {
  const commits = { count: 0 };
  const element = createElement(
    Profiler,
    { id: "desk", onRender: () => (commits.count += 1) },
    createElement(DeskClient, {
      data: sampleDesk(null),
      initial,
      date: extra.date ?? null,
      week: extra.week ?? null,
      home: extra.home,
    }),
  );
  const { container } = render(element);
  return { container, commits };
}

const frameOf = (container: HTMLElement, pane: string) =>
  container.querySelector(`section.v2-frame[data-pane="${pane}"]`) as HTMLElement;

const stageOf = (container: HTMLElement) => container.querySelector(".v2-desk-stage") as HTMLElement;

const dividerOf = (container: HTMLElement, cls: TiledClass, index: number) =>
  container.querySelector(`.v2-divider[data-class="${cls}"][data-split="${index}"]`) as HTMLElement;

const spoken = (container: HTMLElement) => container.querySelector('[role="status"]')?.textContent ?? "";

const railPane = (container: HTMLElement, pane: string) =>
  container.querySelector(`.v2-desk-rail .v2-desk-pane[data-pane="${pane}"] button`) as HTMLButtonElement;

/** The set the desk last saved, read back the way a load reads it. */
const saved = (): TileSet => parseTileSet(window.localStorage.getItem(DESK_STORAGE_KEY));

function expectNoRemount() {
  for (const pane of PANE_IDS) {
    expect(counts.mounted.get(pane), pane).toBe(1);
    expect(counts.unmounted.get(pane) ?? 0, pane).toBe(0);
  }
}

/** One split's geometry as the engine gives it on a workspace. */
function engineSplit(arrangement: Arrangement, splitId: string, workspace: Workspace) {
  const split = splitNode(arrangement.tree, splitId) as Split;
  const rect = layoutTree(arrangement, workspace).dividers.find((d) => d.splitId === splitId);
  if (rect === undefined) throw new Error(`no divider ${splitId}`);
  const [low, high] = shareLimits(split, rect.size);
  return { split, rect, low, high, now: drawnShare(split, rect.size) };
}

/** The split a divider of this pre-order index commits to, read off the tree. */
function splitAt(tree: TileNode | null, index: number): Split {
  const order: Split[] = [];
  const walk = (node: TileNode | null) => {
    if (node === null || node.kind === "leaf") return;
    order.push(node);
    walk(node.first);
    walk(node.second);
  };
  walk(tree);
  return order[index - 1];
}

// ============================================================ behaviour 1

describe("a divider (behaviour 1)", () => {
  test("is a focusable separator with its orientation, its name and the three values from shareLimits", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const arrangement = arrangementOf(EMPTY_TILE_SET, "today", "wide");
    const root = dividerOf(container, "wide", 1);
    const { low, high, now, split } = engineSplit(arrangement, splitAt(arrangement.tree, 1).id, WIDE);
    expect(root.getAttribute("role")).toBe("separator");
    expect(root.getAttribute("aria-orientation")).toBe(split.dir === "h" ? "vertical" : "horizontal");
    expect(root.tabIndex).toBe(0);
    expect(Number(root.getAttribute("aria-valuenow"))).toBe(Math.round(now * 100));
    expect(Number(root.getAttribute("aria-valuemin"))).toBe(Math.round(low * 100));
    expect(Number(root.getAttribute("aria-valuemax"))).toBe(Math.round(high * 100));
    expect(root.getAttribute("aria-label")).toBe(
      deskLine(DESK_COPY.divider, { first: titleOf("today"), second: titleOf("calendar") }),
    );
    // A stacked split is a horizontal separator.
    expect(splitAt(arrangement.tree, 3).dir).toBe("v");
    const stacked = dividerOf(container, "wide", 3);
    expect(stacked.getAttribute("aria-orientation")).toBe("horizontal");
    // The other class's dividers cannot be reached.
    expect(dividerOf(container, "regular", 1).hasAttribute("inert")).toBe(true);
  });

  test("moves by 2 percent of the split on an arrow key, 10 with Shift, to the limits on Home and End, and evens on Enter", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const stage = stageOf(container);
    const root = dividerOf(container, "wide", 1);
    const id = splitAt(arrangementOf(EMPTY_TILE_SET, "today", "wide").tree, 1).id;
    let expected = arrangementOf(EMPTY_TILE_SET, "today", "wide");
    const press = (key: string, shiftKey = false) => {
      const before = engineSplit(expected, id, WIDE);
      act(() => {
        fireEvent.keyDown(root, { key, shiftKey });
      });
      return before;
    };
    const held = () => stage.style.getPropertyValue("--v2-wide-r1");

    let before = press("ArrowRight");
    expected = setRatio(expected, id, before.now + 0.02, before.rect.size);
    expect(held()).toBe(ratioText((splitNode(expected.tree, id) as Split).ratio));
    expect(held()).toBe("0.52");

    before = press("ArrowLeft", true);
    expected = setRatio(expected, id, before.now - 0.1, before.rect.size);
    expect(held()).toBe(ratioText((splitNode(expected.tree, id) as Split).ratio));

    before = press("Home");
    expected = setRatio(expected, id, before.low, before.rect.size);
    expect(held()).toBe(ratioText(normalizeRatio(before.low)));

    before = press("End");
    expected = setRatio(expected, id, before.high, before.rect.size);
    expect(held()).toBe(ratioText(normalizeRatio(before.high)));

    press("Enter");
    expected = equalize(expected, id);
    expect(held()).toBe("0.5");

    // Alt is not bound, and neither is the other axis.
    act(() => {
      fireEvent.keyDown(root, { key: "ArrowRight", altKey: true });
      fireEvent.keyDown(root, { key: "ArrowDown" });
    });
    expect(held()).toBe("0.5");
  });

  test("a stacked divider moves on Up and Down", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const stacked = dividerOf(container, "wide", 3);
    const arrangement = arrangementOf(EMPTY_TILE_SET, "today", "wide");
    const split = splitAt(arrangement.tree, 3);
    expect(split.dir).toBe("v");
    const { now, rect } = engineSplit(arrangement, split.id, WIDE);
    act(() => {
      fireEvent.keyDown(stacked, { key: "ArrowDown" });
    });
    const after = setRatio(arrangement, split.id, now + 0.02, rect.size);
    expect(stageOf(container).style.getPropertyValue("--v2-wide-r3")).toBe(
      ratioText((splitNode(after.tree, split.id) as Split).ratio),
    );
  });

  test("drags on the stage with no render, commits once on release, and takes the pointer", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container, commits } = drawDesk();
    const stage = stageOf(container);
    const root = dividerOf(container, "wide", 1);
    const arrangement = arrangementOf(EMPTY_TILE_SET, "today", "wide");
    const id = splitAt(arrangement.tree, 1).id;
    const { rect, low, high } = engineSplit(arrangement, id, WIDE);

    pointer("pointerdown", root, { clientX: rect.x + 3, pointerId: 7 });
    expect(captured.get(root)).toBe(7);
    expect(document.activeElement).toBe(root);
    const before = commits.count;

    pointer("pointermove", root, { clientX: rect.x + 3 + 100, pointerId: 7 });
    const raw = (rect.x + 100 - rect.start) / (rect.size - 6);
    expect(stage.style.getPropertyValue("--v2-wide-r1")).toBe(
      ratioText(normalizeRatio(Math.min(high, Math.max(low, raw)))),
    );
    // Held to the engine's limits, past the far one.
    pointer("pointermove", root, { clientX: 1460, pointerId: 7 });
    expect(stage.style.getPropertyValue("--v2-wide-r1")).toBe(ratioText(normalizeRatio(high)));
    pointer("pointermove", root, { clientX: rect.x + 3 + 100, pointerId: 7 });
    expect(commits.count).toBe(before);

    pointer("pointerup", root, { clientX: rect.x + 3 + 100, pointerId: 7 });
    const committed = setRatio(arrangement, id, raw, rect.size);
    const stored = (splitNode(committed.tree, id) as Split).ratio;
    expect(stage.style.getPropertyValue("--v2-wide-r1")).toBe(ratioText(stored));
    expect(captured.has(root)).toBe(false);
    expect(stage.hasAttribute("data-drag")).toBe(false);
    // Kept: the saved desk holds the ratio the engine stored.
    const kept = splitAt(arrangementOf(saved(), "today", "wide").tree, 1);
    expect(kept.ratio).toBe(stored);
    expectNoRemount();
  });

  test("writes the stored ratio back when a drag is cancelled: Escape, a cancelled pointer, a lost capture", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const stage = stageOf(container);
    const root = dividerOf(container, "wide", 1);
    const { rect } = engineSplit(arrangementOf(EMPTY_TILE_SET, "today", "wide"), "s1", WIDE);
    const held = () => stage.style.getPropertyValue("--v2-wide-r1");

    for (const end of ["escape", "pointercancel", "lostpointercapture"] as const) {
      pointer("pointerdown", root, { clientX: rect.x + 2, pointerId: 3 });
      pointer("pointermove", root, { clientX: rect.x + 182, pointerId: 3 });
      expect(held(), end).not.toBe("0.5");
      if (end === "escape") {
        act(() => {
          fireEvent.keyDown(root, { key: "Escape" });
        });
      } else {
        pointer(end, root, { pointerId: 3 });
      }
      expect(held(), end).toBe("0.5");
      // A move after the drag ended does nothing.
      pointer("pointermove", root, { clientX: rect.x + 300, pointerId: 3 });
      expect(held(), end).toBe("0.5");
    }
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });

  test("a press and release that does not move commits nothing", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const root = dividerOf(container, "wide", 1);
    const { rect } = engineSplit(arrangementOf(EMPTY_TILE_SET, "today", "wide"), "s1", WIDE);
    pointer("pointerdown", root, { clientX: rect.x + 1 });
    pointer("pointerup", root, { clientX: rect.x + 1 });
    expect(stageOf(container).style.getPropertyValue("--v2-wide-r1")).toBe("0.5");
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });

  test("evens both sides on a double click", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const week = setCurrent(EMPTY_TILE_SET, "week");
    const { container } = drawDesk(week);
    const root = dividerOf(container, "wide", 1);
    expect(stageOf(container).style.getPropertyValue("--v2-wide-r1")).toBe("0.29");
    act(() => {
      fireEvent.doubleClick(root);
    });
    expect(stageOf(container).style.getPropertyValue("--v2-wide-r1")).toBe("0.5");
  });

  test("does nothing when the stage has not computed its extents: no size is measured in script", () => {
    stubMedia(2000);
    stubExtents(null);
    const { container } = drawDesk();
    const root = dividerOf(container, "wide", 1);
    // The workspace's own rectangle says something else entirely; it is never read.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, left: 0, top: 0, width: 1500.7, height: 701.3, right: 1500.7, bottom: 701.3, toJSON: () => ({}) },
    );
    act(() => {
      fireEvent.keyDown(root, { key: "ArrowRight" });
      fireEvent.keyDown(root, { key: "Enter" });
    });
    pointer("pointerdown", root, { clientX: 735 });
    pointer("pointermove", root, { clientX: 900 });
    pointer("pointerup", root, { clientX: 900 });
    expect(stageOf(container).style.getPropertyValue("--v2-wide-r1")).toBe("0.5");
    // Before anything is computed the separator still has values: the engine's range.
    expect(root.getAttribute("aria-valuemin")).toBe("5");
    expect(root.getAttribute("aria-valuemax")).toBe("95");
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });
});

// ============================================================ behaviour 2

describe("tabs (behaviour 2)", () => {
  test("a click brings a tab to the front on the class on screen, and the focus follows it to its own frame", () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const strip = frameOf(container, "today").querySelector('[role="tablist"]') as HTMLElement;
    const status = within(strip).getByRole("tab", { name: "Status" });
    expect(status.tagName).toBe("BUTTON");
    status.focus();
    act(() => {
      fireEvent.click(status);
    });
    expect(frameOf(container, "status").getAttribute("data-shown")).toContain("regular");
    expect(frameOf(container, "today").hasAttribute("inert")).toBe(true);
    // The strip now sits over Status, and the focus is on its tab there.
    const moved = frameOf(container, "status").querySelector('[role="tablist"][data-in~="regular"]') as HTMLElement;
    const front = within(moved).getByRole("tab", { name: "Status" });
    expect(front.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(front);
    // Only regular changed.
    expect(arrangementOf(saved(), "today", "wide")).toBe(arrangementOf(EMPTY_TILE_SET, "today", "wide"));
    expectNoRemount();
  });

  test("the arrow keys, Home and End move along the strip without choosing; Alt is not bound", () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const strip = frameOf(container, "today").querySelector('[role="tablist"]') as HTMLElement;
    const tab = (name: string) => within(strip).getByRole("tab", { name });
    tab("Day").focus();
    act(() => {
      fireEvent.keyDown(tab("Day"), { key: "ArrowRight" });
    });
    expect(document.activeElement).toBe(tab("Status"));
    expect(tab("Day").getAttribute("aria-selected")).toBe("true");
    act(() => {
      fireEvent.keyDown(tab("Status"), { key: "End" });
    });
    expect(document.activeElement).toBe(tab("Did not fit"));
    act(() => {
      fireEvent.keyDown(tab("Did not fit"), { key: "ArrowRight" });
    });
    expect(document.activeElement).toBe(tab("Day"));
    act(() => {
      fireEvent.keyDown(tab("Day"), { key: "ArrowLeft", altKey: true });
    });
    expect(document.activeElement).toBe(tab("Day"));
    act(() => {
      fireEvent.keyDown(tab("Day"), { key: "Home" });
    });
    expect(document.activeElement).toBe(tab("Day"));
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });

  test("each tab has a close control; closing one says so and leaves the focus on the tab in front", () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const strip = frameOf(container, "today").querySelector('[role="tablist"]') as HTMLElement;
    const closes = Array.from(strip.querySelectorAll<HTMLButtonElement>(".v2-frame-close"));
    expect(closes.map((button) => button.getAttribute("aria-label"))).toEqual(
      ["today", "status", "past-due", "not-today"].map((pane) =>
        deskLine(DESK_COPY.closePane, { pane: titleOf(pane) }),
      ),
    );
    // The close control is beside the tab, never inside it.
    expect(strip.querySelector('[role="tab"] button')).toBeNull();
    const status = closes[1];
    status.focus();
    act(() => {
      fireEvent.click(status);
    });
    const after = arrangementOf(saved(), "today", "regular");
    expect(after).toEqual(closePane(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "status"));
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneClosed, { pane: titleOf("status") }));
    const front = within(strip).getByRole("tab", { name: "Day" });
    expect(document.activeElement).toBe(front);
    expect(within(strip).queryByRole("tab", { name: "Status" })).toBeNull();
    expectNoRemount();
  });

  test("Delete on a tab closes that pane", () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const strip = frameOf(container, "today").querySelector('[role="tablist"]') as HTMLElement;
    const past = within(strip).getByRole("tab", { name: "Past" });
    past.focus();
    act(() => {
      fireEvent.keyDown(past, { key: "Delete" });
    });
    expect(leafOf(arrangementOf(saved(), "today", "regular").tree, "past-due")).toBeNull();
  });

  test("a pane alone has its close control by its title, and the last pane open has none", () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    let set = EMPTY_TILE_SET;
    for (const pane of ["status", "past-due", "not-today"]) {
      set = withArrangement(set, "today", "regular", closePane(arrangementOf(set, "today", "regular"), pane));
    }
    const { container } = drawDesk(set);
    const solo = () => frameOf(container, "calendar").querySelector<HTMLButtonElement>(".v2-frame-solo");
    expect(solo()?.getAttribute("data-in")).toBe("regular wide");
    expect(frameOf(container, "today").querySelector(".v2-frame-solo")?.getAttribute("data-in")).toBe(
      "regular wide",
    );
    act(() => {
      fireEvent.click(solo() as HTMLButtonElement);
    });
    // Today is the last pane open on regular: its close is gone on regular, kept on wide.
    expect(frameOf(container, "today").querySelector(".v2-frame-solo")?.getAttribute("data-in")).toBe("wide");
    expect(document.activeElement).toBe(frameOf(container, "today").querySelector(".v2-pane-body"));
  });
});

// ============================================================ behaviour 3

describe("close and reopen from the rail (behaviour 3)", () => {
  test("marks what is open, opens a closed pane where it was, and keeps the focus on the rail", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const past = frameOf(container, "past-due");
    const close = past.querySelector<HTMLButtonElement>(".v2-frame-solo") as HTMLButtonElement;
    act(() => {
      fireEvent.click(close);
    });
    expect(
      (container.querySelector('.v2-desk-pane[data-pane="past-due"]') as HTMLElement).dataset.open,
    ).toBe("compact regular");
    const button = railPane(container, "past-due");
    button.focus();
    act(() => {
      fireEvent.click(button);
    });
    const reopened = arrangementOf(saved(), "today", "wide");
    // Back above Did not fit, at the share it had: the layout is its default again.
    expect(isChanged(saved(), "today", "wide")).toBe(false);
    expect(encodeArrangement(reopened)).toBe(encodeArrangement(arrangementOf(EMPTY_TILE_SET, "today", "wide")));
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneOpened, { pane: titleOf("past-due") }));
    expect(document.activeElement).toBe(button);
    expect(frameOf(container, "past-due")).toBe(past);
    expectNoRemount();
  });

  test("opens a pane that was never there beside the largest leaf, on the workspace the stage computed", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    act(() => {
      fireEvent.click(railPane(container, "ledger"));
    });
    const expected = openPane(arrangementOf(EMPTY_TILE_SET, "today", "wide"), "ledger", WIDE);
    expect(encodeArrangement(arrangementOf(saved(), "today", "wide"))).toBe(encodeArrangement(expected));
    // The minimum follows the tree on screen, with its one pixel of slack.
    const work = container.querySelector(".v2-desk-work") as HTMLElement;
    expect(work.style.getPropertyValue("--v2-desk-wide-min-w")).not.toBe("");
  });

  test("opens nothing while the stage has not computed its extents", () => {
    stubMedia(2000);
    stubExtents(null);
    const { container } = drawDesk();
    act(() => {
      fireEvent.click(railPane(container, "ledger"));
    });
    expect(frameOf(container, "ledger").getAttribute("data-shown")).toBe("");
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
  });

  test("pressing an open pane brings it to the front and focuses it", () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    act(() => {
      fireEvent.click(railPane(container, "not-today"));
    });
    const strip = frameOf(container, "not-today").querySelector('[role="tablist"]') as HTMLElement;
    const tab = within(strip).getByRole("tab", { name: "Did not fit" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab);
  });

  test("names a pane on the rail by its short label where the title would wrap, and reads the title", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const shown = (pane: string) =>
      (railPane(container, pane).querySelector(".v2-desk-pane-name") as HTMLElement).textContent;
    expect(shown("past-due")).toBe("Past");
    expect(shown("not-today")).toBe("Did not fit");
    expect(shown("status")).toBe("Status");
    expect(shown("ledger")).toBe("Transactions");
    const rail = container.querySelector(".v2-desk-rail") as HTMLElement;
    expect(within(rail).getByRole("button", { name: /^Past their date/ })).toBe(railPane(container, "past-due"));
    expect(within(rail).getByRole("button", { name: /^Did not fit today/ })).toBe(
      railPane(container, "not-today"),
    );
  });
});

// ============================================================ behaviour 4

describe("maximize (behaviour 4)", () => {
  test("a button in the header gives a pane the desk, makes every other body inert, and one press restores", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const calendar = frameOf(container, "calendar");
    const button = calendar.querySelector(".v2-frame-max") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe(deskLine(DESK_COPY.maximizePane, { pane: "Calendar" }));
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.focus();
    act(() => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("data-max")).toBe("wide");
    for (const pane of PANE_IDS) {
      expect(frameOf(container, pane).hasAttribute("inert"), pane).toBe(pane !== "calendar");
    }
    for (const divider of container.querySelectorAll('.v2-divider[data-class="wide"]')) {
      expect(divider.hasAttribute("inert")).toBe(true);
    }
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneMaximized, { pane: "Calendar" }));
    expect(document.activeElement).toBe(button);
    expect(arrangementOf(saved(), "today", "wide")).toEqual(
      toggleMaximize(arrangementOf(EMPTY_TILE_SET, "today", "wide"), "calendar"),
    );

    act(() => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(frameOf(container, "status").hasAttribute("inert")).toBe(false);
    expect(spoken(container)).toBe(deskLine(DESK_COPY.paneRestored, { pane: "Calendar" }));
    expectNoRemount();
  });

  test("a double click on the header does the same, and one on a control in it does not", () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const head = frameOf(container, "calendar").querySelector(".v2-frame-head") as HTMLElement;
    act(() => {
      fireEvent.doubleClick(head);
    });
    expect(arrangementOf(saved(), "today", "regular").maximized).toBe("calendar");
    act(() => {
      fireEvent.doubleClick(frameOf(container, "calendar").querySelector(".v2-frame-max") as HTMLElement);
    });
    expect(arrangementOf(saved(), "today", "regular").maximized).toBe("calendar");
    act(() => {
      fireEvent.doubleClick(head);
    });
    expect(arrangementOf(saved(), "today", "regular").maximized).toBeNull();
  });
});

// ============================================================ behaviour 9

const FOCUSABLE = 'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';

/**
 * Everything a Tab key can reach on one class: focusable, not inert or hidden,
 * and not inside something desk.css does not draw on that class (the rail on a
 * phone, the phone's bars from 1024px, anything whose `data-in` leaves it out).
 * Frames and dividers are NOT filtered by what they say they show: that is the
 * claim under test.
 */
function tabbable(container: HTMLElement, cls: ScreenClass): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.tabIndex < 0 || element.closest("[inert], [hidden]") !== null) return false;
    for (let at: HTMLElement | null = element; at !== null; at = at.parentElement) {
      const within = at.getAttribute("data-in");
      if (within !== null && !within.split(" ").includes(cls)) return false;
    }
    const tiledOnly = element.closest(".v2-desk-rail") !== null;
    const phoneOnly = element.closest(".v2-desk-top, .v2-desk-bar") !== null;
    return cls === "compact" ? !tiledOnly : !phoneOnly;
  });
}

function expectReachesOnlyWhatIsShown(container: HTMLElement, cls: ScreenClass) {
  const reached = tabbable(container, cls);
  const bodies = reached.filter((element) => element.classList.contains("v2-pane-body"));
  expect(bodies.length).toBeGreaterThan(0);
  for (const element of reached) {
    const frame = element.closest<HTMLElement>(".v2-frame");
    if (frame !== null) {
      expect(frame.dataset.shown?.split(" "), `${cls} ${frame.dataset.pane}`).toContain(cls);
    }
    const divider = element.closest<HTMLElement>(".v2-divider");
    if (divider !== null) expect(divider.dataset.shown, `${cls} divider`).toBe(cls);
  }
  const shownFrames = Array.from(container.querySelectorAll<HTMLElement>(".v2-frame")).filter((frame) =>
    frame.dataset.shown?.split(" ").includes(cls),
  );
  expect(bodies.map((body) => body.closest<HTMLElement>(".v2-frame")?.dataset.pane).sort()).toEqual(
    shownFrames.map((frame) => frame.dataset.pane).sort(),
  );
}

describe("tab order (behaviour 9)", () => {
  test("in four states never reaches a body that is not displayed", () => {
    const cases: Array<[string, number, ScreenClass, (container: HTMLElement) => void]> = [
      ["default, wide", 2000, "wide", () => {}],
      ["default, regular", 1366, "regular", () => {}],
      ["default, phone", 390, "compact", () => {}],
      [
        "one pane maximized",
        2000,
        "wide",
        (container) => {
          act(() => {
            fireEvent.click(frameOf(container, "status").querySelector(".v2-frame-max") as HTMLElement);
          });
        },
      ],
      [
        "one pane closed",
        1366,
        "regular",
        (container) => {
          act(() => {
            fireEvent.click(
              frameOf(container, "today").querySelector('[data-close="status"]') as HTMLElement,
            );
          });
        },
      ],
      [
        "another layout",
        2000,
        "wide",
        (container) => {
          act(() => {
            fireEvent.click(
              within(container.querySelector(".v2-desk-rail") as HTMLElement).getByRole("link", { name: "Money" }),
            );
          });
        },
      ],
    ];
    for (const [name, width, cls, arrange] of cases) {
      cleanup();
      vi.restoreAllMocks();
      stubMedia(width);
      stubExtents({ wide: WIDE, regular: REGULAR });
      window.localStorage.clear();
      const { container } = drawDesk();
      arrange(container);
      try {
        expectReachesOnlyWhatIsShown(container, cls);
      } catch (error) {
        throw new Error(`${name}: ${(error as Error).message}`);
      }
    }
  });
});

// ============================================================ behaviour 7

describe("saving (behaviour 7)", () => {
  test("writes the whole set to storage and the open layout to a year's cookie on /v2", () => {
    expect(deskCookie("1!a!!a!!!", false)).toBe(
      `${TILE_COOKIE}=1!a!!a!!!; Path=/v2; Max-Age=${DESK_COOKIE_AGE}; SameSite=Lax`,
    );
    expect(DESK_COOKIE_AGE).toBe(365 * 24 * 60 * 60);
    expect(deskCookie("v", true).endsWith("; Secure")).toBe(true);
    expect(cookieValue(`a=1; ${TILE_COOKIE}=1!x; b=2`)).toBe("1!x");
    expect(cookieValue("a=1")).toBeNull();

    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBeNull();
    act(() => {
      fireEvent.click(frameOf(container, "today").querySelector('[data-close="status"]') as HTMLElement);
    });
    const expected = withArrangement(
      EMPTY_TILE_SET,
      "today",
      "regular",
      closePane(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "status"),
    );
    expect(window.localStorage.getItem(DESK_STORAGE_KEY)).toBe(serializeTileSet(expected));
    expect(cookieValue(document.cookie)).toBe(encodeTileCookie(expected));
  });

  test("writes nothing for a move of focus: the saved text is what is compared, not the set", () => {
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const cookies = vi.spyOn(document, "cookie", "set");
    // Status is open and alone in front on wide: pressing it moves the focus only.
    act(() => {
      fireEvent.click(railPane(container, "status"));
    });
    expect(document.activeElement).toBe(frameOf(container, "status").querySelector(".v2-pane-body"));
    expect(writes).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
  });

  test("keeps the cookie there was when the desk does not fit, and says so", () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    act(() => {
      fireEvent.click(frameOf(container, "today").querySelector('[data-close="status"]') as HTMLElement);
    });
    const before = cookieValue(document.cookie);
    expect(before).not.toBeNull();
    cookieJam.full = true;
    act(() => {
      fireEvent.click(frameOf(container, "today").querySelector('[data-close="past-due"]') as HTMLElement);
    });
    expect(cookieValue(document.cookie)).toBe(before);
    expect(leafOf(arrangementOf(saved(), "today", "regular").tree, "past-due")).toBeNull();
    expect(spoken(container)).toBe(
      `${deskLine(DESK_COPY.paneClosed, { pane: titleOf("past-due") })} ${DESK_COPY.savedHereOnly}`,
    );
  });

  test("the save step: storage when the text changed, the cookie when its value changed", () => {
    const moved = setCurrent(EMPTY_TILE_SET, "week");
    const first = saveStep(moved, { text: null, cookie: null });
    expect(first.storage).toBe(serializeTileSet(moved));
    expect(first.cookie).toBe(encodeTileCookie(moved));
    const again = saveStep({ ...moved }, first.written);
    expect(again).toMatchObject({ storage: null, cookie: null, tooBig: false });
    // A stale cookie under the same text is put right.
    expect(saveStep(moved, { text: first.written.text, cookie: "1!old" }).cookie).toBe(encodeTileCookie(moved));
  });
});

describe("loading (behaviour 7)", () => {
  /** A desk the owner rearranged: regular and wide Today, and Money's regular. */
  function rearranged(): TileSet {
    let set = EMPTY_TILE_SET;
    const change = (layout: string, cls: ScreenClass, make: (arrangement: Arrangement) => Arrangement) => {
      set = withArrangement(set, layout, cls, make(arrangementOf(set, layout, cls)));
    };
    change("today", "regular", (a) => closePane(a, "status"));
    change("today", "wide", (a) => closePane(a, "not-today"));
    change("money", "regular", (a) => closePane(a, "hours"));
    return set;
  }

  test("replaces everything but the arrangement on screen, which the cookie carried", () => {
    const stored = rearranged();
    window.localStorage.setItem(DESK_STORAGE_KEY, serializeTileSet(stored));
    // The cookie's regular Today differs from storage's (storage could not be written).
    const cookieSet = withArrangement(
      stored,
      "today",
      "regular",
      closePane(arrangementOf(EMPTY_TILE_SET, "today", "regular"), "calendar"),
    );
    const cookie = encodeTileCookie(cookieSet) as string;
    document.cookie = deskCookie(cookie, false);
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const painted = decodeTileCookie(cookie);
    const { container } = drawDesk(painted);
    const now = saved();
    // On screen: the cookie's.
    expect(encodeArrangement(arrangementOf(now, "today", "regular"))).toBe(
      encodeArrangement(arrangementOf(cookieSet, "today", "regular")),
    );
    expect(frameOf(container, "calendar").getAttribute("data-shown")).not.toContain("regular");
    // Everything else: storage's.
    expect(encodeArrangement(arrangementOf(now, "today", "wide"))).toBe(
      encodeArrangement(arrangementOf(stored, "today", "wide")),
    );
    expect(encodeArrangement(arrangementOf(now, "money", "regular"))).toBe(
      encodeArrangement(arrangementOf(stored, "money", "regular")),
    );
    expectNoRemount();
  });

  test("takes the stored arrangement where the cookie carried nothing for the layout on screen", () => {
    const stored = rearranged();
    window.localStorage.setItem(DESK_STORAGE_KEY, serializeTileSet(stored));
    const cookie = encodeTileCookie(stored) as string;
    document.cookie = deskCookie(cookie, false);
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    // A link to Money: the cookie was written on Today and says nothing of Money.
    const painted = setCurrent(decodeTileCookie(cookie), "money");
    expect(isChanged(painted, "money", "regular")).toBe(false);
    const { container } = drawDesk(painted, { home: "today" });
    expect(leafOf(arrangementOf(saved(), "money", "regular").tree, "hours")).toBeNull();
    expect(frameOf(container, "hours").getAttribute("data-shown")).not.toContain("regular");
  });

  test("keeps the remembered spots the cookie cannot carry, so a pane closed before a reload reopens where it was", () => {
    const stored = rearranged();
    window.localStorage.setItem(DESK_STORAGE_KEY, serializeTileSet(stored));
    const cookie = encodeTileCookie(stored) as string;
    stubMedia(2000);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk(decodeTileCookie(cookie));
    act(() => {
      fireEvent.click(railPane(container, "not-today"));
    });
    expect(isChanged(saved(), "today", "wide")).toBe(false);
  });

  test("the merge, pure: storage wins unless the cookie carried what is on screen and it draws differently", () => {
    const stored = rearranged();
    const painted = decodeTileCookie(encodeTileCookie(stored) as string);
    const merged = mergeSaved(painted, stored, ["regular"]);
    // The same drawing: storage's own arrangement, spots and all.
    expect(arrangementOf(merged, "today", "regular")).toBe(arrangementOf(stored, "today", "regular"));
    // The layout the stored desk cannot show: the stored desk as it is.
    const hidden = { ...stored, hidden: ["today"], current: "week" };
    expect(mergeSaved(painted, hidden, ["regular"]).current).toBe("week");
  });

  test("a change of class shows that class's own arrangement and copies nothing across", () => {
    const media = stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    act(() => {
      fireEvent.click(frameOf(container, "today").querySelector('[data-close="status"]') as HTMLElement);
    });
    media.resize(2000);
    expect(frameOf(container, "status").getAttribute("data-shown")).toContain("wide");
    expect(frameOf(container, "status").hasAttribute("inert")).toBe(false);
    media.resize(1366);
    expect(frameOf(container, "status").hasAttribute("inert")).toBe(true);
    expect(saved().slots.today?.wide).toBeUndefined();
    expect(saved().slots.today?.compact).toBeUndefined();
  });
});

// ============================================================ behaviour 10

/** The page, one level deep: what its guarded child returns. */
async function page(search: Record<string, string> = {}) {
  vi.stubEnv("V2_FIXTURES", "1");
  vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
  vi.stubEnv("VERCEL_ENV", "preview");
  const outer = DeskPage({ searchParams: Promise.resolve(search) }) as unknown as {
    type: (props: unknown) => Promise<ReactElement<{ initial: TileSet; home: string; week: string | null }>>;
    props: unknown;
  };
  return outer.type(outer.props);
}

describe("a reload (behaviour 10)", () => {
  test("draws the rearranged desk in the server's HTML, from the cookie the client wrote", async () => {
    stubMedia(1366);
    stubExtents({ wide: WIDE, regular: REGULAR });
    const { container } = drawDesk();
    act(() => {
      fireEvent.click(frameOf(container, "today").querySelector('[data-close="status"]') as HTMLElement);
    });
    act(() => {
      fireEvent.keyDown(dividerOf(container, "regular", 1), { key: "ArrowRight" });
    });
    const written = cookieValue(document.cookie) as string;
    const client = stageOf(container).style.getPropertyValue("--v2-regular-r1");
    expect(client).toBe("0.52");
    cleanup();

    request.cookie = written;
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(await page({}));
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(html).toContain("--v2-regular-r1:0.52");
    const strip = host.querySelector('section[data-pane="today"] [role="tablist"][data-in~="regular"]') as HTMLElement;
    expect(Array.from(strip.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent)).toEqual([
      "Day",
      "Past",
      "Did not fit",
    ]);
    // And the address still wins over the cookie's open layout.
    expect((await page({ layout: "money" })).props.initial.current).toBe("money");
    expect((await page({ layout: "money" })).props.home).toBe("today");
  });

  test("a cookie that does not decode is the empty desk", async () => {
    request.cookie = "1!nonsense";
    expect((await page({})).props.initial).toBe(EMPTY_TILE_SET);
  });
});

// ============================================================ hydration

describe("the first client render (review finding 4)", () => {
  const cases: Array<[string, number, () => TileSet]> = [
    ["the phone, on Quests", 390, () => setCurrent(EMPTY_TILE_SET, "quests")],
    ["a laptop, on Money", 1366, () => setCurrent(EMPTY_TILE_SET, "money")],
    [
      "a laptop, from a cookie",
      1366,
      () => {
        let set = setCurrent(EMPTY_TILE_SET, "week");
        set = withArrangement(set, "week", "regular", closePane(arrangementOf(set, "week", "regular"), "status"));
        set = withArrangement(set, "week", "wide", toggleMaximize(arrangementOf(set, "week", "wide"), "calendar"));
        return decodeTileCookie(encodeTileCookie(set) as string);
      },
    ],
    [
      "the phone, from a cookie",
      390,
      () => {
        let set = setCurrent(EMPTY_TILE_SET, "money");
        set = withArrangement(set, "money", "compact", closePane(arrangementOf(set, "money", "compact"), "hours"));
        return decodeTileCookie(encodeTileCookie(set) as string);
      },
    ],
  ];

  for (const [name, width, initialOf] of cases) {
    test(`is the server's HTML on ${name}: no mismatch, and nothing changes until the effects run`, async () => {
      const { renderToString } = await import("react-dom/server");
      const { hydrateRoot } = await import("react-dom/client");
      const initial = initialOf();
      const element = createElement(DeskClient, { data: sampleDesk(null), initial, date: null });
      const html = renderToString(element);
      expect(html).not.toContain("inert");

      const host = document.createElement("div");
      document.body.appendChild(host);
      host.innerHTML = html;
      const served = host.innerHTML;
      let atFirstRead: string | null = null;
      stubMedia(width, () => {
        atFirstRead ??= host.innerHTML;
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const recoverable: unknown[] = [];
      let root: Root | null = null;
      await act(async () => {
        root = hydrateRoot(host, element, {
          onRecoverableError: (error) => {
            recoverable.push(error);
          },
        });
      });
      expect(atFirstRead).toBe(served);
      expect(errors).not.toHaveBeenCalled();
      expect(recoverable).toEqual([]);
      act(() => {
        (root as unknown as Root).unmount();
      });
      host.remove();
    });
  }
});

// ============================================================ the review

describe("Task 9 review, folded in", () => {
  test("Back after a week link lands on the layout the server draws for the bare address (finding 1)", async () => {
    stubMedia(2000);
    window.history.replaceState(null, "", "/v2/desk");
    const desk = sampleDesk(null);
    const draw = (initial: TileSet) =>
      createElement(DeskClient, { data: desk, initial, date: null, home: "today" });
    const { container, rerender } = render(draw(EMPTY_TILE_SET));
    const layoutOn = () => (container.querySelector(".v2-desk") as HTMLElement).dataset.layout;
    act(() => {
      fireEvent.click(
        within(container.querySelector(".v2-desk-rail") as HTMLElement).getByRole("link", { name: "Money" }),
      );
    });
    expect(layoutOn()).toBe("money");
    // A week link: the router pushes its address and renders the page again,
    // which hands the desk the layout that link carried.
    window.history.pushState(null, "", "/v2/desk?week=2026-04-20&layout=money");
    rerender(draw(setCurrent(EMPTY_TILE_SET, "money")));
    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
      window.history.go(-2);
      await popped;
    });
    expect(window.location.search).toBe("");
    expect(layoutOn()).toBe("today");
  });

  test("a pick in the phone's layout list gives the focus back to its button, and a press outside closes it (finding 2, ruling 6)", () => {
    stubMedia(390);
    const { container } = drawDesk();
    const button = container.querySelector(".v2-desk-switch") as HTMLButtonElement;
    const list = container.querySelector(".v2-desk-menu") as HTMLElement;
    act(() => {
      fireEvent.click(button);
    });
    const week = within(list).getByRole("link", { name: "Week" });
    week.focus();
    act(() => {
      fireEvent.click(week);
    });
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(button);

    act(() => {
      fireEvent.click(button);
    });
    expect(list.hidden).toBe(false);
    act(() => {
      fireEvent.pointerDown(within(list).getByRole("link", { name: "Money" }));
    });
    expect(list.hidden).toBe(false);
    act(() => {
      fireEvent.pointerDown(container.querySelector(".v2-desk-work") as HTMLElement);
    });
    expect(list.hidden).toBe(true);
  });

  test("the layout links and the pushed address carry the week on screen, and only a week the calendar used (finding 3)", async () => {
    stubMedia(2000);
    const pushed = vi.spyOn(window.history, "pushState");
    const asked = await page({ week: "2026-04-21" });
    expect(asked.props.week).toBe("2026-04-20");
    expect((await page({ week: "2001-01-01" })).props.week).toBeNull();
    expect((await page({ week: "nonsense" })).props.week).toBeNull();
    const { container } = render(asked);
    const money = within(container.querySelector(".v2-desk-rail") as HTMLElement).getByRole("link", {
      name: "Money",
    });
    expect(money.getAttribute("href")).toBe(deskHref("money", null, "2026-04-20"));
    act(() => {
      fireEvent.click(money);
    });
    expect(pushed.mock.calls[0][2]).toBe("/v2/desk?layout=money&week=2026-04-20");
  });

  test("a frame a tab shows is that tab's panel, once the class is known (finding 5)", () => {
    const media = stubMedia(390);
    const { container } = drawDesk();
    const bar = container.querySelector(".v2-desk-bar") as HTMLElement;
    for (const tab of within(bar).getAllByRole("tab")) {
      const panel = document.getElementById(tab.getAttribute("aria-controls") as string) as HTMLElement;
      expect(panel.getAttribute("role")).toBe("tabpanel");
    }
    media.resize(2000);
    // Wide Today has no leaf of several: no frame is a panel.
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
    media.resize(1366);
    const strip = frameOf(container, "today").querySelector('[role="tablist"]') as HTMLElement;
    for (const tab of within(strip).getAllByRole("tab")) {
      const panel = document.getElementById(tab.getAttribute("aria-controls") as string) as HTMLElement;
      expect(panel.getAttribute("role")).toBe("tabpanel");
    }
    expect(frameOf(container, "calendar").hasAttribute("role")).toBe(false);
    expect(frameId("today")).toBe("v2-frame-today");
  });
});

// ============================================================ the reducer

describe("the reducer's new actions", () => {
  const start: TilesState = { set: EMPTY_TILE_SET, cls: null };

  test("each is one engine call on the class it names, and a refusal is the same state", () => {
    const wide = arrangementOf(EMPTY_TILE_SET, "today", "wide");
    const id = splitAt(wide.tree, 1).id;
    const ratio = tilesReducer(start, { type: "ratio", cls: "wide", splitId: id, ratio: 0.6, size: 1472 });
    expect(arrangementOf(ratio.set, "today", "wide")).toEqual(setRatio(wide, id, 0.6, 1472));
    expect(arrangementOf(ratio.set, "today", "regular")).toBe(arrangementOf(EMPTY_TILE_SET, "today", "regular"));
    expect(tilesReducer(start, { type: "equalize", cls: "wide", splitId: id })).toBe(start);
    expect(tilesReducer(start, { type: "close", cls: "wide", pane: "ledger" })).toBe(start);
    expect(tilesReducer(start, { type: "maximize", cls: "wide", pane: "ledger" })).toBe(start);
    const opened = tilesReducer(start, { type: "open", cls: "wide", pane: "ledger", workspace: WIDE });
    expect(arrangementOf(opened.set, "today", "wide")).toEqual(openPane(wide, "ledger", WIDE));
    expect(tilesReducer(opened, { type: "open", cls: "wide", pane: "ledger", workspace: WIDE })).toBe(opened);
  });
});

// ============================================================ the stylesheets

const DESK_CSS = readFileSync(path.join(ROOT, "app/v2/desk.css"), "utf8");
const SHEET = postcss.parse(DESK_CSS, { from: "app/v2/desk.css" });
const V2_CSS = postcss.parse(readFileSync(path.join(ROOT, "app/v2/v2.css"), "utf8"), { from: "app/v2/v2.css" });

function declsIn(sheet: Container, selector: string, media: string | null): Record<string, string> {
  const parent: Container | undefined =
    media === null
      ? sheet
      : ((sheet.nodes ?? []).find(
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

describe("the rulings in the stylesheets", () => {
  test("a frame is the page's colour under a header band of the card's, with its hairline and radius (ruling 1)", () => {
    const frame = declsIn(SHEET, "[data-v2-root] .v2-frame", null);
    expect(frame.background).toBe("var(--v2-page)");
    expect(frame.border).toBe("1px solid var(--v2-edge)");
    expect(frame["border-radius"]).toBe("12px");
    expect(declsIn(SHEET, "[data-v2-root] .v2-frame-head", null).background).toBe("var(--v2-card)");
  });

  test("a body does not say its frame's title again (ruling 2), and the day pane's dot is not drawn on the desk (ruling 4)", () => {
    expect(declsIn(SHEET, "[data-v2-root] .v2-frame .v2-list > .v2-sub", null)).toEqual({ display: "none" });
    expect(declsIn(SHEET, "[data-v2-root] .v2-frame .v2-cal-name", null)).toEqual({ display: "none" });
    expect(
      declsIn(SHEET, "[data-v2-root] .v2-desk .v2-pane .v2-top-aside .v2-appearance-dot", null),
    ).toEqual({ display: "none" });
    expect(declsIn(SHEET, "[data-v2-root] .v2-desk .v2-pane", "(width < 1024px)")).toEqual({
      "--v2-gutter": "0px",
    });
  });

  // A size container whose block size came from stretching to a line that its
  // own min-height set is not known when the stage's units are first resolved:
  // on a window shorter than the tree's minimum the first layout measured the
  // stage 0px tall and drew every frame 2px high (the controller's browser run
  // on 24aaf49, 1366 by 300). The height is written out instead, per class.
  test("gives the workspace a definite height on each tiled class, never a stretched one, so a short window does not blank the desk", () => {
    expect(declsIn(SHEET, "[data-v2-root] .v2-desk-work", "(min-width: 1024px)").margin).toBe("6px");
    for (const [cls, media] of [
      ["regular", "(1024px <= width < 1600px)"],
      ["wide", "(min-width: 1600px)"],
    ] as const) {
      const work = declsIn(SHEET, "[data-v2-root] .v2-desk-work", media);
      // The window less the 6px margin above and below, or the class's minimum.
      expect(work.height, cls).toBe(`max(calc(100dvh - 12px), var(--v2-desk-${cls}-min-h))`);
      expect(work["align-self"], cls).toBe("flex-start");
      expect(work["min-height"], cls).toBe(`var(--v2-desk-${cls}-min-h)`);
    }
    // The phone's slot keeps its height from the bars: no explicit height there.
    expect(declsIn(SHEET, "[data-v2-root] .v2-desk-work", null).height).toBeUndefined();
  });

  test("a divider draws nothing at rest, says its way with a cursor, and never selects or scrolls", () => {
    const divider = declsIn(SHEET, "[data-v2-root] .v2-divider", null);
    expect(divider.cursor).toBe("col-resize");
    expect(divider["touch-action"]).toBe("none");
    expect(divider["user-select"]).toBe("none");
    expect(declsIn(SHEET, '[data-v2-root] .v2-divider[data-dir="v"]', null).cursor).toBe("row-resize");
    expect(declsIn(SHEET, "[data-v2-root] .v2-divider::before", null).inset).toBe("0 -3px");
    const line = declsIn(SHEET, "[data-v2-root] .v2-divider::after", null);
    expect(line.opacity).toBe("0");
    expect(line.background).toBe("var(--v2-accent)");
  });

  test("a header's controls are quiet until asked for, and always there on a touch screen", () => {
    expect(declsIn(SHEET, "[data-v2-root] .v2-frame-close", null).opacity).toBe("0");
    expect(declsIn(SHEET, "[data-v2-root] .v2-frame-head:focus-within .v2-frame-max", null).opacity).toBe("1");
    expect(declsIn(SHEET, "[data-v2-root] .v2-frame-max", "(hover: none)").opacity).toBe("1");
  });

  test("a row's foot wraps between its parts in a side column or a pane, from 1024px (ruling 7)", () => {
    expect(declsIn(V2_CSS, "[data-v2-root] :where(.v2-side, .v2-pane) .v2-row-meta", "(min-width: 1024px)")).toEqual(
      { "flex-wrap": "wrap", "row-gap": "2px" },
    );
    expect(
      declsIn(V2_CSS, "[data-v2-root] :where(.v2-side, .v2-pane) .v2-row-meta > .v2-row-reason", "(min-width: 1024px)"),
    ).toEqual({ "margin-left": "auto" });
  });

  test("the scroller of a named box is a group; the gallery's, with no name, has no role (ruling 5)", () => {
    const box = PaneBox as unknown as ComponentType<{ paneId: string; labelledBy?: string }>;
    const { container } = render(
      createElement("div", null, createElement(box, { paneId: "x", labelledBy: "t" }, "a"), createElement(box, { paneId: "y" }, "b")),
    );
    const [named, bare] = Array.from(container.querySelectorAll(".v2-pane-body"));
    expect(named.getAttribute("role")).toBe("group");
    expect(bare.hasAttribute("role")).toBe(false);
  });

  test("words the desk without a dash", () => {
    const words = Object.values(DESK_COPY).join("\n");
    expect(words).not.toContain(String.fromCodePoint(0x2014));
    expect(words).not.toContain(String.fromCodePoint(0x2013));
  });
});
