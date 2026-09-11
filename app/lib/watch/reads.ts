import "server-only";
import { createServiceClient } from "@/utils/supabase/service";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { addDaysKey } from "@/app/_components/finance-projection";
import { getPreferences } from "@/app/lib/mcp/reads";

import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import { listEvents } from "@/utils/google/calendar";
import { countFollowups } from "./followup";
import {
  composeWatchToday,
  WATCH_UPCOMING_DAYS,
  type WatchEventInput,
  type WatchRoutineRule,
  type WatchTaskInput,
  type WatchToday,
  type WatchTodayInput,
} from "./today";

// Read layer for GET /api/watch/today. Same shape as app/lib/mcp/reads.ts:
// service client, every query pinned to the authenticated user id, the pure
// composer does the rest. One Google fetch covers the user's local day plus
// the next WATCH_UPCOMING_DAYS and feeds today's events, the upcoming events,
// and the schedule_snapshot math (next event, free hours); an unreachable
// calendar degrades those to null/empty instead of failing the whole payload
// (the watch can still show tasks).

const TASK_COLUMNS =
  "id, title, due_date, due_time, status, priority, notes, created_at, energy_cost, parent_task_id, groups(name, color)";
const RULE_COLUMNS =
  "id, title, frequency, weekdays, day_of_month, interval_days, start_date, due_time, groups(color)";

type Rel<T> = T | T[] | null;
function firstRel<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);
}

type TaskRow = Omit<WatchTaskInput, "group_name" | "group_color"> & {
  groups: Rel<{ name: string; color: string }>;
};
type RuleRow = Omit<WatchRoutineRule, "group_color"> & { groups: Rel<{ color: string }> };

export async function getWatchToday(userId: string): Promise<WatchToday> {
  const supabase = createServiceClient();
  const prefs = await getPreferences(userId);
  const timeZone = safeTimeZone(prefs.timezone);
  const today = todayISO(timeZone);
  const now = new Date();

  const horizon = addDaysKey(today, WATCH_UPCOMING_DAYS);
  const dayStartMs = zonedWallTimeToUtcMs(today, 0, 0, timeZone);
  const horizonEndMs = zonedWallTimeToUtcMs(addDaysKey(horizon, 1), 0, 0, timeZone);
  const eventsPromise = listEvents(userId, {
    timeMin: new Date(dayStartMs).toISOString(),
    timeMax: new Date(horizonEndMs).toISOString(),
  }).catch((error) => {
    console.warn("watch calendar read failed", error);
    return null;
  });

  const [tasksRes, doneRes, rulesRes, completionsRes, slotsRes, groupsRes, rawEvents, followups] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(TASK_COLUMNS)
        .eq("user_id", userId)
        .in("status", ["todo", "doing"])
        .not("due_date", "is", null)
        .lte("due_date", horizon)
        .order("due_date", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(200),
      supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "done")
        .eq("due_date", today),
      supabase
        .from("recurring_tasks")
        .select(RULE_COLUMNS)
        .eq("user_id", userId)
        .eq("archived", false)
        .order("created_at", { ascending: true }),
      supabase
        .from("recurring_task_completions")
        .select("rule_id")
        .eq("user_id", userId)
        .eq("occurred_on", today),
      supabase
        .from("recurring_task_slots")
        .select("rule_id, start_time")
        .eq("user_id", userId)
        .eq("occurred_on", today),
      // Events from a calendar linked to a group wear the group's name, as
      // the dashboard and MCP list_events do.
      supabase
        .from("groups")
        .select("name, color, google_calendar_id")
        .eq("user_id", userId)
        .eq("archived", false)
        .not("google_calendar_id", "is", null),
      eventsPromise,
      countFollowups(supabase, userId, now.toISOString()),
    ]);

  const linkedGroups = new Map(
    ((groupsRes.data ?? []) as { name: string; color: string; google_calendar_id: string }[]).map(
      (g) => [g.google_calendar_id, { name: g.name, color: g.color }],
    ),
  );
  const events: WatchEventInput[] | null = rawEvents
    ? rawEvents.map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        calendar: linkedGroups.get(e.calendarId)?.name ?? e.calendarSummary,
        // Linked group color, else the Google calendar's own color — the same
        // rule the dashboard calendar uses.
        color: linkedGroups.get(e.calendarId)?.color ?? e.calendarColor ?? null,
        location: e.location ?? null,
        description: e.description ?? null,
      }))
    : null;

  const fetchedRows = ((tasksRes.data ?? []) as unknown as TaskRow[]).map(
    ({ groups, ...task }) => ({
      ...task,
      group_name: firstRel(groups)?.name ?? null,
      group_color: firstRel(groups)?.color ?? null,
    }),
  );

  // Children of a non-open parent are hidden everywhere (a missed parent keeps
  // its steps as they are). The parent may sit outside this fetch's date
  // window, so its status is read directly rather than from the rows.
  const childParentIds = [
    ...new Set(
      fetchedRows
        .filter((t) => t.parent_task_id)
        .map((t) => t.parent_task_id as string),
    ),
  ];
  const openParentIds = new Set<string>();
  if (childParentIds.length > 0) {
    const { data: parents } = await supabase
      .from("tasks")
      .select("id")
      .eq("user_id", userId)
      .in("id", childParentIds)
      .in("status", ["todo", "doing"]);
    for (const p of (parents ?? []) as { id: string }[]) openParentIds.add(p.id);
  }
  const taskRows = fetchedRows.filter(
    (t) => !t.parent_task_id || openParentIds.has(t.parent_task_id),
  );

  // "n of m" for the decomposed parents on the wrist: one query over their
  // children (any status), pinned to the user like everything else here.
  const parentIds = taskRows.filter((t) => !t.parent_task_id).map((t) => t.id);
  const childrenByParent = new Map<string, { done: number; total: number }>();
  if (parentIds.length > 0) {
    const { data: childRows } = await supabase
      .from("tasks")
      .select("parent_task_id, status")
      .eq("user_id", userId)
      .in("parent_task_id", parentIds);
    for (const row of (childRows ?? []) as { parent_task_id: string; status: string }[]) {
      const cur = childrenByParent.get(row.parent_task_id) ?? { done: 0, total: 0 };
      cur.total++;
      if (row.status === "done") cur.done++;
      childrenByParent.set(row.parent_task_id, cur);
    }
  }

  const input: WatchTodayInput = {
    tasks: taskRows,
    childrenByParent,
    doneTodayCount: doneRes.count ?? 0,
    rules: ((rulesRes.data ?? []) as unknown as RuleRow[]).map(({ groups, ...rule }) => ({
      ...rule,
      group_color: firstRel(groups)?.color ?? null,
    })),
    completedRuleIds: new Set(
      ((completionsRes.data ?? []) as { rule_id: string }[]).map((c) => c.rule_id),
    ),
    slotStartByRule: new Map(
      ((slotsRes.data ?? []) as { rule_id: string; start_time: string }[]).map((s) => [
        s.rule_id,
        s.start_time,
      ]),
    ),
    events,
    wakeStartHour: prefs.wakeStartHour,
    wakeEndHour: prefs.wakeEndHour,
    followups,
    today,
    now,
    timeZone,
  };
  return composeWatchToday(input);
}
