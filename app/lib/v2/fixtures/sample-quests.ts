// The sample desk's quests: the sample day's own planner input, lanes and tags,
// plus an invented history of what was finished over the three weeks before it.
//
// EVERYTHING HERE IS FICTIONAL. No title, place, name or time describes anybody,
// and no title is one of the sample day's open candidates: a thing cannot be
// both waiting and done. The clock is the sample's own, so the history reads the
// same every time and nothing here looks at the process clock or rolls a die.
//
// Shaped to exercise the panes: about twenty finishes over 21 days, some days
// with two, four days empty, one this morning, three with no lane, two titles
// with a detail in brackets, and one lane (Work) that nothing feeds and nothing was
// finished in, so the sample shows a quiet lane saying nothing.

import { SAMPLE_DATE, sampleInstant } from "@/app/lib/v2/fixtures/sample-base";
import type { LaneKey } from "@/app/lib/v2/types";
import type { QuestDone, QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

/** The sample's history reaches back four weeks, the longest span the panes show. */
const SAMPLE_HISTORY_DAYS = 28;

/** [id, date, clock, lane, title], newest first. */
const HISTORY: ReadonlyArray<readonly [string, string, string, LaneKey | null, string]> = [
  ["d-walk", SAMPLE_DATE, "08:10", "body", "Walk before breakfast"],
  ["d-chapter", "2026-04-14", "21:40", "study", "Chapter four reading notes"],
  ["d-water-bill", "2026-04-14", "16:05", "money", "Pay the water bill"],
  ["d-ladder", "2026-04-13", "11:30", "people", "Return the borrowed ladder"],
  ["d-brackets", "2026-04-13", "09:15", "craft", "Sand the shelf brackets"],
  ["d-books", "2026-04-11", "18:20", null, "Drop off the library books"],
  ["d-problems", "2026-04-10", "20:00", "study", "Problem set six (questions one to four)"],
  ["d-savings", "2026-04-10", "14:45", "money", "Move the savings transfer date"],
  ["d-physio", "2026-04-09", "10:30", "body", "Book the physio follow up"],
  ["d-card", "2026-04-08", "19:10", "people", "Birthday card for the neighbour"],
  ["d-kiln", "2026-04-07", "13:00", "craft", "Fire the second kiln load"],
  ["d-papers", "2026-04-07", "08:45", "study", "Seminar reading (the two short papers)"],
  ["d-bike", "2026-04-06", "17:30", null, "Fix the bike light"],
  ["d-receipts", "2026-04-04", "12:00", "money", "File the March receipts"],
  ["d-clay", "2026-04-03", "15:20", "craft", "Order more clay"],
  ["d-slides", "2026-04-02", "09:50", "study", "Lecture slides review"],
  ["d-thanks", "2026-03-31", "20:30", "people", "Thank you note to the host"],
  ["d-pool", "2026-03-30", "11:10", "body", "Renew the pool pass"],
  ["d-lab", "2026-03-28", "16:40", "study", "Lab report corrections"],
  ["d-parcel", "2026-03-27", "10:00", null, "Return the parcel"],
  ["d-subscription", "2026-03-26", "18:00", "money", "Cancel the unused subscription"],
];

/**
 * Built from the sample day itself, so the quests on the sample desk are the
 * candidates the sample day plans from and nothing else. A fresh history every
 * call. The sample has no groups, so no finished thing carries a tag: each one
 * wears its lane, exactly as the day's own steps do.
 */
export function sampleQuests(today: TodayScreenData): QuestsScreenData {
  const done: QuestDone[] = HISTORY.map(([id, date, clock, lane, title]) => ({
    id,
    title,
    lane,
    tag: null,
    doneAt: sampleInstant(clock, date),
  }));
  return {
    input: today.input,
    lanes: today.lanes,
    tags: today.tags,
    done,
    historyDays: SAMPLE_HISTORY_DAYS,
  };
}
