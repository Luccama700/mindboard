// The shapes the tile engine is written against.
//
// A workspace is one split tree. Every leaf of it is a stack of tabs that fills
// its share of the screen, and every split is a divider with a ratio. There is
// no floating window and no free grid: the panes always cover the workspace,
// which is what makes a layout describable by a tree at all.
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

/** The phone has no tiles, so there is no class for it. */
export type ScreenClass = "regular" | "wide";

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
  /** The share of the first child, 0.05 to 0.95. */
  ratio: number;
  first: TileNode;
  second: TileNode;
}

export type TileNode = Leaf | Split;

export interface PaneSpec {
  id: PaneId;
  title: string;
  minWidth: number;
  minHeight: number;
  closable: boolean;
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
