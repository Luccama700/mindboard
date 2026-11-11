"use client";

import {
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import {
  GAP,
  RATIO_MAX,
  RATIO_MIN,
  drawnShare,
  extentVars,
  layoutTree,
  normalizeRatio,
  ratioText,
  shareLimits,
  workspaceFromComputed,
  type Arrangement,
  type CssBox,
  type ScreenClass,
  type Split,
  type SplitDir,
  type TileNode,
  type Workspace,
} from "@/app/lib/v2/tiles";
import { DESK_COPY, deskLine } from "@/app/lib/v2/view/desk";
import { BOX_SIDES, titleOf, type TiledClass } from "./pane-frame";

export interface DeskDivider {
  cls: TiledClass;
  /** The split's pre-order index, which is also what keys it: split ids are minted again on a load. */
  index: number;
  splitId: string;
  dir: SplitDir;
  ratioVar: string;
  box: CssBox;
  /** False when a maximized pane covers the workspace on this class. */
  shown: boolean;
}

/** The property a divider's box is written in. A divider belongs to one class. */
export function dividerVar(side: (typeof BOX_SIDES)[number]): string {
  return `--v2-divider-${side}`;
}

// A divider: the 6px gap between two frames, made a separator a pointer can
// drag and a keyboard can move.
//
// THE ENGINE OWNS THE RATIO. While a pointer moves, the share it asks for is
// written straight onto the STAGE (where the geometry's registered properties
// live), held to the engine's own limits for this split at this size, with no
// React render; the registered number recomputes every length that depends on
// it. Letting go commits it in one action (`setRatio`). Escape, a cancelled
// pointer and a lost capture commit nothing. In every one of those cases the
// stored ratio is first written back to the stage through `ratioText`, the
// geometry's own formatter: React does not rewrite a style it believes
// unchanged, so a drag that ended where it began would otherwise leave its
// last raw value on the stage. A commit that does change the ratio is then
// written by React, in the same task, before anything is painted.
//
// EVERY SIZE IS THE BROWSER'S. The workspace handed to the engine is the one
// the stage computed (`workspaceFromComputed` over its two extent properties),
// never a measured rectangle. When the stylesheet has not applied yet that is
// null, and the divider does nothing.

/** The workspace the browser computed on the stage for one tiled class, or null. */
export function measureWorkspace(stage: HTMLElement | null, cls: TiledClass): Workspace | null {
  if (stage === null || typeof window === "undefined") return null;
  const names = extentVars(cls);
  const style = window.getComputedStyle(stage);
  return workspaceFromComputed(style.getPropertyValue(names.w), style.getPropertyValue(names.h));
}

/** The split with this id, read off the tree as it is. */
export function splitNode(node: TileNode | null, id: string): Split | null {
  if (node === null || node.kind === "leaf") return null;
  if (node.id === id) return node;
  return splitNode(node.first, id) ?? splitNode(node.second, id);
}

/** Where one split is, and what it may be, on a workspace: all of it the engine's answer. */
export interface SplitGeometry {
  split: Split;
  /** The split's own span along its direction, and where it starts. */
  start: number;
  size: number;
  /** Where its divider is now, along the same axis. */
  at: number;
  low: number;
  high: number;
  /** The share drawn now: the stored one, held to the limits. */
  now: number;
}

export function splitGeometry(
  arrangement: Arrangement,
  splitId: string,
  workspace: Workspace,
): SplitGeometry | null {
  const split = splitNode(arrangement.tree, splitId);
  if (split === null) return null;
  const rect = layoutTree(arrangement, workspace).dividers.find((candidate) => candidate.splitId === splitId);
  if (rect === undefined) return null;
  const [low, high] = shareLimits(split, rect.size);
  return {
    split,
    start: rect.start,
    size: rect.size,
    at: split.dir === "h" ? rect.x : rect.y,
    low,
    high,
    now: drawnShare(split, rect.size),
  };
}

/** A share as a separator's value: whole percents. */
function percent(share: number): number {
  return Math.round(share * 100);
}

/** What one key does to a divider, or null for a key it does not take. */
function keyedShare(
  key: string,
  shift: boolean,
  dir: Split["dir"],
  geometry: SplitGeometry,
): number | "equal" | null {
  const step = shift ? 0.1 : 0.02;
  const back = dir === "h" ? "ArrowLeft" : "ArrowUp";
  const on = dir === "h" ? "ArrowRight" : "ArrowDown";
  if (key === back) return geometry.now - step;
  if (key === on) return geometry.now + step;
  if (key === "Home") return geometry.low;
  if (key === "End") return geometry.high;
  if (key === "Enter") return "equal";
  return null;
}

interface Drag {
  pointerId: number;
  geometry: SplitGeometry;
  /** Where in the divider the pointer took hold, so the gap does not jump to the pointer. */
  grab: number;
  origin: number;
  raw: number | null;
}

/** The front pane of a subtree's first leaf: what a divider is named after on that side. */
function frontOf(node: TileNode): string {
  return node.kind === "leaf" ? node.active : frontOf(node.first);
}

function dividerStyle(divider: DeskDivider): CSSProperties {
  const style: Record<string, string> = {};
  for (const side of BOX_SIDES) style[dividerVar(side)] = divider.box[side];
  return style as CSSProperties;
}

export function Divider({
  divider,
  arrangement,
  stage,
  measured,
  cls,
  onRatio,
  onEqualize,
}: {
  divider: DeskDivider;
  /** The arrangement of the layout on screen, on this divider's class. */
  arrangement: Arrangement;
  stage: RefObject<HTMLDivElement | null>;
  /** The workspace last computed for this divider's class, for the values it announces. */
  measured: Workspace | null;
  cls: ScreenClass | null;
  onRatio(cls: TiledClass, splitId: string, ratio: number, size: number): void;
  onEqualize(cls: TiledClass, splitId: string): void;
}) {
  const drag = useRef<Drag | null>(null);
  const split = splitNode(arrangement.tree, divider.splitId);
  const shown = measured === null ? null : splitGeometry(arrangement, divider.splitId, measured);
  const stored = split?.ratio ?? 0.5;
  const live = cls === divider.cls && divider.shown;

  const geometryNow = (): SplitGeometry | null => {
    const workspace = measureWorkspace(stage.current, divider.cls);
    return workspace === null ? null : splitGeometry(arrangement, divider.splitId, workspace);
  };

  const write = (share: number) => {
    stage.current?.style.setProperty(divider.ratioVar, ratioText(share));
  };

  const finish = (element: HTMLElement) => {
    const held = drag.current;
    drag.current = null;
    if (held === null) return null;
    stage.current?.removeAttribute("data-drag");
    if (element.hasPointerCapture?.(held.pointerId)) element.releasePointerCapture(held.pointerId);
    write(held.origin);
    return held;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || drag.current !== null) return;
    const geometry = geometryNow();
    if (geometry === null || stage.current === null) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.focus({ preventScroll: true });
    element.setPointerCapture?.(event.pointerId);
    const box = stage.current.getBoundingClientRect();
    const position = divider.dir === "h" ? event.clientX - box.left : event.clientY - box.top;
    drag.current = {
      pointerId: event.pointerId,
      geometry,
      grab: position - geometry.at,
      origin: geometry.split.ratio,
      raw: null,
    };
    stage.current.setAttribute("data-drag", divider.dir);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (held === null || event.pointerId !== held.pointerId || stage.current === null) return;
    const box = stage.current.getBoundingClientRect();
    const position = divider.dir === "h" ? event.clientX - box.left : event.clientY - box.top;
    const { geometry } = held;
    const inner = geometry.size - GAP;
    if (!(inner > 0)) return;
    held.raw = (position - held.grab - geometry.start) / inner;
    // What setRatio will store for this raw share at this size, so what is
    // drawn while dragging is what is kept on release.
    write(normalizeRatio(Math.min(geometry.high, Math.max(geometry.low, held.raw))));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null || event.pointerId !== drag.current.pointerId) return;
    const held = finish(event.currentTarget);
    if (held === null || held.raw === null) return;
    onRatio(divider.cls, divider.splitId, held.raw, held.geometry.size);
  };

  const cancel = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null || event.pointerId !== drag.current.pointerId) return;
    finish(event.currentTarget);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      if (drag.current === null) return;
      event.preventDefault();
      finish(event.currentTarget);
      return;
    }
    if (drag.current !== null) return;
    const geometry = geometryNow();
    if (geometry === null) return;
    const share = keyedShare(event.key, event.shiftKey, divider.dir, geometry);
    if (share === null) return;
    event.preventDefault();
    if (share === "equal") onEqualize(divider.cls, divider.splitId);
    else onRatio(divider.cls, divider.splitId, share, geometry.size);
  };

  const onDoubleClick = () => {
    if (geometryNow() === null) return;
    onEqualize(divider.cls, divider.splitId);
  };

  const name =
    split === null
      ? ""
      : deskLine(DESK_COPY.divider, {
          first: titleOf(frontOf(split.first)),
          second: titleOf(frontOf(split.second)),
        });

  return (
    <div
      className="v2-divider"
      role="separator"
      aria-orientation={divider.dir === "h" ? "vertical" : "horizontal"}
      aria-label={name}
      aria-valuenow={percent(shown?.now ?? stored)}
      aria-valuemin={percent(shown?.low ?? RATIO_MIN)}
      aria-valuemax={percent(shown?.high ?? RATIO_MAX)}
      tabIndex={0}
      inert={cls !== null && !live}
      data-class={divider.cls}
      data-dir={divider.dir}
      data-split={divider.index}
      data-shown={divider.shown ? divider.cls : ""}
      style={dividerStyle(divider)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
