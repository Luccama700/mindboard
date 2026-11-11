// The tile engine's geometry, written a second time as CSS lengths.
//
// WHY THERE ARE TWO FORMS. The server draws a saved layout without knowing how
// wide the window is, and the browser has to reflow it on every resize without
// running script. So what the page carries cannot be a list of rectangles: it
// has to be the formula itself, for the browser to evaluate. layoutTree in
// geometry.ts is that formula as numbers, which is what hit testing and the
// keyboard use on the measured workspace. This module is the same formula as
// CSS. __tests__/v2-tiles-css.test.ts evaluates these strings the way a browser
// does and holds every box to layoutTree's rectangle to the pixel, at whole and
// fractional workspace sizes, so the two cannot drift apart.
//
// THE CONTRACT WITH THE PAGE. Four things, all required:
//
//  1. propertyRules(scopes) goes into a stylesheet once, before the first
//     paint. It registers every name this module can write (the pool below) as
//     a <length> or a <number>. A registered property is computed once, on the
//     element that sets it, to one value; a var() of it then substitutes that
//     one value. Unregistered, var() would substitute text, and the text of a
//     deep split would be the text of every split above it, doubling per level
//     until the browser's cap on substitution throws the declaration away.
//  2. The workspace box is a size container: `container-type: size`, not
//     inline-size, because the height is read from it too. It has no padding
//     and no border, so its container size is the box hit testing measures,
//     and it takes min-width and min-height from `min`.
//  3. ONE element inside it, the stage, carries `vars` as its style. Nothing
//     between the stage and the workspace is a size container, so `100cqw` and
//     `100cqh` in its properties are the workspace's own width and height (an
//     element's container units never read the element itself). It covers the
//     workspace exactly: `position: absolute; inset: 0` on a workspace that is
//     a positioning parent does it.
//  4. Every frame and every divider is a descendant of the stage, absolutely
//     positioned against it, with left, top, width and height from `leaves` and
//     `dividers`. The properties inherit, so a box reads the stage's values.
//
// And hit testing measures the workspace (getBoundingClientRect, which keeps
// the fraction) and passes the size through hitTestWorkspace before layoutTree,
// because the CSS floors it the same way.
//
// THE POOL. Names are fixed so they can be registered statically, and a split
// is addressed by its pre-order index k (1 first), never by its id: an id can be
// anything the tree was given, an index is always in 1 to MAX_SPLITS. Per scope:
//
//   --v2-<scope>-w, --v2-<scope>-h   the workspace's extent in whole pixels: <length>
//   --v2-<scope>-a<k>                split k's first child's extent: <length>
//   --v2-<scope>-r<k>                split k's ratio: <number>
//
// A scope is a screen class, so the regular and wide layouts can sit on one
// stage. `rail` is taken (v2.css has --v2-rail-w); the test keeps the pool of
// `regular` and `wide` clear of every name in the desk's stylesheets.
//
// THE FORMULA. The workspace is `round(down, 100cqw, 1px)` by
// `round(down, 100cqh, 1px)`: whole pixels at any zoom, which is what lets the
// two forms agree everywhere and not only at whole pixel window sizes. A split
// whose extent along its direction is S gives its first child
//
//   round(nearest, clamp(<min first>px, (S - 6px) * <ratio>, S - 6px - <min second>px), 1px)
//
// then the 6px gap, then the rest. That is layoutTree's
// `round(inner * clamp(ratio, firstMin / inner, 1 - secondMin / inner))` with
// the clamp moved from shares to lengths, and CSS round(nearest) breaks a tie
// toward positive infinity exactly as Math.round does. The ratio written is the
// one drawnShare uses: the stored value when it is a finite number, an even
// share when it is not. It is held to 0 to 1 first, which changes no rectangle
// (both limits of a split whose sides fit lie inside 0 to 1) and keeps the
// number short.
//
// Every box, and every S, is a sum: the workspace's w or h, minus or plus the
// a<k> of the splits above it, plus or minus whole multiples of the gap. So a
// string is linear in the depth of its node, every var() in it is one computed
// value, and no a<k> contains another's definition, only a var() of it.
//
// WHERE THE TWO FORMS STOP AGREEING. They agree exactly when every split's two
// minimums fit inside its own extent less the gap. On a workspace at least
// `min` in both dimensions once floored, with whole pixel minimums, that is
// every split: the root fits by the definition of `min`, and a split that fits
// hands each child at least that child's minimum, because both ends of the clamp
// are whole pixels and rounding cannot carry a value past either one. The
// test's sizes start at `min` for this reason.
//
// Where the minimums do not fit, the engine draws the split at an even share
// (shareLimits answers [0.5, 0.5]) and the CSS does not: a clamp whose lower
// bound is above its upper bound returns the lower one, so a<k> is the first
// child's minimum and the second child gets what is left, which can be less
// than its own minimum or nothing. Under 6px the engine also narrows the gap,
// and the CSS does not. Writing the engine's fallback in CSS would take a step
// function, which baseline CSS has no form for. The desk does not draw there:
// the workspace takes its min-width and min-height from `min`.
//
// NOTHING BUT WHAT THIS MODULE WROTE. Every number in a string is one this
// module formatted, finite and never in exponent notation, and every name comes
// from the pool. A scope must be lowercase letters and every node id l<n> or
// s<n>, or the call throws; ids are checked but never written. No pane id and
// no title is ever read into a string.
//
// Pure. No DOM, no storage, no clock.

import { GAP, minSize } from "./geometry";
import type { PaneSpec, SplitDir, TileNode, Workspace } from "./types";

/**
 * The most splits one tree may have: the pool registers this many of each
 * per-split name. The catalog's fourteen panes, one leaf each, need thirteen.
 */
export const MAX_SPLITS = 13;

export interface CssBox {
  left: string;
  top: string;
  width: string;
  height: string;
}

export interface CssLayout {
  /** One per leaf, in the order leavesOf gives. Lengths are absolute, from the stage's properties. */
  leaves: Array<CssBox & { leafId: string }>;
  /**
   * One per split: the divider's box, in the order layoutTree returns them.
   * `index` is the split's pre-order index and `ratioVar` the property a drag
   * rewrites on the stage.
   */
  dividers: Array<CssBox & { splitId: string; dir: SplitDir; index: number; ratioVar: string }>;
  /** The registered custom properties the stage element sets. */
  vars: Record<string, string>;
  /** The smallest workspace this tree can be drawn in. */
  min: { w: number; h: number };
}

const SCOPE_SHAPE = /^[a-z]+$/;
const ID_SHAPE = /^[ls][0-9]+$/;

/** The share drawnShare falls back to, and what a ratio that is no number draws at. */
const EVEN_SHARE = 0.5;

function checkScope(scope: string): void {
  if (typeof scope !== "string" || !SCOPE_SHAPE.test(scope)) {
    throw new Error("cssLayout: a scope is lowercase letters a to z and nothing else");
  }
}

function checkIndex(index: number): void {
  if (!Number.isInteger(index) || index < 1 || index > MAX_SPLITS) {
    throw new Error(`cssLayout: a split's index is a whole number from 1 to ${MAX_SPLITS}`);
  }
}

function poolName(scope: string, suffix: string): string {
  return `--v2-${scope}-${suffix}`;
}

/** The property that holds split k's ratio, which a divider drag rewrites on the stage. */
export function ratioVar(scope: string, index: number): string {
  checkScope(scope);
  checkIndex(index);
  return poolName(scope, `r${index}`);
}

function firstVar(scope: string, index: number): string {
  return poolName(scope, `a${index}`);
}

/** A measurement in whole pixels, floored as the CSS floors the workspace. */
function wholePixels(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * The workspace as hit testing must hand it to layoutTree: floored to whole
 * pixels, exactly as `round(down, 100cqw, 1px)` floors it for the drawing.
 */
export function hitTestWorkspace(width: number, height: number): Workspace {
  return { width: wholePixels(width), height: wholePixels(height) };
}

function lengthRule(name: string): string {
  return `@property ${name} { syntax: "<length>"; inherits: true; initial-value: 0px; }`;
}

function numberRule(name: string): string {
  return `@property ${name} { syntax: "<number>"; inherits: true; initial-value: 0.5; }`;
}

/**
 * The `@property` rules for the whole pool of each scope, one per line, for a
 * stylesheet the page loads once. A scope named twice is registered once.
 */
export function propertyRules(scopes: readonly string[]): string {
  scopes.forEach(checkScope);
  const rules: string[] = [];
  for (const scope of new Set(scopes)) {
    rules.push(lengthRule(poolName(scope, "w")), lengthRule(poolName(scope, "h")));
    for (let index = 1; index <= MAX_SPLITS; index += 1) rules.push(lengthRule(firstVar(scope, index)));
    for (let index = 1; index <= MAX_SPLITS; index += 1) rules.push(numberRule(ratioVar(scope, index)));
  }
  return rules.join("\n");
}

/**
 * A number as CSS reads it: finite, and never in the exponent notation String()
 * falls into below 1e-6 and from 1e21. The digits are String()'s own, the
 * shortest that read back as the same double, so nothing is rounded away.
 */
function decimal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("cssLayout: a length or a share is not a finite number");
  }
  const text = String(value);
  const scientific = /^(-?)([0-9])(?:\.([0-9]+))?e([+-][0-9]+)$/.exec(text);
  if (scientific === null) return text;
  const [, sign, lead, rest = "", power] = scientific;
  const digits = lead + rest;
  // Where the decimal point falls among `digits`, counted from the left.
  const point = 1 + Number(power);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function px(value: number): string {
  return `${decimal(value)}px`;
}

/** The share a split's ratio is written as. See the header for why 0 to 1 changes nothing. */
function writtenShare(ratio: number): number {
  if (!Number.isFinite(ratio)) return EVEN_SHARE;
  return Math.max(0, Math.min(1, ratio));
}

/** Every id well formed, and the number of splits. */
function checkTree(node: TileNode): number {
  if (typeof node.id !== "string" || !ID_SHAPE.test(node.id)) {
    throw new Error("cssLayout: a node id is l or s followed by digits and nothing else");
  }
  if (node.kind === "leaf") return 0;
  return 1 + checkTree(node.first) + checkTree(node.second);
}

/**
 * A length as a sum: registered properties added or taken away, then whole
 * pixels. Every gap on the way is folded into `px`, which is exact because
 * every term is a whole number of pixels.
 */
interface Length {
  terms: ReadonlyArray<{ sign: 1 | -1; name: string }>;
  px: number;
}

const NOTHING: Length = { terms: [], px: 0 };

function only(name: string): Length {
  return { terms: [{ sign: 1, name }], px: 0 };
}

function withTerm(length: Length, sign: 1 | -1, name: string): Length {
  return { terms: [...length.terms, { sign, name }], px: length.px };
}

function moved(length: Length, by: number): Length {
  return { terms: length.terms, px: length.px + by };
}

/** The length written to sit inside a math function. */
function sum(length: Length): string {
  const parts = length.terms.map((term, index) => {
    if (index > 0) return `${term.sign > 0 ? "+" : "-"} var(${term.name})`;
    // Every extent starts from w, h or an a<k>, and every offset only adds.
    if (term.sign < 0) throw new Error("cssLayout: a length began by taking a property away");
    return `var(${term.name})`;
  });
  if (parts.length === 0) return px(length.px);
  if (length.px !== 0) parts.push(`${length.px > 0 ? "+" : "-"} ${px(Math.abs(length.px))}`);
  return parts.join(" ");
}

/**
 * The length as a whole property value: one term, one var() or one calc(),
 * never a bare sum, and a zero as the bare `0` CSS allows only there.
 */
function whole(length: Length): string {
  if (length.terms.length === 0) return length.px === 0 ? "0" : px(length.px);
  if (length.terms.length === 1 && length.px === 0) return sum(length);
  return `calc(${sum(length)})`;
}

/** A node's box while it is being placed. */
interface Place {
  x: Length;
  y: Length;
  w: Length;
  h: Length;
}

/**
 * The tree's geometry as CSS lengths for frames and dividers on the stage, and
 * the registered properties the stage sets. See the header for the contract.
 *
 * The maximized leaf, when there is one, takes the whole workspace, and every
 * other leaf keeps the box it would have, as layoutTree returns them. An id that
 * is no leaf of the tree maximizes nothing. A tree with more than MAX_SPLITS
 * splits, an id that is not l<n> or s<n>, or a scope that is not lowercase
 * letters throws.
 */
export function cssLayout(
  tree: TileNode | null,
  maximizedLeafId: string | null,
  specs: readonly PaneSpec[],
  scope: string,
): CssLayout {
  checkScope(scope);
  const out: CssLayout = { leaves: [], dividers: [], vars: {}, min: { w: 0, h: 0 } };
  if (tree === null) return out;
  if (checkTree(tree) > MAX_SPLITS) {
    throw new Error(`cssLayout: a tree has at most ${MAX_SPLITS} splits`);
  }

  const width = poolName(scope, "w");
  const height = poolName(scope, "h");
  out.vars[width] = "round(down, 100cqw, 1px)";
  out.vars[height] = "round(down, 100cqh, 1px)";

  const gap = px(GAP);
  let splits = 0;

  const place = (node: TileNode, box: Place): void => {
    if (node.kind === "leaf") {
      const maximized = node.id === maximizedLeafId;
      out.leaves.push({
        leafId: node.id,
        left: maximized ? "0" : whole(box.x),
        top: maximized ? "0" : whole(box.y),
        width: whole(maximized ? only(width) : box.w),
        height: whole(maximized ? only(height) : box.h),
      });
      return;
    }

    // Pre-order: a split is numbered before anything inside it.
    splits += 1;
    const index = splits;
    const horizontal = node.dir === "h";
    const extent = horizontal ? box.w : box.h;
    const offset = horizontal ? box.x : box.y;
    const firstMinimum = minSize(node.first, specs);
    const secondMinimum = minSize(node.second, specs);
    const firstMin = horizontal ? firstMinimum.w : firstMinimum.h;
    const secondMin = horizontal ? secondMinimum.w : secondMinimum.h;

    const ratio = ratioVar(scope, index);
    const first = firstVar(scope, index);
    const inner = moved(extent, -GAP);

    out.vars[ratio] = decimal(writtenShare(node.ratio));
    out.vars[first] =
      `round(nearest, clamp(${px(firstMin)}, (${sum(inner)}) * var(${ratio}), ` +
      `${sum(inner)} - ${px(secondMin)}), 1px)`;

    const firstExtent = only(first);
    const secondExtent = withTerm(inner, -1, first);
    const dividerAt = withTerm(offset, 1, first);
    const secondAt = moved(dividerAt, GAP);
    const divider = { splitId: node.id, index, ratioVar: ratio };

    if (horizontal) {
      place(node.first, { ...box, w: firstExtent });
      out.dividers.push({
        ...divider,
        dir: "h",
        left: whole(dividerAt),
        top: whole(box.y),
        width: gap,
        height: whole(box.h),
      });
      place(node.second, { ...box, x: secondAt, w: secondExtent });
    } else {
      place(node.first, { ...box, h: firstExtent });
      out.dividers.push({
        ...divider,
        dir: "v",
        left: whole(box.x),
        top: whole(dividerAt),
        width: whole(box.w),
        height: gap,
      });
      place(node.second, { ...box, y: secondAt, h: secondExtent });
    }
  };
  place(tree, { x: NOTHING, y: NOTHING, w: only(width), h: only(height) });

  const min = minSize(tree, specs);
  out.min = { w: min.w, h: min.h };
  return out;
}
