"use client";

import type { CSSProperties } from "react";

import {
  TODAY_COPY,
  laneDueLabel,
  laneOpenLabel,
  type TodayView,
} from "@/app/lib/v2/view/today";
import { identityTokens } from "@/app/lib/v2/view/appearance";
import { useAppearance } from "./appearance-root";

/**
 * What is waiting, lane by lane: the user's own name for it, how much of it, and
 * when the nearest of it closes. It is the answer to "what is this day leaving
 * alone", which the line of stops cannot give, and it is why the side column is
 * worth having on desktop.
 *
 * Desktop only. On the phone it would push the day down the screen, and the
 * phone screen's one job is the stop in hand.
 *
 * Each line wears its lane's colour as the same dot the line of stops uses, so
 * one colour vocabulary covers both. The last line, "No lane", has no colour of
 * its own and takes the neutral mark: in a real account half the open tasks
 * belong to no lane, and before that row they appeared nowhere on this screen.
 */
export function LaneSummary({
  lanes,
  headingLevel = 2,
}: {
  lanes: TodayView["lanes"];
  /** The heading's level: 2 on Today, 3 inside a frame of the desk, whose title is the h2. */
  headingLevel?: 2 | 3;
}) {
  const { tokens } = useAppearance();
  if (lanes.length === 0) return null;
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <section className="v2-side-block v2-desk-only" aria-labelledby="v2-lanes">
      <Heading className="v2-side-head" id="v2-lanes">
        {TODAY_COPY.lanesHeading}
      </Heading>
      <ul className="v2-lanes">
        {lanes.map((lane) => (
          <li
            key={lane.key}
            className="v2-lane-line"
            style={identityTokens(lane.color, tokens) as CSSProperties}
          >
            <span className="v2-lane-name">{lane.label}</span>
            <span className="v2-lane-count">{laneOpenLabel(lane.open)}</span>
            {lane.due !== null && (
              <span className="v2-lane-due">{laneDueLabel(lane.due)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
