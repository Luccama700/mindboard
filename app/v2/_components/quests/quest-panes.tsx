// The Quests panes, by pane id.
//
// Four bodies over the desk's quests and the day's own plan. Each builds its
// part with `buildQuestsView` on the very planner input Today plans from and
// the set of tasks worked on in the plan on screen, prints what that returns,
// and says so in one sentence when the source cannot speak about quests. The
// steps pane's lane filter is the only control among them, and none holds a
// live region.

import type { PaneBody } from "@/app/v2/_desk/pane-body";
import { DonePane } from "./done-pane";
import { LanesPane } from "./lanes-pane";
import { SideQuestsPane } from "./side-quests-pane";
import { StepsPane } from "./steps-pane";

export const QUEST_PANE_BODIES: Readonly<Record<string, PaneBody>> = {
  lanes: LanesPane,
  steps: StepsPane,
  "side-quests": SideQuestsPane,
  done: DonePane,
};
