// Task 2, the engine's geometry written as CSS lengths.
//
// THE PROPERTY THIS FILE EXISTS FOR. cssLayout and layoutTree are one formula
// written twice. The browser paints with the first, from a page the server
// wrote without knowing the window's size; the desk hit tests and moves focus
// with the second, on the measured workspace. A pixel of disagreement is a
// divider drawn in one place and dragged from another, so the two are held to
// each other here box by box, to the pixel.
//
// HOW, WITHOUT A BROWSER. The file carries a small evaluator for exactly the CSS
// the module writes: + - * inside calc, clamp, min, max, round(nearest, x, 1px),
// px, %, and var(). It is strict on purpose, because it is the only browser
// this task has: arithmetic outside a math function, + or - without whitespace
// on both sides, a unitless 0 added to a length, two lengths multiplied, an
// exponent, a unit it does not know, a custom property whose value is a bare
// sum, all of these throw rather than compute something a browser would not.
//
// var() is evaluated once per property and axis and remembered. That is the
// only way a deep chain finishes (each level names its parent's extent about
// three times), and it is faithful to the browser's textual substitution only
// because every custom property's value is one complete term. The evaluator
// checks that too.

import { describe, expect, test } from "vitest";

import { cssLayout, ratioVar } from "@/app/lib/v2/tiles/css";
import type { CssBox, CssLayout } from "@/app/lib/v2/tiles/css";
import { layoutTree, minSize, shareLimits } from "@/app/lib/v2/tiles/geometry";
import { leavesOf } from "@/app/lib/v2/tiles/tree";
import type {
  Arrangement,
  PaneId,
  PaneSpec,
  Rect,
  Split,
  SplitDir,
  TileNode,
  Workspace,
} from "@/app/lib/v2/tiles/types";

// ------------------------------------------------------------ the evaluator

type Axis = "x" | "y";

interface Typed {
  kind: "number" | "length";
  value: number;
}

type Token =
  | { t: "ws" }
  | { t: "number"; value: number }
  | { t: "px"; value: number }
  | { t: "percent"; value: number }
  | { t: "ident"; name: string }
  | { t: "function"; name: string }
  | { t: "open" }
  | { t: "close" }
  | { t: "comma" }
  | { t: "delim"; char: string };

const NUMBER_TOKEN = /^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)/;
const STARTS_NUMBER = /^[+-]?\.?[0-9]/;
const NAME_TOKEN = /^(?:--|-?[A-Za-z_])[A-Za-z0-9_-]*/;
const UNIT_TOKEN = /^-?[A-Za-z_][A-Za-z0-9_-]*/;

/** Tokens do not depend on the workspace's size, so each string is read once. */
const tokenCache = new Map<string, Token[]>();

/**
 * CSS's own tokenizing rules, as far as this subset needs them: a sign
 * directly before a digit belongs to the number, which is why `1px -2px` is
 * two values and not a subtraction.
 */
function tokenize(text: string): Token[] {
  const cached = tokenCache.get(text);
  if (cached !== undefined) return cached;
  const out: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/.exec(rest);
    if (space !== null) {
      out.push({ t: "ws" });
      at += space[0].length;
      continue;
    }
    const char = rest[0];
    if (char === "(" || char === ")" || char === ",") {
      out.push({ t: char === "(" ? "open" : char === ")" ? "close" : "comma" });
      at += 1;
      continue;
    }
    if (STARTS_NUMBER.test(rest)) {
      const number = NUMBER_TOKEN.exec(rest);
      if (number === null) throw new Error(`unreadable number in "${text}"`);
      at += number[0].length;
      const value = Number(number[0]);
      const after = text.slice(at);
      if (after.startsWith("%")) {
        out.push({ t: "percent", value });
        at += 1;
        continue;
      }
      const unit = UNIT_TOKEN.exec(after);
      if (unit !== null) {
        if (unit[0] !== "px") throw new Error(`"${unit[0]}" after a number in "${text}"`);
        out.push({ t: "px", value });
        at += unit[0].length;
        continue;
      }
      out.push({ t: "number", value });
      continue;
    }
    const name = NAME_TOKEN.exec(rest);
    if (name !== null) {
      at += name[0].length;
      if (text[at] === "(") {
        out.push({ t: "function", name: name[0] });
        at += 1;
      } else {
        out.push({ t: "ident", name: name[0] });
      }
      continue;
    }
    if ("+-*/".includes(char)) {
      out.push({ t: "delim", char });
      at += 1;
      continue;
    }
    throw new Error(`unexpected "${char}" in "${text}"`);
  }
  tokenCache.set(text, out);
  return out;
}

function sameKind(values: Typed[], what: string): Typed["kind"] {
  const kind = values[0].kind;
  if (values.some((value) => value.kind !== kind)) {
    throw new Error(`${what} mixes a number and a length`);
  }
  return kind;
}

/** CSS round(nearest): the nearer multiple, and exactly between two goes up. */
function roundNearest(value: number, step: number): number {
  const lower = Math.floor(value / step) * step;
  const upper = Math.ceil(value / step) * step;
  if (lower === upper) return lower;
  return value - lower < upper - value ? lower : upper;
}

class Evaluator {
  private readonly memo = new Map<string, Typed>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly vars: Record<string, string>,
    private readonly width: number,
    private readonly height: number,
  ) {}

  /** A box property: one term that is a length, or the bare `0` CSS allows for one. */
  length(text: string, axis: Axis): number {
    if (text === "0") return 0;
    const value = this.term(text, axis);
    if (value.kind !== "length") throw new Error(`"${text}" is not a length`);
    return value.value;
  }

  /** One complete term, which is what a box string and a custom property's value must be. */
  term(text: string, axis: Axis): Typed {
    return new Reader(tokenize(text), this, axis).whole();
  }

  variable(name: string, axis: Axis): Typed {
    const key = `${axis} ${name}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    if (this.busy.has(key)) throw new Error(`${name} refers to itself`);
    if (!Object.prototype.hasOwnProperty.call(this.vars, name)) {
      throw new Error(`${name} is not defined`);
    }
    this.busy.add(key);
    const value = this.term(this.vars[name], axis);
    this.busy.delete(key);
    this.memo.set(key, value);
    return value;
  }

  /** A percentage of the workspace box: its width for left and width, its height for top and height. */
  percent(value: number, axis: Axis): number {
    return (value / 100) * (axis === "x" ? this.width : this.height);
  }
}

class Reader {
  private at = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly css: Evaluator,
    private readonly axis: Axis,
  ) {}

  whole(): Typed {
    this.space();
    const value = this.atom(false);
    this.space();
    if (this.at !== this.tokens.length) {
      throw new Error("more than one term: arithmetic belongs inside calc()");
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private take(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error("ends early");
    this.at += 1;
    return token;
  }

  private space(): boolean {
    let any = false;
    while (this.peek()?.t === "ws") {
      this.at += 1;
      any = true;
    }
    return any;
  }

  private expect(t: Token["t"]): void {
    const token = this.take();
    if (token.t !== t) throw new Error(`expected ${t}, found ${token.t}`);
  }

  /** Products joined by + and -, which CSS requires to have whitespace on both sides. */
  private sum(): Typed {
    let left = this.product();
    for (;;) {
      const mark = this.at;
      const before = this.space();
      const op = this.peek();
      if (op !== undefined && op.t === "delim" && (op.char === "+" || op.char === "-")) {
        if (!before) throw new Error(`"${op.char}" with no whitespace before it`);
        this.at += 1;
        if (!this.space()) throw new Error(`"${op.char}" with no whitespace after it`);
        const right = this.product();
        if (left.kind !== right.kind) throw new Error(`"${op.char}" between a number and a length`);
        left = {
          kind: left.kind,
          value: op.char === "+" ? left.value + right.value : left.value - right.value,
        };
        continue;
      }
      this.at = mark;
      return left;
    }
  }

  private product(): Typed {
    let left = this.atom(true);
    for (;;) {
      const mark = this.at;
      this.space();
      const op = this.peek();
      if (op !== undefined && op.t === "delim" && op.char === "*") {
        this.at += 1;
        this.space();
        const right = this.atom(true);
        if (left.kind === "length" && right.kind === "length") {
          throw new Error("two lengths multiplied");
        }
        left = {
          kind: left.kind === "length" || right.kind === "length" ? "length" : "number",
          value: left.value * right.value,
        };
        continue;
      }
      if (op !== undefined && op.t === "delim" && op.char === "/") {
        throw new Error("division is outside this evaluator");
      }
      this.at = mark;
      return left;
    }
  }

  private atom(insideMath: boolean): Typed {
    const token = this.take();
    switch (token.t) {
      case "number":
        return { kind: "number", value: token.value };
      case "px":
        return { kind: "length", value: token.value };
      case "percent":
        return { kind: "length", value: this.css.percent(token.value, this.axis) };
      case "open": {
        if (!insideMath) throw new Error("a bracket outside a math function");
        this.space();
        const value = this.sum();
        this.space();
        this.expect("close");
        return value;
      }
      case "function":
        return this.call(token.name);
      default:
        throw new Error(`unexpected ${token.t}`);
    }
  }

  /** Arguments up to the closing bracket, each a full sum. */
  private list(): Typed[] {
    const out: Typed[] = [];
    for (;;) {
      this.space();
      out.push(this.sum());
      this.space();
      const token = this.take();
      if (token.t === "close") return out;
      if (token.t !== "comma") throw new Error(`expected a comma, found ${token.t}`);
    }
  }

  private call(name: string): Typed {
    switch (name) {
      case "calc": {
        this.space();
        const value = this.sum();
        this.space();
        this.expect("close");
        return value;
      }
      case "min":
      case "max": {
        const args = this.list();
        const kind = sameKind(args, `${name}()`);
        const values = args.map((arg) => arg.value);
        return { kind, value: name === "min" ? Math.min(...values) : Math.max(...values) };
      }
      case "clamp": {
        const args = this.list();
        if (args.length !== 3) throw new Error("clamp() takes three arguments");
        const kind = sameKind(args, "clamp()");
        const [low, wanted, high] = args;
        // A lower bound above the upper one wins, as CSS says.
        return { kind, value: Math.max(low.value, Math.min(wanted.value, high.value)) };
      }
      case "round": {
        this.space();
        const strategy = this.take();
        if (strategy.t !== "ident" || strategy.name !== "nearest") {
          throw new Error("round() here is always round(nearest, value, step)");
        }
        this.space();
        this.expect("comma");
        const args = this.list();
        if (args.length !== 2) throw new Error("round(nearest, value, step) takes a value and a step");
        const [value, step] = args;
        if (value.kind !== "length" || step.kind !== "length" || !(step.value > 0)) {
          throw new Error("round() here rounds a length by a positive length");
        }
        return { kind: "length", value: roundNearest(value.value, step.value) };
      }
      case "var": {
        this.space();
        const ident = this.take();
        if (ident.t !== "ident" || !ident.name.startsWith("--")) {
          throw new Error("var() names a custom property");
        }
        this.space();
        this.expect("close");
        return this.css.variable(ident.name, this.axis);
      }
      default:
        throw new Error(`${name}() is outside this evaluator`);
    }
  }
}

function evaluateBox(css: Evaluator, box: CssBox): Rect {
  return {
    x: css.length(box.left, "x"),
    y: css.length(box.top, "y"),
    w: css.length(box.width, "x"),
    h: css.length(box.height, "y"),
  };
}

// --------------------------------------------------------------- the trees

/** Mulberry32: a few lines, no dependency, and the same run every time. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand: () => number, low: number, high: number): number {
  return low + Math.floor(rand() * (high - low + 1));
}

/**
 * The fields PaneSpec carries besides the three read here, on both sides of
 * the change Task 1 is making to it beside this file (`closable` goes; `short`,
 * `group` and `options` come). The cast goes through unknown so this file
 * compiles before and after; cssLayout and the engine's geometry only ever read
 * `id`, `minWidth` and `minHeight`.
 */
const SPEC_EXTRAS = { short: "Pane", group: "day", options: [], closable: true };

function paneSpec(id: PaneId, minWidth: number, minHeight: number): PaneSpec {
  return { ...SPEC_EXTRAS, id, title: `Pane title ${id}`, minWidth, minHeight } as unknown as PaneSpec;
}

/** An arrangement for layoutTree, carrying Task 1's `options` the same way. */
function arrangementFor(tree: TileNode | null, maximized: PaneId | null): Arrangement {
  return { tree, maximized, focus: null, lastSpot: {}, options: {} } as unknown as Arrangement;
}

function leafNode(id: string, ...tabs: PaneId[]): TileNode {
  return { kind: "leaf", id, tabs: [...tabs], active: tabs[0] };
}

function splitNode(
  id: string,
  dir: SplitDir,
  ratio: number,
  first: TileNode,
  second: TileNode,
): TileNode {
  return { kind: "split", id, dir, ratio, first, second };
}

const EDGE_RATIOS = [0, 1, 0.05, 0.95, 0.5, -0.25, 1.5, 1e-7, 0.9999999];
const UNUSABLE_RATIOS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

function randomRatio(rand: () => number): number {
  const roll = rand();
  // As the engine stores a ratio: four decimals, inside the range normalize allows.
  if (roll < 0.6) return Math.round((0.05 + rand() * 0.9) * 10000) / 10000;
  // A share at full precision, as a drag might hand one over.
  if (roll < 0.85) return rand();
  // The ends of the range, outside it, and a value String() writes with an exponent.
  if (roll < 0.97) return EDGE_RATIOS[Math.floor(rand() * EDGE_RATIOS.length)];
  return UNUSABLE_RATIOS[Math.floor(rand() * UNUSABLE_RATIOS.length)];
}

function randomMinimum(rand: () => number, low: number, high: number): number {
  return rand() < 0.1 ? 0 : pick(rand, low, high);
}

interface World {
  tree: TileNode;
  specs: PaneSpec[];
}

/**
 * A tree of one to twelve leaves, each holding one to three panes. Pane ids
 * are unique across the whole tree because layoutTree finds the maximized leaf
 * as the first one holding the pane, and minSize takes the first spec with an
 * id. Node ids are `l<n>` and `s<n>` with gaps, so no id is guessable from its
 * place in the tree.
 */
function randomWorld(rand: () => number): World {
  const specs: PaneSpec[] = [];
  let idNumber = 0;
  let paneNumber = 0;
  const nextId = (letter: "l" | "s"): string => {
    idNumber += pick(rand, 1, 3);
    return `${letter}${idNumber}`;
  };
  const build = (count: number): TileNode => {
    if (count === 1) {
      const tabs: PaneId[] = [];
      const tabCount = pick(rand, 1, 3);
      for (let index = 0; index < tabCount; index += 1) {
        paneNumber += 1;
        const id = `pane${paneNumber}`;
        tabs.push(id);
        // Now and then a pane with no spec at all, which minSize reads as no minimum.
        if (rand() >= 0.05) {
          specs.push(paneSpec(id, randomMinimum(rand, 120, 330), randomMinimum(rand, 100, 300)));
        }
      }
      return {
        kind: "leaf",
        id: nextId("l"),
        tabs,
        active: tabs[Math.floor(rand() * tabs.length)],
      };
    }
    const id = nextId("s");
    const dir: SplitDir = rand() < 0.5 ? "h" : "v";
    const ratio = randomRatio(rand);
    const firstCount = pick(rand, 1, count - 1);
    return splitNode(id, dir, ratio, build(firstCount), build(count - firstCount));
  };
  return { tree: build(pick(rand, 1, 12)), specs };
}

const LARGEST: Workspace = { width: 3840, height: 2160 };

/**
 * Forty whole pixel sizes from the tree's minimum up to 3840 by 2160: the four
 * corners (the minimum itself is where every clamp binds), twelve just above
 * the minimum, and the rest anywhere in between. A tree whose minimum is past
 * the largest screen is checked at its minimum in that dimension.
 */
function sizesFor(min: { w: number; h: number }, rand: () => number): Workspace[] {
  const top = { width: Math.max(min.w, LARGEST.width), height: Math.max(min.h, LARGEST.height) };
  const sizes: Workspace[] = [
    { width: min.w, height: min.h },
    { width: top.width, height: top.height },
    { width: min.w, height: top.height },
    { width: top.width, height: min.h },
  ];
  while (sizes.length < 16) {
    sizes.push({
      width: Math.min(top.width, min.w + pick(rand, 0, 24)),
      height: Math.min(top.height, min.h + pick(rand, 0, 24)),
    });
  }
  while (sizes.length < 40) {
    sizes.push({ width: pick(rand, min.w, top.width), height: pick(rand, min.h, top.height) });
  }
  return sizes;
}

function show(rect: Rect): string {
  return `${rect.x},${rect.y} ${rect.w}x${rect.h}`;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Every box where the CSS and layoutTree differ at this size, in words. */
function disagreements(
  layout: CssLayout,
  tree: TileNode | null,
  maximizedPane: PaneId | null,
  specs: readonly PaneSpec[],
  size: Workspace,
): string[] {
  const rects = layoutTree(arrangementFor(tree, maximizedPane), size, specs);
  const css = new Evaluator(layout.vars, size.width, size.height);
  const at = `${size.width}x${size.height}`;
  const out: string[] = [];
  if (layout.leaves.length !== rects.leaves.length) {
    out.push(`${at}: ${layout.leaves.length} leaf boxes, ${rects.leaves.length} leaf rects`);
  }
  if (layout.dividers.length !== rects.dividers.length) {
    out.push(`${at}: ${layout.dividers.length} divider boxes, ${rects.dividers.length} divider rects`);
  }
  rects.leaves.forEach((rect, index) => {
    const box = layout.leaves[index];
    if (box === undefined || box.leafId !== rect.leafId) {
      out.push(`${at}: leaf ${index} is ${box?.leafId} in the CSS, ${rect.leafId} in the engine`);
      return;
    }
    const drawn = evaluateBox(css, box);
    if (!sameRect(drawn, rect)) {
      out.push(`${at}: leaf ${rect.leafId} css ${show(drawn)} engine ${show(rect)}`);
    }
  });
  rects.dividers.forEach((rect, index) => {
    const box = layout.dividers[index];
    if (box === undefined || box.splitId !== rect.splitId || box.dir !== rect.dir) {
      out.push(`${at}: divider ${index} is ${box?.splitId} in the CSS, ${rect.splitId} in the engine`);
      return;
    }
    const drawn = evaluateBox(css, box);
    if (!sameRect(drawn, rect)) {
      out.push(`${at}: divider ${rect.splitId} css ${show(drawn)} engine ${show(rect)}`);
    }
  });
  return out;
}

/** The pane to maximize, and the leaf it is in, each derived from the other's tree. */
function maximizedIn(tree: TileNode, rand: () => number): { pane: PaneId; leafId: string } {
  const panes = leavesOf(tree).flatMap((leaf) => leaf.tabs);
  const pane = panes[Math.floor(rand() * panes.length)];
  const holding = leavesOf(tree).find((leaf) => leaf.tabs.includes(pane));
  if (holding === undefined) throw new Error("a pane in no leaf");
  return { pane, leafId: holding.id };
}

/**
 * How each split is drawn at this size: held at its first side's minimum, held
 * at its second side's, or where it was set. Read off the engine's own divider
 * rects, which carry each split's span.
 */
function countShares(
  tree: TileNode,
  size: Workspace,
  specs: readonly PaneSpec[],
  counts: { low: number; high: number; free: number },
): void {
  const splits = new Map<string, Split>();
  const collect = (node: TileNode): void => {
    if (node.kind === "leaf") return;
    splits.set(node.id, node);
    collect(node.first);
    collect(node.second);
  };
  collect(tree);
  for (const divider of layoutTree(arrangementFor(tree, null), size, specs).dividers) {
    const split = splits.get(divider.splitId);
    if (split === undefined) continue;
    const [low, high] = shareLimits(split, divider.size, specs);
    const ratio = Number.isFinite(split.ratio) ? split.ratio : 0.5;
    if (ratio < low) counts.low += 1;
    else if (ratio > high) counts.high += 1;
    else counts.free += 1;
  }
}

// ------------------------------------------------------------------ chains

const CHAIN_MIN = { w: 230, h: 150 };

/**
 * A chain of `depth` splits. `side` says which child the next split is;
 * `axes` whether every split runs the same way or they alternate.
 */
function chain(
  depth: number,
  side: "first" | "second" | "zigzag",
  axes: "same" | "alternate",
  ratio: number,
): World {
  const specs: PaneSpec[] = [];
  let leafNumber = 0;
  const leaf = (): TileNode => {
    leafNumber += 1;
    const pane = `pane${leafNumber}`;
    specs.push(paneSpec(pane, CHAIN_MIN.w + (leafNumber % 3) * 45, CHAIN_MIN.h));
    return leafNode(`l${leafNumber + 100}`, pane);
  };
  const build = (level: number): TileNode => {
    if (level === depth) return leaf();
    const dir: SplitDir = axes === "same" || level % 2 === 0 ? "h" : "v";
    const deeperFirst = side === "first" || (side === "zigzag" && level % 2 === 0);
    const id = `s${level + 1}`;
    return deeperFirst
      ? splitNode(id, dir, ratio, build(level + 1), leaf())
      : splitNode(id, dir, ratio, leaf(), build(level + 1));
  };
  return { tree: build(0), specs };
}

function allStrings(layout: CssLayout): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(layout.vars)) out.push(name, value);
  for (const box of [...layout.leaves, ...layout.dividers]) {
    out.push(box.left, box.top, box.width, box.height);
  }
  return out;
}

function totalLength(layout: CssLayout): number {
  return allStrings(layout).reduce((sum, text) => sum + text.length, 0);
}

/**
 * The longest box string once every var() in it is replaced by its value, as
 * a browser substitutes them, counted without building the text.
 */
function substitutedLength(layout: CssLayout): number {
  const memo = new Map<string, number>();
  const lengthOf = (text: string): number => {
    let total = text.length;
    for (const match of text.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      total += valueLength(match[1]) - match[0].length;
    }
    return total;
  };
  const valueLength = (name: string): number => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const length = lengthOf(layout.vars[name]);
    memo.set(name, length);
    return length;
  };
  let longest = 0;
  for (const box of [...layout.leaves, ...layout.dividers]) {
    for (const text of [box.left, box.top, box.width, box.height]) {
      longest = Math.max(longest, lengthOf(text));
    }
  }
  return longest;
}

// ------------------------------------------------------------------- tests

describe("the evaluator this file proves with", () => {
  const css = new Evaluator(
    {
      "--a": "calc(100% - 6px)",
      "--r": "0.25",
      "--sum": "100% - 6px",
      "--zero": "0",
      "--loop": "var(--loop)",
      "--b": "var(--a)",
    },
    1000,
    500,
  );

  test("reads the CSS the module writes, with each percentage taken where it is used", () => {
    expect(css.length("calc(100% - 6px)", "x")).toBe(994);
    expect(css.length("calc(100% - 6px)", "y")).toBe(494);
    expect(css.length("var(--b)", "y")).toBe(494);
    expect(css.length("var(--b)", "x")).toBe(994);
    expect(
      css.length("round(nearest, clamp(300px, var(--a) * var(--r), var(--a) - 100px), 1px)", "x"),
    ).toBe(300);
    expect(
      css.length("round(nearest, clamp(100px, var(--a) * var(--r), var(--a) - 100px), 1px)", "x"),
    ).toBe(249);
    expect(css.length("clamp(300px, 10px, 200px)", "x")).toBe(300);
    expect(css.length("min(1px, 2px, calc(3px - 4px))", "x")).toBe(-1);
    expect(css.length("max(1px, 2px)", "x")).toBe(2);
    expect(css.length("calc(2px + 3px * 2)", "x")).toBe(8);
    expect(css.length("calc((2px + 3px) * 2)", "x")).toBe(10);
    expect(css.length("calc(0.5 * 10px)", "x")).toBe(5);
    expect(css.length("0", "x")).toBe(0);
  });

  test("rounds a half toward positive infinity, as Math.round does", () => {
    expect(css.length("round(nearest, 2.5px, 1px)", "x")).toBe(3);
    expect(css.length("round(nearest, 2.4999px, 1px)", "x")).toBe(2);
    expect(css.length("round(nearest, -2.5px, 1px)", "x")).toBe(-2);
    expect(css.length("round(nearest, 0.49999999999999994px, 1px)", "x")).toBe(
      Math.round(0.49999999999999994),
    );
    expect(css.length("round(nearest, 7px, 1px)", "x")).toBe(7);
  });

  test.each([
    "calc(1px+2px)",
    "calc(1px +2px)",
    "calc(1px -2px)",
    "calc(0 + 6px)",
    "calc(1px * 2px)",
    "calc(1px / 2)",
    "100% - 6px",
    "6px 6px",
    "(1px)",
    "0.5",
    "calc(1e3px)",
    "1.5e-7px",
    "2em",
    "calc(var(--sum) * 2)",
    "var(--zero)",
    "calc(var(--zero) + 1px)",
    "var(--loop)",
    "var(--missing)",
    "var(--a, 1px)",
    "round(1px, 1px)",
    "round(up, 1px, 1px)",
    "round(nearest, 1px, 0px)",
    "clamp(1px, 2px)",
    "clamp(1px, 2, 3px)",
    "min(1px, 2)",
    "abs(1px)",
  ])("refuses %s", (text) => {
    expect(() => css.length(text, "x")).toThrow();
  });
});

describe("behaviour 1 and 2: the same formula, proven against layoutTree", () => {
  test("200 seeded trees of up to 12 leaves, each at 40 sizes from its minimum to 3840 by 2160", () => {
    const rand = seeded(0x7ce55);
    const problems: string[] = [];
    const shares = { low: 0, high: 0, free: 0 };
    let compared = 0;
    let maximizedTrees = 0;
    let splitTrees = 0;
    for (let index = 0; index < 200; index += 1) {
      const { tree, specs } = randomWorld(rand);
      const maximized = rand() < 0.3 ? maximizedIn(tree, rand) : null;
      if (maximized !== null) maximizedTrees += 1;
      if (tree.kind === "split") splitTrees += 1;
      const layout = cssLayout(tree, maximized?.leafId ?? null, specs, "wide");
      expect(layout.min).toEqual(minSize(tree, specs));
      for (const size of sizesFor(layout.min, rand)) {
        problems.push(...disagreements(layout, tree, maximized?.pane ?? null, specs, size));
        countShares(tree, size, specs, shares);
        compared += 1;
      }
    }
    expect({ count: problems.length, first: problems.slice(0, 8) }).toEqual({
      count: 0,
      first: [],
    });
    expect(compared).toBe(8000);
    // Not vacuous: the run reached maximized leaves, real splits, and shares
    // held at each limit as well as shares drawn where they were set.
    expect(maximizedTrees).toBeGreaterThan(30);
    expect(splitTrees).toBeGreaterThan(150);
    expect(shares.low).toBeGreaterThan(500);
    expect(shares.high).toBeGreaterThan(500);
    expect(shares.free).toBeGreaterThan(500);
  });

  test.each([
    ["the second child, one axis", "second", "same"],
    ["the first child, one axis", "first", "same"],
    ["the second child, alternating axes", "second", "alternate"],
    ["alternating children, one axis", "zigzag", "same"],
  ] as const)("a 12 deep chain down %s agrees at 40 sizes", (_name, side, axes) => {
    const rand = seeded(12);
    const { tree, specs } = chain(12, side, axes, 0.6180339887498949);
    const layout = cssLayout(tree, null, specs, "regular");
    const problems = sizesFor(layout.min, rand).flatMap((size) =>
      disagreements(layout, tree, null, specs, size),
    );
    expect(problems.slice(0, 8)).toEqual([]);
  });

  test("below the minimum the engine shares evenly and the CSS keeps the first side's minimum", () => {
    // The header's boundary, made executable: at the tree's minimum the two
    // forms agree, one pixel under it they part.
    const tree = splitNode("s1", "h", 0.5, leafNode("l2", "pane1"), leafNode("l3", "pane2"));
    const specs = [paneSpec("pane1", 300, 100), paneSpec("pane2", 100, 100)];
    const layout = cssLayout(tree, null, specs, "wide");
    expect(layout.min).toEqual({ w: 406, h: 100 });
    expect(disagreements(layout, tree, null, specs, { width: 406, height: 100 })).toEqual([]);
    expect(disagreements(layout, tree, null, specs, { width: 405, height: 100 })).not.toEqual([]);
  });

  test("a workspace that is not a whole number of pixels can part them above the minimum", () => {
    // The header's second limit. The root's share is held at its upper limit,
    // so its first child should leave the second exactly 300. At 700.6 the
    // first child rounds from 394.6 up to 395 and the engine's second child gets
    // 299.6, which no longer fits the 200 and 94 inside it, so the engine shares
    // that split evenly. The CSS builds that split from the second child's
    // minimum, 300, and gives its first side 200. At whole pixels either side of
    // it the two agree.
    const tree = splitNode(
      "s1",
      "h",
      0.9,
      leafNode("l2", "pane1"),
      splitNode("s3", "h", 0.5, leafNode("l4", "pane2"), leafNode("l5", "pane3")),
    );
    const specs = [paneSpec("pane1", 300, 100), paneSpec("pane2", 200, 100), paneSpec("pane3", 94, 100)];
    const layout = cssLayout(tree, null, specs, "wide");
    expect(layout.min).toEqual({ w: 606, h: 100 });
    expect(disagreements(layout, tree, null, specs, { width: 700, height: 400 })).toEqual([]);
    expect(disagreements(layout, tree, null, specs, { width: 701, height: 400 })).toEqual([]);
    expect(disagreements(layout, tree, null, specs, { width: 700.6, height: 400 })).toContain(
      "700.6x400: leaf l4 css 401,0 200x400 engine 401,0 147x400",
    );
  });
});

describe("behaviour 3: a maximized leaf, and no tree", () => {
  const tree = splitNode(
    "s1",
    "h",
    0.4,
    leafNode("l2", "pane1", "pane2"),
    splitNode("s3", "v", 0.5, leafNode("l4", "pane3"), leafNode("l5", "pane4")),
  );
  const specs = [
    paneSpec("pane1", 300, 200),
    paneSpec("pane2", 230, 150),
    paneSpec("pane3", 230, 150),
    paneSpec("pane4", 260, 180),
  ];

  test("the maximized leaf gets the whole box and every other box is unchanged", () => {
    const plain = cssLayout(tree, null, specs, "wide");
    const maximized = cssLayout(tree, "l4", specs, "wide");
    const whole = { left: "0", top: "0", width: "100%", height: "100%" };
    expect(maximized.leaves.find((box) => box.leafId === "l4")).toEqual({ leafId: "l4", ...whole });
    expect(maximized.leaves.filter((box) => box.leafId !== "l4")).toEqual(
      plain.leaves.filter((box) => box.leafId !== "l4"),
    );
    expect(maximized.dividers).toEqual(plain.dividers);
    expect(maximized.vars).toEqual(plain.vars);
    expect(maximized.min).toEqual(plain.min);
  });

  test("an id that is no leaf of the tree maximizes nothing", () => {
    const plain = cssLayout(tree, null, specs, "wide");
    expect(cssLayout(tree, "l99", specs, "wide")).toEqual(plain);
    expect(cssLayout(tree, "s3", specs, "wide")).toEqual(plain);
  });

  test("a null tree gives no leaves, no dividers, no properties and a minimum of zero", () => {
    expect(cssLayout(null, null, specs, "wide")).toEqual({
      leaves: [],
      dividers: [],
      vars: {},
      min: { w: 0, h: 0 },
    });
  });

  test("a tree of one leaf fills the box, with nothing else to write", () => {
    expect(cssLayout(leafNode("l1", "pane1"), null, specs, "wide")).toEqual({
      leaves: [{ leafId: "l1", left: "0", top: "0", width: "100%", height: "100%" }],
      dividers: [],
      vars: {},
      min: { w: 300, h: 200 },
    });
  });
});

describe("behaviour 4: linear, not exponential", () => {
  const SHAPES = [
    ["second", "same"],
    ["first", "same"],
    ["second", "alternate"],
    ["zigzag", "alternate"],
  ] as const;

  test.each(SHAPES)("a 12 deep chain down %s children, %s axes, stays under 8 KB", (side, axes) => {
    // A ratio at full precision is the longest a ratio can be written.
    const { tree, specs } = chain(12, side, axes, 1 / 3);
    expect(totalLength(cssLayout(tree, null, specs, "regular"))).toBeLessThan(8 * 1024);
  });

  test.each(SHAPES)("each split down %s children, %s axes, adds a bounded length", (side, axes) => {
    const lengths: number[] = [];
    for (let depth = 0; depth <= 40; depth += 1) {
      const { tree, specs } = chain(depth, side, axes, 1 / 3);
      lengths.push(totalLength(cssLayout(tree, null, specs, "regular")));
    }
    const steps = lengths.slice(1).map((length, index) => length - lengths[index]);
    expect(Math.min(...steps)).toBeGreaterThan(0);
    expect(Math.max(...steps)).toBeLessThan(720);
    // The step stops growing once the shape repeats: past depth 20 it is no
    // longer than it was between 10 and 20, give or take an id's extra digit.
    // Anything worse than linear would keep climbing.
    const settled = Math.max(...steps.slice(10, 20));
    expect(Math.max(...steps.slice(20))).toBeLessThanOrEqual(settled + 4);
  });

  // Not the brief's measure but the browser's: var() is substituted as text,
  // so this is how long a box string really is once a browser has read it, and
  // browsers cap that length. Each split names its parent's extent twice on the
  // way to either child, so the substituted length doubles per level of splits
  // that run the same way. Naming it three times (the inner extent less the
  // first child, for a split inside the second) made it about 27 MB at depth 12.
  test.each(SHAPES)("what a browser substitutes, down %s children, %s axes, doubles per level", (side, axes) => {
    const lengths: number[] = [];
    for (let depth = 0; depth <= 12; depth += 1) {
      const { tree, specs } = chain(depth, side, axes, 1 / 3);
      lengths.push(substitutedLength(cssLayout(tree, null, specs, "regular")));
    }
    // Two levels is the most any default tree nests one way.
    expect(lengths[2]).toBeLessThan(1024);
    // Twelve levels is as deep as the store keeps a tree.
    expect(lengths[12]).toBeLessThan(1024 * 1024);
    // From depth 6 to 12 there are six levels of one axis, or three when the
    // axes alternate: about two to the power of that, and nothing like three.
    const levels = axes === "same" ? 6 : 3;
    expect(lengths[12] / lengths[6]).toBeLessThan(2 ** levels * 1.5);
  });
});

describe("behaviour 5: only what the module wrote", () => {
  const ALLOWED = /^[a-z0-9.%(),*+ -]+$/;
  const VAR_NAME = /^--v2-[rifo]-wide-s[0-9]+$/;

  // Pane ids and titles shaped like the catalog's, so a leak would look like one.
  const tree = splitNode(
    "s7",
    "h",
    1e-7,
    leafNode("l1", "today"),
    splitNode(
      "s30",
      "v",
      Number.NaN,
      leafNode("l12", "status"),
      splitNode("s4", "h", 1.5, leafNode("l5", "ledger"), leafNode("l6", "forecast", "calendar")),
    ),
  );
  const specs: PaneSpec[] = [
    { ...paneSpec("today", 320, 320), title: "The day" },
    { ...paneSpec("status", 1e21, 5e-7), title: "Status" },
    { ...paneSpec("calendar", 320, 300), title: "Calendar" },
    { ...paneSpec("ledger", 260, 180), title: "Transactions" },
    { ...paneSpec("forecast", Number.NaN, -20), title: "Forecast" },
  ];
  const layout = cssLayout(tree, null, specs, "wide");

  test("every string is made of the module's own characters, with no exponent and no non-number", () => {
    for (const text of allStrings(layout)) {
      expect(text).toMatch(ALLOWED);
      expect(text).not.toMatch(/[0-9.]e|nan|infinity/i);
    }
    for (const name of Object.keys(layout.vars)) expect(name).toMatch(VAR_NAME);
  });

  test("numbers String() would write with an exponent are written out in full", () => {
    const values = Object.values(layout.vars).join(" ");
    expect(layout.vars[ratioVar("wide", "s7")]).toBe("0.0000001");
    expect(values).toContain("clamp(320px, ");
    expect(values).toContain(" - 1000000000000000000000px)");
    expect(values).toContain("clamp(0.0000005px, ");
  });

  test("a share that is no number is drawn even, and one outside 0 to 1 is held to it", () => {
    expect(layout.vars[ratioVar("wide", "s30")]).toBe("0.5");
    expect(layout.vars[ratioVar("wide", "s4")]).toBe("1");
  });

  test("no pane id and no title reaches a string", () => {
    const text = allStrings(layout).join("\n").toLowerCase();
    for (const spec of specs) {
      expect(text).not.toContain(spec.id.toLowerCase());
      expect(text).not.toContain(spec.title.toLowerCase());
    }
    expect(text).not.toContain("pane");
  });

  test("every split's ratio is under ratioVar's name", () => {
    expect(ratioVar("wide", "s3")).toBe("--v2-r-wide-s3");
    expect(Object.keys(layout.vars)).toEqual(
      expect.arrayContaining(["s7", "s30", "s4"].map((id) => ratioVar("wide", id))),
    );
  });

  test.each(["", "Wide", "wide1", "wide-x", "wide ", "wíde", "__proto__"])(
    "a scope of %j throws",
    (scope) => {
      expect(() => cssLayout(tree, null, specs, scope)).toThrow();
      expect(() => cssLayout(null, null, specs, scope)).toThrow();
      expect(() => ratioVar(scope, "s1")).toThrow();
    },
  );

  test.each(["x1", "L1", "s", "s-1", "s1a", "l 1", "", "__proto__", "s1)"])(
    "an id of %j throws",
    (id) => {
      expect(() => cssLayout(leafNode(id, "today"), null, specs, "wide")).toThrow();
      expect(() =>
        cssLayout(splitNode(id, "h", 0.5, leafNode("l1", "today"), leafNode("l2", "status")), null, specs, "wide"),
      ).toThrow();
      expect(() => ratioVar("wide", id)).toThrow();
    },
  );

  test("an id used twice throws, because two splits would share one set of names", () => {
    const twice = splitNode(
      "s1",
      "h",
      0.5,
      splitNode("s2", "v", 0.5, leafNode("l3", "today"), leafNode("l4", "status")),
      splitNode("s2", "v", 0.5, leafNode("l5", "calendar"), leafNode("l6", "ledger")),
    );
    expect(() => cssLayout(twice, null, specs, "wide")).toThrow();
    const leafTwice = splitNode("s1", "h", 0.5, leafNode("l3", "today"), leafNode("l3", "status"));
    expect(() => cssLayout(leafTwice, null, specs, "wide")).toThrow();
  });
});
