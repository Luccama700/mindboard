// One arrangement as a short line of text, for a cookie to carry.
//
// WHY A GRAMMAR OF ITS OWN. The server draws the first paint, so it has to know
// the arrangement before any script runs, and the only place it can read that
// from is a cookie: about four kilobytes, every byte of which travels with
// every request. JSON spends most of that on keys and quotes and has to be
// escaped to be a cookie at all. This text spends nothing on either:
//
//   leaf    (  its panes joined by ~, the one in front followed by *  )
//   split   h or v, the ratio times ten thousand in four digits, then the two
//           children with nothing between them
//   then    _m. and a pane, when one is maximized
//   then    _o.<pane>.<key>.<value> for each option, panes and keys sorted
//
// so the wide Today layout is h5000h5000v6700(today*)(status*)v5000(past-due*)
// (not-today*)(calendar*), and an empty tree is (). Every character used is in
// the set encodeURIComponent leaves alone and is a legal cookie octet, so the
// text is the cookie's value as it is, whether the browser or the server
// writes it.
//
// WHAT IS NOT WRITTEN. Ids, because they are a function of the tree and the
// engine mints them again down it on the way back. The focus, because it is
// not stored anywhere (amendment B). The places of closed panes, because a
// first paint does not need them; the browser's own storage keeps them.
//
// THE ENCODER IS ONLY SYNTAX. It writes whatever it is handed that the grammar
// can spell (a pane id, key or value of [a-z0-9-]) and leaves out whatever it
// cannot, so its output is always in the grammar. Whether a pane is in the
// catalog, or an option is one the pane offers, is the engine's to decide on
// the way back in, and a value the engine never makes may lose a pane here.
//
// THE DECODER TRUSTS NOTHING IT READ. readArrangement turns the text into the
// same plain value a stored slot is, and the engine's own repair decides what
// survives: unknown panes, a pane twice, ratios out of range, a maximize on a
// pane behind another, options the catalog does not have. Text that is not in
// the grammar at all is null. A tree nested past the depth the engine can build
// is a tree nothing survives from, as the parser treats one: the reader stops
// at the cap without reading on, so its work is bounded whatever follows, and
// the answer is an arrangement with nothing open. In a cookie that leaves one
// class at its default and keeps the rest of the desk.
//
// Pure. No DOM, no storage, no clock, no randomness.

import { MAX_TREE_DEPTH, repairArrangement } from "./store";
import { normalizeRatio } from "./tree";
import type { Arrangement, TileNode } from "./types";

/** A ratio is written as this many parts of one, in exactly RATIO_DIGITS digits. */
const RATIO_SCALE = 10_000;
const RATIO_DIGITS = 4;

const OPEN = "(";
const CLOSE = ")";
const TAB = "~";
const FRONT = "*";
const SECTION = "_";
const PART = ".";
const MAXIMIZED = "_m.";
const OPTION = "_o.";

function isTokenChar(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-";
}

/** A pane id, option key or value the grammar can spell: [a-z0-9-] and at least one of them. */
function isToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let at = 0; at < value.length; at += 1) {
    if (!isTokenChar(value[at])) return false;
  }
  return true;
}

/** A record's own keys in code unit order, which is the same on every engine. */
function sortedKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

// ---------------------------------------------------------------- writing

function writeRatio(ratio: number): string {
  return String(Math.round(normalizeRatio(ratio) * RATIO_SCALE)).padStart(RATIO_DIGITS, "0");
}

function writeNode(node: TileNode | null, depth: number): string {
  if (node === null) return `${OPEN}${CLOSE}`;
  if (node.kind === "leaf") {
    let starred = false;
    const tabs: string[] = [];
    for (const tab of node.tabs) {
      if (!isToken(tab)) continue;
      const front = !starred && tab === node.active;
      if (front) starred = true;
      tabs.push(front ? `${tab}${FRONT}` : tab);
    }
    return `${OPEN}${tabs.join(TAB)}${CLOSE}`;
  }
  // A split at the limit would put its children past what the reader reads.
  // No tree the engine builds reaches here; a hand made one is cut where the
  // reader would stop, so what is written can always be read.
  if (depth >= MAX_TREE_DEPTH) return `${OPEN}${CLOSE}`;
  const dir = node.dir === "v" ? "v" : "h";
  return `${dir}${writeRatio(node.ratio)}${writeNode(node.first, depth + 1)}${writeNode(node.second, depth + 1)}`;
}

/**
 * One arrangement in the grammar above. Never throws for a value the engine
 * can make; ids, focus and closed panes' places are not written.
 */
export function encodeArrangement(arr: Arrangement): string {
  let text = writeNode(arr.tree, 1);
  if (isToken(arr.maximized)) text += `${MAXIMIZED}${arr.maximized}`;
  for (const pane of sortedKeys(arr.options)) {
    if (!isToken(pane)) continue;
    const held: unknown = arr.options[pane];
    for (const key of sortedKeys(held)) {
      const value = (held as Record<string, unknown>)[key];
      if (!isToken(key) || !isToken(value)) continue;
      text += `${OPTION}${pane}${PART}${key}${PART}${value}`;
    }
  }
  return text;
}

// ---------------------------------------------------------------- reading

/** Where the reader is in the text. */
interface Cursor {
  text: string;
  at: number;
}

/** What a node is when the text is not in the grammar. */
const UNREADABLE = Symbol("unreadable");

/** What a node is when it sits past MAX_TREE_DEPTH: the reader stopped there and read no further. */
const TOO_DEEP = Symbol("too deep");

type ReadNode = Record<string, unknown> | typeof UNREADABLE | typeof TOO_DEEP;

function readToken(cursor: Cursor): string {
  const start = cursor.at;
  while (cursor.at < cursor.text.length && isTokenChar(cursor.text[cursor.at])) cursor.at += 1;
  return cursor.text.slice(start, cursor.at);
}

function readLeaf(cursor: Cursor): Record<string, unknown> | typeof UNREADABLE {
  cursor.at += OPEN.length;
  const tabs: string[] = [];
  let active: string | null = null;
  if (cursor.text[cursor.at] === CLOSE) {
    cursor.at += CLOSE.length;
    return { kind: "leaf", tabs };
  }
  for (;;) {
    const tab = readToken(cursor);
    if (tab.length === 0) return UNREADABLE;
    if (cursor.text[cursor.at] === FRONT) {
      if (active !== null) return UNREADABLE;
      active = tab;
      cursor.at += FRONT.length;
    }
    tabs.push(tab);
    const next = cursor.text[cursor.at];
    cursor.at += 1;
    if (next === CLOSE) break;
    if (next !== TAB) return UNREADABLE;
  }
  return active === null ? { kind: "leaf", tabs } : { kind: "leaf", tabs, active };
}

/**
 * The root is level one, as the engine's parser counts. A node past
 * MAX_TREE_DEPTH is not looked at: the reader stops there, and the answer
 * travels up without the rest of the text being read.
 */
function readNode(cursor: Cursor, depth: number): ReadNode {
  if (depth > MAX_TREE_DEPTH) return TOO_DEEP;
  const head = cursor.text[cursor.at];
  if (head === OPEN) return readLeaf(cursor);
  if (head !== "h" && head !== "v") return UNREADABLE;
  cursor.at += 1;
  let parts = 0;
  for (let digit = 0; digit < RATIO_DIGITS; digit += 1) {
    const char = cursor.text[cursor.at];
    if (char === undefined || char < "0" || char > "9") return UNREADABLE;
    parts = parts * 10 + (char.charCodeAt(0) - 48);
    cursor.at += 1;
  }
  const first = readNode(cursor, depth + 1);
  if (typeof first === "symbol") return first;
  const second = readNode(cursor, depth + 1);
  if (typeof second === "symbol") return second;
  return { kind: "split", dir: head, ratio: parts / RATIO_SCALE, first, second };
}

/**
 * The text as the plain value a stored slot is (tree, maximized, lastSpot,
 * options), with no ids and nothing checked against the catalog, or null when
 * the text is not in the grammar. It is what the engine's repair, or the
 * parser of a whole desk, is handed; it is not an arrangement anything should
 * draw. An option given twice keeps its first value.
 *
 * A tree nested past MAX_TREE_DEPTH is a value with no tree and nothing else:
 * the reader stops at the cap and reads none of what follows, neither the rest
 * of the tree nor any maximize or option after it.
 */
export function readArrangement(text: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const cursor: Cursor = { text, at: 0 };
  const tree = readNode(cursor, 1);
  if (tree === UNREADABLE) return null;
  if (tree === TOO_DEEP) return { tree: null, maximized: null, lastSpot: {}, options: {} };

  let maximized: string | null = null;
  // Map keys, so that no word read from the text is ever looked up on an object.
  const options = new Map<string, Map<string, string>>();
  while (cursor.at < text.length) {
    if (text.startsWith(MAXIMIZED, cursor.at)) {
      if (maximized !== null || options.size > 0) return null;
      cursor.at += MAXIMIZED.length;
      const pane = readToken(cursor);
      if (pane.length === 0) return null;
      maximized = pane;
      continue;
    }
    if (!text.startsWith(OPTION, cursor.at)) return null;
    cursor.at += OPTION.length;
    const pane = readToken(cursor);
    if (pane.length === 0 || text[cursor.at] !== PART) return null;
    cursor.at += PART.length;
    const key = readToken(cursor);
    if (key.length === 0 || text[cursor.at] !== PART) return null;
    cursor.at += PART.length;
    const value = readToken(cursor);
    if (value.length === 0) return null;
    if (cursor.at < text.length && text[cursor.at] !== SECTION) return null;
    const held = options.get(pane) ?? new Map<string, string>();
    if (!held.has(key)) held.set(key, value);
    options.set(pane, held);
  }

  return {
    tree,
    maximized,
    lastSpot: {},
    // Object.fromEntries defines each key as the object's own, whatever word it is.
    options: Object.fromEntries([...options].map(([pane, held]) => [pane, Object.fromEntries(held)])),
  };
}

/**
 * The arrangement the text describes, after the engine's own repair has seen
 * it, or null when the text is not in the grammar. Never throws. Ids are minted
 * again down the tree; the focus is the maximized pane or the tab the first
 * leaf shows; `()`, a tree of nothing but panes the catalog does not know, or
 * a tree nested past MAX_TREE_DEPTH is an arrangement with nothing open.
 */
export function decodeArrangement(text: string): Arrangement | null {
  const read = readArrangement(text);
  return read === null ? null : repairArrangement(read);
}
