"use client";

import { useCallback, useEffect, useMemo } from "react";

import { propertyRules, setCurrent, type LayoutId, type PaneId, type TileSet } from "@/app/lib/v2/tiles";
// Type only: the page loads the desk on the server and hands the plain shape
// down, so no source and no loader reaches the browser through here.
import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";
import { DayProvider } from "../_components/day-provider";
import { Announcer } from "./announcer";
import { DeskTabBar, DeskTopBar } from "./desk-bar";
import { DeskDataProvider } from "./desk-data-provider";
import { DeskNotes, DeskRail } from "./desk-rail";
import { DESK_PATH, deskHref, deskKeep, layoutAsked, useTiles } from "./use-tiles";
import { Workspace, deskStage } from "./workspace";

/**
 * Every name the geometry can write on the stage, registered once. It is in the
 * markup the server sends, so the first paint already computes each property
 * once on the stage instead of substituting its text into every frame.
 */
export const DESK_PROPERTY_RULES = propertyRules(["regular", "wide"]);

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
 * come back as `popstate`, read the same way. Without script the anchor is an
 * ordinary link and the server draws that layout.
 *
 * The day is keyed on the planned day, as on Today: a calendar link on the same
 * day keeps every press, and another planned day starts the day again. The
 * tiles live above it, so a new day keeps the layout.
 */
export function DeskClient({
  data,
  initial,
  date,
}: {
  data: DeskScreenData;
  /** The set the server drew, its current layout the one the address asked for. */
  initial: TileSet;
  /** The request's `date`, when it is the day that was planned; every link carries it. */
  date: string | null;
}) {
  const { set, cls, dispatch } = useTiles(initial);
  const layout = set.current;
  const stage = useMemo(() => deskStage(set, layout), [set, layout]);
  const keep = useMemo(() => deskKeep(layout, date), [layout, date]);
  const fallback = initial.current;

  const openLayout = useCallback(
    (id: LayoutId) => {
      // A layout already on screen, hidden, or not on the desk: nothing to push.
      if (setCurrent(set, id) === set) return;
      dispatch({ type: "layout", id });
      window.history.pushState(null, "", deskHref(id, date));
    },
    [set, date, dispatch],
  );

  const showTab = useCallback(
    (pane: PaneId) => dispatch({ type: "tab", cls: "compact", pane }),
    [dispatch],
  );

  // Back and Forward. An address without a usable layout is the one the server
  // drew for it.
  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname !== DESK_PATH) return;
      dispatch({ type: "layout", id: layoutAsked(window.location.search, set, fallback) });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [set, fallback, dispatch]);

  return (
    <>
      <style>{DESK_PROPERTY_RULES}</style>
      <DeskDataProvider data={data} keep={keep}>
        <DayProvider key={data.today.input.date} data={data.today}>
          <div className="v2-desk" data-layout={layout}>
            <DeskTopBar set={set} date={date} onOpen={openLayout} />
            <DeskRail set={set} stage={stage} date={date} onOpen={openLayout} />
            <DeskNotes where="compact" />
            <Workspace set={set} stage={stage} cls={cls} />
            <DeskTabBar tabs={stage.compact.tabs} active={stage.compact.active} onTab={showTab} />
            <Announcer />
          </div>
        </DayProvider>
      </DeskDataProvider>
    </>
  );
}
