"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";

import {
  PANES,
  arrangementOf,
  cssLayout,
  flatten,
  leafOf,
  leavesOf,
  openPanes,
  optionsOf,
  type Arrangement,
  type LayoutId,
  type PaneId,
  type ScreenClass,
  type TileSet,
  type Workspace as WorkspaceSize,
} from "@/app/lib/v2/tiles";
import { paneOptions } from "@/app/lib/v2/view/desk";
import { Divider, measureWorkspace, type DeskDivider } from "./divider";
import {
  PaneFrame,
  TILED_CLASSES,
  type DeskFrame,
  type FrameActions,
  type TiledClass,
} from "./pane-frame";

export { dividerVar, type DeskDivider } from "./divider";

// The workspace: one size container, one stage inside it, and on the stage the
// fourteen frames and the dividers of both tiled classes.
//
// THE SERVER DRAWS EVERY CLASS. It cannot know the window, so everything that
// depends on the class is written for every class and the stylesheet picks
// (desk.css, by the same media queries `useTiles` reads):
//   - the stage carries the registered properties of BOTH tiled classes, whose
//     names cannot collide (`--v2-regular-*`, `--v2-wide-*`);
//   - each frame carries its box once per tiled class, as
//     `--v2-frame-<class>-<side>`, and says in `data-shown` which classes it is
//     displayed in;
//   - the workspace carries each class's minimum as `--v2-desk-<class>-min-*`.
// The class the browser reports later only adds `inert`, and the roles that
// depend on it.
//
// FLAT AND STABLE. The stage's children are the fourteen frames in the
// catalog's order, keyed by pane id and nothing else, then the dividers. A
// frame is never moved, wrapped or keyed by a leaf: leaf and split ids are
// minted again whenever a saved layout is read, and a body under a frame that
// was re-keyed would be mounted again.

/** Every class, in the order `data-shown` lists them. */
export const SCREEN_CLASSES: readonly ScreenClass[] = ["compact", "regular", "wide"];

export interface DeskStage {
  /** Both tiled classes' registered properties, for the stage. */
  vars: Record<string, string>;
  /** The smallest workspace each tiled class can be drawn in. */
  min: Record<TiledClass, { w: number; h: number }>;
  /** The fourteen frames, in the catalog's order. */
  frames: DeskFrame[];
  /** Regular's dividers, then wide's. */
  dividers: DeskDivider[];
  /** The phone's one leaf: its tabs in order, and the one in front. */
  compact: { tabs: PaneId[]; active: PaneId | null };
}

/** The property the workspace's minimum is written in, for one class. */
export function minVar(cls: TiledClass, side: "w" | "h"): string {
  return `--v2-desk-${cls}-min-${side}`;
}

function sameTabs(a: readonly PaneId[], b: readonly PaneId[]): boolean {
  return a.length === b.length && a.every((tab, index) => tab === b[index]);
}

/**
 * Everything the desk draws for one layout, on every class at once. Pure: the
 * same set and layout give the same stage, which is what lets the server's HTML
 * and the browser's first render agree.
 */
export function deskStage(set: TileSet, layout: LayoutId): DeskStage {
  const vars: Record<string, string> = {};
  const min = { regular: { w: 0, h: 0 }, wide: { w: 0, h: 0 } };
  const dividers: DeskDivider[] = [];
  const byPane = new Map<PaneId, DeskFrame>();
  const strips = new Map<PaneId, Array<{ cls: TiledClass; tabs: PaneId[]; active: PaneId }>>();
  for (const pane of PANES) {
    byPane.set(pane.id, {
      pane,
      shown: [],
      open: [],
      boxes: {},
      strips: [],
      soloClose: [],
      maximized: [],
      panelIn: [],
    });
    strips.set(pane.id, []);
  }

  let compact: DeskStage["compact"] = { tabs: [], active: null };

  for (const cls of SCREEN_CLASSES) {
    // The phone's arrangement is one stack; the store keeps it flattened, and
    // flattening an arrangement that already is one changes nothing.
    const arrangement =
      cls === "compact"
        ? flatten(arrangementOf(set, layout, cls))
        : arrangementOf(set, layout, cls);
    const tree = arrangement.tree;
    const maximized =
      arrangement.maximized === null ? null : leafOf(tree, arrangement.maximized);
    const several = openPanes(tree).length > 1;

    const css = cls === "compact" ? null : cssLayout(tree, maximized?.id ?? null, PANES, cls);
    if (css !== null && cls !== "compact") {
      Object.assign(vars, css.vars);
      min[cls] = css.min;
      for (const divider of css.dividers) {
        dividers.push({
          cls,
          index: divider.index,
          splitId: divider.splitId,
          dir: divider.dir,
          ratioVar: divider.ratioVar,
          box: { left: divider.left, top: divider.top, width: divider.width, height: divider.height },
          shown: maximized === null,
        });
      }
    }

    for (const leaf of leavesOf(tree)) {
      if (cls === "compact" && compact.active === null) {
        compact = { tabs: [...leaf.tabs], active: leaf.active };
      }
      const box = css?.leaves.find((candidate) => candidate.leafId === leaf.id);
      for (const tab of leaf.tabs) {
        const frame = byPane.get(tab);
        if (frame === undefined) continue;
        frame.open.push(cls);
        const front = leaf.active === tab;
        const shown = front && (maximized === null || maximized.id === leaf.id);
        if (shown) frame.shown.push(cls);
        if (cls === "compact") {
          frame.panelIn.push(cls);
          continue;
        }
        if (box !== undefined) {
          frame.boxes[cls] = { left: box.left, top: box.top, width: box.width, height: box.height };
        }
        if (arrangement.maximized === tab) frame.maximized.push(cls);
        if (front && leaf.tabs.length > 1) {
          strips.get(tab)?.push({ cls, tabs: [...leaf.tabs], active: leaf.active });
        }
        if (leaf.tabs.length > 1) frame.panelIn.push(cls);
        else if (shown && several) frame.soloClose.push(cls);
      }
    }
  }

  // One strip element per distinct strip: a leaf that is the same on both
  // tiled classes draws one, marked for both.
  for (const [pane, raw] of strips) {
    const frame = byPane.get(pane) as DeskFrame;
    for (const strip of raw) {
      const same = frame.strips.find(
        (held) => held.active === strip.active && sameTabs(held.tabs, strip.tabs),
      );
      if (same !== undefined) same.classes.push(strip.cls);
      else frame.strips.push({ classes: [strip.cls], tabs: strip.tabs, active: strip.active });
    }
  }

  return {
    vars,
    min,
    frames: PANES.map((pane) => byPane.get(pane.id) as DeskFrame),
    dividers,
    compact,
  };
}

/** Each pane's options as a body is handed them: no prototype, frozen (see `paneOptions`). */
function optionsByPane(arrangement: Arrangement): Map<PaneId, Readonly<Record<string, string>>> {
  return new Map(
    PANES.map((pane) => [pane.id, paneOptions(Object.entries(optionsOf(arrangement, pane.id)))]),
  );
}

/**
 * One pixel past the tree's minimum, on each side.
 *
 * Under a fractional page zoom a browser holds a box a fraction under the
 * length it was given (819.98 for 820 at 90 percent). The stage floors the
 * workspace to whole pixels, so a workspace held at exactly `min` would read as
 * `min` less one, a split's two minimums would no longer fit, and the CSS and
 * the engine would then draw that split differently: a whole split apart, not a
 * pixel. The one pixel of slack keeps the floor at `min` or above. The minimum
 * is the tree on screen's, so it follows every change to that tree.
 */
export const MIN_SLACK = 1;

/** The workspace's minimum on each tiled class, as the custom properties desk.css reads. */
function minStyle(min: DeskStage["min"]): CSSProperties {
  const style: Record<string, string> = {};
  for (const cls of TILED_CLASSES) {
    style[minVar(cls, "w")] = `${min[cls].w + MIN_SLACK}px`;
    style[minVar(cls, "h")] = `${min[cls].h + MIN_SLACK}px`;
  }
  return style as CSSProperties;
}

type Measured = Record<TiledClass, WorkspaceSize | null>;

const NOTHING_MEASURED: Measured = { regular: null, wide: null };

function sameSize(a: WorkspaceSize | null, b: WorkspaceSize | null): boolean {
  if (a === null || b === null) return a === b;
  return a.width === b.width && a.height === b.height;
}

/**
 * The workspace each tiled class computes on the stage, read again whenever the
 * workspace is resized. It feeds only the values a divider announces; every
 * action reads the stage afresh when it is taken.
 */
function useMeasured(
  work: RefObject<HTMLElement | null>,
  stage: RefObject<HTMLDivElement | null>,
): Measured {
  const [measured, setMeasured] = useState<Measured>(NOTHING_MEASURED);
  useEffect(() => {
    const read = () => {
      const next: Measured = {
        regular: measureWorkspace(stage.current, "regular"),
        wide: measureWorkspace(stage.current, "wide"),
      };
      setMeasured((was) =>
        sameSize(was.regular, next.regular) && sameSize(was.wide, next.wide) ? was : next,
      );
    };
    if (typeof ResizeObserver === "function" && work.current !== null) {
      const observer = new ResizeObserver(read);
      observer.observe(work.current);
      return () => observer.disconnect();
    }
    const frame = window.requestAnimationFrame(read);
    window.addEventListener("resize", read);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", read);
    };
  }, [work, stage]);
  return measured;
}

/**
 * What the workspace asks the desk to do besides the frames' own actions. A
 * divider's change carries `layout`, the layout the divider was drawn and
 * measured on, so the reducer can refuse it once another layout is on screen.
 */
export interface WorkspaceActions extends FrameActions {
  onRatio(cls: TiledClass, splitId: string, ratio: number, size: number, layout: LayoutId): void;
  onEqualize(cls: TiledClass, splitId: string, layout: LayoutId): void;
}

/**
 * The workspace and its stage.
 *
 * The workspace is the size container the stage's properties measure (`100cqw`
 * and `100cqh`), with no padding and no border, so its size is the size hit
 * testing will measure. The stage covers it exactly and is the ONE element that
 * sets the properties; nothing between a frame and the stage, or between the
 * stage and the workspace, is a size container. `stageRef` is how the desk
 * reads what the stage computed, and where a drag writes.
 *
 * A body's options follow the class on screen; before the browser has said
 * which that is, they are regular's, on the server and in the first render
 * alike.
 */
export function Workspace({
  set,
  stage,
  cls,
  stageRef,
  actions,
}: {
  set: TileSet;
  stage: DeskStage;
  cls: ScreenClass | null;
  stageRef?: RefObject<HTMLDivElement | null>;
  actions?: WorkspaceActions;
}) {
  const reference = arrangementOf(set, set.current, cls ?? "regular");
  const options = useMemo(() => optionsByPane(reference), [reference]);
  const work = useRef<HTMLElement>(null);
  const ownStage = useRef<HTMLDivElement>(null);
  const stageElement = stageRef ?? ownStage;
  const measured = useMeasured(work, stageElement);
  const act = actions ?? NO_ACTIONS;

  return (
    <main ref={work} className="v2-desk-work" style={minStyle(stage.min)}>
      <div ref={stageElement} className="v2-desk-stage" style={stage.vars as CSSProperties}>
        {stage.frames.map((frame) => (
          <PaneFrame
            key={frame.pane.id}
            frame={frame}
            cls={cls}
            desk={set}
            options={options.get(frame.pane.id) as Readonly<Record<string, string>>}
            actions={act}
          />
        ))}
        {stage.dividers.map((divider) => {
          // The layout this divider is drawn on, which its changes carry.
          const drawnOn = set.current;
          return (
            <Divider
              key={`${divider.cls}-${divider.index}`}
              divider={divider}
              arrangement={arrangementOf(set, drawnOn, divider.cls)}
              stage={stageElement}
              measured={measured[divider.cls]}
              cls={cls}
              onRatio={(on, splitId, ratio, size) => act.onRatio(on, splitId, ratio, size, drawnOn)}
              onEqualize={(on, splitId) => act.onEqualize(on, splitId, drawnOn)}
            />
          );
        })}
      </div>
    </main>
  );
}

/** A workspace drawn on its own (a test, the gallery of a later task) answers nothing. */
const NO_ACTIONS: WorkspaceActions = {
  onTab: () => {},
  onClose: () => {},
  onMaximize: () => {},
  menuItems: () => [],
  onMenu: () => {},
  onDragStart: () => {},
  onRatio: () => {},
  onEqualize: () => {},
};
