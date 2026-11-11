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
  arrangementOf,
  closePane,
  equalize,
  openPane,
  setCurrent,
  setRatio,
  toggleMaximize,
  withArrangement,
  type Arrangement,
  type LayoutId,
  type PaneId,
  type ScreenClass,
  type TileSet,
  type Workspace,
} from "@/app/lib/v2/tiles";

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
  | { type: "ratio"; cls: ScreenClass; splitId: string; ratio: number; size: number }
  /** Both sides of a divider the same: `equalize`. */
  | { type: "equalize"; cls: ScreenClass; splitId: string }
  | { type: "close"; cls: ScreenClass; pane: PaneId }
  /** Open a pane, placed by the engine on the workspace the browser computed. */
  | { type: "open"; cls: ScreenClass; pane: PaneId; workspace: Workspace }
  | { type: "maximize"; cls: ScreenClass; pane: PaneId };

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
    default:
      return arrangement;
  }
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
    default: {
      const layout = state.set.current;
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
