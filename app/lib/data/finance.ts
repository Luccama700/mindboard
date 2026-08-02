import "server-only";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import type {
  Account,
  BalanceChange,
  RecurringExpense,
  SpendLimit,
} from "@/app/_components/finance-types";
import type { SpendHistoryRow } from "@/app/_components/spend-baseline";
import { todayISO } from "@/app/_components/date-utils";
import { addDaysKey } from "@/app/_components/finance-projection";

// Reusable finance reads. Selects mirror app/finance/page.tsx; RLS scopes every
// row to the caller, so no explicit user_id filter is needed. Each read is
// React-cache()'d, so calling it from both the dashboard and the vitals strip in
// one request hits the database once. userId is the cache key.

const ACCOUNT_COLUMNS =
  "id, name, type, color, balance, currency, archived, created_at, updated_at";
const CHANGE_COLUMNS =
  "id, account_id, category_id, direction, amount, note, occurred_at, created_at, source, is_transfer";
const RECURRING_COLUMNS =
  "id, name, amount, category_id, frequency, day_of_month, weekday, interval_days, start_date, archived, created_at";
const SPEND_LIMIT_COLUMNS =
  "id, scope, category_id, period, amount, archived, created_at";

export const getAccounts = cache(
  async (userId: string): Promise<Account[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("user_id", userId)
      .eq("archived", false)
      .order("created_at", { ascending: true });
    return (data ?? []) as Account[];
  },
);

export const getActiveRecurringExpenses = cache(
  async (userId: string): Promise<RecurringExpense[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("recurring_expenses")
      .select(RECURRING_COLUMNS)
      .eq("user_id", userId)
      .eq("archived", false)
      .order("created_at", { ascending: false });
    return (data ?? []) as RecurringExpense[];
  },
);

// Active spending limits (budget caps tracked against actual spend).
export const getSpendLimits = cache(
  async (userId: string): Promise<SpendLimit[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("spend_limits")
      .select(SPEND_LIMIT_COLUMNS)
      .eq("user_id", userId)
      .eq("archived", false)
      .order("created_at", { ascending: true });
    return (data ?? []) as SpendLimit[];
  },
);

// Balance changes on a single day, used for the dashboard's "today delta".
export const getBalanceChangesOn = cache(
  async (userId: string, dateKey: string): Promise<BalanceChange[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("balance_changes")
      .select(CHANGE_COLUMNS)
      .eq("user_id", userId)
      .eq("occurred_at", dateKey);
    return (data ?? []) as BalanceChange[];
  },
);

// Per-day everyday-spend overrides for today onward, as a date → amount map
// (set via the finance calendar's selected-day slider).
export const getSpendOverrides = cache(
  async (
    userId: string,
    timeZone?: string | null,
  ): Promise<Record<string, number>> => {
    const supabase = await createClient();
    const todayKey = todayISO(timeZone ?? null);
    const { data } = await supabase
      .from("spend_overrides")
      .select("date, amount")
      .eq("user_id", userId)
      .gte("date", todayKey);
    const out: Record<string, number> = {};
    for (const row of (data ?? []) as { date: string; amount: number }[]) {
      out[row.date] = Number(row.amount);
    }
    return out;
  },
);

// Trailing transaction history feeding the everyday-spend baseline (90 days
// comfortably covers the 12-week window).
//
// The ORDER BY is load-bearing, not cosmetic: without it Postgres may return
// rows in any order, so the cap would truncate an arbitrary subset at any
// volume and the baseline would train on it while still reporting confident.
// Descending, so an overflowing window costs historical depth (older weeks
// drop out of the 12-week median) rather than erasing the present.
//
// The order ends in `id` to make it TOTAL. `occurred_at` is a `date`, and
// `created_at` defaults to now() = TRANSACTION time, so every row of one
// statement-import batch carries an identical timestamp; without the primary
// key the cap boundary would still fall arbitrarily inside that tie group.
export const getSpendHistory = cache(
  async (
    userId: string,
    days = 90,
    timeZone?: string | null,
  ): Promise<SpendHistoryRow[]> => {
    const supabase = await createClient();
    const startKey = addDaysKey(todayISO(timeZone ?? null), -days);
    const { data } = await supabase
      .from("balance_changes")
      .select("occurred_at, direction, amount, category_id, is_transfer")
      .eq("user_id", userId)
      .gte("occurred_at", startKey)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(2000);
    return ((data ?? []) as SpendHistoryRow[]).map((row) => ({
      ...row,
      amount: Number(row.amount),
    }));
  },
);
