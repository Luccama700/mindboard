"use client";

import {
  QUESTS_COPY,
  laneDueLabel,
  laneOpenLabel,
  questPastLabel,
  type QuestLane,
} from "@/app/lib/v2/view/quests";
import {
  NoQuests,
  QUEST_DEFAULT_SPAN,
  QuestsNote,
  WhenMark,
  WorkedMark,
  useIdentityStyle,
  useQuestsView,
} from "./quest-row";

/**
 * Every lane of the user, in their order, with its next stop: the map of the
 * long running work. The next stop is the one thing this pane exists to say, so
 * its title is the brightest text in the row; the lane's name carries its colour
 * as a mark, and the count and the date are quieter.
 *
 * THE COUNT AND THE DATE ARE TODAY'S OWN WORDS on the same numbers (the view
 * gets both by calling Today's lane line), so the Status pane and this one can
 * never read one lane two ways on one desk.
 *
 * A QUIET LANE SAYS NOTHING. Nothing open and nothing finished lately: its name,
 * in the dim ink, and no number, no date, no empty place for a stop.
 *
 * NO ZEROS, AND NO SECOND COUNT OF WHAT WAS FINISHED. A lane with nothing open
 * that did finish something lately is not quiet, so it keeps its card and the
 * normal ink, but it prints its name alone: never "0 open", and no finished
 * count either, because that would be counted over a window of its own beside
 * Done lately's, which counts over the span the user picked. One fact, one
 * number, and Done lately has it.
 *
 * By the pane's own width (quests.css): under 300px a lane is its name, its
 * count and its next date; from 300px its next stop and what is past its date
 * join it; from 520px the stop sits beside the name, on a track every lane
 * shares. Nothing on a row presses: panes do not talk to each other yet.
 */
export function LanesPane() {
  const view = useQuestsView(QUEST_DEFAULT_SPAN);
  if (view === null) return <NoQuests />;
  if (view.lanes.length === 0) return <QuestsNote text={QUESTS_COPY.noLanes} />;

  return (
    <div className="v2-quests v2-quests-lanes">
      <ul className="v2-quests-lane-list" role="list">
        {view.lanes.map((lane) => (
          <LaneRow key={lane.key} lane={lane} />
        ))}
      </ul>
    </div>
  );
}

function LaneRow({ lane }: { lane: QuestLane }) {
  const style = useIdentityStyle(lane.color);
  if (lane.quiet) {
    return (
      <li className="v2-quests-lane" data-quiet="" style={style}>
        <span className="v2-quests-lane-name">{lane.label}</span>
      </li>
    );
  }

  const { next } = lane;
  return (
    <li className="v2-quests-lane" style={style}>
      <span className="v2-quests-lane-name">{lane.label}</span>{" "}
      {next !== null && (
        <p
          className="v2-quests-next"
          data-when={next.when}
          data-worked={next.worked ? "" : undefined}
        >
          {/* Read, not seen: beside the lane's name, the place says it. */}
          <span className="v2-hidden">{QUESTS_COPY.next}</span>{" "}
          <b className="v2-quests-next-title" title={next.title}>
            {next.title}
          </b>{" "}
          <WhenMark when={next.when} /> {next.worked && <WorkedMark />}
        </p>
      )}{" "}
      {lane.open > 0 && (
        <p className="v2-quests-lane-meta">
          <span className="v2-quests-lane-open">{laneOpenLabel(lane.open)}</span>{" "}
          {lane.due !== null && <span className="v2-quests-lane-due">{laneDueLabel(lane.due)}</span>}{" "}
          {lane.past > 0 && <span className="v2-quests-lane-past">{questPastLabel(lane.past)}</span>}
        </p>
      )}
    </li>
  );
}
