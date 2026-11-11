// The quests of a local snapshot folder.
//
// STUB, written with the contracts so the desk's loader can be built against a
// function that exists. PLAN-DESK Task 3 replaces the body; the signature does
// not change.
//
// Server only: reads files. Never imported by anything a browser loads.

import type { QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

/**
 * Built on the day the same request already loaded, so Quests is handed the
 * very planner input Today plans from. What it adds is read from the folder:
 * the history of what was finished.
 *
 * Null when the folder cannot speak about quests at all.
 */
export async function loadLocalQuests(
  dir: string,
  today: TodayScreenData,
): Promise<QuestsScreenData | null> {
  void dir;
  void today;
  return null;
}
