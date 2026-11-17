// Two rules a task row is read by, wherever it is read: the live engine's
// candidates (./sources.ts) and a local copy's history of finished tasks
// (app/lib/v2/local/quests.ts). One home, so a task cannot be named or laned one
// way when it is open and another when it is done.
//
// A pure leaf: no imports, so anything may import it, the browser included.

/** A title is the user's own text; this is only for a row that has none. */
export const UNTITLED = "untitled";

/**
 * The row's own title, or the word for a row that has none.
 *
 * Blank counts as none. A title of "" or of spaces is a title the user never
 * wrote, and it reached the screen as an empty heading on the lit card and a
 * status line that read " marked done." Trimmed as well, so the two levels of a
 * name (view/today.ts splitTitle) are not measuring padding.
 */
export function titleOf(value: string | null): string {
  const text = (value ?? "").trim();
  return text === "" ? UNTITLED : text;
}

/**
 * The lane a task's group belongs to: the first lane whose `groupIds` holds it,
 * or null for a task with no group or a group in no lane.
 *
 * Generic over the lane's shape so each caller gets its own lane back (the
 * engine reads `hardDates` off it, the history only its key).
 */
export function laneOfGroup<Lane extends { groupIds: readonly string[] }>(
  groupId: string | null,
  lanes: readonly Lane[],
): Lane | null {
  if (groupId === null) return null;
  return lanes.find((lane) => lane.groupIds.includes(groupId)) ?? null;
}
