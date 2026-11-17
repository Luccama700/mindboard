// Turning a split tree into rectangles, and turning a pointer back into a
// place to drop.
//
// WHY THE RATIOS ARE NOT STORED AS PIXELS. A workspace changes size: the window
// is resized, the screen class changes, a pane opens. A layout held as pixels
// has to be rewritten every time, and every rewrite is a chance to lose the
// proportion the user set. A ratio survives all of it, and the only thing that
// depends on the current size is the drawing.
//
// So this module READS and never writes. It clamps a ratio to what the two
// sides' minimum sizes allow, but only for the rectangles it returns: nothing
// here hands a clamped value back to the tree. That is the whole reason a tree
// laid out on a phone sized workspace and then on the real one comes back with
// the rectangles it started with.
//
// Every `specs` parameter defaults to the catalog's panes. A caller passes its
// own only to measure panes the catalog does not have, which is what the tests
// of this module and of css.ts do.
//
// Pure. It does not import the tree module, so the one dependency runs the
// other way (tree.ts needs shareLimits for a drag and layoutTree to open a
// pane) and there is no cycle. The catalog imports nothing but the types.
//
// THIS FILE IS NOT CALLED layout.ts, and must not be. Next reads any layout
// file anywhere under app/ as a route layout, folder depth and route segments
// notwithstanding, and type checks its exports against a layout component: the
// production build fails on a module that exports functions instead. The guard
// is __tests__/v2-reserved-filenames.test.ts.

import { PANES } from "./catalog";
import type {
  Arrangement,
  Direction,
  PaneId,
  PaneSpec,
  Rect,
  Split,
  TileNode,
  TileRects,
  Workspace,
  Zone,
} from "./types";

/** The space between two panes, and the width of the divider that sits in it. */
export const GAP = 6;

/** The share a split falls back to when its two sides cannot both fit. */
const EVEN_SHARE = 0.5;

/**
 * How close to an edge a pointer has to be for the drop to mean "dock on that
 * side" rather than "make a tab". Just over a quarter, so the centre target is
 * still the largest one: making a tab is the common intent.
 */
const EDGE_FRACTION = 0.27;

/**
 * How far two leaves may be from exactly one gap apart and still count as
 * touching. A divider is drawn at a rounded pixel, so a shared edge can miss by
 * a pixel on either side.
 */
const TOUCH_TOLERANCE = 2;

/** A length, with anything that is not a usable number read as nothing. */
function extent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function along(dir: Split["dir"], size: { w: number; h: number }): number {
  return dir === "h" ? size.w : size.h;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * The smallest this node can be drawn at. A leaf takes the largest minimum
 * among its tabs, because a tab stack has to hold whichever tab is in front.
 *
 * A tab with no spec contributes nothing. The parser drops panes the catalog
 * does not know, so that can only happen to a tree built by hand.
 */
export function minSize(
  node: TileNode,
  specs: readonly PaneSpec[] = PANES,
): { w: number; h: number } {
  if (node.kind === "leaf") {
    let w = 0;
    let h = 0;
    for (const tab of node.tabs) {
      const spec = specs.find((candidate) => candidate.id === tab);
      if (spec === undefined) continue;
      w = Math.max(w, extent(spec.minWidth));
      h = Math.max(h, extent(spec.minHeight));
    }
    return { w, h };
  }
  const first = minSize(node.first, specs);
  const second = minSize(node.second, specs);
  return node.dir === "h"
    ? { w: first.w + second.w + GAP, h: Math.max(first.h, second.h) }
    : { w: Math.max(first.w, second.w), h: first.h + second.h + GAP };
}

/**
 * The lowest and highest share the first child may take at this size, so that
 * neither side goes under its minimum.
 *
 * Both sides fitting is checked as `firstMin + secondMin > free` rather than as
 * `low > high`, because the two divisions that follow can disagree by one bit
 * and the sum cannot: minimum sizes are whole pixels. When they do disagree,
 * `clamp` below prefers the low end, which is the first child's own minimum, and
 * the second child then gets exactly the rest.
 */
export function shareLimits(
  split: Split,
  size: number,
  specs: readonly PaneSpec[] = PANES,
): [number, number] {
  const free = extent(size) - GAP;
  const firstMin = along(split.dir, minSize(split.first, specs));
  const secondMin = along(split.dir, minSize(split.second, specs));
  if (free <= 0 || firstMin + secondMin > free) return [EVEN_SHARE, EVEN_SHARE];
  return [firstMin / free, 1 - secondMin / free];
}

/** The share a split is drawn at here and now, which is not what it stores. */
export function drawnShare(
  split: Split,
  size: number,
  specs: readonly PaneSpec[] = PANES,
): number {
  const [low, high] = shareLimits(split, size, specs);
  const wanted = Number.isFinite(split.ratio) ? split.ratio : EVEN_SHARE;
  return clamp(wanted, low, high);
}

function leafIdHolding(node: TileNode, pane: PaneId): string | null {
  if (node.kind === "leaf") return node.tabs.includes(pane) ? node.id : null;
  return leafIdHolding(node.first, pane) ?? leafIdHolding(node.second, pane);
}

/**
 * One rectangle per leaf and one per divider, covering the workspace exactly.
 *
 * A split gives its first child `round((span - GAP) * share)`, then the gap,
 * then whatever is left, so the three always add back to the span: there is no
 * rounding slack to leak into a seam. A span smaller than the gap is spent
 * entirely on the divider, which keeps every number at or above zero on a
 * workspace that has not been measured yet.
 *
 * When a pane is maximized its leaf is given the whole workspace. The other
 * rectangles are still returned as they would be, so a renderer can animate
 * from and back to them.
 */
export function layoutTree(
  arrangement: Arrangement,
  workspace: Workspace,
  specs: readonly PaneSpec[] = PANES,
): TileRects {
  const width = extent(workspace.width);
  const height = extent(workspace.height);
  const out: TileRects = { leaves: [], dividers: [] };
  const tree = arrangement.tree;
  if (tree === null) return out;

  const place = (node: TileNode, x: number, y: number, w: number, h: number): void => {
    if (node.kind === "leaf") {
      out.leaves.push({ leafId: node.id, x, y, w, h });
      return;
    }
    const horizontal = node.dir === "h";
    const span = horizontal ? w : h;
    const gap = Math.min(GAP, span);
    const inner = span - gap;
    const first = clamp(Math.round(inner * drawnShare(node, span, specs)), 0, inner);
    const second = inner - first;
    if (horizontal) {
      place(node.first, x, y, first, h);
      out.dividers.push({
        splitId: node.id,
        dir: node.dir,
        x: x + first,
        y,
        w: gap,
        h,
        start: x,
        size: span,
      });
      place(node.second, x + first + gap, y, second, h);
    } else {
      place(node.first, x, y, w, first);
      out.dividers.push({
        splitId: node.id,
        dir: node.dir,
        x,
        y: y + first,
        w,
        h: gap,
        start: y,
        size: span,
      });
      place(node.second, x, y + first + gap, w, second);
    }
  };
  place(tree, 0, 0, width, height);

  const maximized = arrangement.maximized;
  const maximizedLeaf = maximized === null ? null : leafIdHolding(tree, maximized);
  if (maximizedLeaf !== null) {
    out.leaves = out.leaves.map((rect) =>
      rect.leafId === maximizedLeaf ? { ...rect, x: 0, y: 0, w: width, h: height } : rect,
    );
  }
  return out;
}

/**
 * The leaf next to this one in that direction: among the leaves that share an
 * edge with it, the one that shares the most of it. Measured on the rectangles
 * rather than on the tree, because what reads as "to the right" on screen is a
 * question about pixels and not about which branch a node sits in.
 */
export function neighbourOf(
  rects: TileRects,
  leafId: string,
  dir: Direction,
): string | null {
  const from = rects.leaves.find((rect) => rect.leafId === leafId);
  if (from === undefined) return null;
  let best: string | null = null;
  let bestOverlap = 0;
  for (const other of rects.leaves) {
    if (other.leafId === leafId) continue;
    const overlap =
      dir === "left" || dir === "right"
        ? Math.min(from.y + from.h, other.y + other.h) - Math.max(from.y, other.y)
        : Math.min(from.x + from.w, other.x + other.w) - Math.max(from.x, other.x);
    if (!(overlap > 0)) continue;
    const touch =
      dir === "left"
        ? Math.abs(other.x + other.w + GAP - from.x)
        : dir === "right"
          ? Math.abs(from.x + from.w + GAP - other.x)
          : dir === "up"
            ? Math.abs(other.y + other.h + GAP - from.y)
            : Math.abs(from.y + from.h + GAP - other.y);
    if (!(touch <= TOUCH_TOLERANCE)) continue;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = other.leafId;
    }
  }
  return best;
}

/**
 * What a drop at this point inside this rectangle means: the nearest edge when
 * the point is within EDGE_FRACTION of it, and otherwise "make a tab".
 *
 * A rectangle with no width or height has no edges to be near, so it reads as
 * the centre rather than as a division by nothing.
 */
export function zoneAt(rect: Rect, x: number, y: number): Zone {
  if (!(rect.w > 0) || !(rect.h > 0)) return "centre";
  const fromLeft = (x - rect.x) / rect.w;
  const fromTop = (y - rect.y) / rect.h;
  const edges: Array<[Zone, number]> = [
    ["left", fromLeft],
    ["right", 1 - fromLeft],
    ["top", fromTop],
    ["bottom", 1 - fromTop],
  ];
  let nearest = edges[0];
  for (const edge of edges) {
    if (edge[1] < nearest[1]) nearest = edge;
  }
  return nearest[1] < EDGE_FRACTION ? nearest[0] : "centre";
}

/** The part of the rectangle a drop in that zone would take. */
export function zoneRect(rect: Rect, zone: Zone): Rect {
  switch (zone) {
    case "left":
      return { x: rect.x, y: rect.y, w: rect.w / 2, h: rect.h };
    case "right":
      return { x: rect.x + rect.w / 2, y: rect.y, w: rect.w / 2, h: rect.h };
    case "top":
      return { x: rect.x, y: rect.y, w: rect.w, h: rect.h / 2 };
    case "bottom":
      return { x: rect.x, y: rect.y + rect.h / 2, w: rect.w, h: rect.h / 2 };
    default:
      return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }
}
