"use client";

import type { CSSProperties } from "react";

import { identityTokens } from "@/app/lib/v2/view/appearance";
import { STOP_STATUS_COPY, TODAY_COPY, type Stop } from "@/app/lib/v2/view/today";

/**
 * A stop's colours, as data.
 *
 * A lane is a per-user row and a group colour is a per-task one, so there is no
 * class per colour: this goes on the stop's own `li`, where the rail and the dot
 * (drawn as its pseudo elements) can read it, and the card inside inherits it.
 *
 * The four tokens come from `identityTokens`, which needs the ACTIVE SCHEME:
 * what the user chose may be a colour that cannot be read on the scheme that is
 * on, and which lift fixes that is arithmetic rather than a constant. The lit
 * card's fill is computed there too, rather than with color-mix here, so the
 * surface the label's contrast was measured against is the surface that is
 * painted.
 */
export function stopStyle(stop: Stop, tokens: Record<string, string>): CSSProperties {
  return identityTokens(stop.identity?.color ?? null, tokens) as CSSProperties;
}

/** One stop on the line. The lit one is the same row, wearing a filled card. */
export function StopCard({
  stop,
  lit,
  moved,
  revision,
  onStart,
  onDone,
  onSkip,
}: {
  stop: Stop;
  lit: boolean;
  /** The planner gave this block a new time in the replan that just happened. */
  moved: boolean;
  /** Which replan that was, so a block that moves twice flashes twice. */
  revision: number;
  onStart: (blockId: string) => void;
  onDone: (blockId: string) => void;
  onSkip: (blockId: string) => void;
}) {
  const when = stop.state === "now" ? TODAY_COPY.now : TODAY_COPY.nextStop;
  const tag = STOP_STATUS_COPY[stop.state];
  // A fixed event is not the planner's to start, finish or move, so it carries
  // no actions: the only thing to say about it is when to leave.
  const actionable = lit && stop.source === "block";

  // The quiet line of identity: the name of the group this task lives in, in
  // that group's colour. A lane is NOT printed, because a lane is the planner's
  // own grouping rather than a name the user gave this task, and the colour on
  // the line already says which lane it is.
  const identity = stop.identity?.source === "tag" ? stop.identity.label : null;

  // A time that changed gets a flash, because `layout` only animates a stop that
  // changed PLACE: a block that keeps its position and moves by twenty minutes
  // would otherwise change in silence. The key is what replays it: a CSS
  // animation does not restart on an attribute change, so the node is recreated.
  const flash = moved ? "v2-moved" : undefined;
  const flashKey = moved ? `moved-${revision}` : "still";

  if (lit) {
    return (
      <div className="v2-lit">
        <p className={`v2-when ${flash ?? ""}`.trim()} key={flashKey}>
          {when}, {stop.start}
        </p>
        {/* The thing DayLine moves focus to after a press. It is marked rather
            than ref'd from here: whose turn it is to hold focus is a decision
            about the whole line, so one effect up there owns it (see day-line).
            A card deciding for itself is how focus ended up being taken off the
            energy control whenever a replan lit a different card. */}
        <h3 data-lit-heading tabIndex={-1} title={stop.full}>
          {stop.title}
        </h3>
        {/* A real title keeps its detail in a trailing parenthetical, which as
            one line of display type ran to five lines on a phone. The detail is
            quiet text under the name, clamped, with the whole original string on
            both elements so a hover still has all of it. */}
        {stop.detail !== null && (
          <p className="v2-detail" title={stop.full}>
            {stop.detail}
          </p>
        )}
        {identity !== null && <p className="v2-ident">{identity}</p>}
        {stop.reason !== "" && <p>{stop.reason}</p>}
        {stop.leaveBy !== null && <p className="v2-leave">{stop.leaveBy}</p>}
        {actionable && (
          <div className="v2-acts">
            {stop.state === "next" && (
              <button type="button" className="v2-go" onClick={() => onStart(stop.id)}>
                {TODAY_COPY.start}
              </button>
            )}
            <button
              type="button"
              className={stop.state === "next" ? "v2-quiet" : "v2-go"}
              onClick={() => onDone(stop.id)}
            >
              {TODAY_COPY.done}
            </button>
            <button type="button" className="v2-quiet" onClick={() => onSkip(stop.id)}>
              {TODAY_COPY.notToday}
            </button>
          </div>
        )}
      </div>
    );
  }

  // A skipped stop keeps its row in start order but gives up its dot and its
  // detail: the planner has freed that time, so another stop may be placed over
  // the same minutes, and two full stops at one point on the line would read as
  // a contradiction. One struck line, and the reason it is gone, is enough.
  if (stop.state === "skipped") {
    return (
      <>
        <time title={`${stop.start} to ${stop.end}`}>{stop.start}</time>
        <div>
          <h3 title={stop.full}>{stop.title}</h3>{" "}
          <span className="v2-tag">{tag}</span>
        </div>
      </>
    );
  }

  return (
    <>
      <time className={flash} key={flashKey} title={`${stop.start} to ${stop.end}`}>
        {stop.start}
      </time>
      <div>
        <h3 title={stop.full}>{stop.title}</h3>
        {stop.detail !== null && (
          <p className="v2-detail" title={stop.full}>
            {stop.detail}
          </p>
        )}
        {identity !== null && <p className="v2-ident">{identity}</p>}
        {stop.reason !== "" && <p>{stop.reason}</p>}
        {stop.leaveBy !== null && <p className="v2-leave">{stop.leaveBy}</p>}
        {tag !== "" && <span className="v2-tag">{tag}</span>}
      </div>
    </>
  );
}
