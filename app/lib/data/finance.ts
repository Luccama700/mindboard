import "server-only";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import type {
  Account,
  BalanceChange,
  RecurringExpense,
} from "@/app/_components/finance-types";

// Reusable finance reads. Selects mirror app/finance/page.tsx; RLS scopes every
// row to the caller, so no explicit user_id filter is needed. Each read is
// React-cache()'d, so calling it from both the dashboard and the vitals strip in
// one request hits the database once. userId is the cache key.

const ACCOUNT_COLUMNS =
  "id, name, type, color, balance, currency, archived, created_at, updated_at";
const CHANGE_COLUMNS =
  "id, account_id, category_id, direction, amount, balance_after, note, occurred_at, created_at";
const RECURRING_COLUMNS =
  "id, name, amount, category_id, frequency, day_of_month, weekday, interval_days, start_date, archived, created_at";

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
