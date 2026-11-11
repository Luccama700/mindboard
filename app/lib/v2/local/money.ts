// The money of a local snapshot folder.
//
// STUB, written with the contracts so the desk's loader can be built against a
// function that exists. PLAN-DESK Task 4 replaces the body; the signature does
// not change.
//
// Server only: reads files. Never imported by anything a browser loads.

import type { MoneyScreenData } from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

/**
 * Takes the day the same request already loaded, for its clock and its planned
 * day. Null when the folder holds no money file: the panes then say so.
 */
export async function loadLocalMoney(
  dir: string,
  today: TodayScreenData,
): Promise<MoneyScreenData | null> {
  void dir;
  void today;
  return null;
}
