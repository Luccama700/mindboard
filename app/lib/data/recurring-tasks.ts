import "server-only";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";

// Reusable recurring-task reads, RLS-scoped and cache()'d per request like the
// finance/inventory reads. Occurrences are computed from these rules — never
// materialized as task rows.

export const RECURRING_TASK_COLUMNS =
  "id, title, notes, priority, frequency, weekdays, day_of_month, interval_days, start_date, due_time, duration_min, group_id, archived, created_at";

export type RecurringTaskRow = {
  id: string;
  title: string;
  notes: string | null;
  priority: "low" | "med" | "high";
  frequency: "daily" | "weekly" | "monthly" | "custom";
  weekdays: number[] | null;
  day_of_month: number | null;
  interval_days: number | null;
  start_date: string | null;
  due_time: string | null;
  duration_min: number | null;
  group_id: string | null;
  archived: boolean;
  created_at: string;
  group_name: string | null;
  group_color: string | null;
};

type RawRow = Omit<RecurringTaskRow, "group_name" | "group_color"> & {
  groups: { name: string; color: string } | { name: string; color: string }[] | null;
};

function flattenGroup({ groups, ...rest }: RawRow): RecurringTaskRow {
  const group = Array.isArray(groups) ? (groups[0] ?? null) : groups;
  return {
    ...rest,
    group_name: group?.name ?? null,
    group_color: group?.color ?? null,
  };
}

export const getActiveRecurringTasks = cache(
  async (userId: string): Promise<RecurringTaskRow[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("recurring_tasks")
      .select(`${RECURRING_TASK_COLUMNS}, groups(name, color)`)
      .eq("user_id", userId)
      .eq("archived", false)
      .order("created_at", { ascending: true });
    return ((data ?? []) as unknown as RawRow[]).map(flattenGroup);
  },
);

export const getRecurringCompletions = cache(
  async (
    userId: string,
    startKey: string,
    endKey: string,
  ): Promise<{ rule_id: string; occurred_on: string }[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("recurring_task_completions")
      .select("rule_id, occurred_on")
      .eq("user_id", userId)
      .gte("occurred_on", startKey)
      .lte("occurred_on", endKey);
    return (data ?? []) as { rule_id: string; occurred_on: string }[];
  },
);

export type RecurringSlotRow = {
  rule_id: string;
  occurred_on: string;
  start_time: string;
  duration_min: number | null;
  // Promotion link (migration 0046): when set, this day's occurrence was
  // turned into a real Google Calendar event and the event stands in.
  gcal_event_id: string | null;
};

export const getRecurringSlots = cache(
  async (
    userId: string,
    startKey: string,
    endKey: string,
  ): Promise<RecurringSlotRow[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("recurring_task_slots")
      .select("rule_id, occurred_on, start_time, duration_min, gcal_event_id")
      .eq("user_id", userId)
      .gte("occurred_on", startKey)
      .lte("occurred_on", endKey);
    return (data ?? []) as RecurringSlotRow[];
  },
);
