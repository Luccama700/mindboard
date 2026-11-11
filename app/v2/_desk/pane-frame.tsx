"use client";

import {
  createElement,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

import {
  PANES,
  type CssBox,
  type PaneId,
  type PaneSpec,
  type ScreenClass,
  type TileSet,
} from "@/app/lib/v2/tiles";
import { DESK_COPY, deskLine } from "@/app/lib/v2/view/desk";
import { PaneBox } from "./pane-box";
import { PaneMenu, type PaneMenuItem } from "./pane-menu";
import { paneBody } from "./pane-registry";

/** The classes that are tiled, and drawn from `cssLayout`. Compact never is. */
export type TiledClass = "regular" | "wide";
export const TILED_CLASSES: readonly TiledClass[] = ["regular", "wide"];

/** The four sides of a box, in the order they are written. */
export const BOX_SIDES = ["left", "top", "width", "height"] as const;

/** A leaf's tab strip over one frame: the leaf's tabs, the one in front, and the classes it is drawn in. */
export interface FrameStrip {
  classes: TiledClass[];
  tabs: PaneId[];
  active: PaneId;
}

/** One pane's frame, for every class at once. */
export interface DeskFrame {
  pane: PaneSpec;
  /** The classes the frame is displayed in: in front of its leaf, and not behind a maximized pane. */
  shown: ScreenClass[];
  /** The classes the pane is open in, in front or behind. */
  open: ScreenClass[];
  /** The leaf's box on each tiled class the pane is open in. */
  boxes: Partial<Record<TiledClass, CssBox>>;
  /** The strip over this frame, once per distinct strip, when it is in front of a leaf of several. */
  strips: FrameStrip[];
  /**
   * The tiled classes where the pane is alone in its leaf, shown, and not the
   * last pane open: there its title carries a close control of its own. (On a
   * class with a strip, every tab has one: a strip means two panes are open.)
   */
  soloClose: TiledClass[];
  /** The tiled classes where this pane is the one maximized. */
  maximized: TiledClass[];
  /**
   * The classes where the frame is the panel of a tab: always on the phone,
   * whose bar is the one leaf's strip, and on a tiled class where a strip is
   * drawn over it.
   */
  panelIn: ScreenClass[];
}

/** What a press in a frame's header asks the desk to do. The pressed element comes along for focus. */
export interface FrameActions {
  onTab(cls: TiledClass, pane: PaneId, pressed: HTMLElement): void;
  onClose(cls: TiledClass, pane: PaneId, pressed: HTMLElement): void;
  onMaximize(cls: TiledClass, pane: PaneId, pressed: HTMLElement): void;
  /** What the pane menu offers for this pane on this class, the desk as it is now. */
  menuItems(cls: ScreenClass, pane: PaneId): PaneMenuItem[];
  /** One item of the pane menu taken; `button` is the menu's own button. */
  onMenu(cls: ScreenClass, pane: PaneId, item: PaneMenuItem, button: HTMLElement): void;
  /**
   * A press on a handle: the header's empty part or its title for the frame's
   * own pane, or a tab for that tab's pane. It is a drag only after it travels
   * (use-dock-drag.ts); until then it is a press like any other.
   */
  onDragStart(pane: PaneId, event: globalThis.PointerEvent, handle: HTMLElement): void;
}

/**
 * The tiled class a frame's menu acts on: the class on screen where the frame
 * is drawn there, and otherwise, before the browser has said its class, the
 * first tiled class the frame is drawn in. Never the phone's: a phone's frame
 * has no header row and no menu.
 */
function menuTarget(cls: ScreenClass | null, frame: DeskFrame): TiledClass | null {
  const tiled = tiledShown(frame);
  if (cls === null) return tiled[0] ?? null;
  return (cls === "regular" || cls === "wide") && tiled.includes(cls) ? cls : null;
}

/** What a press on a header never starts a drag from: a control, or the open menu. */
const NOT_A_HANDLE = 'button, a, input, select, textarea, [role="menu"]';

/**
 * The property a frame's box is written in, for one class and one side. Not to
 * be confused with the stage's `--v2-<class>-w`, which is the whole workspace.
 */
export function frameVar(cls: TiledClass, side: (typeof BOX_SIDES)[number]): string {
  return `--v2-frame-${cls}-${side}`;
}

/** The ids a frame is reached by: its section, and the title it is labelled by. */
export function frameId(pane: PaneId): string {
  return `v2-frame-${pane}`;
}

export function frameTitleId(pane: PaneId): string {
  return `v2-frame-${pane}-title`;
}

/** A frame's box on each tiled class it is open in, as the custom properties desk.css reads. */
export function frameStyle(boxes: DeskFrame["boxes"]): CSSProperties {
  const style: Record<string, string> = {};
  for (const cls of TILED_CLASSES) {
    const box = boxes[cls];
    if (box === undefined) continue;
    for (const side of BOX_SIDES) style[frameVar(cls, side)] = box[side];
  }
  return style as CSSProperties;
}

/** A pane's label on a tab. */
export function shortOf(pane: PaneId): string {
  return PANES.find((spec) => spec.id === pane)?.short ?? pane;
}

/** A pane's title. */
export function titleOf(pane: PaneId): string {
  return PANES.find((spec) => spec.id === pane)?.title ?? pane;
}

/**
 * The tiled class a control acts on: the class on screen when the control is
 * drawn there, and otherwise the first class it is drawn in (a browser that
 * never said its width; the stylesheet still shows exactly one).
 */
export function tiledTarget(cls: ScreenClass | null, among: readonly TiledClass[]): TiledClass | null {
  if ((cls === "regular" || cls === "wide") && among.includes(cls)) return cls;
  return among[0] ?? null;
}

/** The tiled classes the frame is displayed in. */
function tiledShown(frame: DeskFrame): TiledClass[] {
  return TILED_CLASSES.filter((cls) => frame.shown.includes(cls));
}

/** A strip's keys: along the strip, wrapping, and to either end. Alt is never bound. */
function stepTo(key: string, at: number, count: number): number | null {
  if (key === "ArrowRight") return (at + 1) % count;
  if (key === "ArrowLeft") return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function TabStrip({
  strip,
  cls,
  actions,
}: {
  strip: FrameStrip;
  cls: ScreenClass | null;
  actions: FrameActions;
}) {
  const target = tiledTarget(cls, strip.classes);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, pane: PaneId) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Delete") {
      if (target === null) return;
      event.preventDefault();
      actions.onClose(target, pane, event.currentTarget);
      return;
    }
    const to = stepTo(event.key, strip.tabs.indexOf(pane), strip.tabs.length);
    if (to === null) return;
    event.preventDefault();
    const list = event.currentTarget.closest('[role="tablist"]');
    list?.querySelector<HTMLElement>(`[data-tab="${strip.tabs[to]}"]`)?.focus();
  };

  return (
    <div className="v2-frame-tabs" role="tablist" data-in={strip.classes.join(" ")}>
      {strip.tabs.map((tab) => {
        const selected = tab === strip.active;
        return (
          // The tab and its close control side by side: a control may not sit
          // inside another, so the pair is held by an element with no role.
          <span key={tab} className="v2-frame-tabitem" role="presentation">
            <button
              type="button"
              className="v2-frame-tab"
              role="tab"
              data-tab={tab}
              aria-selected={selected}
              aria-controls={frameId(tab)}
              tabIndex={selected ? 0 : -1}
              onClick={(event) => {
                if (target !== null) actions.onTab(target, tab, event.currentTarget);
              }}
              onKeyDown={(event) => onKeyDown(event, tab)}
            >
              {shortOf(tab)}
            </button>
            <button
              type="button"
              className="v2-frame-close"
              data-close={tab}
              aria-label={deskLine(DESK_COPY.closePane, { pane: titleOf(tab) })}
              title={deskLine(DESK_COPY.closePane, { pane: titleOf(tab) })}
              tabIndex={selected ? 0 : -1}
              onClick={(event) => {
                if (target !== null) actions.onClose(target, tab, event.currentTarget);
              }}
            />
          </span>
        );
      })}
    </div>
  );
}

/**
 * One pane on the desk: a header, then the box its body is drawn in.
 *
 * THE TITLE IS THE PANE'S ONE h2, always there, read and not seen. The section
 * and the scroller are both labelled by it, and the bodies' own headings are h3
 * under it, so the outline is the same whether the pane is alone or shares a
 * leaf. What is seen is a copy of it, or the leaf's tab strip in its place: the
 * two are chosen per class by desk.css, because the same pane can be in front
 * of a leaf of four on a laptop and alone on a big screen.
 *
 * THE HEADER'S CONTROLS. A strip's tabs bring a pane to the front (a click,
 * Enter or Space; the arrow keys, Home and End move along the strip; Delete
 * closes), and each tab has its close control. A pane alone in its leaf has a
 * close control by its title, except the last pane open. Maximize is a button
 * here and a double click on the header; while a pane fills the desk every
 * other frame is not shown, so it is inert. The pane menu (pane-menu.tsx) is
 * the tools' first control. Each control is drawn for the classes it applies
 * to (`data-in`), like the strips, and the class on screen is the one it acts
 * on. The tools are tiled only: a phone's frame has no header row.
 *
 * THE HEADER IS THE HANDLE. A press on its empty part or on the title may
 * become a drag of this pane, and a press on a tab one of that tab's pane; a
 * press on a control never does (use-dock-drag.ts). A drag starts only after
 * 6px of travel, so a click and a double click stay what they were.
 *
 * ONE SHAPE, ALWAYS. The header and the box are the section's two children
 * whatever the arrangement, so no change of layout, class or tab can change the
 * box's place and remount the body under it. The body is rendered through
 * `createElement` on the registry's own function for the id (the same function
 * every time), never as a tag on a local name and never called.
 *
 * A frame that is not displayed in the class the browser reports is also
 * `inert`, so nothing in it can take focus whatever a later style does. Once
 * the class is known, a frame a tab shows is that tab's panel.
 */
export function PaneFrame({
  frame,
  cls,
  desk,
  options,
  actions,
}: {
  frame: DeskFrame;
  cls: ScreenClass | null;
  /** The set on screen: the pane menu belongs to the one it was opened on. */
  desk: TileSet;
  options: Readonly<Record<string, string>>;
  actions: FrameActions;
}) {
  const { pane } = frame;
  const titleId = frameTitleId(pane.id);
  const stripIn = frame.strips.flatMap((strip) => strip.classes).join(" ");
  const tiled = tiledShown(frame);
  const maximizeTarget = tiledTarget(cls, tiled);
  const soloTarget = tiledTarget(cls, frame.soloClose);
  // Before the browser has said its class, regular's, as a body's options are.
  const pressedIn: ScreenClass = cls ?? "regular";
  const maximizedNow = frame.maximized.some((held) => held === pressedIn);
  const panel = cls !== null && frame.panelIn.includes(cls);

  const onDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('button, [role="menu"]') !== null) return;
    const header = event.currentTarget;
    if (maximizeTarget === null) return;
    const button = header.querySelector<HTMLElement>(".v2-frame-max");
    actions.onMaximize(maximizeTarget, pane.id, button ?? header);
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const target = event.target as Element;
    const tab = target.closest<HTMLElement>(".v2-frame-tab");
    if (tab === null && target.closest(NOT_A_HANDLE) !== null) return;
    actions.onDragStart(tab?.dataset.tab ?? pane.id, event.nativeEvent, tab ?? event.currentTarget);
  };

  return (
    <section
      className="v2-frame"
      id={frameId(pane.id)}
      role={panel ? "tabpanel" : undefined}
      aria-labelledby={titleId}
      data-pane={pane.id}
      data-shown={frame.shown.join(" ")}
      inert={cls !== null && !frame.shown.includes(cls)}
      style={frameStyle(frame.boxes)}
    >
      <header className="v2-frame-head" onDoubleClick={onDoubleClick} onPointerDown={onPointerDown}>
        <h2 className="v2-hidden" id={titleId}>
          {pane.title}
        </h2>
        <p className="v2-frame-name" aria-hidden="true" data-strip={stripIn === "" ? undefined : stripIn}>
          {pane.title}
        </p>
        {frame.strips.map((strip) => (
          <TabStrip
            key={strip.classes.join(" ")}
            strip={strip}
            cls={cls}
            actions={actions}
          />
        ))}
        <span className="v2-frame-tools" data-in={tiled.join(" ")}>
          <PaneMenu
            paneId={pane.id}
            title={pane.title}
            target={menuTarget(cls, frame)}
            desk={desk}
            itemsFor={(on) => actions.menuItems(on, pane.id)}
            onPick={(on, item, button) => actions.onMenu(on, pane.id, item, button)}
          />
          {frame.soloClose.length > 0 && (
            <button
              type="button"
              className="v2-frame-close v2-frame-solo"
              data-in={frame.soloClose.join(" ")}
              aria-label={deskLine(DESK_COPY.closePane, { pane: pane.title })}
              title={deskLine(DESK_COPY.closePane, { pane: pane.title })}
              onClick={(event) => {
                if (soloTarget !== null) actions.onClose(soloTarget, pane.id, event.currentTarget);
              }}
            />
          )}
          <button
            type="button"
            className="v2-frame-max"
            aria-label={deskLine(DESK_COPY.maximizePane, { pane: pane.title })}
            title={deskLine(DESK_COPY.maximizePane, { pane: pane.title })}
            aria-pressed={maximizedNow}
            data-max={frame.maximized.join(" ")}
            onClick={(event) => {
              if (maximizeTarget !== null) actions.onMaximize(maximizeTarget, pane.id, event.currentTarget);
            }}
          />
        </span>
      </header>
      <PaneBox paneId={pane.id} labelledBy={titleId}>
        {createElement(paneBody(pane.id), { options })}
      </PaneBox>
    </section>
  );
}
