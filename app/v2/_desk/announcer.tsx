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
 *
 * THE SAME SENTENCE TWICE IS SAID TWICE. A region whose text does not change
 * is not read again, so "Status moved left." after "Status moved left." would
 * be silent. Each new sentence is put in a new node (two keys, alternating),
 * which the region hears as text added. Still one live region, and nothing
 * seen changes.
 */
export function Announcer({ desk = null }: { desk?: DeskSaid | null }) {
  // The day's `revision` advances with every press, so the day's sentence said
  // again (the same words) is a new sentence too, as a new desk object is.
  const { said, view, revision } = useDay();
  const [seen, setSeen] = useState<{
    said: string | null;
    revision: number;
    desk: DeskSaid | null;
    last: "day" | "desk";
    turn: number;
  }>({ said, revision, desk, last: "day", turn: 0 });
  let last = seen.last;
  let turn = seen.turn;
  if (seen.said !== said || seen.revision !== revision || seen.desk !== desk) {
    if (seen.desk !== desk && desk !== null) last = "desk";
    else if (seen.said !== said || seen.revision !== revision) last = "day";
    turn = seen.turn + 1;
    setSeen({ said, revision, desk, last, turn });
  }
  const text = last === "desk" && desk !== null ? desk.text : (said ?? view.energy.label);
  return (
    <p className="v2-hidden" role="status">
      <span key={turn % 2}>{text}</span>
    </p>
  );
}
