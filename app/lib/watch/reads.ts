import "server-only";
import { createServiceClient } from "@/utils/supabase/service";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { getPreferences, getScheduleSnapshot } from "@/app/lib/mcp/reads";
import type { ScheduleVitals } from "@/app/lib/snapshots/schedule";
import {
  composeWatchToday,
  type WatchRoutineRule,
  type WatchToday,
  type WatchTodayInput,
} from "./today";

// Read layer for GET /api/watch/today. Same shape as app/lib/mcp/reads.ts:
// service client, every query pinned to the authenticated user id, the pure
// composer does the rest. The schedule block reuses the MCP schedule_snapshot
// read as-is; a missing Google connection degrades it to null instead of
// failing the whole payload (the watch can still show tasks).

const TASK_COLUMNS = "id, title, due_date, due_time, status, priority, created_at";
const RULE_COLUMNS =
  "id, title, frequency, weekdays, day_of_month, interval_days, start_date, due_time";

export async function getWatchToday(userId: string): Promise<WatchToday> {
  const supabase = createServiceClient();
  const prefs = await getPreferences(userId);
  const timeZone = safeTimeZone(prefs.timezone);
  const today = todayISO(timeZone);
  const now = new Date();

  const [tasksRes, doneRes, rulesRes, completionsRes, slotsRes, schedule] =
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
      getScheduleSnapshot(userId).catch((error): ScheduleVitals | null => {
        console.warn("watch schedule read failed", error);
        return null;
      }),
    ]);

  const input: WatchTodayInput = {
    tasks: (tasksRes.data ?? []) as WatchTodayInput["tasks"],
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
    schedule: schedule
      ? { nextEvent: schedule.nextEvent, freeHoursToday: schedule.freeHoursToday }
      : null,
    today,
    now,
    timeZone,
  };
  return composeWatchToday(input);
}
