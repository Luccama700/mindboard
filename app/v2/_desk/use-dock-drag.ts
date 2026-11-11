// Drag to dock: pick a pane up by its header or its tab and put it against
// another, or make it one of the other's tabs.
//
// A PRESS STAYS A PRESS until it has travelled 6px, mouse and pen only. A click
// on a tab still brings it forward and a double click on the header still
// maximizes, because neither travels. A press on a control in the header (the
// menu, close, maximize, a tab's close) never starts one (pane-frame.tsx), and
// nothing drags on a touch screen, whose way to arrange is the pane menu's
// keyboard twin and, on the phone, the list.
//
// UP. The stage carries `data-dock` (the pane carried; not `data-drag`, which is
// a divider's), the carried frame `data-lifted` (it dims), and the handle holds
// the pointer. The zone under the pointer is the engine's: `zoneAt` on
// `layoutTree`'s rectangle for the workspace the stage COMPUTED, with the
// pointer's offset from the stage's own box. The overlay sits on `zoneRect`
// with the words of `TILE_COPY.zone` and the target's title, and only for a
// drop that changes something: its own leaf, or a zone the engine answers
// with the same object, shows nothing. It moves between zones by fading in
// again, quickly; it never slides after the pointer.
//
// DOWN. A release over a zone is one `move` (`movePane`) through the desk's
// commit, so it glides like a pick from the pane menu. It is worked out again
// at the release, on the desk as it is then, and carries its layout and class:
// the reducer refuses it on any other.
//
// A DRAG CAN DIE, AND LEAVES NOTHING BEHIND. Escape, a release outside every
// pane, a cancelled pointer, a lost capture, a move with no button held, the
// next press anywhere, a change of layout or class under it, and unmounting
// all end it, and every one of those takes the attribute, the dimming, the
// overlay, the capture and every listener off. Only a key that does something
// ends it: Escape. A modifier pressed on its own never does. After a drag that
// was up, the click its release makes is swallowed, so a tab let go after a
// drag is not pressed too.

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import {
  PANES,
  TILE_COPY,
  arrangementOf,
  layoutTree,
  leafOf,
  leavesOf,
  zoneAt,
  zoneRect,
  type LayoutId,
  type PaneId,
  type Rect,
  type ScreenClass,
  type TileSet,
  type Workspace,
  type Zone,
} from "@/app/lib/v2/tiles";
import { DESK_COPY, deskLine } from "@/app/lib/v2/view/desk";
import { measureWorkspace } from "./divider";
import { mayMove, playOn, readTimes } from "./flip";
import { tilesReducer, type TilesAction, type TilesState } from "./use-tiles";

/**
 * The overlay and its line of words: made on the stage when a pane is lifted,
 * and taken off when the drag ends, so the stage at rest is what it always was.
 */
export const DOCK_CLASS = "v2-dock";
export const DOCK_WORDS_CLASS = "v2-dock-words";
/** On the stage while a pane is carried: the pane's id. */
export const DOCK_ATTRIBUTE = "data-dock";
/** On the carried pane's frame. */
export const LIFTED_ATTRIBUTE = "data-lifted";
/** How far a press travels before it is a drag. */
export const DOCK_THRESHOLD = 6;

type TiledClass = "regular" | "wide";
type MoveAction = Extract<TilesAction, { type: "move" }>;

/** What a release here would do. */
export interface DockTarget {
  leafId: string;
  zone: Zone;
  /** The pane in front of the leaf dropped on: what the words name. */
  over: PaneId;
  /** The part of the leaf the drop takes, in the workspace's pixels. */
  box: Rect;
  /** The overlay's line: TILE_COPY.zone and the target's title. */
  words: string;
  /** The live region's sentence once it is done. */
  said: string;
  action: MoveAction;
}

const DOCKED: Record<Exclude<Zone, "centre">, string> = {
  left: DESK_COPY.paneDockedLeft,
  right: DESK_COPY.paneDockedRight,
  top: DESK_COPY.paneDockedTop,
  bottom: DESK_COPY.paneDockedBottom,
};

function titleOf(pane: PaneId): string {
  return PANES.find((spec) => spec.id === pane)?.title ?? pane;
}

function isTiled(cls: ScreenClass | null): cls is TiledClass {
  return cls === "regular" || cls === "wide";
}

/**
 * The drop at a point of the workspace (its own pixels, from its top left), for
 * one pane of the layout on screen on one tiled class, or null when a release
 * there changes nothing: no displayed leaf under it (a gap, outside), the
 * pane's own leaf, a pane that is not open, or a zone the engine answers with
 * the same object. Under a maximize only the leaf that fills the desk is drawn,
 * so it is the only one dropped on.
 */
export function dockTarget(
  set: TileSet,
  cls: TiledClass,
  pane: PaneId,
  workspace: Workspace,
  x: number,
  y: number,
): DockTarget | null {
  const arrangement = arrangementOf(set, set.current, cls);
  const tree = arrangement.tree;
  const own = leafOf(tree, pane);
  if (own === null) return null;
  const rects = layoutTree(arrangement, workspace);
  const filled = arrangement.maximized === null ? null : leafOf(tree, arrangement.maximized);
  const drawn = filled === null ? rects.leaves : rects.leaves.filter((rect) => rect.leafId === filled.id);
  const rect = drawn.find((candidate) => x >= candidate.x && x < candidate.x + candidate.w && y >= candidate.y && y < candidate.y + candidate.h);
  if (rect === undefined || rect.leafId === own.id) return null;
  const over = leavesOf(tree).find((leaf) => leaf.id === rect.leafId)?.active;
  if (over === undefined) return null;
  const zone = zoneAt(rect, x, y);
  const action: MoveAction = { type: "move", cls, pane, leafId: rect.leafId, zone, layout: set.current };
  const state: TilesState = { set, cls };
  if (tilesReducer(state, action) === state) return null;
  const names = { pane: titleOf(pane), first: titleOf(over) };
  return {
    leafId: rect.leafId,
    zone,
    over,
    box: zoneRect(rect, zone),
    words: `${TILE_COPY.zone[zone]} ${titleOf(over)}`,
    said: deskLine(zone === "centre" ? DESK_COPY.paneTabbed : DOCKED[zone], names),
    action,
  };
}

function sameTarget(a: DockTarget | null, b: DockTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.leafId === b.leafId &&
    a.zone === b.zone &&
    a.box.x === b.box.x &&
    a.box.y === b.box.y &&
    a.box.w === b.box.w &&
    a.box.h === b.box.h &&
    a.words === b.words
  );
}

/** One drag, from the press that began it. */
interface Held {
  /** The press itself: the document's own press listener lets this one pass. */
  start: Event;
  pointerId: number;
  pane: PaneId;
  cls: TiledClass;
  layout: LayoutId;
  /** Where the press was, in the window's pixels. */
  x: number;
  y: number;
  handle: HTMLElement;
  /** Held here, not read from the ref, so an unmount can still clean it. */
  stage: HTMLElement;
  /** Past the threshold: the pane is up. */
  up: boolean;
  frame: HTMLElement | null;
  /** Where it would land: on the stage only while the pane is up. */
  overlay: HTMLElement | null;
  target: DockTarget | null;
  fade: Animation | null;
  /** Takes every listener this drag added off again. */
  detach(): void;
}

/** What the desk hands the drag: the stage, the layout and class on screen, the desk as last committed, and the drop. */
export interface DockOptions {
  stage: RefObject<HTMLDivElement | null>;
  layout: LayoutId;
  cls: ScreenClass | null;
  now(): { set: TileSet; cls: ScreenClass | null };
  onDrop(target: DockTarget): void;
}

/**
 * The click a release makes after a drag that was up, swallowed before anything
 * hears it. Taken off at the next press, or after this task, so it can never
 * eat a later click.
 */
function swallowNextClick(): void {
  const swallow = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    disarm();
  };
  const disarm = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerdown", disarm, true);
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerdown", disarm, true);
  window.setTimeout(disarm, 0);
}

/**
 * The same, for a drag ended while its button is still held (Escape): the
 * release, and the click it makes, come later, so the swallow is armed when
 * that pointer is let go. A new press first takes it off.
 */
function swallowClickAfterRelease(pointerId: number): void {
  const onRelease = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    disarm();
    swallowNextClick();
  };
  const disarm = () => {
    window.removeEventListener("pointerup", onRelease, true);
    window.removeEventListener("pointerdown", disarm, true);
  };
  window.addEventListener("pointerup", onRelease, true);
  window.addEventListener("pointerdown", disarm, true);
}

/** The overlay, made for one drag: hidden by the sheet until it is aimed. */
function makeOverlay(stage: HTMLElement): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = DOCK_CLASS;
  overlay.setAttribute("aria-hidden", "true");
  const words = document.createElement("span");
  words.className = DOCK_WORDS_CLASS;
  overlay.append(words);
  stage.append(overlay);
  return overlay;
}

/** The overlay aimed at nothing: not drawn, nothing written on it. */
function clearOverlay(overlay: HTMLElement): void {
  overlay.removeAttribute("data-zone");
  overlay.removeAttribute("data-target");
  for (const side of ["left", "top", "width", "height"] as const) overlay.style[side] = "";
  const words = overlay.querySelector(`.${DOCK_WORDS_CLASS}`);
  if (words !== null) words.textContent = "";
}

/** The frame of one pane among the stage's own children, matched by its data, not by a selector. */
function frameOf(stage: HTMLElement, pane: PaneId): HTMLElement | null {
  for (const child of Array.from(stage.children)) {
    if (child instanceof HTMLElement && child.matches("section.v2-frame") && child.dataset.pane === pane) return child;
  }
  return null;
}

export function useDockDrag(options: DockOptions): {
  start(pane: PaneId, event: PointerEvent, handle: HTMLElement): void;
} {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const held = useRef<Held | null>(null);

  /** Ends the drag, if there is one, without a drop, and takes off everything it wrote. */
  const finish = useCallback((): void => {
    const record = held.current;
    if (record === null) return;
    held.current = null;
    record.detach();
    record.fade?.cancel();
    try {
      if (record.handle.hasPointerCapture?.(record.pointerId)) record.handle.releasePointerCapture(record.pointerId);
    } catch {
      // The pointer is gone already: nothing is held.
    }
    record.stage.removeAttribute(DOCK_ATTRIBUTE);
    record.frame?.removeAttribute(LIFTED_ATTRIBUTE);
    record.overlay?.remove();
    record.overlay = null;
  }, []);

  /** The overlay on what a release at this window point would do, faded in when that changes. */
  const aim = useCallback((record: Held, set: TileSet, x: number, y: number) => {
    const box = record.stage.getBoundingClientRect();
    const workspace = measureWorkspace(record.stage, record.cls);
    const target =
      workspace === null ? null : dockTarget(set, record.cls, record.pane, workspace, x - box.left, y - box.top);
    if (sameTarget(record.target, target)) return;
    record.target = target;
    record.fade?.cancel();
    record.fade = null;
    const overlay = record.overlay;
    if (overlay === null) return;
    if (target === null) {
      clearOverlay(overlay);
      return;
    }
    overlay.style.left = `${target.box.x}px`;
    overlay.style.top = `${target.box.y}px`;
    overlay.style.width = `${target.box.w}px`;
    overlay.style.height = `${target.box.h}px`;
    overlay.setAttribute("data-zone", target.zone);
    overlay.setAttribute("data-target", target.over);
    const words = overlay.querySelector(`.${DOCK_WORDS_CLASS}`);
    if (words !== null) words.textContent = target.words;
    if (!mayMove(record.stage)) return;
    const times = readTimes(record.stage);
    record.fade = playOn(overlay, [{ opacity: 0 }, { opacity: 1 }], {
      duration: times.quick,
      easing: times.ease,
      fill: "backwards",
    });
  }, []);

  const start = useCallback(
    (pane: PaneId, event: PointerEvent, handle: HTMLElement) => {
      // A drag still recorded is stale (its release was missed): it ends here,
      // without a drop, and this press starts afresh.
      finish();
      if (event.button !== 0 || !event.isPrimary) return;
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      const { stage, now } = latest.current;
      const element = stage.current;
      const { set, cls } = now();
      if (element === null || !isTiled(cls)) return;
      if (leafOf(arrangementOf(set, set.current, cls).tree, pane) === null) return;

      const record: Held = {
        start: event,
        pointerId: event.pointerId,
        pane,
        cls,
        layout: set.current,
        x: event.clientX,
        y: event.clientY,
        handle,
        stage: element,
        up: false,
        frame: null,
        overlay: null,
        target: null,
        fade: null,
        detach: () => {},
      };

      const stillOurs = (): { set: TileSet } | null => {
        const desk = latest.current.now();
        return desk.set.current === record.layout && desk.cls === record.cls ? desk : null;
      };

      const onLost = (lost: Event) => {
        if ((lost as PointerEvent).pointerId === record.pointerId) finish();
      };

      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== record.pointerId) return;
        // No button held: the release was missed somewhere.
        if (move.buttons === 0) {
          finish();
          return;
        }
        const desk = stillOurs();
        if (desk === null) {
          finish();
          return;
        }
        if (!record.up) {
          if (Math.hypot(move.clientX - record.x, move.clientY - record.y) < DOCK_THRESHOLD) return;
          record.up = true;
          record.stage.setAttribute(DOCK_ATTRIBUTE, record.pane);
          record.frame = frameOf(record.stage, record.pane);
          record.frame?.setAttribute(LIFTED_ATTRIBUTE, "");
          record.overlay = makeOverlay(record.stage);
          try {
            record.handle.setPointerCapture?.(record.pointerId);
          } catch {
            // A pointer the browser no longer knows: the document still hears it.
          }
          record.handle.addEventListener("lostpointercapture", onLost);
          window.getSelection?.()?.removeAllRanges();
        }
        aim(record, desk.set, move.clientX, move.clientY);
      };

      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== record.pointerId) return;
        if (!record.up) {
          finish();
          return;
        }
        // Worked out again where it was let go, on the desk as it is now.
        const desk = stillOurs();
        const workspace = desk === null ? null : measureWorkspace(record.stage, record.cls);
        const box = record.stage.getBoundingClientRect();
        const target =
          desk === null || workspace === null
            ? null
            : dockTarget(desk.set, record.cls, record.pane, workspace, up.clientX - box.left, up.clientY - box.top);
        finish();
        swallowNextClick();
        if (target !== null) latest.current.onDrop(target);
      };

      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === record.pointerId) finish();
      };

      // Only a key that does something ends it: Escape, on a pane that is up. A
      // modifier alone never does, and a press that has not travelled is still a
      // press, whose keys are its page's.
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !record.up) return;
        key.preventDefault();
        key.stopPropagation();
        finish();
        swallowClickAfterRelease(record.pointerId);
      };

      // Any other press while this one is recorded ends it.
      const onPress = (press: Event) => {
        if (press !== record.start) finish();
      };

      record.detach = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        document.removeEventListener("pointerdown", onPress);
        document.removeEventListener("keydown", onKey, true);
        record.handle.removeEventListener("lostpointercapture", onLost);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
      document.addEventListener("pointerdown", onPress);
      document.addEventListener("keydown", onKey, true);
      held.current = record;
    },
    [finish, aim],
  );

  // A change of layout or class under a drag ends it: it belongs to the one it
  // started on, and never lands on another.
  const { layout, cls } = options;
  useEffect(() => {
    const record = held.current;
    if (record !== null && (record.layout !== layout || record.cls !== cls)) finish();
  }, [layout, cls, finish]);

  // Unmounting ends it, and takes everything it wrote off the stage.
  useEffect(() => finish, [finish]);

  return { start };
}
