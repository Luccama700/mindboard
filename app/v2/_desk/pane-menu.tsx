"use client";

import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import {
  PANES,
  TILE_COPY,
  arrangementOf,
  layoutTree,
  leafOf,
  neighbourOf,
  openPanes,
  type Direction,
  type PaneId,
  type ScreenClass,
  type TileSet,
  type Workspace,
  type Zone,
} from "@/app/lib/v2/tiles";
import { DESK_COPY, deskLine } from "@/app/lib/v2/view/desk";
import { tilesReducer, type TilesAction, type TilesState } from "./use-tiles";

// The pane menu: one button in each frame's header, and the menu it opens.
//
// EVERY CHANGE A DRAG CAN MAKE, BY KEYBOARD AND BY A PRESS (WCAG 2.5.7). Move
// left, right, up and down (the engine's `neighbourOf`, then `movePane` on that
// side of the neighbour), make this pane a tab of each other open pane, split
// this tab off, maximize or restore, close, and move it to another layout.
//
// THE ENGINE DECIDES WHAT IS OFFERED. Each item is a reducer action, and it is
// offered only when the reducer's answer for it is not the state it was given:
// the engine's own identity contract, so nothing here re-derives a rule. The
// one thing chosen here is the side a tab splits off to, the longer side of its
// own leaf, because the engine has no single answer for it. Each action carries
// the layout it was worked out on (`layout`): a leaf id means nothing on
// another layout, so a pick after a layout switched under the open menu is
// refused by the reducer.
//
// NOT ON THE PHONE. A phone's frame has no header row: the screen is for the
// content, and the list that orders, hides and shows the stack
// (pane-list.tsx) is the phone's way to arrange it. The builder answers
// nothing for the compact class.
//
// WHERE IT IS DRAWN. Inside its frame (desk.css): the header, the tools and the
// menu's wrapper are not positioned, so the frame is what the menu is placed
// against, under the header at its right edge, held to the frame and to the
// window and scrolling inside itself. The frame's overflow can never clip it,
// and on opening it is scrolled into view, whole.

/** One thing the menu offers. */
export interface PaneMenuItem {
  id: string;
  label: string;
  /** The sentence the live region says once it is done. */
  said: string;
  group: "move" | "tab" | "size" | "send";
  action: TilesAction;
}

const MOVES: ReadonlyArray<{ dir: Direction; zone: Zone; label: string; said: string }> = [
  { dir: "left", zone: "left", label: DESK_COPY.moveLeft, said: DESK_COPY.paneMovedLeft },
  { dir: "right", zone: "right", label: DESK_COPY.moveRight, said: DESK_COPY.paneMovedRight },
  { dir: "up", zone: "top", label: DESK_COPY.moveUp, said: DESK_COPY.paneMovedUp },
  { dir: "down", zone: "bottom", label: DESK_COPY.moveDown, said: DESK_COPY.paneMovedDown },
];

function titleOf(pane: PaneId): string {
  return PANES.find((spec) => spec.id === pane)?.title ?? pane;
}

/**
 * What the menu offers for one pane of the layout on screen, on one tiled
 * class (nothing on the phone). `workspace` is the one the browser computed
 * (null before the sheet has applied): without it nothing that needs a size
 * is offered.
 */
export function paneMenuItems(
  set: TileSet,
  cls: ScreenClass,
  pane: PaneId,
  workspace: Workspace | null,
): PaneMenuItem[] {
  if (cls === "compact") return [];
  const state: TilesState = { set, cls };
  const arrangement = arrangementOf(set, set.current, cls);
  const tree = arrangement.tree;
  const leaf = leafOf(tree, pane);
  if (leaf === null) return [];
  const title = titleOf(pane);
  const items: PaneMenuItem[] = [];
  const offer = (item: PaneMenuItem) => {
    if (tilesReducer(state, item.action) !== state) items.push(item);
  };

  // Neighbours on the layout as it is arranged: a move clears a maximize.
  const rects = workspace === null ? null : layoutTree({ ...arrangement, maximized: null }, workspace);
  if (rects !== null) {
    for (const move of MOVES) {
      const next = neighbourOf(rects, leaf.id, move.dir);
      if (next === null) continue;
      offer({
        id: move.dir,
        group: "move",
        label: move.label,
        said: deskLine(move.said, { pane: title }),
        action: { type: "move", cls, pane, leafId: next, zone: move.zone, layout: set.current },
      });
    }
  }
  for (const other of openPanes(tree)) {
    const holder = other === pane ? null : leafOf(tree, other);
    if (holder === null) continue;
    offer({
      id: `tab:${other}`,
      group: "tab",
      label: `${TILE_COPY.zone.centre} ${titleOf(other)}`,
      said: deskLine(DESK_COPY.paneTabbed, { pane: title, first: titleOf(other) }),
      action: { type: "move", cls, pane, leafId: holder.id, zone: "centre", layout: set.current },
    });
  }
  const own = rects?.leaves.find((rect) => rect.leafId === leaf.id);
  offer({
    id: "split",
    group: "tab",
    label: DESK_COPY.splitOff,
    said: deskLine(DESK_COPY.paneSplit, { pane: title }),
    action: {
      type: "move",
      cls,
      pane,
      leafId: leaf.id,
      zone: own === undefined || own.w >= own.h ? "right" : "bottom",
      layout: set.current,
    },
  });
  const filled = arrangement.maximized === pane;
  offer({
    id: "maximize",
    group: "size",
    label: filled ? DESK_COPY.restore : DESK_COPY.maximize,
    said: deskLine(filled ? DESK_COPY.paneRestored : DESK_COPY.paneMaximized, { pane: title }),
    action: { type: "maximize", cls, pane, layout: set.current },
  });
  offer({
    id: "close",
    group: "size",
    label: DESK_COPY.close,
    said: deskLine(DESK_COPY.paneClosed, { pane: title }),
    action: { type: "close", cls, pane, layout: set.current },
  });

  // Another layout opens the pane in its arrangement for this class, placed on
  // this workspace, so it needs the size.
  if (workspace !== null) {
    for (const meta of set.layouts) {
      if (meta.id === set.current || set.hidden.includes(meta.id)) continue;
      offer({
        id: `send:${meta.id}`,
        group: "send",
        label: deskLine(DESK_COPY.sendTo, { layout: meta.title }),
        said: deskLine(DESK_COPY.paneSent, { pane: title, layout: meta.title }),
        action: { type: "sendPane", cls, pane, to: meta.id, workspace, layout: set.current },
      });
    }
  }
  return items;
}

/** The next item whose label starts with this letter, after the one at `from`, wrapping; null for none. */
function typedAhead(labels: readonly string[], from: number, letter: string): number | null {
  const wanted = letter.toLowerCase();
  for (let step = 1; step <= labels.length; step += 1) {
    const at = (from + step + labels.length) % labels.length;
    if (labels[at].toLowerCase().startsWith(wanted)) return at;
  }
  return null;
}

/**
 * The button and its menu, for one frame. `target` is the class the menu acts
 * on: the class on screen where the frame is drawn there, or null when it acts
 * on none. `itemsFor` is asked when the menu opens, so what it offers is the
 * desk as it is then; `onPick` is handed the item and the button, which is
 * where the focus goes when the pane is still here to hold it.
 *
 * `desk` is the set on screen. The menu belongs to the set it was opened on:
 * any other set (another tab's write merged in, the saved desk loading, Back
 * or Forward) closes it, because leaf ids are minted again whenever a set is
 * read, and nothing may act on ids held from before.
 */
export function PaneMenu({
  paneId,
  title,
  target,
  desk,
  itemsFor,
  onPick,
}: {
  paneId: PaneId;
  title: string;
  target: ScreenClass | null;
  desk: TileSet;
  itemsFor(cls: ScreenClass): PaneMenuItem[];
  onPick(cls: ScreenClass, item: PaneMenuItem, button: HTMLElement): void;
}) {
  // What was offered, for which class, on which set. Another class or another
  // set closes it: the items were worked out on the ones it was opened on.
  const [menu, setMenu] = useState<{ cls: ScreenClass; desk: TileSet; items: PaneMenuItem[] } | null>(null);
  const open = menu !== null && menu.cls === target && menu.desk === desk;
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = `v2-frame-${paneId}-menu`;
  const buttonId = `v2-frame-${paneId}-menu-button`;
  const name = deskLine(DESK_COPY.paneMenu, { pane: title });

  const itemElements = () =>
    Array.from(list.current?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]') ?? []);

  const show = (at: "first" | "last") => {
    if (target === null) return;
    const items = itemsFor(target);
    flushSync(() => setMenu({ cls: target, desk, items }));
    list.current?.scrollIntoView?.({ block: "nearest" });
    const all = itemElements();
    (at === "first" ? all[0] : all[all.length - 1])?.focus();
  };

  const close = (returnFocus: boolean) => {
    flushSync(() => setMenu(null));
    if (returnFocus) button.current?.focus();
  };

  // A press anywhere outside the button and its menu closes it, and the focus
  // stays where the press put it.
  useEffect(() => {
    if (!open) return;
    const onPress = (event: Event) => {
      if (event.target instanceof Node && wrap.current?.contains(event.target)) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [open]);

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    show(event.key === "ArrowDown" ? "first" : "last");
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const all = itemElements();
    const from = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      // The focus goes back to the button, and Tab goes on from there.
      close(true);
      return;
    }
    let to: number | null = null;
    if (event.key === "ArrowDown") to = (from + 1) % all.length;
    else if (event.key === "ArrowUp") to = from <= 0 ? all.length - 1 : from - 1;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = all.length - 1;
    else if (event.key.length === 1 && event.key.trim() !== "") {
      to = typedAhead(all.map((item) => item.textContent ?? ""), from, event.key);
    }
    if (to === null || all.length === 0) return;
    event.preventDefault();
    all[to]?.focus();
  };

  // The focus leaving for somewhere else (a screen reader's cursor, a script)
  // closes it too, without moving the focus back.
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (!open) return;
    const next = event.relatedTarget;
    if (next === null || (next instanceof Node && wrap.current?.contains(next))) return;
    setMenu(null);
  };

  const pick = (item: PaneMenuItem) => {
    if (menu === null || button.current === null) return;
    const on = menu.cls;
    close(false);
    onPick(on, item, button.current);
  };

  const items = open ? menu.items : [];

  return (
    <span ref={wrap} className="v2-frame-menu" onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        id={buttonId}
        className="v2-frame-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={name}
        title={name}
        onClick={() => {
          if (open) close(true);
          else show("first");
        }}
        onKeyDown={onButtonKey}
      />
      <div
        ref={list}
        id={menuId}
        className="v2-frame-menu-list"
        role="menu"
        aria-labelledby={buttonId}
        hidden={!open}
        onKeyDown={onMenuKey}
      >
        {items.flatMap((item, index) => [
          index > 0 && items[index - 1].group !== item.group ? (
            <div key={`rule-${item.id}`} className="v2-frame-menu-rule" role="separator" />
          ) : null,
          <button
            key={item.id}
            type="button"
            className="v2-frame-menu-item"
            role="menuitem"
            tabIndex={-1}
            data-item={item.id}
            onClick={() => pick(item)}
          >
            {item.label}
          </button>,
        ])}
      </div>
    </span>
  );
}
