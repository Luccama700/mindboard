import "server-only";
import { createServiceClient } from "@/utils/supabase/service";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { addDaysKey } from "@/app/_components/finance-projection";
import { getPreferences } from "@/app/lib/mcp/reads";
import { scheduleSnapshot, type ScheduleEvent } from "@/app/lib/snapshots/schedule";
import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import { listEvents } from "@/utils/google/calendar";
import {
  composeWatchToday,
  type WatchRoutineRule,
  type WatchTaskInput,
  type WatchToday,
  type WatchTodayInput,
} from "./today";

// Read layer for GET /api/watch/today. Same shape as app/lib/mcp/reads.ts:
// service client, every query pinned to the authenticated user id, the pure
// composer does the rest. One Google fetch covers the user's local day and
// feeds both the events section and the schedule_snapshot math (next event,
// free hours); an unreachable calendar degrades those to null/empty instead of
// failing the whole payload (the watch can still show tasks).

const TASK_COLUMNS =
  "id, title, due_date, due_time, status, priority, notes, created_at, groups(name)";
const RULE_COLUMNS =
  "id, title, frequency, weekdays, day_of_month, interval_days, start_date, due_time";

type Rel<T> = T | T[] | null;
function firstRel<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);
}

type TaskRow = Omit<WatchTaskInput, "group_name"> & { groups: Rel<{ name: string }> };

export async function getWatchToday(userId: string): Promise<WatchToday> {
  const supabase = createServiceClient();
  const prefs = await getPreferences(userId);
  const timeZone = safeTimeZone(prefs.timezone);
  const today = todayISO(timeZone);
  const now = new Date();

  const dayStartMs = zonedWallTimeToUtcMs(today, 0, 0, timeZone);
  const dayEndMs = zonedWallTimeToUtcMs(addDaysKey(today, 1), 0, 0, timeZone);
  const eventsPromise: Promise<ScheduleEvent[] | null> = listEvents(userId, {
    timeMin: new Date(dayStartMs).toISOString(),
    timeMax: new Date(dayEndMs).toISOString(),
  })
    .then((events) =>
      events.map((e) => ({ summary: e.summary, start: e.start, end: e.end, allDay: e.allDay })),
    )
    .catch((error) => {
      console.warn("watch calendar read failed", error);
      return null;
    });

  const [tasksRes, doneRes, rulesRes, completionsRes, slotsRes, events] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(TASK_COLUMNS)
        .eq("user_id", userId)
        .in("status", ["todo", "doing"])
        .not("due_date", "is", null)
        .lte("due_date", today)
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
      eventsPromise,
    ]);

  const input: WatchTodayInput = {
    tasks: ((tasksRes.data ?? []) as unknown as TaskRow[]).map(({ groups, ...task }) => ({
      ...task,
      group_name: firstRel(groups)?.name ?? null,
    })),
    doneTodayCount: doneRes.count ?? 0,
    rules: (rulesRes.data ?? []) as WatchRoutineRule[],
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
    schedule: events
      ? scheduleSnapshot({
          events,
          now,
          wakeStartHour: prefs.wakeStartHour,
          wakeEndHour: prefs.wakeEndHour,
          timeZone,
        })
      : null,
    today,
    now,
    timeZone,
  };
  return composeWatchToday(input);
}
