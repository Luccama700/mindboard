// The shapes the tile engine is written against.
//
// A workspace is one split tree. Every leaf of it is a stack of tabs that fills
// its share of the screen, and every split is a divider with a ratio. There is
// no floating window and no free grid: the panes always cover the workspace,
// which is what makes a layout describable by a tree at all.
//
// A LAYOUT is a named workspace (Today, Week, Quests, Money, or one the user
// made), and it has one arrangement per screen class. The phone is a class too:
// its arrangement is always a single leaf, whose tab strip is the phone's bar.
//
// Nothing here has behaviour. Every function that reads or writes these values
// lives in tree.ts, geometry.ts, catalog.ts or store.ts, and every one of them is
// pure: no DOM, no storage, no clock, no randomness.

export type PaneId = string;

/** h: side by side, v: one above the other. */
export type SplitDir = "h" | "v";

/** Where a drop lands inside a leaf. `centre` means "as another tab". */
export type Zone = "left" | "right" | "top" | "bottom" | "centre";

/** Which way a keyboard move or a focus jump goes. */
export type Direction = "left" | "right" | "up" | "down";

/**
 * compact: under 1024 pixels, always one leaf. regular: 1024 to 1599. wide:
 * 1600 and up.
 */
export type ScreenClass = "compact" | "regular" | "wide";

/** A built in layout's id, or one of the user's: `u1`, `u2`, and so on. */
export type LayoutId = string;

/** The four layouts every desk has. */
export type BuiltInLayoutId = "today" | "week" | "quests" | "money";

/** Where a pane is listed in the pane list. */
export type PaneGroup = "day" | "quests" | "money";

/**
 * One view setting a pane offers, with its choices fixed in the catalog.
 * `key` matches [a-z][a-z0-9-]*, every choice's `value` matches [a-z0-9-]+,
 * and `fallback` is one of the values.
 */
export interface PaneOption {
  key: string;
  label: string;
  choices: ReadonlyArray<{ value: string; label: string }>;
  fallback: string;
}

export interface Leaf {
  kind: "leaf";
  id: string;
  tabs: PaneId[];
  active: PaneId;
}

export interface Split {
  kind: "split";
  id: string;
  dir: SplitDir;
  /** The share of the first child, 0.05 to 0.95, held to four decimals. */
  ratio: number;
  first: TileNode;
  second: TileNode;
}

export type TileNode = Leaf | Split;

export interface PaneSpec {
  id: PaneId;
  /** The title on a pane's frame. */
  title: string;
  /** The label on a tab and on the phone's bar. */
  short: string;
  group: PaneGroup;
  minWidth: number;
  minHeight: number;
  options: readonly PaneOption[];
}

/** Where a closed pane was, so it can come back there. */
export interface Spot {
  beside: PaneId;
  zone: Zone;
  ratio: number | null;
}

/** One arrangement of the workspace as it is right now. */
export interface Arrangement {
  tree: TileNode | null;
  maximized: PaneId | null;
  focus: PaneId | null;
  lastSpot: Record<PaneId, Spot>;
  /** Pane, then option key, then value: only values that differ from the fallback. */
  options: Record<PaneId, Record<string, string>>;
}

/** A layout on the rail. `base` is the built in layout it starts from. */
export interface LayoutMeta {
  id: LayoutId;
  title: string;
  base: BuiltInLayoutId;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Workspace {
  width: number;
  height: number;
}

/**
 * What the engine hands a renderer: one rectangle per leaf and one per divider.
 * `start` and `size` on a divider are the split's own span along its direction,
 * which is what turns a pointer position back into a ratio.
 */
export interface TileRects {
  leaves: Array<Rect & { leafId: string }>;
  dividers: Array<Rect & { splitId: string; dir: SplitDir; start: number; size: number }>;
}
