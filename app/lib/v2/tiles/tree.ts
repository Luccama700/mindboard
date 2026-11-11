// Every operation on the workspace tree.
//
// THE TWO RULES THAT MAKE THIS SAFE TO PUT A SCREEN ON TOP OF.
//
//  1. Every function returns a NEW arrangement and shares every branch it did
//     not change. A call that changes nothing returns the SAME object, so a
//     caller can tell a refusal from a move by identity alone and never has to
//     compare two trees to find out whether to redraw.
//  2. Ids are a function of the tree. A new leaf is `l<n>` and a new split
//     `s<n>`, where n is one more than the largest number any id in the tree
//     already uses. The reference prototype took ids from a counter that lived
//     outside the tree, which made the same operation on the same tree produce
//     a different tree on a second run: nothing could be compared, replayed or
//     tested. Here the tree is the only state there is.
//
// The ratio a split stores is the user's own, at the size they dragged it. The
// geometry module clamps for drawing and hands nothing back, so a tree laid out
// on a workspace too small for it comes back unchanged. The one exception is
// this module's own clamp in `setRatio`, which keeps a drag inside the range
// `normalize` allows, because a value `normalize` would change could not
// survive a save and a load.
//
// A RATIO IS HELD TO FOUR DECIMALS, by `setRatio`, `normalize` and every place
// a remembered ratio comes back. A saved form written in any encoding, JSON or
// a fixed point number, then holds exactly what the engine holds, and a load
// never hands back a ratio a hair away from the one that was saved.
//
// Every `specs` parameter defaults to the catalog's panes.
//
// Pure. No DOM, no storage, no clock, no randomness.

import { PANES } from "./catalog";
import { layoutTree, shareLimits } from "./geometry";
import type {
  Arrangement,
  Leaf,
  PaneId,
  PaneOption,
  PaneSpec,
  Spot,
  Split,
  TileNode,
  TileRects,
  Workspace,
  Zone,
} from "./types";

/**
 * The narrowest and widest share a split may store. Exported because the store
 * holds a remembered ratio to the same range and there must be one definition
 * of it: two copies drifting apart would put a value in storage that a load
 * then changes, which is the one thing the round trip cannot survive.
 */
export const RATIO_MIN = 0.05;
export const RATIO_MAX = 0.95;

/** What a fresh split takes, and what `equalize` sets. */
export const EVEN_RATIO = 0.5;

/** Four decimals: the finest a share is held to. */
const RATIO_PRECISION = 10_000;

/**
 * How much wider than tall the largest leaf has to be before a pane with no
 * remembered place opens beside it rather than under it.
 */
const WIDE_ENOUGH_FOR_BESIDE = 1.2;

/**
 * How finely a signature records a ratio: whole percents. Two layouts that
 * differ only by a rounding error are the same layout, and the store would
 * otherwise keep a layout the user had not visibly changed as if they had.
 */
const SIGNATURE_PRECISION = 100;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * A share held inside the range a split may store, to four decimals. Rounding
 * after clamping cannot leave the range, because both ends are four decimal
 * numbers already, and rounding a rounded value gives the same value back.
 */
export function normalizeRatio(value: number): number {
  if (!Number.isFinite(value)) return EVEN_RATIO;
  return Math.round(clamp(value, RATIO_MIN, RATIO_MAX) * RATIO_PRECISION) / RATIO_PRECISION;
}

// ------------------------------------------------------------------ reading

export function leavesOf(node: TileNode | null): Leaf[] {
  if (node === null) return [];
  if (node.kind === "leaf") return [node];
  return [...leavesOf(node.first), ...leavesOf(node.second)];
}

export function leafOf(tree: TileNode | null, pane: PaneId): Leaf | null {
  for (const found of leavesOf(tree)) {
    if (found.tabs.includes(pane)) return found;
  }
  return null;
}

/** Every pane that is open, in tree order. A pane is in exactly one leaf. */
export function openPanes(tree: TileNode | null): PaneId[] {
  const out: PaneId[] = [];
  for (const found of leavesOf(tree)) out.push(...found.tabs);
  return out;
}

function nodeById(node: TileNode | null, id: string): TileNode | null {
  if (node === null) return null;
  if (node.id === id) return node;
  if (node.kind === "leaf") return null;
  return nodeById(node.first, id) ?? nodeById(node.second, id);
}

function leafById(tree: TileNode | null, id: string): Leaf | null {
  const found = nodeById(tree, id);
  return found !== null && found.kind === "leaf" ? found : null;
}

function splitById(tree: TileNode | null, id: string): Split | null {
  const found = nodeById(tree, id);
  return found !== null && found.kind === "split" ? found : null;
}

function parentOf(tree: TileNode, childId: string): Split | null {
  if (tree.kind === "leaf") return null;
  if (tree.first.id === childId || tree.second.id === childId) return tree;
  return parentOf(tree.first, childId) ?? parentOf(tree.second, childId);
}

/**
 * The shape of the tree as one string, ratios rounded to whole percents. It
 * says nothing about ids or about which tab is in front, because neither is
 * part of how a layout is arranged: bringing a tab forward is not a change to
 * the layout, and the store does not keep a layout that differs from its
 * default by nothing else.
 */
export function signature(node: TileNode | null): string {
  if (node === null) return "-";
  if (node.kind === "leaf") return `[${node.tabs.join(",")}]`;
  const percent = Math.round(node.ratio * SIGNATURE_PRECISION);
  return `${node.dir}${percent}(${signature(node.first)}|${signature(node.second)})`;
}

// ---------------------------------------------------------------- the ids

const ID_SHAPE = /^[ls][0-9]+$/;

/**
 * The largest number an id may carry, and the reason it is nothing like
 * Number.MAX_SAFE_INTEGER.
 *
 * Ids are a function of the tree, so the next one is read off the largest
 * already in it. That only works while every id in the tree can be READ. A
 * hand edited `l9007199254740991` used to pass as sound; the next move then
 * minted `...992`, which no longer parses as a safe integer, so the move after
 * that read the largest number as zero and minted `...992` a second time. Two
 * nodes with one id are rewritten together by `mapNode`, which corrupts the
 * tree.
 *
 * A billion is eight orders of magnitude past anything the engine can reach
 * (one move mints one id) and far enough below the safe integer ceiling that
 * arithmetic on it is exact. Anything above it is not a sound id, so the store
 * renumbers the whole tree on load instead of trusting it.
 */
const MAX_ID_NUMBER = 1_000_000_000;

function idNumber(id: string): number | null {
  if (!ID_SHAPE.test(id)) return null;
  const parsed = Number.parseInt(id.slice(1), 10);
  return Number.isSafeInteger(parsed) && parsed <= MAX_ID_NUMBER ? parsed : null;
}

function highestIdNumber(node: TileNode | null): number {
  if (node === null) return 0;
  const mine = idNumber(node.id) ?? 0;
  if (node.kind === "leaf") return mine;
  return Math.max(mine, highestIdNumber(node.first), highestIdNumber(node.second));
}

/** One more than the largest number any id in this tree uses. */
function nextIdNumber(node: TileNode | null): number {
  return highestIdNumber(node) + 1;
}

function collectIds(node: TileNode, out: string[]): void {
  out.push(node.id);
  if (node.kind === "leaf") return;
  collectIds(node.first, out);
  collectIds(node.second, out);
}

/**
 * Whether every id in this tree is one this module could have made: the right
 * letter for the kind, a number this module can count past, and distinct from
 * every other id. The store repairs a tree that fails this, because two nodes
 * with one id would be found and rewritten together.
 */
export function hasSoundIds(node: TileNode | null): boolean {
  if (node === null) return true;
  const ids: string[] = [];
  collectIds(node, ids);
  if (new Set(ids).size !== ids.length) return false;
  return soundShapes(node);
}

function soundShapes(node: TileNode): boolean {
  const letter = node.kind === "leaf" ? "l" : "s";
  if (node.id.slice(0, 1) !== letter) return false;
  if (idNumber(node.id) === null) return false;
  if (node.kind === "leaf") return true;
  return soundShapes(node.first) && soundShapes(node.second);
}

/**
 * The same tree with ids numbered down the tree from one. Used only to repair a
 * stored tree whose ids are missing, malformed or repeated: an engine made tree
 * never needs it, which is what keeps a save and a load lossless.
 */
export function withCanonicalIds(node: TileNode): TileNode {
  const next = { value: 1 };
  const rebuild = (current: TileNode): TileNode => {
    const number = next.value;
    next.value += 1;
    if (current.kind === "leaf") {
      return { kind: "leaf", id: `l${number}`, tabs: [...current.tabs], active: current.active };
    }
    return {
      kind: "split",
      id: `s${number}`,
      dir: current.dir,
      ratio: current.ratio,
      first: rebuild(current.first),
      second: rebuild(current.second),
    };
  };
  return rebuild(node);
}

// ---------------------------------------------------------------- normalize

/**
 * The tree with the four things that can never be true of a drawn layout fixed:
 * a leaf with no tabs is gone, a split with one child left is that child, a
 * ratio is inside the range and held to four decimals, and the tab in front is
 * one of the tabs. An empty tree is null.
 *
 * Returns the same object when there was nothing to fix, so every operation can
 * finish with a normalize and still report "nothing changed" honestly.
 */
export function normalize(node: TileNode | null): TileNode | null {
  if (node === null) return null;
  if (node.kind === "leaf") {
    if (node.tabs.length === 0) return null;
    if (!node.tabs.includes(node.active)) {
      return { kind: "leaf", id: node.id, tabs: node.tabs, active: node.tabs[0] };
    }
    return node;
  }
  const first = normalize(node.first);
  const second = normalize(node.second);
  if (first === null) return second;
  if (second === null) return first;
  const ratio = normalizeRatio(node.ratio);
  if (first === node.first && second === node.second && ratio === node.ratio) return node;
  return { kind: "split", id: node.id, dir: node.dir, ratio, first, second };
}

/**
 * The tree with the node that carries this id replaced by whatever `make`
 * returns. Every branch that does not hold the node comes back by reference.
 */
function mapNode(
  node: TileNode,
  id: string,
  make: (found: TileNode) => TileNode,
): TileNode {
  if (node.id === id) return make(node);
  if (node.kind === "leaf") return node;
  const first = mapNode(node.first, id, make);
  const second = mapNode(node.second, id, make);
  if (first === node.first && second === node.second) return node;
  return { kind: "split", id: node.id, dir: node.dir, ratio: node.ratio, first, second };
}

function withActiveTab(tree: TileNode, leafId: string, pane: PaneId): TileNode {
  return mapNode(tree, leafId, (found) =>
    found.kind === "leaf"
      ? { kind: "leaf", id: found.id, tabs: [...found.tabs], active: pane }
      : found,
  );
}

// ------------------------------------------------- what is focused can be seen

/**
 * BEHAVIOUR 18, IN ONE PLACE. The first review of this engine found four
 * operations that could each leave `focus` on a pane nobody could see: behind
 * another tab of its own leaf, or in a leaf that a maximized pane had covered
 * over. Four separate patches would have been four chances to miss the fifth,
 * so the rule is enforced once, here, and every operation's result passes
 * through it:
 *
 *   `focus`, when it is not null, is the active tab of its leaf, and when
 *   `maximized` is not null, `focus` is that same pane.
 *
 * FOCUS IS THE AUTHORITY, which is what makes one function enough. Each
 * operation says where the focus went and this decides the rest: the focused
 * pane comes to the front of its own leaf, a maximize in that same leaf follows
 * the focus onto the new tab (the full size leaf is now showing it), and a
 * maximize anywhere else is dropped (it was covering the pane the user just
 * asked for). So `activateTab` inside the maximized leaf moves the maximize and
 * outside it clears the maximize, without either case being written down twice.
 *
 * A null `focus` stays null. The rule allows it, and an arrangement nobody has
 * focused yet should not have a pane picked for it.
 */
function settled(next: Arrangement): Arrangement {
  const tree = next.tree;
  if (tree === null) {
    if (next.maximized === null && next.focus === null) return next;
    return { ...next, maximized: null, focus: null };
  }
  const held = next.focus;
  if (held === null) {
    if (next.maximized === null) return next;
    return { ...next, maximized: null };
  }
  const heldLeaf = leafOf(tree, held);
  const leaf = heldLeaf ?? leavesOf(tree)[0];
  const focus = heldLeaf === null ? leaf.active : held;
  const maximizedLeaf = next.maximized === null ? null : leafOf(tree, next.maximized);
  const maximized = maximizedLeaf !== null && maximizedLeaf.id === leaf.id ? focus : null;
  const inFront = leaf.active === focus;
  if (inFront && focus === next.focus && maximized === next.maximized) return next;
  return {
    ...next,
    tree: inFront ? tree : withActiveTab(tree, leaf.id, focus),
    maximized,
    focus,
  };
}

function sameArrangement(a: Arrangement, b: Arrangement): boolean {
  return (
    a.tree === b.tree &&
    a.maximized === b.maximized &&
    a.focus === b.focus &&
    a.lastSpot === b.lastSpot &&
    a.options === b.options
  );
}

/**
 * What every operation returns: the arrangement it built, put through the rule
 * above, and then the ORIGINAL when the rule left it identical to what came in.
 * That is the second contract of this module in the same place as the first, so
 * no operation can keep one and lose the other.
 */
function result(from: Arrangement, next: Arrangement): Arrangement {
  const out = settled(next);
  return sameArrangement(from, out) ? from : out;
}

function withoutTab(leaf: Leaf, pane: PaneId): Leaf {
  const tabs = leaf.tabs.filter((tab) => tab !== pane);
  return {
    kind: "leaf",
    id: leaf.id,
    tabs,
    // An empty leaf is about to be dropped by normalize, so the value here is
    // never read. It has to be a pane id all the same.
    active: leaf.active === pane ? (tabs[0] ?? pane) : leaf.active,
  };
}

// ----------------------------------------------------------------- moving

/**
 * Put a pane somewhere. `centre` makes it another tab of the target and brings
 * it to the front; any other zone splits the target in half with the pane on
 * that side, and the target keeps its own id so a renderer can animate the half
 * that stayed rather than replace it.
 *
 * Refused when the target is not there, and when the pane is being dropped on
 * its own leaf in a way that would change nothing: as a tab of the leaf it is
 * already in, or off a leaf where it is the only tab.
 *
 * A pane that is closed can be moved in. That is how a pane opens at a place
 * the user chose rather than where the engine would have put it. Its
 * remembered spot is dropped as it comes in, like every way a pane opens.
 */
export function movePane(
  arrangement: Arrangement,
  pane: PaneId,
  targetLeafId: string,
  zone: Zone,
): Arrangement {
  const tree = arrangement.tree;
  if (tree === null) return arrangement;
  const target = leafById(tree, targetLeafId);
  if (target === null) return arrangement;
  const source = leafOf(tree, pane);
  if (
    source !== null &&
    source.id === target.id &&
    (target.tabs.length < 2 || zone === "centre")
  ) {
    return arrangement;
  }

  const number = nextIdNumber(tree);
  // The pane leaves its old leaf FIRST, so that a pane splitting off its own
  // leaf leaves the rest of that leaf behind rather than a copy of itself.
  const lifted =
    source === null
      ? tree
      : mapNode(tree, source.id, (found) =>
          found.kind === "leaf" ? withoutTab(found, pane) : found,
        );

  const docked = mapNode(lifted, target.id, (found) => {
    if (found.kind !== "leaf") return found;
    if (zone === "centre") {
      return { kind: "leaf", id: found.id, tabs: [...found.tabs, pane], active: pane };
    }
    const kept: Leaf = {
      kind: "leaf",
      id: found.id,
      tabs: [...found.tabs],
      active: found.active,
    };
    const moved: Leaf = { kind: "leaf", id: `l${number}`, tabs: [pane], active: pane };
    const paneFirst = zone === "left" || zone === "top";
    return {
      kind: "split",
      id: `s${number}`,
      dir: zone === "left" || zone === "right" ? "h" : "v",
      ratio: EVEN_RATIO,
      first: paneFirst ? moved : kept,
      second: paneFirst ? kept : moved,
    };
  });

  return result(arrangement, {
    ...arrangement,
    tree: normalize(docked),
    maximized: null,
    focus: pane,
    lastSpot: source === null ? forgetSpot(arrangement.lastSpot, pane) : arrangement.lastSpot,
  });
}

/**
 * The spots without this pane's, or the same object when it had none. A spot
 * says where a CLOSED pane was, so it goes the moment the pane is open again.
 * Nothing is lost by that: `closePane` writes it afresh. Keeping it would leave
 * a layout that was closed and reopened back to its default looking changed
 * for good, with nothing on screen to show for it.
 */
function forgetSpot(spots: Record<PaneId, Spot>, pane: PaneId): Record<PaneId, Spot> {
  if (!own(spots, pane)) return spots;
  return Object.fromEntries(Object.entries(spots).filter(([name]) => name !== pane));
}

/**
 * Where this pane is, in terms that survive it being gone: the pane it sat
 * beside and the side it was on. A tab remembers the first other tab of its own
 * leaf; a leaf of its own remembers the first leaf of its sibling, the side it
 * was on, and the split's ratio, so reopening restores the proportion too.
 */
function spotFor(tree: TileNode, leaf: Leaf, pane: PaneId): Spot | null {
  if (leaf.tabs.length > 1) {
    const beside = leaf.tabs.find((tab) => tab !== pane);
    return beside === undefined ? null : { beside, zone: "centre", ratio: null };
  }
  const parent = parentOf(tree, leaf.id);
  if (parent === null) return null;
  const wasFirst = parent.first.id === leaf.id;
  const sibling = leavesOf(wasFirst ? parent.second : parent.first)[0];
  if (sibling === undefined) return null;
  const zone: Zone =
    parent.dir === "h" ? (wasFirst ? "left" : "right") : wasFirst ? "top" : "bottom";
  return { beside: sibling.active, zone, ratio: parent.ratio };
}

/**
 * Close a pane, remembering where it was.
 *
 * Every pane can be closed. The one refusal is the last pane open: a layout
 * with nothing in it is not a state the user can get out of, and keeping one
 * protected pane in every layout instead would force the day's line into the
 * Money layout.
 */
export function closePane(arrangement: Arrangement, pane: PaneId): Arrangement {
  const tree = arrangement.tree;
  if (tree === null) return arrangement;
  const leaf = leafOf(tree, pane);
  if (leaf === null) return arrangement;
  if (openPanes(tree).length < 2) return arrangement;

  const spot = spotFor(tree, leaf, pane);
  const trimmed = mapNode(tree, leaf.id, (found) =>
    found.kind === "leaf" ? withoutTab(found, pane) : found,
  );
  const next = normalize(trimmed);
  const first = leavesOf(next)[0];
  return result(arrangement, {
    ...arrangement,
    tree: next,
    maximized: arrangement.maximized === pane ? null : arrangement.maximized,
    focus:
      arrangement.focus === pane
        ? first === undefined
          ? null
          : first.active
        : arrangement.focus,
    lastSpot: spot === null ? arrangement.lastSpot : { ...arrangement.lastSpot, [pane]: spot },
  });
}

function ownSpot(spots: Record<PaneId, Spot>, pane: PaneId): Spot | null {
  if (!own(spots, pane)) return null;
  const spot = spots[pane];
  return spot === undefined || spot === null ? null : spot;
}

/** The leaf a pane with nothing remembered about it should open beside. */
function dockTarget(tree: TileNode, rects: TileRects | null): { leafId: string; zone: Zone } {
  const leaves = leavesOf(tree);
  let best: { leafId: string; w: number; h: number } | null = null;
  if (rects !== null) {
    for (const leaf of leaves) {
      const rect = rects.leaves.find((candidate) => candidate.leafId === leaf.id);
      if (rect === undefined) continue;
      if (best === null || rect.w * rect.h > best.w * best.h) {
        best = { leafId: leaf.id, w: rect.w, h: rect.h };
      }
    }
  }
  // With no measurements to go on, beside the first leaf: a workspace is wider
  // than it is tall far more often than not.
  if (best === null) return { leafId: leaves[0].id, zone: "right" };
  return {
    leafId: best.leafId,
    zone: best.w >= best.h * WIDE_ENOUGH_FOR_BESIDE ? "right" : "bottom",
  };
}

/**
 * Open a pane. It goes back where it was if the pane it sat beside is still
 * open, and otherwise beside the largest leaf there is: to the right of a leaf
 * that is clearly wider than tall, under one that is not. Either way its
 * remembered spot is dropped once it is open.
 *
 * The engine works the leaves' sizes out itself from the workspace's size, so
 * no caller measures one pane to place another. It measures the layout WITHOUT
 * any maximize, because opening a pane clears the maximize: the pane belongs
 * beside the largest leaf of the layout the user is about to see. With no
 * workspace the first leaf is used, so the engine still answers before
 * anything has been measured.
 */
export function openPane(
  arrangement: Arrangement,
  pane: PaneId,
  workspace: Workspace | null,
  specs: readonly PaneSpec[] = PANES,
): Arrangement {
  const tree = arrangement.tree;
  if (tree !== null && leafOf(tree, pane) !== null) return arrangement;
  if (tree === null) {
    return result(arrangement, {
      ...arrangement,
      tree: { kind: "leaf", id: `l${nextIdNumber(null)}`, tabs: [pane], active: pane },
      maximized: null,
      focus: pane,
      lastSpot: forgetSpot(arrangement.lastSpot, pane),
    });
  }

  const spot = ownSpot(arrangement.lastSpot, pane);
  const beside = spot === null ? null : leafOf(tree, spot.beside);
  if (spot !== null && beside !== null) {
    const moved = movePane(arrangement, pane, beside.id, spot.zone);
    const ratio = spot.ratio;
    if (spot.zone === "centre" || ratio === null || moved.tree === null) return moved;
    const landed = leafOf(moved.tree, pane);
    const parent = landed === null ? null : parentOf(moved.tree, landed.id);
    if (parent === null) return moved;
    return result(arrangement, {
      ...moved,
      tree: mapNode(moved.tree, parent.id, (found) =>
        found.kind === "split" ? { ...found, ratio: normalizeRatio(ratio) } : found,
      ),
    });
  }

  const rects =
    workspace === null ? null : layoutTree({ ...arrangement, maximized: null }, workspace, specs);
  const target = dockTarget(tree, rects);
  return movePane(arrangement, pane, target.leafId, target.zone);
}

// --------------------------------------------------------------- the sizes

/**
 * Store the share the user dragged a divider to, at the size they dragged it.
 * It is clamped so neither side goes under its minimum at that size, and then
 * into the range `normalize` allows, to four decimals, because a value a save
 * and a load would change is a value the user did not get to keep.
 *
 * Nothing else ever writes a ratio: the layout clamps only what it draws.
 */
export function setRatio(
  arrangement: Arrangement,
  splitId: string,
  ratio: number,
  size: number,
  specs: readonly PaneSpec[] = PANES,
): Arrangement {
  const tree = arrangement.tree;
  if (tree === null || !Number.isFinite(ratio)) return arrangement;
  const split = splitById(tree, splitId);
  if (split === null) return arrangement;
  const [low, high] = shareLimits(split, size, specs);
  const next = normalizeRatio(clamp(ratio, low, high));
  if (next === split.ratio) return arrangement;
  return result(arrangement, {
    ...arrangement,
    tree: mapNode(tree, splitId, (found) =>
      found.kind === "split" ? { ...found, ratio: next } : found,
    ),
  });
}

/** Give both sides of one divider the same share. */
export function equalize(arrangement: Arrangement, splitId: string): Arrangement {
  const tree = arrangement.tree;
  if (tree === null) return arrangement;
  const split = splitById(tree, splitId);
  if (split === null || split.ratio === EVEN_RATIO) return arrangement;
  return result(arrangement, {
    ...arrangement,
    tree: mapNode(tree, splitId, (found) =>
      found.kind === "split" ? { ...found, ratio: EVEN_RATIO } : found,
    ),
  });
}

/**
 * Exchange what two leaves hold, and nothing else: the panes trade places and
 * every divider stays exactly where it was. That is what makes a keyboard move
 * feel like moving a pane rather than rebuilding the layout around it.
 */
export function swapLeaves(
  arrangement: Arrangement,
  leafIdA: string,
  leafIdB: string,
): Arrangement {
  const tree = arrangement.tree;
  if (tree === null || leafIdA === leafIdB) return arrangement;
  const a = leafById(tree, leafIdA);
  const b = leafById(tree, leafIdB);
  if (a === null || b === null) return arrangement;
  const withA = mapNode(tree, leafIdA, () => ({
    kind: "leaf",
    id: leafIdA,
    tabs: [...b.tabs],
    active: b.active,
  }));
  return result(arrangement, {
    ...arrangement,
    tree: mapNode(withA, leafIdB, () => ({
      kind: "leaf",
      id: leafIdB,
      tabs: [...a.tabs],
      active: a.active,
    })),
  });
}

// ----------------------------------------------------------- tabs and size

/**
 * Bring a tab to the front of its leaf and focus it. A maximize in that same
 * leaf follows onto the new tab; a maximize anywhere else is cleared, because
 * it was covering the pane that was just asked for. Both come from `settled`.
 */
export function activateTab(arrangement: Arrangement, pane: PaneId): Arrangement {
  const tree = arrangement.tree;
  if (tree === null) return arrangement;
  if (leafOf(tree, pane) === null) return arrangement;
  return result(arrangement, { ...arrangement, focus: pane });
}

/**
 * The next or previous tab of the focused pane's leaf, wrapping. Counted from
 * the tab that is in front, which is the one the user is looking at.
 */
export function cycleTab(arrangement: Arrangement, step: 1 | -1): Arrangement {
  const tree = arrangement.tree;
  const focus = arrangement.focus;
  if (tree === null || focus === null) return arrangement;
  const leaf = leafOf(tree, focus);
  if (leaf === null || leaf.tabs.length < 2) return arrangement;
  const at = leaf.tabs.indexOf(leaf.active);
  const from = at < 0 ? 0 : at;
  return activateTab(arrangement, leaf.tabs[(from + step + leaf.tabs.length) % leaf.tabs.length]);
}

/**
 * Move a tab to another place in its own stack. `toIndex` is where it ends up,
 * clamped to the stack, a fraction read as the place before it. The tab in
 * front stays in front and the focus stays where it was: reordering the strip
 * is not choosing a tab.
 */
export function moveTab(arrangement: Arrangement, pane: PaneId, toIndex: number): Arrangement {
  const tree = arrangement.tree;
  if (tree === null || !Number.isFinite(toIndex)) return arrangement;
  const leaf = leafOf(tree, pane);
  if (leaf === null) return arrangement;
  const from = leaf.tabs.indexOf(pane);
  const to = clamp(Math.trunc(toIndex), 0, leaf.tabs.length - 1);
  if (to === from) return arrangement;
  const tabs = leaf.tabs.filter((tab) => tab !== pane);
  tabs.splice(to, 0, pane);
  return result(arrangement, {
    ...arrangement,
    tree: mapNode(tree, leaf.id, () => ({ kind: "leaf", id: leaf.id, tabs, active: leaf.active })),
  });
}

/**
 * Give one pane the whole workspace, or give it back. A pane that is not open
 * cannot be maximized; naming a pane while a different one is maximized moves
 * the maximize to it rather than only clearing it, so one call can always
 * answer "show me this one alone".
 *
 * Maximizing also brings the pane to the front of its leaf and focuses it,
 * because a full size leaf showing a different tab is a pane filling the
 * workspace with something nobody asked for.
 */
export function toggleMaximize(arrangement: Arrangement, pane: PaneId): Arrangement {
  const tree = arrangement.tree;
  if (tree === null || leafOf(tree, pane) === null) return arrangement;
  if (arrangement.maximized === pane) {
    return result(arrangement, { ...arrangement, maximized: null });
  }
  return result(arrangement, { ...arrangement, maximized: pane, focus: pane });
}

/**
 * The same panes as ONE leaf: every tab of every leaf in leaf order, with the
 * focus in front (or the first pane, when nothing is focused), and nothing
 * maximized. This is the phone's arrangement, whose bar is that leaf's strip.
 *
 * A tree that is already one leaf keeps its own tab in front: flattening it
 * again changes nothing, which is what lets the store flatten every phone
 * arrangement it is handed and still hand back the same object.
 */
export function flatten(arrangement: Arrangement): Arrangement {
  const leaves = leavesOf(arrangement.tree);
  if (leaves.length < 2) return result(arrangement, { ...arrangement, maximized: null });
  const tabs: PaneId[] = [];
  for (const found of leaves) tabs.push(...found.tabs);
  const focus = arrangement.focus;
  const active = focus !== null && tabs.includes(focus) ? focus : tabs[0];
  return result(arrangement, {
    ...arrangement,
    tree: { kind: "leaf", id: leaves[0].id, tabs, active },
    maximized: null,
  });
}

// --------------------------------------------------------------- options

function specFor(specs: readonly PaneSpec[], pane: PaneId): PaneSpec | null {
  return specs.find((candidate) => candidate.id === pane) ?? null;
}

function optionFor(specs: readonly PaneSpec[], pane: PaneId, key: string): PaneOption | null {
  const spec = specFor(specs, pane);
  if (spec === null) return null;
  return spec.options.find((candidate) => candidate.key === key) ?? null;
}

function offers(option: PaneOption, value: unknown): value is string {
  return typeof value === "string" && option.choices.some((candidate) => candidate.value === value);
}

/** What is stored for one pane, or null. Read as an own property only. */
function heldOptions(
  options: Record<PaneId, Record<string, string>>,
  pane: PaneId,
): Record<string, string> | null {
  if (!own(options, pane)) return null;
  const held = options[pane];
  return held !== null && typeof held === "object" ? held : null;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

/**
 * Every view setting a pane declares, as the user has it: the stored value
 * when there is one the catalog still offers, and the fallback otherwise. A
 * pane with no spec has none.
 */
export function optionsOf(
  arrangement: Arrangement,
  pane: PaneId,
  specs: readonly PaneSpec[] = PANES,
): Record<string, string> {
  const out: Record<string, string> = {};
  const spec = specFor(specs, pane);
  if (spec === null) return out;
  const held = heldOptions(arrangement.options, pane);
  for (const option of spec.options) {
    const value = held !== null && own(held, option.key) ? held[option.key] : undefined;
    out[option.key] = offers(option, value) ? value : option.fallback;
  }
  return out;
}

/**
 * Set one of a pane's view settings. Stored only when the pane's spec has that
 * key and that choice. Only what differs from the fallback is kept, so setting
 * the fallback removes the entry, and the pane's own entry with its last one:
 * an arrangement nobody has set an option on holds no options at all.
 */
export function setOption(
  arrangement: Arrangement,
  pane: PaneId,
  key: string,
  value: string,
  specs: readonly PaneSpec[] = PANES,
): Arrangement {
  const option = optionFor(specs, pane, key);
  if (option === null || !offers(option, value)) return arrangement;
  const held = heldOptions(arrangement.options, pane);
  const current = held !== null && own(held, key) ? held[key] : undefined;
  if (value === option.fallback) {
    if (current === undefined || held === null) return arrangement;
    const rest = without(held, key);
    const options =
      Object.keys(rest).length === 0
        ? without(arrangement.options, pane)
        : { ...arrangement.options, [pane]: rest };
    return result(arrangement, { ...arrangement, options });
  }
  if (current === value) return arrangement;
  return result(arrangement, {
    ...arrangement,
    options: { ...arrangement.options, [pane]: { ...(held ?? {}), [key]: value } },
  });
}
