"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { TODAY_COPY, type Stop, type TodayView } from "@/app/lib/v2/view/today";
import { useAppearance } from "./appearance-root";
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
  focusToken,
  onStart,
  onDone,
  onSkip,
  headingLevel = 2,
}: {
  stops: TodayView["stops"];
  litStopId: string | null;
  /** The sample clock, as HH:MM. */
  clock: string;
  /** Block ids the planner gave a new time in the replan that just happened. */
  movedIds: ReadonlySet<string>;
  /** Which replan that was, so a block that moves twice flashes twice. */
  revision: number;
  /**
   * Counts the presses that unmounted their own button. A change means the
   * control the user was on has gone, so the lit card takes focus and their
   * place is kept. It must NOT count anything else: see the effect below.
   */
  focusToken: number;
  onStart: (blockId: string) => void;
  onDone: (blockId: string) => void;
  onSkip: (blockId: string) => void;
  /** The line's read, not seen heading: 2 on Today, 3 inside a frame of the desk, whose title is the h2. */
  headingLevel?: 2 | 3;
}) {
  const still = useReducedMotion() === true;
  const moves = still ? undefined : ("position" as const);
  // A stop's identity colour is the user's data and the scheme is the user's
  // choice, so what a stop paints is a function of both: see stopStyle.
  const { tokens } = useAppearance();

  // Focus belongs to one effect, keyed on the token and on NOTHING else.
  //
  // The token counts the presses that unmounted their own button, so a change in
  // it means "the control the user was on has gone, keep their place". An
  // earlier version lived in each card and also watched `lit`, which looked
  // equivalent and was not: once any press had happened the token stayed above
  // zero, so a later energy press that happened to light a different card
  // flipped that card's `lit` to true and the card took focus off the energy
  // button. Depending on the token alone makes that impossible rather than
  // unlikely.
  //
  // The ref is what stops the mount run from firing: it starts at whatever the
  // token already is, so the first render (and a remount mid session) focuses
  // nothing. The heading is found in the DOM rather than held in a ref, because
  // a ref that attaches on one card while detaching from another is a question
  // about commit order, and a query after the commit is not.
  //
  // Exactly one marker is a condition, not an assumption, and two of them is a
  // state this screen really reaches: a leaving row stays mounted for its exit
  // rendering the props it had, so an energy press that drops the lit block
  // leaves the old marker beside the new one for 140ms. The token does not move
  // on an energy press, so the effect is not running then; if that ever changes,
  // focus stays where the user put it rather than landing on a row that is on
  // its way out.
  const list = useRef<HTMLOListElement | null>(null);
  const handled = useRef(focusToken);
  useEffect(() => {
    if (focusToken === handled.current) return;
    handled.current = focusToken;
    const marked = list.current?.querySelectorAll<HTMLElement>("[data-lit-heading]");
    if (marked !== undefined && marked.length === 1) marked[0].focus();
  }, [focusToken]);

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
        // The identity goes on the li, not on the card inside it: the rail and
        // the dot are this element's own pseudo elements, so they can only read
        // a variable set here. The card inherits it.
        style={stopStyle(stop, tokens)}
        layout={moves}
        initial={still ? false : { opacity: 0, x: 28 }}
        animate={{ opacity: 1, x: 0 }}
        // pointerEvents on the way out because AnimatePresence keeps a leaving
        // row mounted until its exit finishes: for those 140ms its buttons are
        // still the old plan's, and a second tap would reach a block that is no
        // longer on the day.
        // Under reduced motion the row goes at once: a zero duration lets
        // AnimatePresence unmount it on the spot instead of holding its space
        // for an animation that is not running.
        exit={
          still
            ? { opacity: 1, pointerEvents: "none", transition: { duration: 0 } }
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

  // The section exists for its heading: the page is h1 (the day) and the stops
  // are h3, so without an h2 between them the heading order skips a level. It is
  // read, not seen.
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section aria-labelledby="v2-line-heading">
      <Heading className="v2-hidden" id="v2-line-heading">
        {TODAY_COPY.line}
      </Heading>
      <ol className="v2-line" ref={list}>
        {/* The default mode on purpose: a leaving stop keeps its space until it
            is gone, and the rows below it then slide up through their own layout
            animation. popLayout would take it out of flow and position it
            against the nearest positioned ancestor, which is the whole frame. */}
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </ol>
    </section>
  );
}
