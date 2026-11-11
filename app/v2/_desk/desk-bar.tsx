"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { LayoutId, PaneId, TileSet } from "@/app/lib/v2/tiles";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import { AppearanceTrigger } from "../_components/appearance-root";
import { LayoutLinks } from "./desk-rail";
import { frameId, shortOf } from "./pane-frame";

// The phone's two bars, under 1024px. They follow the phone bar of Today and
// Week: the card's surface with a hairline, 52px of row, the display face, the
// quiet ink, and the accent's mark on the one that is current. Nothing slides.

/** The phone's list of layouts, opened from the top bar. */
const LAYOUT_LIST_ID = "v2-desk-layout-list";

/**
 * The top bar: the layout on screen, as a button that opens the list of
 * layouts (the same anchors as the rail), and the way in to the appearance
 * panel the phone header has on Today.
 */
export function DeskTopBar({
  set,
  date,
  week = null,
  onOpen,
}: {
  set: TileSet;
  date: string | null;
  week?: string | null;
  onOpen(layout: LayoutId): void;
}) {
  const [open, setOpen] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const title = set.layouts.find((meta) => meta.id === set.current)?.title ?? "";

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    button.current?.focus();
  };

  // A press anywhere outside the bar closes the list. Focus is left where the
  // press put it: that is where the user went.
  useEffect(() => {
    if (!open) return;
    const onPress = (event: Event) => {
      if (event.target instanceof Node && bar.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [open]);

  return (
    <header ref={bar} className="v2-desk-top" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="v2-desk-switch"
        aria-expanded={open}
        aria-controls={LAYOUT_LIST_ID}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="v2-hidden">{DESK_COPY.layoutButton}: </span>
        <span>{title}</span>
        <span className="v2-desk-chev" aria-hidden="true" />
      </button>
      <AppearanceTrigger variant="header" />
      <LayoutLinks
        id={LAYOUT_LIST_ID}
        className="v2-desk-menu"
        hidden={!open}
        set={set}
        date={date}
        week={week}
        onOpen={(layout) => {
          // The anchor that was pressed is about to be hidden with the list,
          // so the focus goes back to the button that opened it, as Escape does.
          setOpen(false);
          button.current?.focus();
          onOpen(layout);
        }}
      />
    </header>
  );
}

/**
 * The bottom bar: the tabs of the phone's one leaf, in order, the one in front
 * marked. It scrolls sideways when there are more than fit. A press shows that
 * pane, through the engine (`activateTab`, the reducer's `tab` action on the
 * compact class); the arrow keys, Home and End move along it as a tab strip.
 */
export function DeskTabBar({
  tabs,
  active,
  onTab,
}: {
  tabs: readonly PaneId[];
  active: PaneId | null;
  onTab(pane: PaneId): void;
}) {
  const strip = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: PaneId) => {
    const at = tabs.indexOf(from);
    let to = -1;
    if (event.key === "ArrowRight") to = (at + 1) % tabs.length;
    else if (event.key === "ArrowLeft") to = (at - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = tabs.length - 1;
    if (to < 0) return;
    event.preventDefault();
    const pane = tabs[to];
    onTab(pane);
    strip.current?.querySelector<HTMLElement>(`[data-tab="${pane}"]`)?.focus();
  };

  return (
    <div className="v2-desk-bar">
      <div ref={strip} className="v2-desk-bar-tabs" role="tablist" aria-label={DESK_COPY.bar}>
        {tabs.map((pane) => (
          <button
            key={pane}
            type="button"
            role="tab"
            data-tab={pane}
            aria-selected={pane === active}
            aria-controls={frameId(pane)}
            tabIndex={pane === active ? 0 : -1}
            onClick={() => onTab(pane)}
            onKeyDown={(event) => onKeyDown(event, pane)}
          >
            {shortOf(pane)}
          </button>
        ))}
      </div>
    </div>
  );
}
