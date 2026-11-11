// The desk's one piece of state: the tile set, and the screen class once the
// browser has said what it is.
//
// THE ENGINE OWNS THE ARRANGEMENT. Every action is one engine call on the set
// (`setCurrent`, `activateTab` then `withArrangement`), and nothing here
// computes, clamps or stores a layout of its own. Later tasks add their actions
// to the same reducer.
//
// THE FIRST RENDER IS THE SERVER'S. The state starts from the server's props
// alone, with no class: the server cannot know the window, so it draws every
// class and lets the stylesheet choose (desk.css). The class is read from
// `matchMedia` in an effect, after hydration, so the browser's first render
// produces exactly the markup the server sent.

import { useEffect, useReducer } from "react";

import {
  TILES_MIN_WIDTH,
  WIDE_MIN_WIDTH,
  activateTab,
  addLayout,
  arrangementOf,
  closePane,
  equalize,
  moveLayout,
  movePane,
  moveTab,
  openPane,
  removeLayout,
  renameLayout,
  resetLayout,
  setCurrent,
  setHidden,
  setRatio,
  toggleMaximize,
  withArrangement,
  type Arrangement,
  type LayoutId,
  type PaneId,
  type ScreenClass,
  type TileSet,
  type Workspace,
  type Zone,
} from "@/app/lib/v2/tiles";

/**
 * The layout an action was worked out on: a divider's split and size, a menu's
 * leaf ids. Split and leaf ids are minted per arrangement, so the same id can
 * name another split or leaf in another layout. An action carrying `layout` is
 * refused when another layout is on screen, which no queued change of layout
 * can race. The class is the action's own `cls`.
 *
 * THE LAYOUT, NOT THE ARRANGEMENT OBJECT. A write from another tab is merged
 * in, and when it draws the same as what is on screen the merge takes the other
 * tab's object; an identity test would refuse a release that is perfectly good
 * on the same layout and class.
 *
 * REQUIRED where an action names a split or a leaf by id (a divider's ratio
 * and evening, a move, a move to another layout); optional where it names
 * only a pane (close and maximize from the header carry none; from the menu
 * they do).
 */
interface WorkedOn {
  layout: LayoutId;
}

/**
 * Every action that changes one arrangement names the class it is for, as
 * `tab` does: the reducer's own `cls` is null until the browser has answered,
 * and an action must never fall on another class than the one it was made on.
 */
export type TilesAction =
  | { type: "class"; cls: ScreenClass }
  | { type: "layout"; id: LayoutId }
  | { type: "replace"; set: TileSet }
  /** Bring a pane to the front of its leaf in the current layout, on that class. */
  | { type: "tab"; cls: ScreenClass; pane: PaneId }
  /** A divider let go, or moved by a key: `setRatio` at the size of the split it divides. */
  | ({ type: "ratio"; cls: ScreenClass; splitId: string; ratio: number; size: number } & WorkedOn)
  /** Both sides of a divider the same: `equalize`. */
  | ({ type: "equalize"; cls: ScreenClass; splitId: string } & WorkedOn)
  | ({ type: "close"; cls: ScreenClass; pane: PaneId } & Partial<WorkedOn>)
  /**
   * Open a pane, placed by the engine on the workspace the browser computed. On
   * the phone there is none to give (its arrangement is one stack, which has no
   * geometry), and null is the engine's own answer for that: the first leaf.
   */
  | { type: "open"; cls: ScreenClass; pane: PaneId; workspace: Workspace | null }
  | ({ type: "maximize"; cls: ScreenClass; pane: PaneId } & Partial<WorkedOn>)
  /** A tab moved along its own stack: the phone's list. */
  | { type: "moveTab"; cls: ScreenClass; pane: PaneId; to: number }
  /** A pane put against a leaf, or made one of its tabs: `movePane`, what a drop and the pane menu do. */
  | ({ type: "move"; cls: ScreenClass; pane: PaneId; leafId: string; zone: Zone } & WorkedOn)
  /**
   * A pane moved to another layout: closed in the layout on screen and opened
   * in that one's arrangement for the same class, on the workspace the browser
   * computed (null on the phone, as for `open`). Both or neither: a pane that
   * cannot be closed here, or is open there already, moves nowhere.
   */
  | ({ type: "sendPane"; cls: ScreenClass; pane: PaneId; to: LayoutId; workspace: Workspace | null } & WorkedOn)
  | LayoutAction;

/** What changes the desk's list of layouts rather than one arrangement: one engine call each. */
export type LayoutAction =
  /** A layout of the user's, made from another on this class, and opened. */
  | { type: "addLayout"; title: string; from: LayoutId; cls: ScreenClass }
  | { type: "renameLayout"; id: LayoutId; title: string }
  | { type: "removeLayout"; id: LayoutId }
  | { type: "moveLayout"; id: LayoutId; to: number }
  | { type: "hideLayout"; id: LayoutId; hidden: boolean }
  /** One class of a layout put back to its default. */
  | { type: "resetLayout"; id: LayoutId; cls: ScreenClass };

/** The engine call each layout action is. */
function changedSet(set: TileSet, action: LayoutAction): TileSet {
  switch (action.type) {
    case "addLayout":
      return addLayout(set, action.title, action.from, action.cls);
    case "renameLayout":
      return renameLayout(set, action.id, action.title);
    case "removeLayout":
      return removeLayout(set, action.id);
    case "moveLayout":
      return moveLayout(set, action.id, action.to);
    case "hideLayout":
      return setHidden(set, action.id, action.hidden);
    case "resetLayout":
      return resetLayout(set, action.id, action.cls);
  }
}

const LAYOUT_ACTIONS: ReadonlySet<string> = new Set([
  "addLayout",
  "renameLayout",
  "removeLayout",
  "moveLayout",
  "hideLayout",
  "resetLayout",
]);

function isLayoutAction(action: TilesAction): action is LayoutAction {
  return LAYOUT_ACTIONS.has(action.type);
}

/** The engine call each arrangement action is: one each, and nothing else. */
function changed(arrangement: Arrangement, action: TilesAction): Arrangement {
  switch (action.type) {
    case "tab":
      return activateTab(arrangement, action.pane);
    case "ratio":
      return setRatio(arrangement, action.splitId, action.ratio, action.size);
    case "equalize":
      return equalize(arrangement, action.splitId);
    case "close":
      return closePane(arrangement, action.pane);
    case "open":
      return openPane(arrangement, action.pane, action.workspace);
    case "maximize":
      return toggleMaximize(arrangement, action.pane);
    case "moveTab":
      return moveTab(arrangement, action.pane, action.to);
    case "move":
      return movePane(arrangement, action.pane, action.leafId, action.zone);
    default:
      return arrangement;
  }
}

/** A pane closed here and opened in another layout, on one class: two engine calls, kept only when both change. */
function sentSet(set: TileSet, action: Extract<TilesAction, { type: "sendPane" }>): TileSet {
  const here = set.current;
  if (action.layout !== undefined && action.layout !== here) return set;
  if (action.to === here || !set.layouts.some((meta) => meta.id === action.to)) return set;
  const before = arrangementOf(set, here, action.cls);
  const closed = closePane(before, action.pane);
  if (closed === before) return set;
  const there = arrangementOf(set, action.to, action.cls);
  const opened = openPane(there, action.pane, action.workspace);
  if (opened === there) return set;
  return withArrangement(withArrangement(set, here, action.cls, closed), action.to, action.cls, opened);
}

export interface TilesState {
  set: TileSet;
  /** null until the browser has said how wide it is. */
  cls: ScreenClass | null;
}

/**
 * The reducer, pure. An action that changes nothing hands back the same state,
 * so React skips the render, and an engine refusal (a layout the desk does not
 * have, a pane that is not open) is exactly that.
 */
export function tilesReducer(state: TilesState, action: TilesAction): TilesState {
  switch (action.type) {
    case "class":
      return state.cls === action.cls ? state : { ...state, cls: action.cls };
    case "layout": {
      const set = setCurrent(state.set, action.id);
      return set === state.set ? state : { ...state, set };
    }
    case "replace":
      return action.set === state.set ? state : { ...state, set: action.set };
    case "sendPane": {
      const set = sentSet(state.set, action);
      return set === state.set ? state : { ...state, set };
    }
    default: {
      if (isLayoutAction(action)) {
        const set = changedSet(state.set, action);
        return set === state.set ? state : { ...state, set };
      }
      const layout = state.set.current;
      // Worked out on another layout (one switched in under it): nothing.
      if ("layout" in action && action.layout !== undefined && action.layout !== layout) return state;
      const before = arrangementOf(state.set, layout, action.cls);
      const after = changed(before, action);
      if (after === before) return state;
      const set = withArrangement(state.set, layout, action.cls, after);
      return set === state.set ? state : { ...state, set };
    }
  }
}

/** The media queries the stylesheet switches on, from the engine's own thresholds. */
export const TILED_QUERY = `(min-width: ${TILES_MIN_WIDTH}px)`;
export const WIDE_QUERY = `(min-width: ${WIDE_MIN_WIDTH}px)`;

function classOf(wide: boolean, tiled: boolean): ScreenClass {
  if (wide) return "wide";
  return tiled ? "regular" : "compact";
}

/**
 * The class the window is now, read the way the hook reads it, for code that
 * runs before the hook's answer has been rendered (the first effects after
 * hydration). Null in a browser without matchMedia.
 */
export function classNow(): ScreenClass | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return classOf(window.matchMedia(WIDE_QUERY).matches, window.matchMedia(TILED_QUERY).matches);
}

/**
 * The desk's state. `initial` is used once, for the first render: a later
 * render of the page with other props does not reset what the user did.
 */
export function useTiles(initial: TileSet): {
  set: TileSet;
  /** null until the browser has said how wide it is: the first render is the server's. */
  cls: ScreenClass | null;
  dispatch(action: TilesAction): void;
} {
  const [state, dispatch] = useReducer(tilesReducer, initial, (set: TileSet) => ({
    set,
    cls: null,
  }));

  // The browser's answer, and every change of it. A browser without
  // matchMedia keeps no class at all: the stylesheet still draws the right one,
  // and nothing is made inert.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const wide = window.matchMedia(WIDE_QUERY);
    const tiled = window.matchMedia(TILED_QUERY);
    const read = () => dispatch({ type: "class", cls: classOf(wide.matches, tiled.matches) });
    read();
    wide.addEventListener("change", read);
    tiled.addEventListener("change", read);
    return () => {
      wide.removeEventListener("change", read);
      tiled.removeEventListener("change", read);
    };
  }, []);

  return { set: state.set, cls: state.cls, dispatch };
}

// ------------------------------------------------------------- the address

/** Where the desk lives. */
export const DESK_PATH = "/v2/desk";

/**
 * A layout's address: `/v2/desk?layout=<id>`, carrying the request's `date`
 * when it had a usable one, so the day stays the day that was planned, and the
 * week on screen when the request asked for one the calendar used, so a reload
 * or a new tab shows the week that was showing.
 */
export function deskHref(layout: LayoutId, date: string | null, week: string | null = null): string {
  const params = new URLSearchParams({ layout });
  if (date !== null) params.set("date", date);
  if (week !== null) params.set("week", week);
  return `${DESK_PATH}?${params.toString()}`;
}

/**
 * What every link on the desk carries back (a calendar's week link): the
 * layout on screen now, not the one the page was loaded on, and the date.
 */
export function deskKeep(layout: LayoutId, date: string | null): Readonly<Record<string, string>> {
  return date === null ? { layout } : { layout, date };
}

/**
 * The layout an address asks for, read in the browser on Back and Forward: its
 * `layout` when that is a layout the desk shows, and `fallback` (what the server
 * drew for an address without a usable one) otherwise. A repeated parameter is
 * no one value, so it is read as absent, as the server reads it.
 */
export function layoutAsked(search: string, set: TileSet, fallback: LayoutId): LayoutId {
  const listed = new URLSearchParams(search).getAll("layout");
  const asked = listed.length === 1 ? listed[0] : null;
  if (asked !== null && setCurrent(set, asked).current === asked) return asked;
  return fallback;
}
