"use client";

import { useState } from "react";

import { useDay } from "../_components/day-provider";

/** One sentence the desk says about itself. A new object for every time it is said. */
export interface DeskSaid {
  text: string;
}

/**
 * The desk's one live region, outside every pane.
 *
 * TWO SPEAKERS, THE LATEST WINS. A press on Start, Done or Not today unmounts
 * the button that was pressed, so the day's sentence is the only confirmation a
 * keyboard or screen reader user gets; a close, an open or a maximize on the
 * desk is said here the same way, in one short sentence from DESK_COPY. Which
 * one is spoken is whichever changed last; between both, it falls back to the
 * energy the plan ran on, as Today's and the gallery's do. Read, not seen: the
 * status pane prints the day's sentence when it is on screen.
 *
 * Which changed last is kept as state from the previous render (React's own
 * pattern for it), so nothing here runs an effect.
 */
export function Announcer({ desk = null }: { desk?: DeskSaid | null }) {
  const { said, view } = useDay();
  const [seen, setSeen] = useState<{ said: string | null; desk: DeskSaid | null; last: "day" | "desk" }>(
    { said, desk, last: "day" },
  );
  let last = seen.last;
  if (seen.said !== said || seen.desk !== desk) {
    if (seen.desk !== desk && desk !== null) last = "desk";
    else if (seen.said !== said) last = "day";
    setSeen({ said, desk, last });
  }
  const text = last === "desk" && desk !== null ? desk.text : (said ?? view.energy.label);
  return (
    <p className="v2-hidden" role="status">
      {text}
    </p>
  );
}
