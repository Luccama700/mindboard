// The quests of a local snapshot folder: the day the same request already
// loaded, plus the history of what was finished, read from the folder's task
// file.
//
// Server only: reads files. Never imported by anything a browser loads.
//
// THE SAME READS AS THE DAY. A finished task's lane is the lane whose `groupIds`
// holds its group, exactly as `tasksToCandidates` (engine/sources.ts) gives an
// open one its lane, and its tag is its group's name and colour by the rule
// `tagsFor` (./snapshot.ts) gives an open one its tag. Both of those are private
// to files this one may not change, so the two small rules are written out again
// below, each beside the name of the one it mirrors.

import { z } from "zod";

import { zonedIso } from "@/app/lib/snapshots/zoned-time";
import { compareText } from "@/app/lib/v2/plan/day";
import type { RulesDocument } from "@/app/lib/v2/store/types";
import type { LaneKey } from "@/app/lib/v2/types";
import type { QuestDone, QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import { QUEST_HISTORY_DAYS, doneDayOf, withinDays } from "@/app/lib/v2/view/quests";
import type { TaskTag, TodayScreenData } from "@/app/lib/v2/view/screen-data";

import {
  SNAPSHOT_FILES,
  readGroupRows,
  readOptionalRows,
  readRules,
  readSnapshotMeta,
  type LocalGroup,
} from "./files";

/** The one status that means finished. */
const DONE = "done";

/**
 * What a task with no title is called: the engine's own word for an open one
 * (`titleOf` in engine/sources.ts), copied by value because that module is the
 * live engine's and reaches the database and Google with it.
 */
const UNTITLED = "untitled";

/**
 * A finish time this reader trusts: a date, a time and an explicit offset.
 *
 * The offset is required, not assumed. Without one `Date.parse` reads the time
 * in the zone of whatever process happens to run it, so the same file would put
 * the same finish on two different days on two machines. Postgres writes every
 * `timestamptz` with one, in either spelling below, so a value without it was
 * written by hand and is skipped like any other time nobody can read.
 */
const FINISH_TIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

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

/** Epoch milliseconds of a finish time, or null for one this reader does not trust. */
function finishMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!FINISH_TIME.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** The row's own title, or the word for a row that has none. Blank counts as none. */
function titleOf(value: string | null): string {
  const text = (value ?? "").trim();
  return text === "" ? UNTITLED : text;
}

/** The lane whose `groupIds` holds the group: `tasksToCandidates`'s rule. */
function laneOf(groupId: string | null, document: RulesDocument): LaneKey | null {
  if (groupId === null) return null;
  return document.lanes.find((lane) => lane.groupIds.includes(groupId))?.key ?? null;
}

/**
 * Each group's tag, by `tagsFor`'s rule: a group with no name or no colour has
 * none, because the screen derives a readable text colour from it.
 */
function tagsByGroup(groups: LocalGroup[]): Map<string, TaskTag> {
  const out = new Map<string, TaskTag>();
  for (const { id, name, color } of groups) {
    if (name === null || name.length === 0 || color === null || color.length === 0) continue;
    out.set(id, { label: name, color });
  }
  return out;
}

/**
 * Built on the day the same request already loaded, so Quests is handed the
 * very planner input Today plans from. What it adds is read from the folder:
 * the history of what was finished.
 *
 * `done` holds the finished rows whose finish falls on the planned day or one of
 * the 27 before it, by the same day rule the panes read them with
 * (`doneDayOf`), newest first. `historyDays` is 28 when the file holds any
 * finished row with a readable time at all, older ones included, and 0 when it
 * holds none: a file that records no finishes cannot speak for a rate.
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
  const tags = tagsByGroup(await readGroupRows(dir, meta.userId));

  const { input } = today;
  const rules = input.rules;
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
    const day = doneDayOf(doneAt, rules);
    if (day === null || !withinDays(day, input.date, QUEST_HISTORY_DAYS)) continue;

    const tag = row.group_id === null ? undefined : tags.get(row.group_id);
    done.push({
      id: row.id,
      title: titleOf(row.title),
      lane: laneOf(row.group_id, document),
      tag: tag === undefined ? null : { ...tag },
      doneAt,
    });
  }

  done.sort(
    (a, b) => Date.parse(b.doneAt) - Date.parse(a.doneAt) || compareText(a.id, b.id),
  );

  return {
    input,
    lanes: today.lanes,
    tags: today.tags,
    done,
    historyDays: finishes > 0 ? QUEST_HISTORY_DAYS : 0,
  };
}
