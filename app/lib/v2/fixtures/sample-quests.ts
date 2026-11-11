// The sample desk's quests.
//
// STUB, written with the contracts so every other part of the desk can be built
// against a function that exists. PLAN-DESK Task 3 replaces the body with an
// invented history; the signature does not change.

import type { QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

/**
 * Built from the sample day itself, so the quests on the sample desk are the
 * candidates the sample day plans from and nothing else.
 */
export function sampleQuests(today: TodayScreenData): QuestsScreenData {
  return {
    input: today.input,
    lanes: today.lanes,
    tags: today.tags,
    done: [],
    historyDays: 0,
  };
}
