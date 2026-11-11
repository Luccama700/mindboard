"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { PANES, type PaneId } from "@/app/lib/v2/tiles";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import { titleOf } from "./pane-frame";
import type { TilesAction } from "./use-tiles";

// The phone's list of panes: what is in the layout on screen, in the bottom
// bar's order, and what is not. A pane in the layout can move up or down the
// bar and be hidden from it (Hide closes it, and the last one cannot be);
// a pane not in it can be shown (it opens at the end of the bar, in front).
//
// NO DRAG. Every move is a button, which is the only way a coarse pointer has
// and the way a keyboard has. A move that cannot happen (Move up on the first)
// is marked unavailable rather than removed, so the focus never falls off the
// button that was pressed. Each action is one engine call (`moveTab`,
// `closePane`, `openPane`) on the phone's own arrangement.

/** What the desk does with a press in the list, and where the focus goes when the pressed control is gone. */
export type OnArrange = (action: TilesAction, pressed: HTMLElement, fallback: () => HTMLElement | null) => void;

/** One pane's row, as a group named after the pane, so each button is heard with it. */
function Row({ pane, children }: { pane: PaneId; children: ReactNode }) {
  const title = titleOf(pane);
  return (
    <li data-pane={pane}>
      <div className="v2-desk-arrange-row" role="group" aria-label={title}>
        <span className="v2-desk-arrange-name" aria-hidden="true">
          {title}
        </span>
        <span className="v2-desk-arrange-actions">{children}</span>
      </div>
    </li>
  );
}

export function PaneList({ tabs, onArrange }: { tabs: readonly PaneId[]; onArrange: OnArrange }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closed = PANES.map((spec) => spec.id).filter((pane) => !tabs.includes(pane));

  // A press outside the list closes it, as the top bar's does.
  useEffect(() => {
    if (!open) return;
    const onPress = (event: Event) => {
      if (event.target instanceof Node && wrap.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    trigger.current?.focus();
  };

  const control = (pane: PaneId, part: string) =>
    // `:scope` keeps the row's match inside this list: a frame carries a `data-pane` too.
    wrap.current?.querySelector<HTMLElement>(`:scope li[data-pane="${pane}"] [data-part="${part}"]`) ?? null;

  return (
    <div ref={wrap} className="v2-desk-arrange" onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="v2-desk-arrange-toggle"
        aria-expanded={open}
        aria-controls={id}
        aria-label={DESK_COPY.arrangePanesName}
        onClick={() => setOpen((was) => !was)}
      >
        {DESK_COPY.arrangePanes}
      </button>
      <div id={id} className="v2-desk-arrange-sheet" hidden={!open}>
        <p className="v2-desk-arrange-head">{DESK_COPY.inLayout}</p>
        <ul>
          {tabs.map((pane, index) => {
            const first = index === 0;
            const last = index === tabs.length - 1;
            const alone = tabs.length < 2;
            return (
              <Row key={pane} pane={pane}>
                <button
                  type="button"
                  data-part="up"
                  aria-disabled={first}
                  onClick={(event) => {
                    if (!first) onArrange({ type: "moveTab", cls: "compact", pane, to: index - 1 }, event.currentTarget, () => control(pane, "up"));
                  }}
                >
                  {DESK_COPY.moveUp}
                </button>
                <button
                  type="button"
                  data-part="down"
                  aria-disabled={last}
                  onClick={(event) => {
                    if (!last) onArrange({ type: "moveTab", cls: "compact", pane, to: index + 1 }, event.currentTarget, () => control(pane, "down"));
                  }}
                >
                  {DESK_COPY.moveDown}
                </button>
                <button
                  type="button"
                  data-part="hide"
                  aria-disabled={alone}
                  onClick={(event) => {
                    if (!alone) onArrange({ type: "close", cls: "compact", pane }, event.currentTarget, () => control(pane, "show"));
                  }}
                >
                  {DESK_COPY.hide}
                </button>
              </Row>
            );
          })}
        </ul>
        {closed.length > 0 && (
          <>
            <p className="v2-desk-arrange-head">{DESK_COPY.notInLayout}</p>
            <ul>
              {closed.map((pane) => (
                <Row key={pane} pane={pane}>
                  <button
                    type="button"
                    data-part="show"
                    onClick={(event) =>
                      onArrange({ type: "open", cls: "compact", pane, workspace: null }, event.currentTarget, () =>
                        control(pane, "hide"),
                      )
                    }
                  >
                    {DESK_COPY.show}
                  </button>
                </Row>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
