import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { todayISO, safeTimeZone } from "@/app/_components/date-utils";
import { addDaysKey } from "@/app/_components/finance-projection";
import { GoogleCalendarConnectionError, listEvents } from "@/utils/google/calendar";
import { buildFinanceForecast } from "@/app/lib/finance/forecast";
import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import {
  planningSnapshot,
  type PlanningInput,
  type PlanningRecurringRule,
  type PlanningSnapshot,
} from "@/app/lib/snapshots/planning";
import type { TaskWithGroup } from "@/app/_components/types";

// Session-less assembler for the horizon planning snapshot. Fetches every domain
// with the passed Supabase client (service client for MCP, session client for the
// in-app assistant) — always pinning user_id, so it is correct under both — then
// hands the raw data to the pure planningSnapshot. The pure module owns all the
// math; this file only fetches and shapes rows.

const HORIZON_MIN = 1;
const HORIZON_MAX = 60;
const DEFAULT_BEFORE_HOUR = 17;
const CHECKIN_HISTORY = 14;

type Rel<T> = T | T[] | null;
function firstRel<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);
}

export async function buildPlanningSnapshot(params: {
  supabase: SupabaseClient;
  userId: string;
  horizonDays: number;
  beforeHour?: number;
}): Promise<PlanningSnapshot> {
  const { supabase, userId } = params;
  const horizonDays = Math.min(
    Math.max(HORIZON_MIN, Math.trunc(params.horizonDays)),
    HORIZON_MAX,
  );
  const beforeHour = params.beforeHour ?? DEFAULT_BEFORE_HOUR;

  const prefsRes = await supabase
    .from("user_settings")
    .select("timezone, wake_start_hour, wake_end_hour, daily_spend_estimate")
    .eq("user_id", userId)
    .maybeSingle();
  const prefs = prefsRes.data as
    | {
        timezone: string | null;
        wake_start_hour: number | null;
        wake_end_hour: number | null;
        daily_spend_estimate: number | null;
      }
    | null;

  const timeZone = safeTimeZone(prefs?.timezone ?? null);
  const wakeStartHour =
    typeof prefs?.wake_start_hour === "number" ? prefs.wake_start_hour : 8;
  const wakeEndHour =
    typeof prefs?.wake_end_hour === "number" ? prefs.wake_end_hour : 22;
  const dailySpendEstimate =
    prefs?.daily_spend_estimate === null || prefs?.daily_spend_estimate === undefined
      ? null
      : Number(prefs.daily_spend_estimate);

  const now = new Date();
  const today = todayISO(timeZone);
  const horizonEnd = addDaysKey(today, horizonDays);

  // Event window: from the user's local start-of-today to the end of the last
  // horizon day, as absolute instants.
  const timeMin = new Date(zonedWallTimeToUtcMs(today, 0, 0, timeZone)).toISOString();
  const timeMax = new Date(
    zonedWallTimeToUtcMs(addDaysKey(horizonEnd, 1), 0, 0, timeZone),
  ).toISOString();

  const eventsPromise = listEvents(userId, { timeMin, timeMax })
    .then((events) =>
      events.map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
      })),
    )
    .catch((error) => {
      if (error instanceof GoogleCalendarConnectionError) return [];
      return [];
    });

  const [
    accountsRes,
    expensesRes,
    todayChangesRes,
    itemsRes,
    usagesRes,
    recurringRes,
    completionsRes,
    tasksRes,
    goalsRes,
    logsRes,
    events,
    forecast,
  ] = await Promise.all([
    supabase
      .from("accounts")
      .select("id, name, balance, currency")
      .eq("user_id", userId)
      .eq("archived", false)
      .order("created_at", { ascending: true }),
    supabase
      .from("recurring_expenses")
      .select(
        "id, name, amount, category_id, frequency, day_of_month, weekday, interval_days, start_date",
      )
      .eq("user_id", userId)
      .eq("archived", false),
    supabase
      .from("balance_changes")
      .select("direction, amount")
      .eq("user_id", userId)
      .eq("occurred_at", today),
    supabase
      .from("inventory_items")
      .select("id, name, quantity, unit, reorder_threshold")
      .eq("user_id", userId)
      .eq("archived", false),
    supabase
      .from("inventory_usages")
      .select("inventory_item_id, amount, period, interval_days")
      .eq("user_id", userId),
    supabase
      .from("recurring_tasks")
      .select(
        "id, title, priority, frequency, weekdays, day_of_month, interval_days, start_date, due_time, duration_min, groups(name)",
      )
      .eq("user_id", userId)
      .eq("archived", false)
      .order("created_at", { ascending: true }),
    supabase
      .from("recurring_task_completions")
      .select("rule_id, occurred_on")
      .eq("user_id", userId)
      .gte("occurred_on", today),
    supabase
      .from("tasks")
      .select(
        "id, title, due_date, due_time, duration_min, status, priority, ai_state, notes, group_id, gcal_event_id, gcal_calendar_id, created_at, completed_at, estimated_minutes, missed_at, groups(name, color)",
      )
      .eq("user_id", userId)
      .in("status", ["todo", "doing"]),
    supabase
      .from("goals")
      .select("id, title, horizon, status, target_date")
      .eq("user_id", userId)
      .in("status", ["active", "paused"])
      .order("created_at", { ascending: false }),
    supabase
      .from("daily_logs")
      .select("log_date, mood, energy, sleep_hours")
      .eq("user_id", userId)
      .order("log_date", { ascending: false })
      .limit(CHECKIN_HISTORY),
    eventsPromise,
    buildFinanceForecast({
      supabase,
      userId,
      today,
      days: horizonDays,
      dailySpendEstimate,
      timeZone,
    }),
  ]);

  const accounts = ((accountsRes.data ?? []) as {
    id: string;
    name: string;
    balance: number;
    currency: string;
  }[]).map((a) => ({ ...a, balance: Number(a.balance) }));

  const recurringExpenses = ((expensesRes.data ?? []) as {
    id: string;
    name: string;
    amount: number;
    frequency: "monthly" | "weekly" | "daily" | "custom";
    day_of_month: number | null;
    weekday: number | null;
    interval_days: number | null;
    start_date: string | null;
  }[]).map((row) => ({ ...row, amount: Number(row.amount) }));

  // Same definition as financeSnapshot's todayDelta (paired transfer legs cancel).
  const todayDelta = ((todayChangesRes.data ?? []) as {
    direction: "in" | "out";
    amount: number;
  }[]).reduce(
    (sum, c) => sum + (c.direction === "in" ? Number(c.amount) : -Number(c.amount)),
    0,
  );

  const items = ((itemsRes.data ?? []) as {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    reorder_threshold: number | null;
  }[]).map((row) => ({ ...row, quantity: Number(row.quantity) }));

  const usagesByItem: Record<string, PlanningInput["usagesByItem"][string]> = {};
  for (const row of (usagesRes.data ?? []) as {
    inventory_item_id: string;
    amount: number;
    period: "day" | "week" | "custom";
    interval_days: number | null;
  }[]) {
    (usagesByItem[row.inventory_item_id] ??= []).push({
      amount: Number(row.amount),
      period: row.period,
      interval_days: row.interval_days,
    });
  }

  type RecurringRow = Omit<PlanningRecurringRule, "group_name"> & {
    groups: Rel<{ name: string }>;
  };
  const recurringTasks: PlanningRecurringRule[] = (
    (recurringRes.data ?? []) as unknown as RecurringRow[]
  ).map(({ groups, ...rule }) => ({
    ...rule,
    group_name: firstRel(groups)?.name ?? null,
  }));

  const completedRecurring = new Set(
    ((completionsRes.data ?? []) as { rule_id: string; occurred_on: string }[]).map(
      (c) => `${c.rule_id}|${c.occurred_on}`,
    ),
  );

  type TaskRow = Omit<TaskWithGroup, "group_name" | "group_color"> & {
    groups: Rel<{ name: string; color: string }>;
  };
  const tasks: TaskWithGroup[] = ((tasksRes.data ?? []) as unknown as TaskRow[]).map(
    ({ groups, ...task }) => {
      const group = firstRel(groups);
      return {
        ...task,
        group_name: group?.name ?? null,
        group_color: group?.color ?? null,
      };
    },
  );

  const goals = (goalsRes.data ?? []) as {
    id: string;
    title: string;
    horizon: string | null;
    status: string;
    target_date: string | null;
  }[];

  const checkins = ((logsRes.data ?? []) as {
    log_date: string;
    mood: number | null;
    energy: number | null;
    sleep_hours: number | null;
  }[])
    .map((row) => ({
      date: row.log_date,
      mood: row.mood,
      energy: row.energy,
      sleepHours: row.sleep_hours === null ? null : Number(row.sleep_hours),
    }))
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest → newest trend

  return planningSnapshot({
    today,
    now,
    horizonDays,
    timeZone,
    wakeStartHour,
    wakeEndHour,
    beforeHour,
    events,
    recurringTasks,
    completedRecurring,
    tasks,
    accounts,
    recurringExpenses,
    todayDelta,
    forecast: forecast.days,
    everydaySpend: {
      dailyRate: forecast.everydaySpend.dailyRate,
      confident: forecast.everydaySpend.confident,
      manualFallback: forecast.everydaySpend.manualFallback,
    },
    items,
    usagesByItem,
    checkins,
    goals,
  });
}
