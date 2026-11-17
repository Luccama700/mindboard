// The whole desk from a local snapshot folder: the day, then the quests and the
// money that go with that same day.
//
// Server only: reads files. Never imported by anything a browser loads.

import type { DeskScreenData, MoneyScreenData, QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import type { Instant } from "@/app/lib/v2/types";

import { LocalSnapshotError } from "./files";
import { loadLocalMoney } from "./money";
import { loadLocalQuests } from "./quests";
import { loadLocalToday } from "./snapshot";

/**
 * One part of the desk, or the sentence that says why it is missing.
 *
 * A file that is absent is not an error: the loader answers null and the panes
 * say there is nothing. A file that is there and cannot be read is something to
 * go and fix, and it must not cost the rest of the desk: the day is still worth
 * showing when the money file is broken. So the error's own message (a literal
 * file name and a fixed phrase, never a path or a value) becomes a note, and
 * the part is null. Anything that is not a snapshot error still throws.
 */
async function part<T>(read: Promise<T | null>): Promise<{ value: T | null; note: string | null }> {
  try {
    return { value: await read, note: null };
  } catch (error) {
    if (error instanceof LocalSnapshotError) return { value: null, note: error.message };
    throw error;
  }
}

/**
 * The day is loaded first and alone: a folder whose day cannot be read has no
 * desk to show, so that error is the caller's to turn into the error screen.
 */
export async function loadLocalDesk(
  dir: string,
  now: Instant,
  dateParam: string | null,
  weekParam: string | null,
): Promise<DeskScreenData> {
  const today: TodayScreenData = await loadLocalToday(dir, now, dateParam, weekParam);
  const [quests, money] = await Promise.all([
    part<QuestsScreenData>(loadLocalQuests(dir, today)),
    part<MoneyScreenData>(loadLocalMoney(dir, today)),
  ]);
  return {
    today,
    quests: quests.value,
    money: money.value,
    notes: [quests.note, money.note].filter((note): note is string => note !== null),
  };
}
