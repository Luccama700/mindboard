// The quests of a local snapshot folder: the day the same request already
// loaded, plus the history of what was finished, read from the folder's task
// file.
//
// Server only: reads files. Never imported by anything a browser loads.
//
// THE SAME READS AS THE DAY. A finished task's lane and title come from the two
// rules an open one's do (`laneOfGroup` and `titleOf`, engine/task-rules.ts),
// and its tag from the one group rule the day's tags use (`groupTag`,
// ./files.ts). Nothing here is a second spelling of any of them.
//
// A COPY STOPS KNOWING ON THE DAY IT WAS TAKEN. Its history is the 28 days up to
// that day (never later than the planned day), and `historyThrough` says which
// day that is, so the panes can say where "lately" ends instead of counting the
// days since the copy as days in which nothing was finished.

import { z } from "zod";

import { zonedIso } from "@/app/lib/snapshots/zoned-time";
import { laneOfGroup, titleOf } from "@/app/lib/v2/engine/task-rules";
import { compareText } from "@/app/lib/v2/plan/day";
import type { QuestDone, QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import { QUEST_HISTORY_DAYS, doneDayOf, withinDays } from "@/app/lib/v2/view/quests";
import type { TaskTag, TodayScreenData } from "@/app/lib/v2/view/screen-data";

import {
  SNAPSHOT_FILES,
  groupTag,
  readGroupRows,
  readOptionalRows,
  readRules,
  readSnapshotMeta,
} from "./files";

/** The one status that means finished. */
const DONE = "done";

/**
 * A finish time this reader trusts: a date, `T` or a space, a time, and a FULL
 * offset (`Z`, or a sign with hours and minutes, with or without the colon).
 *
 * The offset is required, not assumed: without one `Date.parse` reads the time
 * in the zone of whatever process runs it. Postgres writes every `timestamptz`
 * with one, in either separator. A short "+00", a bare day or any other spelling
 * is skipped like a time nobody can read, and every accepted spelling is
 * rewritten into the one format the language defines (`normalFinish`) before it
 * is parsed, so no engine is left to guess.
 */
const FINISH_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The columns this reader needs, and nothing stricter than the day's own read.
 *
 * Every row of the account passes through this, the open ones too, so anything
 * the day's reader accepts this one accepts: a null title or group is a row the
 * export really holds. The finish time is checked by hand rather than here,
 * because a finish time nobody can read skips its row instead of failing the
 * file.
 */
const doneRowSchema = z.object({
  id: z.string().min(1),
  title: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  group_id: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  status: z.unknown(),
  completed_at: z.unknown(),
});

/** An accepted finish time in the ECMAScript date time format, or null. */
function normalFinish(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = FINISH_TIME.exec(value.trim());
  if (match === null) return null;
  const [, date, clock, seconds, fraction, offset] = match;
  const millis = fraction === undefined ? "" : `.${fraction.slice(0, 3).padEnd(3, "0")}`;
  const zone = offset === "Z" ? "Z" : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
  return `${date}T${clock}:${seconds ?? "00"}${millis}${zone}`;
}

/** Epoch milliseconds of a finish time, or null for one this reader does not trust. */
function finishMs(value: unknown): number | null {
  const text = normalFinish(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Built on the day the same request already loaded, so Quests is handed the
 * very planner input Today plans from. What it adds is read from the folder:
 * the history of what was finished.
 *
 * - `historyThrough` is the planning day the copy was taken on (`doneDayOf` of
 *   the snapshot's own `takenAt`), or the planned day when that is earlier; null
 *   when the file holds no finished row with a readable time at all.
 * - `done` is the finished rows whose finish falls on that day or one of the 27
 *   before it, by the same day rule, newest first. A finish after it is not the
 *   copy's to speak for as of the planned day.
 * - `historyDays` is 28 whenever there is a history: the export holds every task
 *   the account has, so it reaches back further than any span.
 *
 * Null only when the folder has no task file. A file that is there and cannot
 * be read throws the `LocalSnapshotError` every file of the folder throws: a
 * literal file name and a fixed phrase, never a path or a value.
 */
export async function loadLocalQuests(
  dir: string,
  today: TodayScreenData,
): Promise<QuestsScreenData | null> {
  const meta = await readSnapshotMeta(dir);
  const rows = await readOptionalRows(dir, SNAPSHOT_FILES.tasks, meta.userId, doneRowSchema);
  if (rows === null) return null;

  const { document } = await readRules(dir, meta.timeZone);
  const tags = new Map<string, TaskTag>();
  for (const group of await readGroupRows(dir, meta.userId)) {
    const tag = groupTag(group);
    if (tag !== null) tags.set(group.id, tag);
  }

  const { input } = today;
  const rules = input.rules;
  const takenDay = doneDayOf(meta.takenAt, rules);
  const through =
    takenDay !== null && compareText(takenDay, input.date) < 0 ? takenDay : input.date;

  let finishes = 0;
  const done: QuestDone[] = [];
  for (const row of rows) {
    if (row.status !== DONE) continue;
    const ms = finishMs(row.completed_at);
    if (ms === null) continue;
    finishes += 1;

    // One spelling, in the user's zone, so the panes read it as the day reads
    // every other instant.
    const doneAt = zonedIso(ms, rules.timeZone);
    // Planning day, by `doneDayOf`, as the panes read it.
    const day = doneDayOf(doneAt, rules);
    if (day === null || !withinDays(day, through, QUEST_HISTORY_DAYS)) continue;

    const tag = row.group_id === null ? undefined : tags.get(row.group_id);
    done.push({
      id: row.id,
      title: titleOf(row.title),
      lane: laneOfGroup(row.group_id, document.lanes)?.key ?? null,
      tag: tag === undefined ? null : { ...tag },
      doneAt,
    });
  }

  done.sort(
    (a, b) => Date.parse(b.doneAt) - Date.parse(a.doneAt) || compareText(a.id, b.id),
  );

  const known = finishes > 0;
  return {
    input,
    lanes: today.lanes,
    tags: today.tags,
    done,
    historyThrough: known ? through : null,
    historyDays: known ? QUEST_HISTORY_DAYS : 0,
  };
}
