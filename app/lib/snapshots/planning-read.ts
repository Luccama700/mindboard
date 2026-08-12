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
import {
  computePeopleAttention,
  hydratePeopleAttention,
  type PeopleVitals,
} from "@/app/lib/snapshots/people";
import {
  readVaultCredentials,
  readVaultNoteRaw,
  vaultTag,
} from "@/app/lib/brain/vault";
import { extractSectionBullets } from "@/app/lib/brain/parse";
import type { Person, PersonInteraction } from "@/app/_components/people-types";
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
// The vault section whose bullets are the per-person open loops.
const OPEN_LOOPS_HEADING = "Open questions";
// How many overdue people get vault prose attached. The bound is what keeps the
// vault cost at one tree fetch plus at most three blobs regardless of vault or
// roster size (§7).
const HYDRATE_LIMIT = 3;
// Descending + capped, like every other ledger-shaped read here: an overflowing
// log costs the oldest history first, so last-talked stays correct.
const INTERACTION_SCAN = 5000;

// Step 2 of §7's two-step assembly: attach open loops to an ALREADY-BOUNDED
// slice. BEST-EFFORT BY CONTRACT — a missing vault, revoked token, renamed-away
// note, GitHub outage or parse failure yields no loops and nothing more. Cadence
// is entirely Postgres-backed, so an optional context enhancement must never
// take down routine planning calls for the assistant and every connected MCP
// client.
//
// readVaultNoteRaw defaults to a FRESH tree fetch per call, which for three
// people would be three uncached listings — most of the cost this two-step
// exists to avoid. { fresh: false } shares one cached tree across the three
// reads, and staleness is harmless here (a note edited moments ago is not a
// correctness problem for open loops, unlike an agent verifying its own write).
// The reads are sequential on purpose: concurrent first-calls can each miss the
// data cache and issue their own tree fetch.
async function hydrateOpenLoops(
  supabase: SupabaseClient,
  userId: string,
  vitals: PeopleVitals,
): Promise<PeopleVitals> {
  const top = vitals.attention.slice(0, HYDRATE_LIMIT);
  if (top.length === 0) return { ...vitals, attention: [] };

  const loops: Record<string, string[]> = {};
  try {
    const credentials = await readVaultCredentials(supabase, userId);
    if (credentials) {
      const tag = vaultTag(userId);
      for (const entry of top) {
        // Denise has no note at all; skip rather than pay a read for nothing.
        if (!entry.vaultPath) continue;
        const note = await readVaultNoteRaw(credentials, tag, entry.vaultPath, {
          fresh: false,
        });
        if (!note) continue;
        loops[entry.personId] = extractSectionBullets(
          note.markdown,
          OPEN_LOOPS_HEADING,
        );
      }
    }
  } catch (error) {
    console.warn("people open-loop hydration failed", error);
  }

  return { ...vitals, attention: hydratePeopleAttention(top, loops) };
}

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
    slotsRes,
    tasksRes,
    goalsRes,
    logsRes,
    peopleRes,
    interactionsRes,
    events,
    forecast,
  ] = await Promise.all([
    supabase
      .from("accounts")
      .select("id, name, balance, currency")
      .eq("user_id", userId)
      .eq("archived", false)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
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
      .from("recurring_task_slots")
      .select("rule_id, occurred_on, start_time, duration_min, gcal_event_id")
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
    supabase
      .from("people")
      .select(
        "id, name, vault_path, aliases, checkin_days, attention_snoozed_until, archived, archived_at, created_at, updated_at",
      )
      .eq("user_id", userId)
      .eq("archived", false),
    supabase
      .from("person_interactions")
      .select("id, person_id, summary, occurred_at, occurred_precision, source, created_at")
      .eq("user_id", userId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(INTERACTION_SCAN),
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

  const recurringSlots = (slotsRes.data ?? []) as {
    rule_id: string;
    occurred_on: string;
    start_time: string;
    duration_min: number | null;
    gcal_event_id: string | null;
  }[];

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

  // Step 1: the whole cadence calculation, from Postgres rows alone — it needs
  // no vault data at all. Step 2 then hydrates only the survivors (§7).
  const people = await hydrateOpenLoops(
    supabase,
    userId,
    computePeopleAttention({
      people: (peopleRes.data ?? []) as Person[],
      interactions: (interactionsRes.data ?? []) as PersonInteraction[],
      candidates: [],
      today,
    }),
  );

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
    recurringSlots,
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
    people,
  });
}
