"use client";

import { useMemo } from "react";

import { QUESTS_COPY } from "@/app/lib/v2/view/quests";
import { useDeskData } from "../../_desk/desk-data-provider";
import type { PaneBodyProps } from "../../_desk/pane-body";
import { NoQuests, QUEST_DEFAULT_SPAN, QuestRows, QuestsNote, useQuestsView } from "./quest-row";

/**
 * The `sort` option: "added" is the order the source lists them in, and
 * anything else (absent, "clock", a typo) is the planner's own order. Compared
 * as a whole string, never looked up by it.
 */
export function sideSort(value: string | undefined): "clock" | "added" {
  return value === "added" ? "added" : "clock";
}

/**
 * What belongs to no lane, as the same rows the steps are drawn as. In the
 * planner's order by default; "added" puts them in the order the source lists
 * its candidates, which is arrangement only: every row and every word on it is
 * the view's.
 */
export function SideQuestsPane({ options }: PaneBodyProps) {
  const view = useQuestsView(QUEST_DEFAULT_SPAN);
  const { quests } = useDeskData();
  const sort = sideSort(options.sort);

  const items = useMemo(() => {
    if (view === null || quests === null || sort === "clock") return view?.side ?? [];
    const place = new Map(quests.input.candidates.map((candidate, index) => [candidate.id, index]));
    return [...view.side].sort((a, b) => (place.get(a.id) ?? 0) - (place.get(b.id) ?? 0));
  }, [view, quests, sort]);

  if (view === null) return <NoQuests />;
  if (items.length === 0) return <QuestsNote text={QUESTS_COPY.noSide} />;

  return (
    <div className="v2-quests v2-quests-side">
      <QuestRows items={items} />
    </div>
  );
}
