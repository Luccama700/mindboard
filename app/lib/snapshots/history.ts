// Pure rollup for the tasks history page: turns resolved (done/missed) task rows
// into a Monday-start weekly count block and a day-grouped, timezone-local event
// timeline. `today` and `timeZone` are passed in (not read from the clock) so the
// function stays deterministic and testable. Event day bucketing goes through the
// zoned helpers so a late-night event lands on the user's local day, not UTC's.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";

export type HistoryRow = {
  id: string;
  title: string;
  status: "done" | "missed";
  completed_at: string | null;
  missed_at: string | null;
  group_name: string | null;
  group_color: string | null;
};

export type HistoryEvent = {
  id: string;
  title: string;
  kind: "done" | "missed";
  at: string;
  group_name: string | null;
  group_color: string | null;
};

export type HistoryWeek = { startKey: string; done: number; missed: number };
export type HistoryDay = { dateKey: string; events: HistoryEvent[] };
export type HistoryRollup = { weeks: HistoryWeek[]; days: HistoryDay[] };

// The Monday (ISO YYYY-MM-DD) starting the week a local date key falls in. Pure
// date arithmetic on the already-local key, so it's timezone-independent.
function weekStartKey(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const daysSinceMonday = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - daysSinceMonday);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function historyRollup(
  rows: HistoryRow[],
  today: string,
  timeZone: string | null,
): HistoryRollup {
  const events: HistoryEvent[] = [];
  for (const row of rows) {
    const at = row.status === "done" ? row.completed_at : row.missed_at;
    if (!at) continue;
    events.push({
      id: row.id,
      title: row.title,
      kind: row.status,
      at,
      group_name: row.group_name,
      group_color: row.group_color,
    });
  }

  // Day buckets, keyed by the event's local date.
  const dayMap = new Map<string, HistoryEvent[]>();
  // Week counts, keyed by Monday.
  const weekMap = new Map<string, { done: number; missed: number }>();

  for (const event of events) {
    const dateKey = zonedDateKey(new Date(event.at).getTime(), timeZone);
    const day = dayMap.get(dateKey);
    if (day) day.push(event);
    else dayMap.set(dateKey, [event]);

    const startKey = weekStartKey(dateKey);
    const week = weekMap.get(startKey) ?? { done: 0, missed: 0 };
    if (event.kind === "done") week.done++;
    else week.missed++;
    weekMap.set(startKey, week);
  }

  // The current week is always shown, even when empty.
  const currentStart = weekStartKey(today);
  if (!weekMap.has(currentStart)) weekMap.set(currentStart, { done: 0, missed: 0 });

  const weeks: HistoryWeek[] = [...weekMap.entries()]
    .map(([startKey, counts]) => ({ startKey, ...counts }))
    .sort((a, b) => (a.startKey < b.startKey ? 1 : -1))
    .slice(0, 4);

  const days: HistoryDay[] = [...dayMap.entries()]
    .map(([dateKey, dayEvents]) => ({
      dateKey,
      events: dayEvents
        .slice()
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    }))
    .sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));

  return { weeks, days };
}
