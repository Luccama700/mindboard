// PLAN-DESK Task 9: the desk standing still. The workspace, its stage and the
// fourteen frames on it, the rail, the phone's two bars, and the reducer under
// them (behaviours 3, 4, 5, 7, 8, 9, 10 and 11). The page itself, the gate, the
// address, hydration and the live region are in v2-desk-page.test.ts.
//
// WHAT IS NOT PINNED HERE. Where a frame lands on a real screen: jsdom lays
// nothing out and loads no stylesheet. What the stylesheet says is read with
// postcss below; that the browser draws each frame at the engine's rectangle is
// the controller's capture against layoutTree.
//
// EVERY BODY IS COUNTED. The registry is wrapped so each pane's body is a stand
// in that counts its own mounts and unmounts and renders the REAL body inside
// it, so a press on the day's line is a real press, and a remount anywhere
// shows up as a second mount.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createElement,
  type Attributes,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

import postcss, { type AtRule, type Container, type Declaration, type Rule } from "postcss";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const counts = vi.hoisted(() => ({
  mounted: new Map<string, number>(),
  unmounted: new Map<string, number>(),
  options: new Map<string, unknown>(),
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
        counts.options.set(id, props.options);
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
  arrangementOf,
  cssLayout,
  defaultArrangement,
  leafOf,
  setCurrent,
  setHidden,
  toggleMaximize,
  withArrangement,
  type Arrangement,
  type ScreenClass,
  type TileNode,
  type TileSet,
} from "@/app/lib/v2/tiles";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { DayProvider } from "@/app/v2/_components/day-provider";
import { DESK_PROPERTY_RULES, DeskClient } from "@/app/v2/_desk/desk-client";
import { DeskDataProvider } from "@/app/v2/_desk/desk-data-provider";
import { frameId, frameTitleId, frameVar, type TiledClass } from "@/app/v2/_desk/pane-frame";
import {
  DESK_PATH,
  TILED_QUERY,
  WIDE_QUERY,
  deskHref,
  deskKeep,
  layoutAsked,
  tilesReducer,
  type TilesState,
} from "@/app/v2/_desk/use-tiles";
import { MIN_SLACK, Workspace, deskStage, dividerVar, minVar } from "@/app/v2/_desk/workspace";

const ROOT = path.resolve(__dirname, "..");

// A desk render costs about half a second in jsdom, and the full suite runs
// some 150 files at once: the default 5 s is too close for a test that renders
// and presses several times.
vi.setConfig({ testTimeout: 15_000 });

const TILED: TiledClass[] = ["regular", "wide"];
const SIDES = ["left", "top", "width", "height"] as const;
const PANE_IDS = PANES.map((pane) => pane.id);

// ---------------------------------------------------------------- the window

/**
 * jsdom has no matchMedia. This one answers `(min-width: Npx)` against a width
 * the test sets, and tells its listeners when the width changes.
 */
function stubMedia(width: number) {
  const listeners = new Set<() => void>();
  const state = { width };
  const matchMedia = (query: string): MediaQueryList => {
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

beforeEach(() => {
  counts.mounted.clear();
  counts.unmounted.clear();
  counts.options.clear();
  window.history.replaceState(null, "", deskHref("today", null));
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "matchMedia");
  vi.restoreAllMocks();
});

/**
 * createElement for a component whose `children` prop is required: the
 * children go after the props, where react/no-children-prop wants them.
 */
function wrap<P extends { children: ReactNode }>(
  type: ComponentType<P>,
  props: Omit<P, "children"> & Attributes,
  ...children: ReactNode[]
): ReactElement {
  return createElement(type as ComponentType<Omit<P, "children">>, props, ...children);
}

function drawDesk(initial: TileSet = EMPTY_TILE_SET, date: string | null = null) {
  return render(createElement(DeskClient, { data: sampleDesk(null), initial, date }));
}

const frameOf = (container: HTMLElement, pane: string) =>
  container.querySelector(`section.v2-frame[data-pane="${pane}"]`) as HTMLElement;

const shownOf = (container: HTMLElement, pane: string) =>
  frameOf(container, pane).getAttribute("data-shown");

const railLink = (container: HTMLElement, title: string) =>
  within(container.querySelector(".v2-desk-rail") as HTMLElement).getByRole("link", {
    name: title,
  });

const layoutOn = (container: HTMLElement) =>
  (container.querySelector(".v2-desk") as HTMLElement).dataset.layout;

/** The leaf box cssLayout gives the leaf holding this pane, on one class of one layout. */
function cssBoxOf(set: TileSet, layout: string, cls: TiledClass, pane: string) {
  const arrangement = arrangementOf(set, layout, cls);
  const leaf = leafOf(arrangement.tree, pane);
  if (leaf === null) return null;
  const maximized =
    arrangement.maximized === null ? null : leafOf(arrangement.tree, arrangement.maximized);
  const css = cssLayout(arrangement.tree, maximized?.id ?? null, PANES, cls);
  return css.leaves.find((candidate) => candidate.leafId === leaf.id) ?? null;
}

// ---------------------------------------------------------------- the reducer

describe("the reducer", () => {
  const start: TilesState = { set: EMPTY_TILE_SET, cls: null };

  test("takes the class the browser reports, and hands back the same state for the same class", () => {
    const wide = tilesReducer(start, { type: "class", cls: "wide" });
    expect(wide.cls).toBe("wide");
    expect(wide.set).toBe(start.set);
    expect(tilesReducer(wide, { type: "class", cls: "wide" })).toBe(wide);
  });

  test("opens a layout through the engine, and refuses one the desk does not show", () => {
    const week = tilesReducer(start, { type: "layout", id: "week" });
    expect(week.set.current).toBe("week");
    expect(week.set).toEqual(setCurrent(EMPTY_TILE_SET, "week"));
    expect(tilesReducer(week, { type: "layout", id: "week" })).toBe(week);
    expect(tilesReducer(start, { type: "layout", id: "nowhere" })).toBe(start);
    const hidden: TilesState = { set: setHidden(EMPTY_TILE_SET, "money", true), cls: null };
    expect(tilesReducer(hidden, { type: "layout", id: "money" })).toBe(hidden);
  });

  test("replaces the set, and keeps the class", () => {
    const other = setCurrent(EMPTY_TILE_SET, "quests");
    const held: TilesState = { set: EMPTY_TILE_SET, cls: "regular" };
    expect(tilesReducer(held, { type: "replace", set: other })).toEqual({ set: other, cls: "regular" });
    expect(tilesReducer(held, { type: "replace", set: EMPTY_TILE_SET })).toBe(held);
  });

  test("brings a tab to the front on one class only, through activateTab", () => {
    const next = tilesReducer(start, { type: "tab", cls: "compact", pane: "status" });
    const compact = arrangementOf(next.set, "today", "compact");
    expect(compact.tree?.kind === "leaf" && compact.tree.active).toBe("status");
    expect(compact.focus).toBe("status");
    // The other classes are the defaults still, by reference.
    expect(arrangementOf(next.set, "today", "regular")).toBe(defaultArrangement("regular", "today"));
    expect(arrangementOf(next.set, "today", "wide")).toBe(defaultArrangement("wide", "today"));
  });

  test("hands back the same state for a tab already in front, or a pane not open", () => {
    expect(tilesReducer(start, { type: "tab", cls: "compact", pane: "today" })).toBe(start);
    expect(tilesReducer(start, { type: "tab", cls: "compact", pane: "ledger" })).toBe(start);
  });
});

// ---------------------------------------------------------------- the address

describe("the address", () => {
  test("is the desk's path with the layout, and the date when there is one", () => {
    expect(deskHref("week", null)).toBe(`${DESK_PATH}?layout=week`);
    expect(deskHref("week", "2026-04-15")).toBe(`${DESK_PATH}?layout=week&date=2026-04-15`);
    expect(deskKeep("money", null)).toEqual({ layout: "money" });
    expect(deskKeep("money", "2026-04-15")).toEqual({ layout: "money", date: "2026-04-15" });
  });

  test("reads the layout back on Back and Forward, and the server's for anything unusable", () => {
    const set = setHidden(EMPTY_TILE_SET, "quests", true);
    expect(layoutAsked("?layout=money", set, "today")).toBe("money");
    expect(layoutAsked("?layout=quests", set, "week")).toBe("week");
    expect(layoutAsked("?layout=nowhere", set, "week")).toBe("week");
    expect(layoutAsked("", set, "week")).toBe("week");
    expect(layoutAsked("?layout=money&layout=today", set, "week")).toBe("week");
  });
});

// ------------------------------------------------------------------ the stage

describe("the stage, worked out for every class at once", () => {
  test("is the fourteen frames in the catalog's order", () => {
    for (const meta of BUILT_IN_LAYOUTS) {
      expect(deskStage(EMPTY_TILE_SET, meta.id).frames.map((frame) => frame.pane.id)).toEqual(
        PANE_IDS,
      );
    }
  });

  test("says in which classes each frame is shown: the front of its leaf, on each class", () => {
    const shown = (layout: string) =>
      Object.fromEntries(
        deskStage(EMPTY_TILE_SET, layout).frames.map((frame) => [frame.pane.id, frame.shown]),
      );
    const today = shown("today");
    expect(today.today).toEqual(["compact", "regular", "wide"]);
    expect(today.status).toEqual(["wide"]);
    expect(today["past-due"]).toEqual(["wide"]);
    expect(today.calendar).toEqual(["regular", "wide"]);
    expect(today.lanes).toEqual([]);
    expect(today.ledger).toEqual([]);

    const week = shown("week");
    expect(week.calendar).toEqual(["compact", "regular", "wide"]);
    expect(week["not-today"]).toEqual(["regular", "wide"]);
    expect(week.today).toEqual(["wide"]);
    expect(week.status).toEqual([]);
  });

  test("holds each frame's box on both tiled classes, exactly as cssLayout wrote it", () => {
    for (const meta of BUILT_IN_LAYOUTS) {
      const stage = deskStage(EMPTY_TILE_SET, meta.id);
      for (const frame of stage.frames) {
        for (const cls of TILED) {
          const expected = cssBoxOf(EMPTY_TILE_SET, meta.id, cls, frame.pane.id);
          if (expected === null) {
            expect(frame.boxes[cls], `${meta.id} ${cls} ${frame.pane.id}`).toBeUndefined();
            continue;
          }
          const { left, top, width, height } = expected;
          expect(frame.boxes[cls], `${meta.id} ${cls} ${frame.pane.id}`).toEqual({
            left,
            top,
            width,
            height,
          });
        }
      }
    }
  });

  test("carries both classes' properties, both minimums, and regular's dividers then wide's", () => {
    for (const meta of BUILT_IN_LAYOUTS) {
      const stage = deskStage(EMPTY_TILE_SET, meta.id);
      const regular = cssLayout(arrangementOf(EMPTY_TILE_SET, meta.id, "regular").tree, null, PANES, "regular");
      const wide = cssLayout(arrangementOf(EMPTY_TILE_SET, meta.id, "wide").tree, null, PANES, "wide");
      expect(stage.vars).toEqual({ ...regular.vars, ...wide.vars });
      expect(stage.min).toEqual({ regular: regular.min, wide: wide.min });
      expect(stage.dividers.map((divider) => `${divider.cls} ${divider.index}`)).toEqual([
        ...regular.dividers.map((divider) => `regular ${divider.index}`),
        ...wide.dividers.map((divider) => `wide ${divider.index}`),
      ]);
    }
  });

  test("draws one strip per leaf of several, in its front tab's frame, merged when both classes agree", () => {
    const today = deskStage(EMPTY_TILE_SET, "today");
    const frame = (stage: typeof today, pane: string) =>
      stage.frames.find((candidate) => candidate.pane.id === pane);
    expect(frame(today, "today")?.strips).toEqual([
      { classes: ["regular"], tabs: ["today", "status", "past-due", "not-today"], active: "today" },
    ]);
    expect(frame(today, "status")?.strips).toEqual([]);
    expect(frame(today, "calendar")?.strips).toEqual([]);

    const week = deskStage(EMPTY_TILE_SET, "week");
    expect(frame(week, "not-today")?.strips).toEqual([
      { classes: ["regular"], tabs: ["not-today", "past-due", "today", "status"], active: "not-today" },
      { classes: ["wide"], tabs: ["not-today", "past-due"], active: "not-today" },
    ]);
    expect(frame(week, "today")?.strips).toEqual([
      { classes: ["wide"], tabs: ["today", "status"], active: "today" },
    ]);

    const money = deskStage(EMPTY_TILE_SET, "money");
    expect(frame(money, "accounts")?.strips).toEqual([
      { classes: ["regular"], tabs: ["accounts", "hours"], active: "accounts" },
    ]);
  });

  test("knows the phone's one leaf: its tabs in order and the one in front", () => {
    expect(deskStage(EMPTY_TILE_SET, "today").compact).toEqual({
      tabs: ["today", "status", "past-due", "not-today", "calendar"],
      active: "today",
    });
    expect(deskStage(EMPTY_TILE_SET, "week").compact).toEqual({
      tabs: ["calendar", "not-today", "past-due"],
      active: "calendar",
    });
  });

  // Nothing in this task can maximize a pane, but the engine and the geometry
  // both know about it, so the next task only has to add the control.
  test("hands cssLayout the maximized LEAF, and shows nothing else on that class", () => {
    const wide = toggleMaximize(arrangementOf(EMPTY_TILE_SET, "today", "wide"), "calendar");
    const set = withArrangement(EMPTY_TILE_SET, "today", "wide", wide);
    const stage = deskStage(set, "today");
    const shownIn = (cls: ScreenClass) =>
      stage.frames.filter((frame) => frame.shown.includes(cls)).map((frame) => frame.pane.id);
    expect(shownIn("wide")).toEqual(["calendar"]);
    expect(shownIn("regular")).toEqual(["today", "calendar"]);
    const calendar = stage.frames.find((frame) => frame.pane.id === "calendar");
    expect(calendar?.boxes.wide).toEqual({
      left: "0",
      top: "0",
      width: "var(--v2-wide-w)",
      height: "var(--v2-wide-h)",
    });
    expect(stage.dividers.filter((divider) => divider.cls === "wide").every((d) => !d.shown)).toBe(true);
    expect(stage.dividers.filter((divider) => divider.cls === "regular").every((d) => d.shown)).toBe(true);
  });
});

// ------------------------------------------------------------ on the screen

describe("its own root (behaviour 3)", () => {
  test("is .v2-desk, outside every .v2-shell", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const desk = container.querySelector(".v2-desk") as HTMLElement;
    expect(desk).not.toBeNull();
    expect(desk.closest(".v2-shell")).toBeNull();
    expect(container.querySelector(".v2-shell")).toBeNull();
    expect(desk.parentElement).toBe(container);
  });
});

describe("the geometry's contract (behaviour 4)", () => {
  test("registers both classes' properties in one style, once", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const styles = Array.from(container.querySelectorAll("style"));
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe(DESK_PROPERTY_RULES);
    expect(DESK_PROPERTY_RULES.split("@property --v2-regular-w ")).toHaveLength(2);
    expect(DESK_PROPERTY_RULES.split("@property --v2-wide-w ")).toHaveLength(2);
  });

  test("is a workspace, one stage in it, and every frame and divider a child of the stage", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const work = container.querySelector(".v2-desk-work") as HTMLElement;
    expect(work.tagName).toBe("MAIN");
    expect(Array.from(work.children).map((child) => child.className)).toEqual(["v2-desk-stage"]);
    const stage = work.firstElementChild as HTMLElement;
    for (const frame of container.querySelectorAll(".v2-frame, .v2-divider")) {
      expect(frame.parentElement).toBe(stage);
    }
  });

  test("puts both classes' properties for the layout on the stage, and nowhere else", () => {
    stubMedia(1366);
    const { container } = drawDesk(setCurrent(EMPTY_TILE_SET, "quests"));
    const stage = container.querySelector(".v2-desk-stage") as HTMLElement;
    const expected = deskStage(setCurrent(EMPTY_TILE_SET, "quests"), "quests").vars;
    expect(Object.keys(expected).some((name) => name.startsWith("--v2-regular-a"))).toBe(true);
    expect(Object.keys(expected).some((name) => name.startsWith("--v2-wide-a"))).toBe(true);
    for (const [name, value] of Object.entries(expected)) {
      expect(stage.style.getPropertyValue(name), name).toBe(value);
    }
    expect(stage.style.length).toBe(Object.keys(expected).length);
    // The workspace and the frames set none of them.
    const work = container.querySelector(".v2-desk-work") as HTMLElement;
    for (const name of Object.keys(expected)) {
      expect(work.style.getPropertyValue(name)).toBe("");
      expect(frameOf(container, "lanes").style.getPropertyValue(name)).toBe("");
    }
  });

  // Under a fractional page zoom a browser holds a box a fraction under the
  // length it was given (819.98 for 820 at 90 percent), the stage floors the
  // workspace, and a workspace held at exactly `min` reads as `min` less one:
  // a split's two minimums no longer fit, and the CSS and the engine draw that
  // split a whole split apart. One pixel of slack keeps the floor at `min`.
  test("holds the workspace one pixel over each class's minimum, so a zoom cannot floor it under", () => {
    expect(MIN_SLACK).toBe(1);
    stubMedia(2000);
    // One render, the four layouts opened on it from the rail: the minimum
    // follows the tree on screen.
    const { container } = drawDesk();
    const work = container.querySelector(".v2-desk-work") as HTMLElement;
    for (const meta of BUILT_IN_LAYOUTS) {
      act(() => {
        fireEvent.click(railLink(container, meta.title));
      });
      const set = setCurrent(EMPTY_TILE_SET, meta.id);
      for (const cls of TILED) {
        const { min } = cssLayout(arrangementOf(set, meta.id, cls).tree, null, PANES, cls);
        expect(min.w).toBeGreaterThan(0);
        expect(work.style.getPropertyValue(minVar(cls, "w")), `${meta.id} ${cls}`).toBe(`${min.w + 1}px`);
        expect(work.style.getPropertyValue(minVar(cls, "h")), `${meta.id} ${cls}`).toBe(`${min.h + 1}px`);
      }
    }
  });
});

describe("the server draws every class (behaviour 5)", () => {
  test("writes each frame's box once per tiled class, and says where it is shown", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const stage = deskStage(EMPTY_TILE_SET, "today");
    for (const frame of stage.frames) {
      const element = frameOf(container, frame.pane.id);
      expect(element.getAttribute("data-shown"), frame.pane.id).toBe(frame.shown.join(" "));
      for (const cls of TILED) {
        const box = cssBoxOf(EMPTY_TILE_SET, "today", cls, frame.pane.id);
        for (const side of SIDES) {
          expect(element.style.getPropertyValue(frameVar(cls, side)), `${frame.pane.id} ${cls} ${side}`).toBe(
            box === null ? "" : box[side],
          );
        }
      }
    }
    expect(frameOf(container, "today").getAttribute("data-shown")).toBe("compact regular wide");
    expect(frameOf(container, "lanes").getAttribute("data-shown")).toBe("");
  });

  test("writes each divider's box on its own properties, for its own class", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const stage = deskStage(EMPTY_TILE_SET, "today");
    const dividers = Array.from(container.querySelectorAll<HTMLElement>(".v2-divider"));
    expect(dividers).toHaveLength(stage.dividers.length);
    dividers.forEach((element, at) => {
      const divider = stage.dividers[at];
      expect(element.dataset.class).toBe(divider.cls);
      expect(element.dataset.shown).toBe(divider.cls);
      for (const side of SIDES) {
        expect(element.style.getPropertyValue(dividerVar(side))).toBe(divider.box[side]);
      }
    });
  });
});

describe("flat and stable (behaviour 7)", () => {
  test("is the fourteen frames in the catalog's order, then regular's dividers, then wide's", () => {
    stubMedia(2000);
    const { container } = drawDesk(setCurrent(EMPTY_TILE_SET, "money"));
    const children = Array.from((container.querySelector(".v2-desk-stage") as HTMLElement).children);
    expect(children.slice(0, 14).map((child) => child.getAttribute("data-pane"))).toEqual(PANE_IDS);
    const rest = children.slice(14) as HTMLElement[];
    expect(rest.every((child) => child.classList.contains("v2-divider"))).toBe(true);
    const classes = rest.map((child) => child.dataset.class);
    expect(classes).toEqual([...classes].sort((a, b) => (a === b ? 0 : a === "regular" ? -1 : 1)));
    expect(classes).toContain("regular");
    expect(classes).toContain("wide");
  });

  test("makes each frame a section labelled by its title, its one h2", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    for (const pane of PANES) {
      const frame = frameOf(container, pane.id);
      expect(frame.tagName).toBe("SECTION");
      expect(frame.id).toBe(frameId(pane.id));
      // The frame's own h2. A body's headings sit under it (the day's line has
      // an h2 of its own, from Today's page, which is the body's business).
      const headings = frame.querySelectorAll(":scope > header h2");
      expect(headings, pane.id).toHaveLength(1);
      expect(headings[0].id).toBe(frameTitleId(pane.id));
      expect(headings[0].textContent).toBe(pane.title);
      expect(headings[0].classList.contains("v2-hidden")).toBe(true);
      expect(frame.getAttribute("aria-labelledby")).toBe(frameTitleId(pane.id));
    }
  });

  test("shows a tab strip of the short labels in the front tab's frame, on the class that has it", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const strip = frameOf(container, "today").querySelector('[role="tablist"]') as HTMLElement;
    expect(strip.dataset.in).toBe("regular");
    const tabs = within(strip).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Day", "Status", "Past", "Did not fit"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    // Controls since Task 10 (v2-desk-controls.test.ts): one tab stop, on the tab in front.
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(frameOf(container, "today").querySelector(".v2-frame-name")?.getAttribute("data-strip")).toBe(
      "regular",
    );
    expect(frameOf(container, "status").querySelector('[role="tablist"]')).toBeNull();
  });

  test("makes every frame not shown on the class the browser reports inert, and follows a resize", () => {
    const media = stubMedia(1366);
    const { container } = drawDesk();
    const inert = () =>
      PANE_IDS.filter((pane) => frameOf(container, pane).hasAttribute("inert")).sort();
    const notShownIn = (cls: ScreenClass) =>
      deskStage(EMPTY_TILE_SET, "today")
        .frames.filter((frame) => !frame.shown.includes(cls))
        .map((frame) => frame.pane.id)
        .sort();
    expect(inert()).toEqual(notShownIn("regular"));
    expect(frameOf(container, "today").hasAttribute("inert")).toBe(false);
    expect(frameOf(container, "status").hasAttribute("inert")).toBe(true);

    media.resize(2000);
    expect(inert()).toEqual(notShownIn("wide"));
    expect(frameOf(container, "status").hasAttribute("inert")).toBe(false);

    media.resize(390);
    expect(inert()).toEqual(notShownIn("compact"));
    expect(frameOf(container, "calendar").hasAttribute("inert")).toBe(true);
  });

  // Leaf and split ids are minted again whenever a saved layout is read. A
  // frame keyed by anything but its pane would be mounted again by that.
  test("is keyed by pane id alone: a tree with every id minted again remounts nothing", () => {
    const desk = sampleDesk(null);
    const renumbered = (node: TileNode): TileNode =>
      node.kind === "leaf"
        ? { ...node, id: `l${Number(node.id.slice(1)) + 40}` }
        : {
            ...node,
            id: `s${Number(node.id.slice(1)) + 40}`,
            ratio: 0.6,
            first: renumbered(node.first),
            second: renumbered(node.second),
          };
    const before = arrangementOf(EMPTY_TILE_SET, "today", "wide");
    const after: Arrangement = { ...before, tree: renumbered(before.tree as TileNode) };
    const moved = withArrangement(EMPTY_TILE_SET, "today", "wide", after);
    expect(moved).not.toBe(EMPTY_TILE_SET);

    const draw = (set: TileSet) =>
      wrap(
        DeskDataProvider,
        { data: desk },
        wrap(
          DayProvider,
          { key: desk.today.input.date, data: desk.today },
          createElement(Workspace, { set, stage: deskStage(set, set.current), cls: "wide" }),
        ),
      );
    const { container, rerender } = render(draw(EMPTY_TILE_SET));
    const sections = PANE_IDS.map((pane) => frameOf(container, pane));
    const stage = container.querySelector(".v2-desk-stage") as HTMLElement;
    expect(stage.style.getPropertyValue("--v2-wide-r1")).toBe("0.5");
    rerender(draw(moved));
    expect(PANE_IDS.map((pane) => frameOf(container, pane))).toEqual(sections);
    // The new tree is drawn: its ratios are on the stage.
    expect(stage.style.getPropertyValue("--v2-wide-r1")).toBe("0.6");
    for (const pane of PANE_IDS) {
      expect(counts.mounted.get(pane), pane).toBe(1);
      expect(counts.unmounted.get(pane) ?? 0, pane).toBe(0);
    }
  });
});

describe("mount once (behaviour 8)", () => {
  test("keeps every body mounted through the four layouts and back, and a press on Today with them", async () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const today = frameOf(container, "today");
    const lit = () => today.querySelector("[data-lit-heading]")?.textContent ?? null;
    const spoken = () => container.querySelector('[role="status"]')?.textContent ?? "";

    const first = lit();
    expect(first).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(today).getByRole("button", { name: TODAY_COPY.notToday }));
    });
    const pressed = lit();
    expect(pressed).not.toBe(first);
    expect(spoken()).toContain(TODAY_COPY.acted.skipped);

    for (const meta of [...BUILT_IN_LAYOUTS.slice(1), BUILT_IN_LAYOUTS[0]]) {
      await act(async () => {
        fireEvent.click(railLink(container, meta.title));
      });
      expect(layoutOn(container)).toBe(meta.id);
    }

    expect(frameOf(container, "today")).toBe(today);
    expect(lit()).toBe(pressed);
    expect(spoken()).toContain(TODAY_COPY.acted.skipped);
    for (const pane of PANE_IDS) {
      expect(counts.mounted.get(pane), pane).toBe(1);
      expect(counts.unmounted.get(pane) ?? 0, pane).toBe(0);
    }
  });
});

describe("the frame (behaviour 9)", () => {
  test("is a header, then the box, with the body inside and the scroller named by the title", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    for (const pane of PANE_IDS) {
      const frame = frameOf(container, pane);
      const children = Array.from(frame.children);
      expect(children.map((child) => child.tagName)).toEqual(["HEADER", "DIV"]);
      const box = children[1] as HTMLElement;
      expect(box.className).toBe("v2-pane");
      expect(box.dataset.pane).toBe(pane);
      const scroller = box.querySelector(".v2-pane-body") as HTMLElement;
      expect(scroller.getAttribute("aria-labelledby")).toBe(frameTitleId(pane));
      // The header's controls (Task 10, v2-desk-controls.test.ts) sit inside
      // the header and never between it and the box.
      expect(children[1].querySelector(".v2-frame-tools, .v2-frame-tab")).toBeNull();
    }
  });

  test("hands each body its options from optionsOf, in an object with no prototype", () => {
    stubMedia(2000);
    drawDesk();
    for (const pane of PANES) {
      const options = counts.options.get(pane.id) as Record<string, string>;
      expect(Object.getPrototypeOf(options), pane.id).toBeNull();
      expect(Object.isFrozen(options)).toBe(true);
      const expected = Object.fromEntries(pane.options.map((option) => [option.key, option.fallback]));
      expect({ ...options }, pane.id).toEqual(expected);
    }
    expect({ ...(counts.options.get("calendar") as object) }).toEqual({ days: "auto" });
  });
});

describe("the rail (behaviour 10)", () => {
  test("lists the layouts as anchors to their own addresses, the one on screen current", () => {
    stubMedia(2000);
    const { container } = drawDesk(setCurrent(EMPTY_TILE_SET, "week"), "2026-04-15");
    const rail = container.querySelector(".v2-desk-rail") as HTMLElement;
    expect(rail.tagName).toBe("NAV");
    const links = within(rail).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(BUILT_IN_LAYOUTS.map((meta) => meta.title));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      BUILT_IN_LAYOUTS.map((meta) => `/v2/desk?layout=${meta.id}&date=2026-04-15`),
    );
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, "page", null, null]);
  });

  test("lists every pane by group, marked where it is open in the layout on screen", () => {
    stubMedia(2000);
    const { container } = drawDesk(setCurrent(EMPTY_TILE_SET, "week"));
    const rail = container.querySelector(".v2-desk-rail") as HTMLElement;
    expect(Array.from(rail.querySelectorAll(".v2-desk-group h3")).map((h) => h.textContent)).toEqual([
      DESK_COPY.groupDay,
      DESK_COPY.groupQuests,
      DESK_COPY.groupMoney,
    ]);
    const items = Array.from(rail.querySelectorAll<HTMLElement>(".v2-desk-pane"));
    expect(items.map((item) => item.dataset.pane)).toEqual(PANE_IDS);
    const open = Object.fromEntries(items.map((item) => [item.dataset.pane, item.dataset.open]));
    expect(open.calendar).toBe("compact regular wide");
    expect(open.today).toBe("regular wide");
    expect(open.lanes).toBe("");
    for (const item of items) {
      expect(item.querySelector(".v2-desk-open .v2-hidden")?.textContent?.trim()).toBe(DESK_COPY.open);
      // One control per pane since Task 10 (v2-desk-controls.test.ts).
      expect(item.querySelectorAll("button, a, input")).toHaveLength(1);
    }
  });

  test("ends with the existing appearance control", () => {
    stubMedia(2000);
    const { container } = drawDesk();
    const rail = container.querySelector(".v2-desk-rail") as HTMLElement;
    expect(rail.lastElementChild?.classList.contains("v2-rail-appearance")).toBe(true);
  });
});

describe("compact (behaviour 11)", () => {
  test("names the layout on a button that opens the list of layouts, and closes it on Escape", async () => {
    stubMedia(390);
    const { container } = drawDesk();
    const top = container.querySelector(".v2-desk-top") as HTMLElement;
    const button = top.querySelector(".v2-desk-switch") as HTMLButtonElement;
    expect(button.textContent).toContain("Today");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const list = container.querySelector(`#${button.getAttribute("aria-controls")}`) as HTMLElement;
    expect(list.hidden).toBe(true);

    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);
    expect(within(list).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(
      BUILT_IN_LAYOUTS.map((meta) => deskHref(meta.id, null)),
    );

    await act(async () => {
      fireEvent.keyDown(within(list).getByRole("link", { name: "Week" }), { key: "Escape" });
    });
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  test("opens a layout from that list, and closes it", async () => {
    stubMedia(390);
    const { container } = drawDesk();
    const button = container.querySelector(".v2-desk-switch") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    const list = container.querySelector(".v2-desk-menu") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(list).getByRole("link", { name: "Money" }));
    });
    expect(layoutOn(container)).toBe("money");
    expect(list.hidden).toBe(true);
    expect(button.textContent).toContain("Money");
  });

  test("is the layout's tabs in order on the bottom bar, the front one marked", () => {
    stubMedia(390);
    const { container } = drawDesk();
    const bar = container.querySelector(".v2-desk-bar") as HTMLElement;
    const tabs = within(bar).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Day", "Status", "Past", "Did not fit", "Calendar"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(tabs[1].getAttribute("aria-controls")).toBe(frameId("status"));
  });

  test("shows the pane a tab is pressed for, through the engine, on the phone only", async () => {
    stubMedia(390);
    const { container } = drawDesk();
    const bar = container.querySelector(".v2-desk-bar") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(bar).getByRole("tab", { name: "Status" }));
    });
    expect(shownOf(container, "status")).toBe("compact wide");
    expect(shownOf(container, "today")).toBe("regular wide");
    expect(frameOf(container, "status").hasAttribute("inert")).toBe(false);
    expect(frameOf(container, "today").hasAttribute("inert")).toBe(true);
    expect(within(bar).getByRole("tab", { name: "Status" }).getAttribute("aria-selected")).toBe("true");

    const status = within(bar).getByRole("tab", { name: "Status" });
    status.focus();
    await act(async () => {
      fireEvent.keyDown(status, { key: "ArrowRight" });
    });
    const past = within(bar).getByRole("tab", { name: "Past" });
    expect(past.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(past);
    expect(shownOf(container, "past-due")).toBe("compact wide");

    await act(async () => {
      fireEvent.keyDown(past, { key: "End" });
    });
    expect(shownOf(container, "calendar")).toBe("compact regular wide");
    for (const pane of PANE_IDS) expect(counts.unmounted.get(pane) ?? 0, pane).toBe(0);
  });
});

// ------------------------------------------------------------ the stylesheet

const DESK_CSS = readFileSync(path.join(ROOT, "app/v2/desk.css"), "utf8");
const SHEET = postcss.parse(DESK_CSS, { from: "app/v2/desk.css" });

const REGULAR_MEDIA = "(1024px <= width < 1600px)";
const WIDE_MEDIA = "(min-width: 1600px)";
const COMPACT_MEDIA = "(width < 1024px)";

/** The rules directly in one media block, or at the top level for null. */
function rulesIn(media: string | null): Rule[] {
  const parent: Container | undefined =
    media === null
      ? SHEET
      : (SHEET.nodes.find(
          (node) => node.type === "atrule" && (node as AtRule).name === "media" && (node as AtRule).params === media,
        ) as AtRule | undefined);
  if (parent === undefined) return [];
  return (parent.nodes ?? []).filter((node): node is Rule => node.type === "rule");
}

function declsOf(selector: string, media: string | null): Record<string, string> {
  const rule = rulesIn(media).find((candidate) => candidate.selectors.includes(selector));
  if (rule === undefined) throw new Error(`no rule ${selector} in ${media ?? "the top level"}`);
  const out: Record<string, string> = {};
  rule.walkDecls((decl: Declaration) => {
    out[decl.prop] = decl.value;
  });
  return out;
}

describe("desk.css", () => {
  test("switches at the queries useTiles reads", () => {
    expect(TILED_QUERY).toBe("(min-width: 1024px)");
    expect(WIDE_QUERY).toBe(WIDE_MEDIA);
    const medias = SHEET.nodes
      .filter((node): node is AtRule => node.type === "atrule" && node.name === "media")
      .map((node) => node.params);
    for (const media of [TILED_QUERY, REGULAR_MEDIA, WIDE_MEDIA, COMPACT_MEDIA]) {
      expect(medias, media).toContain(media);
    }
  });

  test("makes the workspace the size container, with no padding and no border", () => {
    const work = declsOf("[data-v2-root] .v2-desk-work", null);
    expect(work["container-type"]).toBe("size");
    expect(work.position).toBe("relative");
    expect(work.padding).toBe("0");
    expect(work.border).toBe("0");
    // Only a margin from 1024px: still no padding and no border.
    expect(declsOf("[data-v2-root] .v2-desk-work", TILED_QUERY)).toEqual({ margin: "6px" });
  });

  test("covers the workspace with the stage", () => {
    expect(declsOf("[data-v2-root] .v2-desk-stage", null)).toEqual({
      position: "absolute",
      inset: "0",
    });
  });

  test("makes nothing a size container but the workspace and the pane's own box", () => {
    const containers: string[] = [];
    SHEET.walkDecls("container-type", (decl) => {
      containers.push((decl.parent as Rule).selector);
    });
    expect(containers.sort()).toEqual(["[data-v2-root] .v2-desk-work", "[data-v2-root] .v2-pane"]);
  });

  test("hides every frame and divider until a class shows it, and places them absolutely", () => {
    const frame = declsOf("[data-v2-root] .v2-frame", null);
    expect(frame.display).toBe("none");
    expect(frame.position).toBe("absolute");
    const divider = declsOf("[data-v2-root] .v2-divider", null);
    expect(divider.display).toBe("none");
    expect(divider.position).toBe("absolute");
    for (const side of SIDES) expect(divider[side]).toBe(`var(${dividerVar(side)})`);
  });

  test("draws each tiled class's frames from that class's own properties", () => {
    for (const [cls, media] of [
      ["regular", REGULAR_MEDIA],
      ["wide", WIDE_MEDIA],
    ] as const) {
      const shown = declsOf(`[data-v2-root] .v2-frame[data-shown~="${cls}"]`, media);
      expect(shown.display).toBe("flex");
      for (const side of SIDES) expect(shown[side], `${cls} ${side}`).toBe(`var(${frameVar(cls, side)})`);
      const work = declsOf("[data-v2-root] .v2-desk-work", media);
      expect(work["min-width"]).toBe(`var(${minVar(cls, "w")})`);
      expect(work["min-height"]).toBe(`var(${minVar(cls, "h")})`);
      expect(declsOf(`[data-v2-root] .v2-frame-tabs[data-in~="${cls}"]`, media).display).toBe("flex");
      expect(declsOf(`[data-v2-root] .v2-frame-name[data-strip~="${cls}"]`, media).display).toBe("none");
      expect(declsOf(`[data-v2-root] .v2-divider[data-shown~="${cls}"]`, media).display).toBe("block");
    }
  });

  test("shows on a phone only the front tab of the one leaf, filling the slot", () => {
    const compact = declsOf('[data-v2-root] .v2-frame[data-shown~="compact"]', COMPACT_MEDIA);
    expect(compact.display).toBe("flex");
    expect(compact.inset).toBe("0");
    const shownRules = rulesIn(COMPACT_MEDIA).filter((rule) => rule.selector.includes("data-shown"));
    expect(shownRules.map((rule) => rule.selector)).toEqual([
      '[data-v2-root] .v2-frame[data-shown~="compact"]',
    ]);
  });

  // The stage's --v2-wide-w is the whole workspace; a frame's width is
  // --v2-frame-wide-width. A transposed name sizes a frame to the workspace,
  // silently, so the sheet never names the stage's properties at all, and each
  // class's frame properties are read only inside that class's block.
  test("never names the stage's properties, and reads a class's frame properties only in its block", () => {
    expect(DESK_CSS).not.toMatch(/--v2-(regular|wide)-/);
    for (const [cls, media] of [
      ["regular", REGULAR_MEDIA],
      ["wide", WIDE_MEDIA],
    ] as const) {
      SHEET.walkDecls((decl) => {
        const named = [...decl.value.matchAll(/--v2-(frame|desk)-(regular|wide)-/g)].map((m) => m[2]);
        if (!named.includes(cls)) return;
        const block = decl.parent?.parent as AtRule | undefined;
        expect(block?.type === "atrule" && block.params, decl.toString()).toBe(media);
      });
    }
  });

  test("makes the scroller the containing block of what a body positions absolutely", () => {
    expect(declsOf("[data-v2-root] .v2-pane-body", null).position).toBe("relative");
  });

  test("says the day's notice once, not again in the day pane", () => {
    expect(declsOf("[data-v2-root] .v2-desk .v2-pane .v2-notice", null)).toEqual({ display: "none" });
  });

  test("fills the window between a phone and a laptop, where Today is framed", () => {
    expect(
      declsOf("[data-v2-root]:has(> .v2-desk)", "(min-width: 520px) and (max-width: 1023.98px)"),
    ).toEqual({ padding: "0" });
  });

  test("animates nothing", () => {
    const moving: string[] = [];
    SHEET.walkDecls(/^(transition|animation)/, (decl) => {
      moving.push(decl.toString());
    });
    expect(moving).toEqual([]);
  });

  test("words the desk without a dash", () => {
    const words = Object.values(DESK_COPY).join("\n");
    expect(words).not.toContain(String.fromCodePoint(0x2014));
    expect(words).not.toContain(String.fromCodePoint(0x2013));
  });
});
