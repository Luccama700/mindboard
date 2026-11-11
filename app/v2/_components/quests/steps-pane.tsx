"use client";

import { useState } from "react";

import { QUESTS_COPY, type QuestItem, type QuestLane } from "@/app/lib/v2/view/quests";
import type { PaneBodyProps } from "../../_desk/pane-body";
import {
  NoQuests,
  QUEST_DEFAULT_SPAN,
  QuestRows,
  QuestsNote,
  useIdentityStyle,
  useQuestsView,
} from "./quest-row";

/**
 * The `group` option: "group" sets the rows under their identity label, and
 * anything else (absent, "none", a typo) is one list. Compared as a whole
 * string, never looked up by it.
 */
export function stepsGrouped(value: string | undefined): boolean {
  return value === "group";
}

/** Rows that share an identity, under its label: in the order their first row ranks. */
interface StepGroup {
  key: string;
  identity: QuestItem["identity"];
  items: QuestItem[];
}

/**
 * Arrangement only: the rows keep the view's order inside each group, and a
 * group comes where its first row comes. Never sorted by name, so the planner's
 * order still reads from the top of the pane.
 */
function groupSteps(items: readonly QuestItem[]): StepGroup[] {
  const groups: StepGroup[] = [];
  const byKey = new Map<string, StepGroup>();
  for (const item of items) {
    const identity = item.identity;
    const key = identity === null ? "" : `${identity.label}\u0000${identity.color}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, identity, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/**
 * The open steps of the lanes, in the planner's own order, each a row: its
 * title, its detail, what it belongs to, its date and where that date stands.
 *
 * THE ONE CONTROL ON THE QUESTS LAYOUT is the lane filter at the top: All, then
 * each lane that has steps, in the user's order. It is this pane's own state,
 * never saved and never sent to another pane. With fewer than two lanes to
 * choose from it is not drawn: it could change nothing.
 *
 * A step worked on today keeps its place and wears the phrase for it: a done
 * block is not a finished task.
 */
export function StepsPane({ options }: PaneBodyProps) {
  const view = useQuestsView(QUEST_DEFAULT_SPAN);
  const grouped = stepsGrouped(options.group);
  const [picked, setPicked] = useState<string | null>(null);
  if (view === null) return <NoQuests />;
  if (view.steps.length === 0) return <QuestsNote text={QUESTS_COPY.noSteps} />;

  const choices = view.lanes.filter((lane) => view.steps.some((item) => item.lane === lane.key));
  // A lane picked earlier that no longer has steps falls back to All here, in
  // the render, so the pane never shows an empty filter.
  const lane = picked !== null && choices.some((choice) => choice.key === picked) ? picked : null;
  const shown = lane === null ? view.steps : view.steps.filter((item) => item.lane === lane);

  return (
    <div className="v2-quests v2-quests-steps">
      {choices.length > 1 && (
        <div className="v2-quests-filter" role="group" aria-label={QUESTS_COPY.filterLabel}>
          <button
            type="button"
            className="v2-quests-chip"
            aria-pressed={lane === null}
            onClick={() => setPicked(null)}
          >
            {QUESTS_COPY.filterAll}
          </button>
          {choices.map((choice) => (
            <LaneChip
              key={choice.key}
              lane={choice}
              pressed={lane === choice.key}
              onPick={setPicked}
            />
          ))}
        </div>
      )}
      {grouped ? (
        groupSteps(shown).map((group) => <StepGroupBlock key={group.key} group={group} />)
      ) : (
        <QuestRows items={shown} />
      )}
    </div>
  );
}

function LaneChip({
  lane,
  pressed,
  onPick,
}: {
  lane: QuestLane;
  pressed: boolean;
  onPick: (key: string) => void;
}) {
  const style = useIdentityStyle(lane.color);
  return (
    <button
      type="button"
      className="v2-quests-chip"
      data-lane=""
      aria-pressed={pressed}
      style={style}
      onClick={() => onPick(lane.key)}
    >
      {lane.label}
    </button>
  );
}

function StepGroupBlock({ group }: { group: StepGroup }) {
  const style = useIdentityStyle(group.identity?.color ?? null);
  return (
    <div className="v2-quests-group" style={style}>
      {group.identity !== null && (
        <h3 className="v2-quests-group-head">{group.identity.label}</h3>
      )}
      <QuestRows items={group.items} named={false} />
    </div>
  );
}
