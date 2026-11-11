"use client";

import { useDay } from "../_components/day-provider";

/**
 * The desk's one live region, outside every pane. A press on Start, Done or Not
 * today unmounts the button that was pressed, so this sentence is the only
 * confirmation a keyboard or screen reader user gets; between presses it falls
 * back to the energy the plan ran on, as Today's and the gallery's do. Read,
 * not seen: the status pane prints the same sentence when it is on screen.
 */
export function Announcer() {
  const { said, view } = useDay();
  return (
    <p className="v2-hidden" role="status">
      {said ?? view.energy.label}
    </p>
  );
}
