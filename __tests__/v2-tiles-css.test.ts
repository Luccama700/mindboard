// Task 2, the engine's geometry written as CSS lengths.
//
// THE PROPERTY THIS FILE EXISTS FOR. cssLayout and layoutTree are one formula
// written twice. The browser paints with the first, from a page the server
// wrote without knowing the window's size; the desk hit tests and moves focus
// with the second, on the workspace extent the stage computed. A pixel of
// disagreement is a divider drawn in one place and dragged from another, so
// the two are held to each other here box by box, to the pixel, at whole and
// fractional sizes.
//
// HOW, WITHOUT A BROWSER. The file carries a small model of what a browser does
// with the module's output. The stage's properties are registered, from the
// rules propertyRules itself writes, so each is computed once, in dependency
// order, to one number, and a var() of it is that number: no text is ever
// substituted. Container units resolve against the workspace, which is the
// stage's container. A frame's box reads the stage's values and nothing else:
// a percentage or a container unit in a box is refused, because it would
// resolve against wherever the frame happens to sit.
//
// The reader is strict on purpose, because it is the only browser this task
// has: arithmetic outside a math function, + or - without whitespace on both
// sides, a unitless 0 added to a length, two lengths multiplied, an exponent, a
// unit it does not know, an unregistered property, a registered one nobody set,
// and a value of the wrong type for its registration all throw rather than
// compute something a browser would not.
//
// Hit testing reads what the stage computed, serialized as getComputedStyle
// serializes it and read back through workspaceFromComputed, so the floor this
// model applies to the workspace is the only floor anywhere. What ties the
// model to a real engine is the controller's browser check, outside git at
// docs/rebuild/os/spikes/css-geometry/spike.html: it builds this contract in a
// real page and compares every frame's box with layoutTree on the computed
// extents, across device scales.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { PANES } from "@/app/lib/v2/tiles/catalog";
import {
  MAX_SPLITS,
  cssLayout,
  extentVars,
  propertyRules,
  ratioVar,
  workspaceFromComputed,
} from "@/app/lib/v2/tiles/css";
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

const ROOT = path.resolve(__dirname, "..");

// ------------------------------------------------------------ the evaluator

type Kind = "number" | "length";

interface Typed {
  kind: Kind;
  value: number;
}

type Unit = "px" | "cqw" | "cqh";

type Token =
  | { t: "ws" }
  | { t: "number"; value: number }
  | { t: "dimension"; value: number; unit: Unit }
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
const UNITS: readonly string[] = ["px", "cqw", "cqh"];

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
      if (after.startsWith("%")) throw new Error(`a percentage in "${text}"`);
      const unit = UNIT_TOKEN.exec(after);
      if (unit !== null) {
        if (!UNITS.includes(unit[0])) throw new Error(`"${unit[0]}" after a number in "${text}"`);
        out.push({ t: "dimension", value, unit: unit[0] as Unit });
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

/** The custom properties a value names, each through a var(). */
function dependenciesOf(text: string): string[] {
  const tokens = tokenize(text);
  const out: string[] = [];
  tokens.forEach((token, index) => {
    if (token.t !== "function" || token.name !== "var") return;
    const next = tokens.slice(index + 1).find((candidate) => candidate.t !== "ws");
    if (next !== undefined && next.t === "ident") out.push(next.name);
  });
  return out;
}

function sameKind(values: Typed[], what: string): Kind {
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

/** What a value may read where it is evaluated. */
interface Context {
  /** A var() of a registered property: the value computed on the stage. */
  variable(name: string): Typed;
  /** The query container's size, or null where a container unit is refused. */
  container: Workspace | null;
}

class Reader {
  private at = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: Context,
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
      case "dimension":
        return { kind: "length", value: this.dimension(token.value, token.unit) };
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

  private dimension(value: number, unit: Unit): number {
    if (unit === "px") return value;
    const container = this.context.container;
    if (container === null) throw new Error("a container unit outside the stage");
    return (value / 100) * (unit === "cqw" ? container.width : container.height);
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
        if (strategy.t !== "ident" || (strategy.name !== "nearest" && strategy.name !== "down")) {
          throw new Error("round() here is round(nearest or down, value, step)");
        }
        this.space();
        this.expect("comma");
        const args = this.list();
        if (args.length !== 2) throw new Error("round() takes a value and a step after the strategy");
        const [value, step] = args;
        if (value.kind !== "length" || step.kind !== "length" || !(step.value > 0)) {
          throw new Error("round() here rounds a length by a positive length");
        }
        const rounded =
          strategy.name === "down"
            ? Math.floor(value.value / step.value) * step.value
            : roundNearest(value.value, step.value);
        return { kind: "length", value: rounded };
      }
      case "var": {
        this.space();
        const ident = this.take();
        if (ident.t !== "ident" || !ident.name.startsWith("--")) {
          throw new Error("var() names a custom property");
        }
        this.space();
        this.expect("close");
        return this.context.variable(ident.name);
      }
      default:
        throw new Error(`${name}() is outside this evaluator`);
    }
  }
}

const RULE =
  /^@property (--[a-z0-9-]+) \{ syntax: "<(length|number)>"; inherits: true; initial-value: (?:0px|0\.5); \}$/;

/** The registrations a block of rules makes, read strictly: a line it cannot read throws. */
function registryOf(rules: string): Map<string, Kind> {
  const registry = new Map<string, Kind>();
  if (rules === "") return registry;
  for (const line of rules.split("\n")) {
    const match = RULE.exec(line);
    if (match === null) throw new Error(`not a rule this file reads: ${line}`);
    registry.set(match[1], match[2] === "length" ? "length" : "number");
  }
  return registry;
}

const registries = new Map<string, Map<string, Kind>>();

function registryFor(scope: string): Map<string, Kind> {
  const known = registries.get(scope);
  if (known !== undefined) return known;
  const registry = registryOf(propertyRules([scope]));
  registries.set(scope, registry);
  return registry;
}

/**
 * The stage as a browser computes it: every property it sets is registered,
 * computed once, after the properties it names, to one typed value, with
 * container units against the workspace. Frames read those values.
 */
class Stage {
  /** The order the properties were computed in: each once, after what it names. */
  readonly order: string[] = [];
  private readonly values = new Map<string, Typed>();

  constructor(
    private readonly registry: Map<string, Kind>,
    private readonly declared: Record<string, string>,
    private readonly container: Workspace,
  ) {
    for (const name of Object.keys(declared)) {
      if (!registry.has(name)) {
        throw new Error(`${name} is not registered, so a browser would substitute it as text`);
      }
    }
    for (const name of Object.keys(declared)) this.compute(name, new Set());
  }

  private compute(name: string, path: Set<string>): Typed {
    const known = this.values.get(name);
    if (known !== undefined) return known;
    const kind = this.registry.get(name);
    if (kind === undefined) throw new Error(`${name} is not registered`);
    if (!Object.prototype.hasOwnProperty.call(this.declared, name)) {
      throw new Error(`${name} is registered but not set on the stage`);
    }
    if (path.has(name)) throw new Error(`${name} depends on itself`);
    path.add(name);
    const text = this.declared[name];
    for (const dependency of dependenciesOf(text)) this.compute(dependency, path);
    path.delete(name);
    const value = new Reader(tokenize(text), {
      variable: (dependency) => this.read(dependency),
      container: this.container,
    }).whole();
    if (value.kind !== kind) throw new Error(`${name} is registered as a ${kind}, set to a ${value.kind}`);
    this.values.set(name, value);
    this.order.push(name);
    return value;
  }

  private read(name: string): Typed {
    if (!this.registry.has(name)) throw new Error(`${name} is not registered`);
    const value = this.values.get(name);
    if (value === undefined) throw new Error(`${name} is not set on the stage`);
    return value;
  }

  /**
   * What getComputedStyle(stage).getPropertyValue(name) gives: a computed
   * length as `<number>px`, a computed number as itself, and an empty string
   * for a property the stage did not compute.
   */
  computedStyle(name: string): string {
    const value = this.values.get(name);
    if (value === undefined) return "";
    return value.kind === "length" ? `${value.value}px` : String(value.value);
  }

  /** A frame's box property: one term of lengths and the stage's values, or a bare `0`. */
  length(text: string): number {
    if (text === "0") return 0;
    const value = new Reader(tokenize(text), {
      variable: (name) => this.read(name),
      container: null,
    }).whole();
    if (value.kind !== "length") throw new Error(`"${text}" is not a length`);
    return value.value;
  }
}

function evaluateBox(stage: Stage, box: CssBox): Rect {
  return {
    x: stage.length(box.left),
    y: stage.length(box.top),
    w: stage.length(box.width),
    h: stage.length(box.height),
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

/** An invented pane spec. cssLayout and the engine's geometry read only the id and the minimums. */
function paneSpec(id: PaneId, minWidth: number, minHeight: number): PaneSpec {
  return { id, title: `Pane title ${id}`, short: "Pane", group: "day", options: [], minWidth, minHeight };
}

function arrangementFor(tree: TileNode | null, maximized: PaneId | null): Arrangement {
  return { tree, maximized, focus: null, lastSpot: {}, options: {} };
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
 * A tree of one to fourteen leaves, each holding one to three panes. Pane ids
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
  return { tree: build(pick(rand, 1, MAX_SPLITS + 1)), specs };
}

const LARGEST: Workspace = { width: 3840, height: 2160 };

/**
 * Forty sizes from the tree's minimum up to 3840 by 2160: the four whole pixel
 * corners (the minimum itself is where every clamp binds), the minimum plus a
 * fraction, eleven just above the minimum and twenty four anywhere, about half
 * of them with a fraction of a pixel, as browser zoom makes them. A tree whose
 * minimum is past the largest screen is checked from its minimum in that
 * dimension.
 */
function sizesFor(min: { w: number; h: number }, rand: () => number): Workspace[] {
  const top = { width: Math.max(min.w, LARGEST.width), height: Math.max(min.h, LARGEST.height) };
  const fraction = (): number => (rand() < 0.5 ? 0 : rand());
  const sizes: Workspace[] = [
    { width: min.w, height: min.h },
    { width: top.width, height: top.height },
    { width: min.w, height: top.height },
    { width: top.width, height: min.h },
    { width: min.w + 0.6, height: min.h + 0.999 },
  ];
  while (sizes.length < 16) {
    sizes.push({
      width: Math.min(top.width, min.w + pick(rand, 0, 24)) + fraction(),
      height: Math.min(top.height, min.h + pick(rand, 0, 24)) + fraction(),
    });
  }
  while (sizes.length < 40) {
    sizes.push({
      width: pick(rand, min.w, top.width) + fraction(),
      height: pick(rand, min.h, top.height) + fraction(),
    });
  }
  return sizes;
}

function show(rect: Rect): string {
  return `${rect.x},${rect.y} ${rect.w}x${rect.h}`;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Where hit testing gets the workspace it hands layoutTree, given the stage and its container. */
type HitTest = (stage: Stage, scope: string, container: Workspace) => Workspace;

/**
 * What the module tells a consumer to do: read the stage's two computed extent
 * properties, as getComputedStyle gives them, through workspaceFromComputed.
 */
const fromComputed: HitTest = (stage, scope) => {
  const names = extentVars(scope);
  const workspace = workspaceFromComputed(stage.computedStyle(names.w), stage.computedStyle(names.h));
  if (workspace === null) throw new Error("the stage computed no workspace");
  return workspace;
};

/** The workspace as the browser computed it for this layout in a container of this size. */
function computedWorkspace(layout: CssLayout, scope: string, container: Workspace): Workspace {
  return fromComputed(new Stage(registryFor(scope), layout.vars, container), scope, container);
}

/**
 * Every box where the drawing and the hit test differ at this container size,
 * in words. The CSS is evaluated on a stage whose container is `size`; the
 * engine is given what `hitTest` hands it, by default the stage's own computed
 * extents.
 */
function disagreements(
  layout: CssLayout,
  tree: TileNode | null,
  maximizedPane: PaneId | null,
  specs: readonly PaneSpec[],
  size: Workspace,
  scope: string,
  hitTest: HitTest = fromComputed,
): string[] {
  const stage = new Stage(registryFor(scope), layout.vars, size);
  const rects = layoutTree(arrangementFor(tree, maximizedPane), hitTest(stage, scope, size), specs);
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
    const drawn = evaluateBox(stage, box);
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
    const drawn = evaluateBox(stage, box);
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

function splitsOf(node: TileNode): Split[] {
  if (node.kind === "leaf") return [];
  return [node, ...splitsOf(node.first), ...splitsOf(node.second)];
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
  const splits = new Map(splitsOf(tree).map((split) => [split.id, split]));
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

type Side = "first" | "second" | "zigzag";
type Axes = "h" | "v" | "alternate";

/**
 * Small enough that a 13 split chain one way still fits well inside 3840 by
 * 2160 (about 2433 by 1198), so its 40 sizes are 40 different extents along the
 * chain and not its minimum forty times over.
 */
const ROOMY_CHAIN_MIN = { w: 120, h: 80 };

/**
 * A chain of `depth` splits. `side` says which child the next split is, and
 * `axes` which way the splits run: all one way, or turning at every level.
 */
function chain(
  depth: number,
  side: Side,
  axes: Axes,
  ratio: number,
  minimum: { w: number; h: number } = CHAIN_MIN,
): World {
  const specs: PaneSpec[] = [];
  let leafNumber = 0;
  const leaf = (): TileNode => {
    leafNumber += 1;
    const pane = `pane${leafNumber}`;
    specs.push(paneSpec(pane, minimum.w + (leafNumber % 3) * 45, minimum.h));
    return leafNode(`l${leafNumber + 100}`, pane);
  };
  const build = (level: number): TileNode => {
    if (level === depth) return leaf();
    const dir: SplitDir = axes === "alternate" ? (level % 2 === 0 ? "h" : "v") : axes;
    const deeperFirst = side === "first" || (side === "zigzag" && level % 2 === 0);
    const id = `s${level + 1}`;
    return deeperFirst
      ? splitNode(id, dir, ratio, build(level + 1), leaf())
      : splitNode(id, dir, ratio, leaf(), build(level + 1));
  };
  return { tree: build(0), specs };
}

const CHAINS: ReadonlyArray<readonly [Side, Axes]> = [
  ["second", "h"],
  ["second", "v"],
  ["first", "h"],
  ["first", "v"],
  ["zigzag", "h"],
  ["second", "alternate"],
  ["first", "alternate"],
  ["zigzag", "alternate"],
];

/** Every string that reaches CSS: the stage's names and values, the boxes, the ratio names. */
function cssStrings(layout: CssLayout): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(layout.vars)) out.push(name, value);
  for (const box of layout.leaves) out.push(box.left, box.top, box.width, box.height);
  for (const box of layout.dividers) {
    out.push(box.ratioVar, box.left, box.top, box.width, box.height);
  }
  return out;
}

/** Every string cssLayout returns, ids and directions included. */
function allStrings(layout: CssLayout): string[] {
  return [
    ...cssStrings(layout),
    ...layout.leaves.map((box) => box.leafId),
    ...layout.dividers.flatMap((box) => [box.splitId, box.dir]),
  ];
}

function totalLength(layout: CssLayout): number {
  return allStrings(layout).reduce((sum, text) => sum + text.length, 0);
}

function boxStrings(layout: CssLayout): string[] {
  return [...layout.leaves, ...layout.dividers].flatMap((box) => [
    box.left,
    box.top,
    box.width,
    box.height,
  ]);
}

/** Every custom property name in every stylesheet of the desk. */
function stylesheetNames(): Set<string> {
  const names = new Set<string>();
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".css")) {
        for (const match of readFileSync(full, "utf8").matchAll(/--v2-[a-z0-9-]+/g)) names.add(match[0]);
      }
    }
  };
  walk(path.join(ROOT, "app/v2"));
  return names;
}

// ------------------------------------------------------------------- tests

describe("the browser this file proves with", () => {
  const T = registryFor("t");
  const DECLARED: Record<string, string> = {
    // Written out of order on purpose: the stage computes what each one names first.
    "--v2-t-a1":
      "round(nearest, clamp(300px, (var(--v2-t-w) - 6px) * var(--v2-t-r1), var(--v2-t-w) - 6px - 100px), 1px)",
    "--v2-t-a2":
      "round(nearest, clamp(100px, (var(--v2-t-h) - 6px) * var(--v2-t-r1), var(--v2-t-h) - 6px - 100px), 1px)",
    "--v2-t-r1": "0.25",
    "--v2-t-w": "round(down, 100cqw, 1px)",
    "--v2-t-h": "round(down, 100cqh, 1px)",
  };
  const CONTAINER: Workspace = { width: 1000.6, height: 500.4 };
  const stage = new Stage(T, DECLARED, CONTAINER);

  test("computes every registered property once, after the ones it names", () => {
    expect([...stage.order].sort()).toEqual(Object.keys(DECLARED).sort());
    const at = (name: string): number => stage.order.indexOf(name);
    expect(at("--v2-t-w")).toBeLessThan(at("--v2-t-a1"));
    expect(at("--v2-t-r1")).toBeLessThan(at("--v2-t-a1"));
    expect(at("--v2-t-h")).toBeLessThan(at("--v2-t-a2"));
  });

  test("floors the container, and reads each var() as one computed value", () => {
    expect(stage.length("var(--v2-t-w)")).toBe(1000);
    expect(stage.length("var(--v2-t-h)")).toBe(500);
    // 994 * 0.25 is 248.5, under the first side's 300.
    expect(stage.length("var(--v2-t-a1)")).toBe(300);
    // 494 * 0.25 is 123.5, a tie, which goes up.
    expect(stage.length("var(--v2-t-a2)")).toBe(124);
    expect(stage.length("calc(var(--v2-t-w) - var(--v2-t-a1) - 6px)")).toBe(694);
    expect(stage.length("0")).toBe(0);
  });

  test("does the arithmetic CSS does", () => {
    expect(stage.length("clamp(300px, 10px, 200px)")).toBe(300);
    expect(stage.length("min(1px, 2px, calc(3px - 4px))")).toBe(-1);
    expect(stage.length("max(1px, 2px)")).toBe(2);
    expect(stage.length("calc(2px + 3px * 2)")).toBe(8);
    expect(stage.length("calc((2px + 3px) * 2)")).toBe(10);
    expect(stage.length("calc(0.5 * 10px)")).toBe(5);
  });

  test("rounds a half toward positive infinity as Math.round does, and down as Math.floor does", () => {
    expect(stage.length("round(nearest, 2.5px, 1px)")).toBe(3);
    expect(stage.length("round(nearest, 2.4999px, 1px)")).toBe(2);
    expect(stage.length("round(nearest, -2.5px, 1px)")).toBe(-2);
    expect(stage.length("round(nearest, 0.49999999999999994px, 1px)")).toBe(
      Math.round(0.49999999999999994),
    );
    expect(stage.length("round(nearest, 7px, 1px)")).toBe(7);
    expect(stage.length("round(down, 2.9px, 1px)")).toBe(2);
    expect(stage.length("round(down, -2.1px, 1px)")).toBe(-3);
    expect(stage.length("round(down, 7px, 1px)")).toBe(7);
  });

  test.each([
    "calc(1px+2px)",
    "calc(1px +2px)",
    "calc(1px -2px)",
    "calc(0 + 6px)",
    "calc(1px * 2px)",
    "calc(1px / 2)",
    "var(--v2-t-w) - 6px",
    "6px 6px",
    "(1px)",
    "0.5",
    "calc(1e3px)",
    "1.5e-7px",
    "2em",
    "100%",
    "calc(100% - 6px)",
    "100cqw",
    "calc(var(--v2-t-w) - 1cqh)",
    "var(--v2-t-r1)",
    "calc(var(--v2-t-r1) + 1px)",
    "var(--v2-t-x1)",
    "var(--v2-t-a9)",
    "var(--v2-t-w, 1px)",
    "round(1px, 1px)",
    "round(up, 1px, 1px)",
    "round(nearest, 1px, 0px)",
    "clamp(1px, 2px)",
    "clamp(1px, 2, 3px)",
    "min(1px, 2)",
    "abs(1px)",
  ])("refuses %s in a box", (text) => {
    expect(() => stage.length(text)).toThrow();
  });

  test.each([
    ["a bare sum", { "--v2-t-a1": "var(--v2-t-w) - 6px" }],
    ["a number for a length", { "--v2-t-a1": "0.5" }],
    ["a length for a number", { "--v2-t-r1": "6px" }],
    ["a percentage", { "--v2-t-w": "100%" }],
    ["an exponent", { "--v2-t-r1": "1e-7" }],
    ["an unregistered property", { "--v2-t-x1": "1px" }],
    ["two properties naming each other", { "--v2-t-a1": "var(--v2-t-a3)", "--v2-t-a3": "var(--v2-t-a1)" }],
    ["a registered property nobody set", { "--v2-t-a1": "var(--v2-t-a4)" }],
    ["round(down) with no step", { "--v2-t-w": "round(down, 100cqw)" }],
  ] as const)("refuses a stage with %s", (_name, overrides) => {
    expect(() => new Stage(T, { ...DECLARED, ...overrides }, CONTAINER)).toThrow();
  });
});

describe("behaviour 1 and 2: the same formula, proven against layoutTree", () => {
  test("200 seeded trees of up to 14 leaves, each at 40 sizes, whole and fractional, from its minimum to 3840 by 2160", () => {
    const rand = seeded(0x7ce55);
    const problems: string[] = [];
    const shares = { low: 0, high: 0, free: 0 };
    let compared = 0;
    let fractional = 0;
    let maximizedTrees = 0;
    let splitTrees = 0;
    let fullTrees = 0;
    for (let index = 0; index < 200; index += 1) {
      const { tree, specs } = randomWorld(rand);
      const maximized = rand() < 0.3 ? maximizedIn(tree, rand) : null;
      if (maximized !== null) maximizedTrees += 1;
      if (tree.kind === "split") splitTrees += 1;
      if (splitsOf(tree).length >= 11) fullTrees += 1;
      const layout = cssLayout(tree, maximized?.leafId ?? null, specs, "wide");
      expect(layout.min).toEqual(minSize(tree, specs));
      for (const size of sizesFor(layout.min, rand)) {
        problems.push(...disagreements(layout, tree, maximized?.pane ?? null, specs, size, "wide"));
        countShares(tree, computedWorkspace(layout, "wide", size), specs, shares);
        if (!Number.isInteger(size.width) || !Number.isInteger(size.height)) fractional += 1;
        compared += 1;
      }
    }
    expect({ count: problems.length, first: problems.slice(0, 8) }).toEqual({
      count: 0,
      first: [],
    });
    expect(compared).toBe(8000);
    // Not vacuous: the run reached maximized leaves, real splits, trees near
    // the pool's limit, fractional sizes, and shares held at each limit as
    // well as shares drawn where they were set.
    expect(maximizedTrees).toBeGreaterThan(30);
    expect(splitTrees).toBeGreaterThan(150);
    expect(fullTrees).toBeGreaterThan(20);
    expect(fractional).toBeGreaterThan(2500);
    expect(shares.low).toBeGreaterThan(500);
    expect(shares.high).toBeGreaterThan(500);
    expect(shares.free).toBeGreaterThan(500);
  });

  test.each(CHAINS)("a 13 split chain down %s children along %s agrees at 40 sizes", (side, axes) => {
    const rand = seeded(13);
    // The deeper side takes the larger share, or twelve more splits never fit
    // in what is left and every share is held at every size.
    const ratio = side === "second" ? 0.3 : 0.6180339887498949;
    const { tree, specs } = chain(MAX_SPLITS, side, axes, ratio, ROOMY_CHAIN_MIN);
    const layout = cssLayout(tree, null, specs, "regular");
    expect(layout.min.w).toBeLessThan(LARGEST.width - 1000);
    expect(layout.min.h).toBeLessThan(LARGEST.height - 900);
    const shares = { low: 0, high: 0, free: 0 };
    const problems = sizesFor(layout.min, rand).flatMap((size) => {
      countShares(tree, computedWorkspace(layout, "regular", size), specs, shares);
      return disagreements(layout, tree, null, specs, size, "regular");
    });
    expect(problems.slice(0, 8)).toEqual([]);
    // Not vacuous: across the sizes some splits are drawn where they were set
    // and some are held at a limit.
    expect(shares.free).toBeGreaterThan(0);
    expect(shares.low + shares.high).toBeGreaterThan(0);
  });

  test("below the minimum the engine shares evenly and the CSS keeps the first side's minimum", () => {
    // The header's boundary, made executable: at the tree's minimum the two
    // forms agree, one pixel under it they part. a1 is clamp(300px, ..., 99px)
    // there, whose lower bound wins.
    const tree = splitNode("s1", "h", 0.5, leafNode("l2", "pane1"), leafNode("l3", "pane2"));
    const specs = [paneSpec("pane1", 300, 100), paneSpec("pane2", 100, 100)];
    const layout = cssLayout(tree, null, specs, "wide");
    expect(layout.min).toEqual({ w: 406, h: 100 });
    expect(disagreements(layout, tree, null, specs, { width: 406, height: 100 }, "wide")).toEqual([]);
    expect(disagreements(layout, tree, null, specs, { width: 406.9, height: 100 }, "wide")).toEqual([]);
    expect(disagreements(layout, tree, null, specs, { width: 405, height: 100 }, "wide")).not.toEqual([]);
  });

  test("a fractional workspace is drawn and hit tested at the extent the stage computed", () => {
    // The first pass's counterexample. The root's share is held at its upper
    // limit; at 700.6 the engine on the raw size gave its second child 299.6,
    // under the 300 the split inside needs, and shared that split evenly where
    // the CSS did not. With the stage flooring the workspace and hit testing
    // reading what the stage computed, the two agree.
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
    for (const width of [700, 700.6, 700.999, 701]) {
      expect(disagreements(layout, tree, null, specs, { width, height: 400.5 }, "wide")).toEqual([]);
    }
    // Handed the raw measurement instead, layoutTree parts from the drawing.
    const raw: HitTest = (_stage, _scope, container) => container;
    expect(
      disagreements(layout, tree, null, specs, { width: 700.6, height: 400 }, "wide", raw),
    ).toContain("700.6x400: leaf l4 css 400,0 200x400 engine 401,0 147x400");
  });

  test("a measured rectangle floored by script can land a pixel from the layout; the computed extents cannot", () => {
    // What Edge did at a device scale of 0.9 (the controller's browser check):
    // its layout held the workspace just under 820 tall, so the stage computed
    // 819px, while getBoundingClientRect measured 820.0000610351562. A script
    // that floors the measurement hands layoutTree 820 and every box is a
    // pixel off. Reading the stage's computed extents hands it 819.
    const tree = splitNode(
      "s1",
      "h",
      0.5,
      splitNode(
        "s2",
        "h",
        0.5,
        splitNode("s3", "v", 0.67, leafNode("l4", "today"), leafNode("l5", "status")),
        splitNode("s6", "v", 0.5, leafNode("l7", "past-due"), leafNode("l8", "not-today")),
      ),
      leafNode("l9", "calendar"),
    );
    const layout = cssLayout(tree, null, PANES, "wide");
    const container: Workspace = { width: 1826.666748046875, height: 819.9999389648438 };
    const measured: Workspace = { width: 1826.666748046875, height: 820.0000610351562 };
    expect(computedWorkspace(layout, "wide", container)).toEqual({ width: 1826, height: 819 });
    expect(disagreements(layout, tree, null, PANES, container, "wide")).toEqual([]);
    const flooredMeasurement: HitTest = () => ({
      width: Math.floor(measured.width),
      height: Math.floor(measured.height),
    });
    expect(disagreements(layout, tree, null, PANES, container, "wide", flooredMeasurement)).not.toEqual([]);
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

  test("the maximized leaf gets the whole workspace and every other box is unchanged", () => {
    const plain = cssLayout(tree, null, specs, "wide");
    const maximized = cssLayout(tree, "l4", specs, "wide");
    expect(maximized.leaves.find((box) => box.leafId === "l4")).toEqual({
      leafId: "l4",
      left: "0",
      top: "0",
      width: "var(--v2-wide-w)",
      height: "var(--v2-wide-h)",
    });
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

  test("a tree of one leaf fills the workspace, with only the workspace's two properties", () => {
    expect(cssLayout(leafNode("l1", "pane1"), null, specs, "wide")).toEqual({
      leaves: [
        { leafId: "l1", left: "0", top: "0", width: "var(--v2-wide-w)", height: "var(--v2-wide-h)" },
      ],
      dividers: [],
      vars: { "--v2-wide-w": "round(down, 100cqw, 1px)", "--v2-wide-h": "round(down, 100cqh, 1px)" },
      min: { w: 300, h: 200 },
    });
  });
});

describe("behaviour 4: linear, and the pool is the only thing named", () => {
  test.each(CHAINS)(
    "a 13 split chain down %s children along %s: under 24 KB, only the pool, no definition inside another",
    (side, axes) => {
      const { tree, specs } = chain(MAX_SPLITS, side, axes, 1 / 3);
      const layout = cssLayout(tree, null, specs, "regular");
      const pool = registryFor("regular");
      expect(totalLength(layout)).toBeLessThan(24 * 1024);
      for (const name of Object.keys(layout.vars)) expect(pool.has(name)).toBe(true);
      for (const text of cssStrings(layout)) {
        for (const match of text.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(pool.has(match[1])).toBe(true);
      }
      const firsts = Object.entries(layout.vars).filter(([name]) => /-a[0-9]+$/.test(name));
      expect(firsts).toHaveLength(MAX_SPLITS);
      for (const [name, text] of firsts) {
        for (const [other, otherText] of firsts) {
          if (other !== name) expect(text.includes(otherText)).toBe(false);
        }
      }
    },
  );

  test.each(CHAINS)("each string down %s children along %s grows by a bounded length per split", (side, axes) => {
    const longest: number[] = [];
    for (let depth = 0; depth <= MAX_SPLITS; depth += 1) {
      const { tree, specs } = chain(depth, side, axes, 1 / 3);
      longest.push(Math.max(...cssStrings(cssLayout(tree, null, specs, "regular")).map((text) => text.length)));
    }
    // Past the first split, a level adds at most one term to each side of the
    // longest a<k>: its extent less the next a<k>, written twice.
    const term = " - var(--v2-regular-a13)".length;
    const steps = longest.slice(2).map((length, index) => length - longest[index + 1]);
    expect(Math.max(...steps)).toBeLessThanOrEqual(2 * term);
  });

  test("the catalog's panes, one leaf each, fit the pool", () => {
    expect(PANES.length - 1).toBeLessThanOrEqual(MAX_SPLITS);
  });

  test("a tree with more splits than the pool holds throws", () => {
    const fits = chain(MAX_SPLITS, "second", "h", 0.5);
    const over = chain(MAX_SPLITS + 1, "second", "h", 0.5);
    expect(() => cssLayout(fits.tree, null, fits.specs, "wide")).not.toThrow();
    expect(() => cssLayout(over.tree, null, over.specs, "wide")).toThrow();
  });
});

describe("behaviour 5: only what the module wrote", () => {
  const ALLOWED = /^[a-z0-9.(),*+ -]+$/;
  const POOL_NAME = /^--v2-wide-(w|h|a([1-9]|1[0-3])|r([1-9]|1[0-3]))$/;

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
    for (const text of cssStrings(layout)) {
      expect(text).toMatch(ALLOWED);
      expect(text).not.toMatch(/[0-9.]e|nan|infinity/i);
    }
    for (const name of Object.keys(layout.vars)) expect(name).toMatch(POOL_NAME);
  });

  test("container units appear only in the workspace's two properties, and a box names only the stage", () => {
    for (const [name, value] of Object.entries(layout.vars)) {
      expect(value.includes("cq")).toBe(/-(w|h)$/.test(name));
    }
    for (const text of boxStrings(layout)) expect(text).not.toMatch(/cq|%/);
  });

  test("numbers String() would write with an exponent are written out in full", () => {
    const values = Object.values(layout.vars).join(" ");
    expect(layout.vars[ratioVar("wide", 1)]).toBe("0.0000001");
    expect(values).toContain("clamp(320px, ");
    expect(values).toContain(" - 1000000000000000000000px)");
    expect(values).toContain("clamp(0.0000005px, ");
  });

  test("a share that is no number is drawn even, and one outside 0 to 1 is held to it", () => {
    expect(layout.vars[ratioVar("wide", 2)]).toBe("0.5");
    expect(layout.vars[ratioVar("wide", 3)]).toBe("1");
  });

  test("no pane id, no title and no node id reaches a string", () => {
    const text = cssStrings(layout).join("\n").toLowerCase();
    for (const spec of specs) {
      expect(text).not.toContain(spec.id.toLowerCase());
      expect(text).not.toContain(spec.title.toLowerCase());
    }
    expect(text).not.toContain("pane");
    expect(text).not.toMatch(/(^|[^a-z])[ls][0-9]+/);
  });

  test("a divider carries its split's pre-order index and the property its ratio is in", () => {
    // layoutTree lists dividers in order, s2 before s1; the index is pre-order.
    const shape = splitNode(
      "s1",
      "h",
      0.4,
      splitNode("s2", "v", 0.3, leafNode("l3", "today"), leafNode("l4", "status")),
      splitNode("s5", "v", 0.7, leafNode("l6", "ledger"), leafNode("l7", "calendar")),
    );
    const drawn = cssLayout(shape, null, specs, "wide");
    expect(drawn.dividers.map((box) => [box.splitId, box.index, box.ratioVar])).toEqual([
      ["s2", 2, "--v2-wide-r2"],
      ["s1", 1, "--v2-wide-r1"],
      ["s5", 3, "--v2-wide-r3"],
    ]);
    expect(drawn.dividers.map((box) => drawn.vars[box.ratioVar])).toEqual(["0.3", "0.4", "0.7"]);
    for (const box of drawn.dividers) expect(box.ratioVar).toBe(ratioVar("wide", box.index));
  });

  test("ratioVar takes a pre-order index inside the pool and nothing else", () => {
    expect(ratioVar("wide", 3)).toBe("--v2-wide-r3");
    expect(ratioVar("regular", MAX_SPLITS)).toBe("--v2-regular-r13");
    for (const index of [0, MAX_SPLITS + 1, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => ratioVar("wide", index)).toThrow();
    }
  });

  test.each(["", "Wide", "wide1", "wide-x", "wide ", "wíde", "__proto__"])(
    "a scope of %j throws",
    (scope) => {
      expect(() => cssLayout(tree, null, specs, scope)).toThrow();
      expect(() => cssLayout(null, null, specs, scope)).toThrow();
      expect(() => ratioVar(scope, 1)).toThrow();
      expect(() => propertyRules(["wide", scope])).toThrow();
    },
  );

  test.each(["x1", "L1", "s", "s-1", "s1a", "l 1", "", "__proto__", "s1)"])(
    "an id of %j throws",
    (id) => {
      expect(() => cssLayout(leafNode(id, "today"), null, specs, "wide")).toThrow();
      expect(() =>
        cssLayout(splitNode(id, "h", 0.5, leafNode("l1", "today"), leafNode("l2", "status")), null, specs, "wide"),
      ).toThrow();
    },
  );

  test("an id used twice is not refused: ids are checked, never written", () => {
    const twice = splitNode("s1", "h", 0.5, leafNode("l3", "today"), leafNode("l3", "status"));
    expect(() => cssLayout(twice, null, specs, "wide")).not.toThrow();
  });
});

describe("propertyRules: the pool, registered", () => {
  test("every name a layout can write, once per scope, as a length or a number", () => {
    const rules = propertyRules(["regular", "wide"]);
    const registry = registryOf(rules);
    const perScope = 2 + 2 * MAX_SPLITS;
    expect(rules.split("\n")).toHaveLength(2 * perScope);
    expect(registry.size).toBe(2 * perScope);
    expect(registry.get("--v2-wide-w")).toBe("length");
    expect(registry.get("--v2-wide-h")).toBe("length");
    expect(registry.get("--v2-regular-a13")).toBe("length");
    expect(registry.get("--v2-wide-r1")).toBe("number");
    expect(registry.has("--v2-wide-a14")).toBe(false);
    expect(registry.has("--v2-wide-a0")).toBe(false);
  });

  test("a scope named twice is registered once, and no scope registers nothing", () => {
    expect(propertyRules(["wide", "wide"])).toBe(propertyRules(["wide"]));
    expect(propertyRules([])).toBe("");
  });

  test("the pool of the desk's two scopes is clear of every name in the desk's stylesheets", () => {
    const taken = stylesheetNames();
    // The walk found the desk's tokens, so an empty walk cannot pass this.
    expect(taken.size).toBeGreaterThan(20);
    for (const name of registryOf(propertyRules(["regular", "wide"])).keys()) {
      expect(taken.has(name)).toBe(false);
    }
  });
});

describe("extentVars and workspaceFromComputed: what hit testing reads", () => {
  test("extentVars names the two properties cssLayout writes the workspace's extent into", () => {
    expect(extentVars("wide")).toEqual({ w: "--v2-wide-w", h: "--v2-wide-h" });
    expect(extentVars("regular")).toEqual({ w: "--v2-regular-w", h: "--v2-regular-h" });
    const layout = cssLayout(leafNode("l1", "pane1"), null, [paneSpec("pane1", 300, 200)], "wide");
    const names = extentVars("wide");
    expect(layout.vars[names.w]).toBe("round(down, 100cqw, 1px)");
    expect(layout.vars[names.h]).toBe("round(down, 100cqh, 1px)");
    expect(registryFor("wide").get(names.w)).toBe("length");
    expect(registryFor("wide").get(names.h)).toBe("length");
  });

  test.each(["", "Wide", "wide1", "wide-x", "__proto__"])("extentVars refuses a scope of %j", (scope) => {
    expect(() => extentVars(scope)).toThrow();
  });

  test("reads two computed lengths as they are, without rounding", () => {
    expect(workspaceFromComputed("1826px", "819px")).toEqual({ width: 1826, height: 819 });
    expect(workspaceFromComputed("1366px", "768px")).toEqual({ width: 1366, height: 768 });
    expect(workspaceFromComputed("819.5px", "0.25px")).toEqual({ width: 819.5, height: 0.25 });
    expect(workspaceFromComputed(".5px", "0px")).toEqual({ width: 0.5, height: 0 });
    expect(workspaceFromComputed("1e3px", "2.5e2px")).toEqual({ width: 1000, height: 250 });
    expect(workspaceFromComputed(" 1826px ", "819px")).toEqual({ width: 1826, height: 819 });
  });

  test.each([
    ["an empty string, before the stylesheet applies", ""],
    ["auto", "auto"],
    ["a percentage", "50%"],
    ["a negative number", "-1px"],
    ["a second token", "1826px 819px"],
    ["a number with no unit", "1826"],
    ["a unit with no number", "px"],
    ["another unit", "1826em"],
    ["a unit in capitals", "1826PX"],
    ["the declared text of a property nobody registered", "round(down, 100cqw, 1px)"],
    ["a calc() nobody computed", "calc(1826px)"],
    ["a number that is not one", "NaNpx"],
    ["an infinite length", "Infinitypx"],
    ["an exponent past what a double holds", "1e999px"],
    ["a trailing point", "1826.px"],
  ])("answers null for %s", (_name, value) => {
    expect(workspaceFromComputed(value, "819px")).toBeNull();
    expect(workspaceFromComputed("1826px", value)).toBeNull();
  });

  test("reads what the stage computed back as the floored workspace", () => {
    // The browser check measured this at a device scale of 0.9.
    const layout = cssLayout(leafNode("l1", "pane1"), null, [paneSpec("pane1", 300, 200)], "wide");
    const stage = new Stage(registryFor("wide"), layout.vars, { width: 1826.666748046875, height: 819.9999389648438 });
    const names = extentVars("wide");
    expect(stage.computedStyle(names.w)).toBe("1826px");
    expect(stage.computedStyle(names.h)).toBe("819px");
    expect(workspaceFromComputed(stage.computedStyle(names.w), stage.computedStyle(names.h))).toEqual({
      width: 1826,
      height: 819,
    });
  });
});
