"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  arrangementOf,
  leafOf,
  leavesOf,
  propertyRules,
  setCurrent,
  type LayoutId,
  type PaneId,
  type ScreenClass,
  type TileSet,
} from "@/app/lib/v2/tiles";
import { DESK_COPY, deskLine } from "@/app/lib/v2/view/desk";
// Type only: the page loads the desk on the server and hands the plain shape
// down, so no source and no loader reaches the browser through here.
import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";
import { DayProvider } from "../_components/day-provider";
import { Announcer, type DeskSaid } from "./announcer";
import { DeskTabBar, DeskTopBar } from "./desk-bar";
import { DeskDataProvider } from "./desk-data-provider";
import { DeskNotes, DeskRail } from "./desk-rail";
import { measureWorkspace } from "./divider";
import { flipChange } from "./flip";
import { frameId, titleOf, type TiledClass } from "./pane-frame";
import { paneMenuItems } from "./pane-menu";
import { useSavedDesk } from "./persist";
import { DESK_PATH, deskHref, deskKeep, layoutAsked, useTiles, type LayoutAction, type TilesAction } from "./use-tiles";
import type { OnLayout } from "./layout-menu";
import type { OnArrange } from "./pane-list";
import { Workspace, deskStage, type WorkspaceActions } from "./workspace";

/**
 * Every name the geometry can write on the stage, registered once. It is in the
 * markup the server sends, so the first paint already computes each property
 * once on the stage instead of substituting its text into every frame.
 */
export const DESK_PROPERTY_RULES = propertyRules(["regular", "wide"]);

/** A layout's title on a desk, or its id when the desk no longer has it. */
function titleIn(set: TileSet, id: LayoutId): string {
  return set.layouts.find((meta) => meta.id === id)?.title ?? id;
}

/** What the live region says after a layout action the engine took. */
function layoutSentence(action: LayoutAction, before: TileSet, after: TileSet): string {
  const line = (template: string, set: TileSet, id: LayoutId) => deskLine(template, { layout: titleIn(set, id) });
  switch (action.type) {
    case "addLayout":
      return line(DESK_COPY.layoutMade, after, after.current);
    case "renameLayout":
      return line(DESK_COPY.layoutRenamed, after, action.id);
    case "removeLayout":
      return line(DESK_COPY.layoutRemoved, before, action.id);
    case "moveLayout": {
      const from = before.layouts.findIndex((meta) => meta.id === action.id);
      return line(action.to < from ? DESK_COPY.layoutMovedUp : DESK_COPY.layoutMovedDown, after, action.id);
    }
    case "hideLayout":
      return line(action.hidden ? DESK_COPY.layoutHidden : DESK_COPY.layoutShown, after, action.id);
    case "resetLayout":
      return line(DESK_COPY.layoutReset, after, action.id);
  }
}

/** What the live region says after a change from the phone's list of panes. */
function arrangeSentence(action: TilesAction, before: TileSet): string {
  if (action.type === "moveTab") {
    const tree = arrangementOf(before, before.current, "compact").tree;
    const from = tree === null ? -1 : leavesOf(tree).flatMap((leaf) => leaf.tabs).indexOf(action.pane);
    return deskLine(action.to < from ? DESK_COPY.paneMovedUp : DESK_COPY.paneMovedDown, {
      pane: titleOf(action.pane),
    });
  }
  if (action.type === "close") return deskLine(DESK_COPY.paneHidden, { pane: titleOf(action.pane) });
  if (action.type === "open") return deskLine(DESK_COPY.paneShown, { pane: titleOf(action.pane) });
  return "";
}

function isTiled(cls: ScreenClass | null): cls is TiledClass {
  return cls === "regular" || cls === "wide";
}

/**
 * Whether an element is still where a keyboard can be: in the document, not
 * inside anything inert or hidden, and drawn on this class (every element that
 * is drawn for some classes only says which in `data-in`).
 */
function reachable(element: HTMLElement | null, cls: ScreenClass): element is HTMLElement {
  if (element === null || !element.isConnected) return false;
  if (element.closest("[inert], [hidden]") !== null) return false;
  for (let at: HTMLElement | null = element; at !== null; at = at.parentElement) {
    const within = at.getAttribute("data-in");
    if (within !== null && !within.split(" ").includes(cls)) return false;
  }
  return true;
}

/**
 * What takes the focus for a pane: the tab in front of its leaf on this class,
 * when it shares the leaf, or else its own scroller, which is named by its title.
 * On the phone, the bottom bar's tab.
 */
function paneTarget(pane: PaneId, cls: ScreenClass): HTMLElement | null {
  if (cls === "compact") {
    return document.querySelector<HTMLElement>(`.v2-desk-bar [role="tab"][data-tab="${pane}"]`);
  }
  const frame = document.getElementById(frameId(pane));
  if (frame === null) return null;
  const strip = frame.querySelector<HTMLElement>(`.v2-frame-tabs[data-in~="${cls}"]`);
  const tab = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
  return tab ?? frame.querySelector<HTMLElement>(".v2-pane-body");
}

/** A pane's menu button: where the focus follows a pane the pane menu moved. */
function menuButtonOf(pane: PaneId): HTMLElement | null {
  const frame = document.getElementById(frameId(pane));
  return frame?.querySelector<HTMLElement>(":scope > header .v2-frame-menu-button") ?? null;
}

/**
 * The phone's list that orders, hides and shows the stack (pane-list.tsx),
 * opened from the pane menu rather than repeated in it, with the focus on its
 * button.
 */
function openArrange(): void {
  const toggle = document.querySelector<HTMLElement>(".v2-desk-bar .v2-desk-arrange-toggle");
  if (toggle === null) return;
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  toggle.focus();
}

/**
 * The desk: one workspace of tiled panes, in whichever of its layouts the
 * address names.
 *
 * ITS OWN ROOT. `.v2-desk` sits directly in the v2 root and never inside a
 * `.v2-shell`: the classic page's rules reach every list under one.
 *
 * ONE PAGE, EVERY LAYOUT. A layout's anchor opens it here, in the browser: the
 * reducer, then `pushState`, which Next keeps in step with its router, so
 * nothing is asked of the server and no pane is mounted again. Back and Forward
 * come back as `popstate`, read the same way: an address with no usable layout
 * is the layout the server draws for one, as the page worked it out when the
 * desk was first loaded (`home`), not whatever a later render was handed.
 * Without script the anchor is an ordinary link and the server draws that
 * layout.
 *
 * EVERY CHANGE IS ONE ACTION, AND THEN FOCUS AND ONE SENTENCE. A press in a
 * frame or on the rail dispatches, waits for the commit (`flushSync`), and then
 * puts the focus where it can be: on the control that was pressed when it is
 * still there to be reached, and otherwise on the front tab of the pane the
 * engine says has the focus. The live region says what happened.
 *
 * SAVED AS IT CHANGES. The whole set goes to this browser's storage and the
 * open layout to a cookie the server paints the first frame from (persist.ts).
 *
 * The day is keyed on the planned day, as on Today: a calendar link on the same
 * day keeps every press, and another planned day starts the day again. The
 * tiles live above it, so a new day keeps the layout.
 */
export function DeskClient({
  data,
  initial,
  date,
  week = null,
  home,
}: {
  data: DeskScreenData;
  /** The set the server drew, its current layout the one the address asked for. */
  initial: TileSet;
  /** The request's `date`, when it is the day that was planned; every link carries it. */
  date: string | null;
  /** The week on screen, when the request asked for one the calendar used; the layout links carry it. */
  week?: string | null;
  /** The layout the server draws for an address with no usable `layout`. */
  home?: LayoutId;
}) {
  const { set, cls, dispatch } = useTiles(initial);
  const layout = set.current;
  const stage = useMemo(() => deskStage(set, layout), [set, layout]);
  const keep = useMemo(() => deskKeep(layout, date), [layout, date]);
  const [fallback] = useState(home ?? initial.current);
  const stageRef = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState<DeskSaid | null>(null);

  // The set as last committed, for what happens right after a commit.
  const latest = useRef(set);
  useLayoutEffect(() => {
    latest.current = set;
  });

  // A change a person makes glides (flip.ts), on the class on screen as last
  // committed. A change of class, the saved desk loading and a divider's ratio
  // are dispatched directly and never come here.
  const shownClass = useRef(cls);
  useLayoutEffect(() => {
    shownClass.current = cls;
  });
  const glide = useCallback(
    (change: () => void) => flipChange(stageRef.current, shownClass.current, change),
    [],
  );

  // What the save said while an action was being committed: it is said after
  // the action's own sentence, in the same breath, so neither hides the other.
  const notice = useRef<string | null>(null);
  const say = useCallback((text: string) => {
    const extra = notice.current;
    notice.current = null;
    setSaid({ text: extra === null ? text : `${text} ${extra}` });
  }, []);
  const tooBig = useCallback(() => {
    notice.current = DESK_COPY.savedHereOnly;
    setSaid({ text: DESK_COPY.savedHereOnly });
  }, []);
  useSavedDesk(set, dispatch, tooBig, (sentence) => { notice.current = sentence; setSaid({ text: sentence }); });

  /**
   * One action, committed before anything else happens, so the focus can be
   * put on what is there now: the pressed control when it can still be
   * reached, then `fallback` when the caller knows better (a row of a list),
   * then the front tab of the pane the engine says has the focus. When the
   * layout on screen changed with it (a layout made, deleted or hidden), the
   * address follows: a new layout is a new entry in the history, the others
   * replace the one there. Answers the set it committed, or null when the
   * engine refused it.
   */
  const commit = useCallback(
    (
      action: TilesAction,
      pressed: HTMLElement | null,
      on: ScreenClass,
      fallback?: (after: TileSet) => HTMLElement | null,
    ): TileSet | null => {
      const before = latest.current;
      notice.current = null;
      glide(() => flushSync(() => dispatch(action)));
      const after = latest.current;
      if (after.current !== before.current) {
        const href = deskHref(after.current, date, week);
        if (action.type === "addLayout") window.history.pushState(null, "", href);
        else window.history.replaceState(null, "", href);
      }
      if (reachable(pressed, on)) {
        if (document.activeElement !== pressed) pressed.focus();
      } else if (fallback !== undefined) {
        fallback(after)?.focus();
      } else {
        const arrangement = arrangementOf(after, after.current, on);
        const pane = arrangement.focus ?? leavesOf(arrangement.tree)[0]?.active;
        if (pane !== undefined) paneTarget(pane, on)?.focus();
      }
      return after === before ? null : after;
    },
    [dispatch, glide, date, week],
  );

  const actions = useMemo<WorkspaceActions>(
    () => ({
      onTab: (on, pane, pressed) => {
        commit({ type: "tab", cls: on, pane }, pressed, on);
      },
      onClose: (on, pane, pressed) => {
        if (commit({ type: "close", cls: on, pane }, pressed, on) !== null) {
          say(deskLine(DESK_COPY.paneClosed, { pane: titleOf(pane) }));
        }
      },
      onMaximize: (on, pane, pressed) => {
        const after = commit({ type: "maximize", cls: on, pane }, pressed, on);
        if (after === null) return;
        const filled = arrangementOf(after, after.current, on).maximized === pane;
        say(deskLine(filled ? DESK_COPY.paneMaximized : DESK_COPY.paneRestored, { pane: titleOf(pane) }));
      },
      // The pane menu: what it offers is worked out from the desk as it is
      // when it opens, on the workspace the browser computed (none on the
      // phone). A pick is one action; the focus follows the pane to its menu
      // button, or goes to the one of the pane the engine focuses when the
      // pane has left (closed, or moved to another layout).
      menuItems: (on, pane) =>
        paneMenuItems(latest.current, on, pane, isTiled(on) ? measureWorkspace(stageRef.current, on) : null),
      onMenu: (on, _pane, item, button) => {
        if (item.action === null) {
          openArrange();
          return;
        }
        const after = commit(item.action, button, on, (next) => {
          const arrangement = arrangementOf(next, next.current, on);
          const focused = arrangement.focus ?? leavesOf(arrangement.tree)[0]?.active;
          if (focused === undefined) return null;
          const target = menuButtonOf(focused);
          return reachable(target, on) ? target : paneTarget(focused, on);
        });
        if (after !== null) say(item.said);
      },
      onRatio: (on, splitId, ratio, size, layout) => dispatch({ type: "ratio", cls: on, splitId, ratio, size, layout }),
      onEqualize: (on, splitId, layout) => dispatch({ type: "equalize", cls: on, splitId, layout }),
    }),
    [commit, dispatch, say],
  );

  /**
   * A pane on the rail. Open in the layout on screen: brought to the front and
   * given the focus. Closed: opened by the engine on the workspace the browser
   * computed, where it was before, and the focus stays on the rail.
   */
  const onPane = useCallback(
    (pane: PaneId, pressed: HTMLElement) => {
      if (!isTiled(cls)) return;
      const arrangement = arrangementOf(set, set.current, cls);
      if (leafOf(arrangement.tree, pane) !== null) {
        glide(() => flushSync(() => dispatch({ type: "tab", cls, pane })));
        paneTarget(pane, cls)?.focus();
        return;
      }
      const workspace = measureWorkspace(stageRef.current, cls);
      if (workspace === null) return;
      if (commit({ type: "open", cls, pane, workspace }, pressed, cls) !== null) {
        say(deskLine(DESK_COPY.paneOpened, { pane: titleOf(pane) }));
      }
    },
    [cls, set, dispatch, glide, commit, say],
  );

  /** The rail's and the sheet's layout actions: one engine call, the focus, one sentence. */
  const onLayout = useCallback<OnLayout>(
    (action, pressed, fallback) => {
      const before = latest.current;
      const after = commit(action, pressed, cls ?? "regular", fallback);
      if (after !== null) say(layoutSentence(action, before, after));
      return after;
    },
    [cls, commit, say],
  );

  /** The phone's list of panes: one engine call on the phone's arrangement, the focus, one sentence. */
  const onArrange = useCallback<OnArrange>(
    (action, pressed, fallback) => {
      const before = latest.current;
      if (commit(action, pressed, "compact", () => fallback()) !== null) {
        say(arrangeSentence(action, before));
      }
    },
    [commit, say],
  );

  const openLayout = useCallback(
    (id: LayoutId) => {
      // A layout already on screen, hidden, or not on the desk: nothing to push.
      if (setCurrent(set, id) === set) return;
      glide(() => flushSync(() => dispatch({ type: "layout", id })));
      window.history.pushState(null, "", deskHref(id, date, week));
    },
    [set, date, week, dispatch, glide],
  );

  const showTab = useCallback(
    (pane: PaneId) => glide(() => flushSync(() => dispatch({ type: "tab", cls: "compact", pane }))),
    [dispatch, glide],
  );

  // Back and Forward. An address without a usable layout is the one the server
  // draws for it.
  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname !== DESK_PATH) return;
      const id = layoutAsked(window.location.search, set, fallback);
      glide(() => flushSync(() => dispatch({ type: "layout", id })));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [set, fallback, dispatch, glide]);

  return (
    <>
      <style>{DESK_PROPERTY_RULES}</style>
      <DeskDataProvider data={data} keep={keep}>
        <DayProvider key={data.today.input.date} data={data.today}>
          <div className="v2-desk" data-layout={layout}>
            <DeskTopBar set={set} cls={cls} date={date} week={week} onOpen={openLayout} onLayout={onLayout} />
            <DeskRail
              set={set}
              stage={stage}
              cls={cls}
              date={date}
              week={week}
              onOpen={openLayout}
              onPane={onPane}
              onLayout={onLayout}
            />
            <DeskNotes where="compact" />
            <Workspace set={set} stage={stage} cls={cls} stageRef={stageRef} actions={actions} />
            <DeskTabBar
              tabs={stage.compact.tabs}
              active={stage.compact.active}
              onTab={showTab}
              onArrange={onArrange}
            />
            <Announcer desk={said} />
          </div>
        </DayProvider>
      </DeskDataProvider>
    </>
  );
}
