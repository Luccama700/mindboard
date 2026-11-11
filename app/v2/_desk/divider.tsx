"use client";

import {
  useEffect,
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

/** The moves a key makes on a divider. */
type KeyMove = "back" | "on" | "home" | "end" | "equal";

/**
 * What one key does to a divider, or null for a key it does not take (a
 * modifier on its own included). It is the one answer to "does this key do
 * anything here", so it also decides whether a key may end a drag.
 */
export function keyMove(key: string, dir: Split["dir"]): KeyMove | null {
  if (key === (dir === "h" ? "ArrowLeft" : "ArrowUp")) return "back";
  if (key === (dir === "h" ? "ArrowRight" : "ArrowDown")) return "on";
  if (key === "Home") return "home";
  if (key === "End") return "end";
  if (key === "Enter") return "equal";
  return null;
}

/** The share a move asks for, from the share drawn now: 2 percent, 10 with Shift. */
function keyedShare(move: KeyMove, shift: boolean, geometry: SplitGeometry): number | "equal" {
  const step = shift ? 0.1 : 0.02;
  if (move === "back") return geometry.now - step;
  if (move === "on") return geometry.now + step;
  if (move === "home") return geometry.low;
  if (move === "end") return geometry.high;
  return "equal";
}

interface Drag {
  pointerId: number;
  geometry: SplitGeometry;
  /** Where in the divider the pointer took hold, so the gap does not jump to the pointer. */
  grab: number;
  raw: number | null;
  /**
   * What the drag belongs to: a layout on a class, and the split it started on.
   * Dividers are keyed by class and place and split ids are positional, so the
   * same divider can find itself over another layout's split of the same id
   * (Back, Forward, a layout opened from the keyboard mid drag): the drag then
   * ends, and a release commits nothing. Not the arrangement object: a write
   * from another tab can bring in an equal arrangement as a new object, and a
   * drag must not die under the hand for that.
   */
  layout: string | null;
  cls: TiledClass;
  splitId: string;
  /** The element that holds the pointer, so it can be let go from anywhere. */
  element: HTMLElement;
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

  /**
   * The layout on screen, as the desk last drew it: its root says so. Read off
   * the page rather than handed down, so a divider needs nothing it did not
   * already have; null when the divider is drawn outside a desk.
   */
  const layoutNow = (): string | null =>
    stage.current?.closest(".v2-desk")?.getAttribute("data-layout") ?? null;

  /** Whether a recorded drag still belongs to what is on screen: its layout, its class, its split. */
  const belongs = (held: Drag): boolean =>
    held.layout === layoutNow() && (cls === null || cls === held.cls) && held.splitId === divider.splitId;

  /**
   * End the drag, committing nothing: the drag mark off the stage, the pointer
   * let go, and the ratio the engine holds for this split NOW written back
   * (React does not rewrite a style it believes unchanged). Answers the drag
   * that ended, or null when there was none.
   */
  const finish = (): Drag | null => {
    const held = drag.current;
    drag.current = null;
    if (held === null) return null;
    stage.current?.removeAttribute("data-drag");
    if (held.element.hasPointerCapture?.(held.pointerId)) held.element.releasePointerCapture(held.pointerId);
    write(stored);
    return held;
  };

  // A drag lives only as long as what it was started on. When the layout on
  // screen, the class or the split changes under it, it ends, and commits
  // nothing.
  useEffect(() => {
    const held = drag.current;
    if (held !== null && !belongs(held)) finish();
  });

  // Unmounted mid drag: let the pointer and the stage go. No ratio is written:
  // the property this divider drove is no longer its own to restore.
  useEffect(() => {
    const node = stage.current;
    return () => {
      const held = drag.current;
      drag.current = null;
      if (held === null) return;
      node?.removeAttribute("data-drag");
      if (held.element.hasPointerCapture?.(held.pointerId)) held.element.releasePointerCapture(held.pointerId);
    };
  }, [stage]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    // A drag still recorded here lost its release (no pointerup, no lost
    // capture): it ends, uncommitted, and this press starts afresh.
    if (drag.current !== null) finish();
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
      raw: null,
      layout: layoutNow(),
      cls: divider.cls,
      splitId: divider.splitId,
      element,
    };
    stage.current.setAttribute("data-drag", divider.dir);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (held === null || event.pointerId !== held.pointerId || stage.current === null) return;
    // No button held: the release was lost. A hover never drags.
    if (event.buttons === 0) {
      finish();
      return;
    }
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
    const held = finish();
    if (held === null || held.raw === null) return;
    // Started on another layout, class or split than the one on screen: nothing to commit.
    if (!belongs(held)) return;
    onRatio(divider.cls, divider.splitId, held.raw, held.geometry.size);
  };

  const cancel = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null || event.pointerId !== drag.current.pointerId) return;
    finish();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape") {
      if (drag.current === null) return;
      event.preventDefault();
      finish();
      return;
    }
    // A key that does nothing here (a modifier on its own) leaves a drag alone,
    // and so does a held key repeating. A key that does something ends a drag
    // whose release was lost, uncommitted, and then does its own work.
    const move = keyMove(event.key, divider.dir);
    if (move === null) return;
    if (drag.current !== null) {
      if (event.repeat) return;
      finish();
    }
    const geometry = geometryNow();
    if (geometry === null) return;
    const share = keyedShare(move, event.shiftKey, geometry);
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
