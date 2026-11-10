"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { TODAY_COPY, type Stop, type TodayView } from "@/app/lib/v2/view/today";
import { StopCard, stopStyle } from "./stop-card";

/** The prototype's one easing and its three durations, in seconds for motion. */
const EASE = [0.2, 0, 0, 1] as const;
const QUICK = 0.14;
const STD = 0.28;
const SLOW = 0.52;

/** A stop still ahead of you, as opposed to one you are past or have settled. */
function isAhead(state: Stop["state"]): boolean {
  return state === "now" || state === "next" || state === "later";
}

/**
 * The day as one line. Stops keep their start order; the "you are here" clock
 * goes in front of the first one still ahead of you.
 *
 * Motion: a replan re-sorts the list, and every stop that moved slides to its
 * new place (`layout="position"`, so the lit card's change of size is not
 * animated into a stretch). A stop the planner added arrives from the right, one
 * it dropped leaves to the left. All of it stops when the system asks for
 * reduced motion, which also turns off the CSS transitions (see v2.css).
 *
 * Two details that are easy to get wrong:
 *   - the children go in ONE flat array. React prefixes the keys of a nested
 *     array by its position, so splitting the rows around the marker would
 *     change a row's key when the marker moves, and every move would read as a
 *     remove and an add instead.
 *   - `AnimatePresence initial={false}` is what keeps the FIRST render, server
 *     side included, at the settled state: it blocks the initial animation for
 *     the children that are there when it mounts, so motion renders them at
 *     their `animate` values instead of at `opacity: 0`. Without it the server
 *     would ship HTML whose every row is invisible until the JavaScript lands.
 *     Children added later are unaffected and do animate in.
 */
export function DayLine({
  stops,
  litStopId,
  clock,
  movedIds,
  revision,
  onStart,
  onDone,
  onSkip,
}: {
  stops: TodayView["stops"];
  litStopId: string | null;
  /** The sample clock, as HH:MM. */
  clock: string;
  /** Block ids the planner gave a new time in the replan that just happened. */
  movedIds: ReadonlySet<string>;
  /** Which replan that was, so a block that moves twice flashes twice. */
  revision: number;
  onStart: (blockId: string) => void;
  onDone: (blockId: string) => void;
  onSkip: (blockId: string) => void;
}) {
  const still = useReducedMotion() === true;
  const moves = still ? undefined : ("position" as const);

  const markerAt = stops.findIndex((stop) => isAhead(stop.state));
  const marker = markerAt < 0 ? stops.length : markerAt;

  const children: ReactNode[] = [];
  const markerRow = (
    <motion.li
      key="v2-you-are-here"
      className="v2-now"
      layout={moves}
      transition={{ duration: SLOW, ease: EASE }}
    >
      <em>{clock}</em>
      <span>{TODAY_COPY.youAreHere}</span>
    </motion.li>
  );

  stops.forEach((stop, index) => {
    if (index === marker) children.push(markerRow);
    children.push(
      <motion.li
        key={`${stop.source}:${stop.id}`}
        className="v2-stop"
        data-state={stop.state}
        data-lit={stop.id === litStopId ? "yes" : "no"}
        // The lane goes on the li, not on the card inside it: the rail and the
        // dot are this element's own pseudo elements, so they can only read a
        // variable set here. The card inherits it.
        style={stopStyle(stop)}
        layout={moves}
        initial={still ? false : { opacity: 0, x: 28 }}
        animate={{ opacity: 1, x: 0 }}
        // pointerEvents on the way out because AnimatePresence keeps a leaving
        // row mounted until its exit finishes: for those 140ms its buttons are
        // still the old plan's, and a second tap would reach a block that is no
        // longer on the day.
        exit={
          still
            ? { opacity: 1, pointerEvents: "none" }
            : {
                opacity: 0,
                x: -28,
                pointerEvents: "none",
                transition: { duration: QUICK, ease: EASE },
              }
        }
        transition={{
          layout: { duration: SLOW, ease: EASE },
          opacity: { duration: STD, ease: EASE },
          x: { duration: STD, ease: EASE },
        }}
      >
        <StopCard
          stop={stop}
          lit={stop.id === litStopId}
          moved={stop.source === "block" && movedIds.has(stop.id)}
          revision={revision}
          onStart={onStart}
          onDone={onDone}
          onSkip={onSkip}
        />
      </motion.li>,
    );
  });
  if (marker >= stops.length) children.push(markerRow);

  return (
    <ol className="v2-line" aria-label={TODAY_COPY.line}>
      {/* The default mode on purpose: a leaving stop keeps its space until it is
          gone, and the rows below it then slide up through their own layout
          animation. popLayout would take it out of flow and position it against
          the nearest positioned ancestor, which is the whole frame. */}
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </ol>
  );
}
