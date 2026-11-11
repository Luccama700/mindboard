// The tile engine's geometry, written a second time as CSS lengths.
//
// WHY THERE ARE TWO FORMS. The server draws a saved layout without knowing how
// wide the window is, and the browser has to reflow it on every resize without
// running script. So what the page carries cannot be a list of rectangles: it
// has to be the formula itself, for the browser to evaluate. layoutTree in
// geometry.ts is that formula as numbers, which is what hit testing and the
// keyboard use on the measured workspace. This module is the same formula as
// CSS. __tests__/v2-tiles-css.test.ts evaluates these strings and holds every
// box to layoutTree's rectangle to the pixel, so the two cannot drift apart.
//
// THE FORMULA. A split whose extent along its direction is S gives its first
// child
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
// WHERE THE TWO FORMS STOP AGREEING. They agree exactly when every split's two
// minimums fit inside its own extent less the gap. On a workspace of whole
// pixels at least `min` in both dimensions, with whole pixel minimums, that is
// every split: the root fits by the definition of `min`, and a split that fits
// hands each child at least that child's minimum, because both ends of the
// clamp are whole pixels and rounding cannot carry a value past either one.
// The test's sizes start at `min` for this reason.
//
// Where the minimums do not fit, the engine draws the split at an even share
// (shareLimits answers [0.5, 0.5]) and the CSS does not: a clamp whose lower
// bound is above its upper bound returns the lower one, so the first child keeps
// its minimum and the second gets what is left. Under 6px the engine also
// narrows the gap, and the CSS does not. Writing the engine's fallback in CSS
// would take a step function, which baseline CSS has no form for; building one
// out of round() and scaled min() and max() leans on very large intermediate
// lengths that browsers clamp, and names each parent's extent several more
// times per level. The desk does not draw there: the workspace takes its
// min-width and min-height from `min`.
//
// A workspace that is not a whole number of pixels can part them above `min`.
// When the first child's extent rounds up to within half a pixel of the second
// child's minimum, the engine's second child is a fraction under that minimum,
// and a split of the same direction inside it falls back to an even share. The
// CSS builds that inner split from the second child's other spelling (below),
// which comes out at the minimum exactly, so the inner split is drawn as it
// should be and its far edge misses the second child's by under half a pixel.
// The test pins one such case.
//
// WHY THE CUSTOM PROPERTIES. Every split's extent depends on its parent's, so
// written out in place a deep tree's strings would grow with every level. Each
// split instead names four custom properties (its ratio, its extent less the
// gap, its first child's extent, and where its second child starts), and every
// box refers to them, so the strings grow by a constant per split.
//
// A browser expands var() by substituting text, though, so what grows is the
// SUBSTITUTED length: it multiplies by the number of times a split names its
// parent's extent, at every level of splits that run the same way. Browsers cap
// it and treat a declaration over the cap as invalid. So every child is reached
// naming the parent twice, which is the least a clamp between a share and an
// upper bound can do. The first child is the formula above. The second child's
// box is the inner extent less the first, which would name it three times, so a
// split inside a second child builds instead from
//
//   max(<min second>px, inner - max(<min first>px, round(nearest, inner * ratio, 1px)))
//
// Both ends of the clamp are whole pixels, so the rounding moves inside it,
// round(clamp(A, x, U)) = clamp(A, round(x), U), and the inner extent less that
// is the expression above: the same length on a whole pixel workspace, from the
// same rounded product, so a tie cannot come out differently. The test measures
// the result: under 1 KB at two levels one way (the most any default tree
// nests), 12 KB at six, 0.1 MB at nine and 0.8 MB at twelve. Naming the parent
// three times would have made twelve levels 27 MB.
//
// EVERY VALUE IS ONE TERM. Each custom property's value and each box string is
// a single token, one var(), or one function call, never a bare sum. var() is
// substituted as text, so a bare `100% - 6px` multiplied by a ratio would mean
// `100% - (6px * ratio)`. And a zero offset is left out of a sum rather than
// written as `0`: a unitless 0 is a length only as a whole value, never as an
// operand of + or - inside calc().
//
// NOTHING BUT WHAT THIS MODULE WROTE. Every number in a string is one this
// module formatted, finite and never in exponent notation, and every name is
// built from a scope of lowercase letters and an id of the form l<n> or s<n>.
// Anything else throws. No pane id and no title is ever read into a string.
//
// Pure. No DOM, no storage, no clock.

import { GAP, minSize } from "./geometry";
import type { PaneSpec, SplitDir, TileNode } from "./types";

export interface CssBox {
  left: string;
  top: string;
  width: string;
  height: string;
}

export interface CssLayout {
  /** One per leaf, in the order leavesOf gives. Lengths are relative to the workspace box. */
  leaves: Array<CssBox & { leafId: string }>;
  /** One per split: the divider's box. */
  dividers: Array<CssBox & { splitId: string; dir: SplitDir }>;
  /** Custom properties for the workspace element: one ratio per split, and the shared sub-expressions. */
  vars: Record<string, string>;
  /** The smallest workspace this tree can be drawn in. */
  min: { w: number; h: number };
}

const SCOPE_SHAPE = /^[a-z]+$/;
const ID_SHAPE = /^[ls][0-9]+$/;

/** The share drawnShare falls back to, and what a ratio that is no number draws at. */
const EVEN_SHARE = 0.5;

/** The box a maximized leaf takes: all of the workspace. */
const WHOLE: CssBox = { left: "0", top: "0", width: "100%", height: "100%" };

function checkScope(scope: string): void {
  if (typeof scope !== "string" || !SCOPE_SHAPE.test(scope)) {
    throw new Error("cssLayout: a scope is lowercase letters a to z and nothing else");
  }
}

function checkId(id: string): void {
  if (typeof id !== "string" || !ID_SHAPE.test(id)) {
    throw new Error("cssLayout: a node id is l or s followed by digits and nothing else");
  }
}

/** The custom property that holds this split's ratio, which a divider drag rewrites. */
export function ratioVar(scope: string, splitId: string): string {
  checkScope(scope);
  checkId(splitId);
  return `--v2-r-${scope}-${splitId}`;
}

/** The split's extent along its direction, less the gap. */
function innerVar(scope: string, splitId: string): string {
  return `--v2-i-${scope}-${splitId}`;
}

/** The first child's extent along the split's direction, rounded to a pixel. */
function firstVar(scope: string, splitId: string): string {
  return `--v2-f-${scope}-${splitId}`;
}

/** Where the second child starts along the split's direction. */
function offsetVar(scope: string, splitId: string): string {
  return `--v2-o-${scope}-${splitId}`;
}

/** A reference to a custom property. Not named `use`: lint reads that as a React hook. */
function ref(name: string): string {
  return `var(${name})`;
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

/** Every id well formed and none used twice: two splits with one id would share one set of names. */
function checkIds(node: TileNode, seen: Set<string>): void {
  checkId(node.id);
  if (seen.has(node.id)) {
    throw new Error("cssLayout: a node id is used twice in one tree");
  }
  seen.add(node.id);
  if (node.kind === "split") {
    checkIds(node.first, seen);
    checkIds(node.second, seen);
  }
}

/**
 * An extent, twice. `term` is what a box is drawn with. `sum` is what a split
 * inside builds its inner extent from, inside a calc() that subtracts the gap.
 * For a first child and the workspace they are the same text; for a second
 * child they are two spellings of one length (see the header).
 */
interface Extent {
  term: string;
  sum: string;
}

function single(term: string): Extent {
  return { term, sum: term };
}

/**
 * A node's box while it is being placed. An offset of null is the workspace's
 * own edge; any other offset is one CSS term.
 */
interface Place {
  x: string | null;
  y: string | null;
  w: Extent;
  h: Extent;
}

function edge(offset: string | null): string {
  return offset ?? "0";
}

/** `offset + term`, with a zero offset left out rather than written as a unitless 0. */
function after(offset: string | null, term: string, plus: string | null = null): string {
  const parts = [offset, term, plus].filter((part): part is string => part !== null);
  return parts.length === 1 ? parts[0] : `calc(${parts.join(" + ")})`;
}

/**
 * The tree's geometry as CSS lengths relative to the workspace box, and the
 * custom properties they refer to. `scope` goes into every property's name, so
 * several layouts can share one element; it must be lowercase letters.
 *
 * The maximized leaf, when there is one, takes the whole box, and every other
 * leaf keeps the box it would have, as layoutTree returns them. An id that is no
 * leaf of the tree maximizes nothing.
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
  checkIds(tree, new Set());

  const gap = px(GAP);

  const place = (node: TileNode, box: Place): void => {
    if (node.kind === "leaf") {
      const whole = node.id === maximizedLeafId;
      out.leaves.push({
        leafId: node.id,
        left: whole ? WHOLE.left : edge(box.x),
        top: whole ? WHOLE.top : edge(box.y),
        width: whole ? WHOLE.width : box.w.term,
        height: whole ? WHOLE.height : box.h.term,
      });
      return;
    }

    const horizontal = node.dir === "h";
    const extent = horizontal ? box.w : box.h;
    const offset = horizontal ? box.x : box.y;
    const firstMinimum = minSize(node.first, specs);
    const secondMinimum = minSize(node.second, specs);
    const firstMin = px(horizontal ? firstMinimum.w : firstMinimum.h);
    const secondMin = px(horizontal ? secondMinimum.w : secondMinimum.h);

    const ratio = ratioVar(scope, node.id);
    const inner = innerVar(scope, node.id);
    const first = firstVar(scope, node.id);
    const start = offsetVar(scope, node.id);

    out.vars[ratio] = decimal(writtenShare(node.ratio));
    out.vars[inner] = `calc(${extent.sum} - ${gap})`;
    out.vars[first] =
      `round(nearest, clamp(${firstMin}, ${ref(inner)} * ${ref(ratio)}, ` +
      `${ref(inner)} - ${secondMin}), 1px)`;
    out.vars[start] = after(offset, ref(first), gap);

    const firstExtent = single(ref(first));
    const rest = `${ref(inner)} - ${ref(first)}`;
    // The same length twice: as the inner extent less the first for the boxes,
    // and naming the inner extent one time fewer for any split inside. See the
    // header for why the two are equal.
    const secondExtent: Extent = {
      term: `calc(${rest})`,
      sum:
        `max(${secondMin}, ${ref(inner)} - ` +
        `max(${firstMin}, round(nearest, ${ref(inner)} * ${ref(ratio)}, 1px)))`,
    };
    const divider = after(offset, ref(first));

    if (horizontal) {
      place(node.first, { ...box, w: firstExtent });
      out.dividers.push({
        splitId: node.id,
        dir: "h",
        left: divider,
        top: edge(box.y),
        width: gap,
        height: box.h.term,
      });
      place(node.second, { ...box, x: ref(start), w: secondExtent });
    } else {
      place(node.first, { ...box, h: firstExtent });
      out.dividers.push({
        splitId: node.id,
        dir: "v",
        left: edge(box.x),
        top: divider,
        width: box.w.term,
        height: gap,
      });
      place(node.second, { ...box, y: ref(start), h: secondExtent });
    }
  };
  place(tree, { x: null, y: null, w: single(WHOLE.width), h: single(WHOLE.height) });

  const min = minSize(tree, specs);
  out.min = { w: min.w, h: min.h };
  return out;
}
