// What the Today screen is handed, whichever source built it: the sample day,
// a local snapshot of an account's own data, or (later) the live stores.
// Pure types only. The screen codes against this and never against a source.

import type { Ask, FeedStatus, LaneKey, PlanInput } from "../types";

/** A lane as the screen shows it. Per-user data, never hard-coded. */
export interface ScreenLane {
  key: LaneKey;
  label: string;
  color: string;
}

/**
 * How one task presents itself: the name and colour of the group it lives in.
 * This is the user's own data and their own colour choice, so it can be any
 * colour at all, including one too dark to read as text on a dark scheme.
 * The screen must derive a readable variant instead of using it raw for text.
 */
export interface TaskTag {
  label: string;
  color: string;
}

export interface TodayScreenData {
  /** A real planner input. The screen shows `planDay(input)`, never a hand-written plan. */
  input: PlanInput;
  lanes: ScreenLane[];
  feeds: FeedStatus[];
  feedLabels: Record<string, string>;
  openAsks: Ask[];
  /** Candidate id to its group's name and colour. Empty when the source has no groups. */
  tags: Record<string, TaskTag>;
  /** One plain sentence saying what this data is and whether taps are saved, or null. */
  notice: string | null;
}
