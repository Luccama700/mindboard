// Which body draws which pane.
//
// The ids are the fourteen of the plan's table, written out here as plain data
// rather than read from the tiling engine: the registry answers "what draws
// this id" and nothing about where a pane goes.

import { DESK_COPY } from "@/app/lib/v2/view/desk";
import { MONEY_PANE_BODIES } from "../_components/money/money-panes";
import { QUEST_PANE_BODIES } from "../_components/quests/quest-panes";
import { DAY_PANE_BODIES } from "./day-panes";
import type { PaneBody } from "./pane-body";

/** The fourteen panes, in the order of the plan's table. */
export const KNOWN_PANE_IDS: readonly string[] = Object.freeze([
  "today",
  "status",
  "past-due",
  "not-today",
  "calendar",
  "lanes",
  "steps",
  "side-quests",
  "done",
  "forecast",
  "accounts",
  "coming-up",
  "hours",
  "ledger",
]);

/** A pane with no body yet, or an id nobody knows: one sentence that says so. */
export function NotBuilt() {
  return <p className="v2-pane-note">{DESK_COPY.notBuilt}</p>;
}

/**
 * The body for a pane id: a day pane, then a quests pane, then a money pane,
 * and NotBuilt for anything else.
 *
 * OWN KEYS ONLY. An id comes from a URL or a stored layout, and a plain lookup
 * would answer "toString" with the prototype's function, which React would then
 * call as a component. An id outside the fourteen is NotBuilt even if a map
 * happens to hold it.
 *
 * The same id always answers the same function, so a re-render never hands
 * React a new component type and a body is never remounted by being looked up.
 */
export function paneBody(id: string): PaneBody {
  if (!KNOWN_PANE_IDS.includes(id)) return NotBuilt;
  for (const bodies of [DAY_PANE_BODIES, QUEST_PANE_BODIES, MONEY_PANE_BODIES]) {
    if (Object.hasOwn(bodies, id)) return bodies[id];
  }
  return NotBuilt;
}
