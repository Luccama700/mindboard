"use client";

import { createElement, type CSSProperties } from "react";

import {
  PANES,
  type CssBox,
  type PaneId,
  type PaneSpec,
  type ScreenClass,
} from "@/app/lib/v2/tiles";
import { PaneBox } from "./pane-box";
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
}

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
 * In this task the header has no controls: the strip says which panes share the
 * leaf and which is in front, and pressing it does nothing yet.
 *
 * ONE SHAPE, ALWAYS. The header and the box are the section's two children
 * whatever the arrangement, so no change of layout, class or tab can change the
 * box's place and remount the body under it. The body is rendered through
 * `createElement` on the registry's own function for the id (the same function
 * every time), never as a tag on a local name and never called.
 *
 * A frame that is not displayed in the class the browser reports is also
 * `inert`, so nothing in it can take focus whatever a later style does.
 */
export function PaneFrame({
  frame,
  cls,
  options,
}: {
  frame: DeskFrame;
  cls: ScreenClass | null;
  options: Readonly<Record<string, string>>;
}) {
  const { pane } = frame;
  const titleId = frameTitleId(pane.id);
  const stripIn = frame.strips.flatMap((strip) => strip.classes).join(" ");

  return (
    <section
      className="v2-frame"
      id={frameId(pane.id)}
      aria-labelledby={titleId}
      data-pane={pane.id}
      data-shown={frame.shown.join(" ")}
      inert={cls !== null && !frame.shown.includes(cls)}
      style={frameStyle(frame.boxes)}
    >
      <header className="v2-frame-head">
        <h2 className="v2-hidden" id={titleId}>
          {pane.title}
        </h2>
        <p className="v2-frame-name" aria-hidden="true" data-strip={stripIn === "" ? undefined : stripIn}>
          {pane.title}
        </p>
        {frame.strips.map((strip) => (
          <div
            key={strip.classes.join(" ")}
            className="v2-frame-tabs"
            role="tablist"
            data-in={strip.classes.join(" ")}
          >
            {strip.tabs.map((tab) => (
              <span
                key={tab}
                className="v2-frame-tab"
                role="tab"
                aria-selected={tab === strip.active}
              >
                {shortOf(tab)}
              </span>
            ))}
          </div>
        ))}
      </header>
      <PaneBox paneId={pane.id} labelledBy={titleId}>
        {createElement(paneBody(pane.id), { options })}
      </PaneBox>
    </section>
  );
}
