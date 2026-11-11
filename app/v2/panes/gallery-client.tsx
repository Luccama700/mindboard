"use client";

import { createElement } from "react";

// Type only, so no source and no loader reaches the browser through here: the
// page loads the desk and hands the plain shape down.
import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";
import { galleryLine } from "@/app/lib/v2/view/desk";
import { DayProvider, useDay } from "../_components/day-provider";
import { DeskDataProvider } from "../_desk/desk-data-provider";
import { PaneBox } from "../_desk/pane-box";
import { paneBody } from "../_desk/pane-registry";

/** Where the gallery lives, so a link inside a pane comes back to it. */
const GALLERY_PATH = "/v2/panes";

/**
 * One pane, alone, in a box of exactly the size asked for: how a pane is looked
 * at before the desk around it exists.
 *
 * The providers are the desk's own: the whole desk's data, and the day keyed on
 * the planned day, as Today's page keys its screen. So a week link (the same
 * day, another week) keeps every press made in the pane, and another planned
 * day starts it again.
 *
 * The body is rendered as a component, never called as a function: `paneBody`
 * answers the same function for the same id, so a re-render keeps the body
 * mounted and its own state (a list's Show more) with it.
 */
export function GalleryClient({
  data,
  paneId,
  width,
  height,
  options,
  keep,
}: {
  data: DeskScreenData;
  paneId: string;
  width: number;
  height: number;
  options: Readonly<Record<string, string>>;
  keep: Readonly<Record<string, string>>;
}) {
  return (
    <DeskDataProvider data={data} keep={keep} basePath={GALLERY_PATH}>
      <DayProvider key={data.today.input.date} data={data.today}>
        <main className="v2-gallery">
          <p className="v2-gallery-line">{galleryLine(paneId, width, height)}</p>
          <GalleryStatus />
          <PaneBox paneId={paneId} style={{ width, height }}>
            {/* createElement rather than a tag on a local name: the lint rule
                cannot see that `paneBody` hands back a component declared once
                at module scope (the same function for the same id, which the
                gallery's test pins), so a tag would read to it as a component
                made during render. Nothing is: the body keeps its state. */}
            {createElement(paneBody(paneId), { options })}
          </PaneBox>
        </main>
      </DayProvider>
    </DeskDataProvider>
  );
}

/**
 * The page's one live region, outside the box. A press on Start, Done or Not
 * today unmounts the button that was pressed, so this sentence is the only
 * confirmation a keyboard or screen reader user gets; between presses it falls
 * back to the energy the plan ran on, as Today's does. Read, not seen: the
 * status pane prints the same sentence when it is the pane in the box.
 */
function GalleryStatus() {
  const { said, view } = useDay();
  return (
    <p className="v2-hidden" role="status">
      {said ?? view.energy.label}
    </p>
  );
}
