import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import {
  GoogleCalendarConnectionError,
  listCalendars,
  type CalendarListEntry,
} from "@/utils/google/calendar";
import type {
  IncomeSource,
  RecurringExpense,
  SpendingCategory,
} from "@/app/_components/finance-types";
import { FinanceSetupClient } from "./setup-client";

export default async function FinanceSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [currencyResult, categoriesResult, expensesResult, incomeResult, calendars] =
    await Promise.all([
      supabase
        .from("accounts")
        .select("currency")
        .eq("archived", false)
        .order("created_at", { ascending: true })
        .limit(1),
      supabase
        .from("spending_categories")
        .select("id, name, color, archived, created_at")
        .eq("archived", false)
        .order("created_at", { ascending: false }),
      supabase
        .from("recurring_expenses")
        .select(
          "id, name, amount, category_id, frequency, day_of_month, weekday, interval_days, start_date, archived, created_at",
        )
        .eq("archived", false)
        .order("created_at", { ascending: false }),
      supabase
        .from("income_sources")
        .select(
          "id, name, hourly_wage, tax_rate, calendar_id, color, pay_frequency, anchor_payday, period_start, period_end, fixed_amount, fixed_day, archived, created_at",
        )
        .eq("archived", false)
        .order("created_at", { ascending: false }),
      listCalendars(user.id).catch((error): CalendarListEntry[] => {
        if (!(error instanceof GoogleCalendarConnectionError)) {
          console.error("listCalendars failed", error);
        }
        return [];
      }),
    ]);

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="mb-8 flex items-center justify-between">
        <Link
          href="/finance"
          className="flex min-h-11 items-center text-label uppercase text-muted hover:text-fg transition-colors"
        >
          ← money
        </Link>
        <h1 className="text-label uppercase text-muted">configure</h1>
      </header>

      <FinanceSetupClient
        initialCategories={(categoriesResult.data ?? []) as SpendingCategory[]}
        initialExpenses={(expensesResult.data ?? []) as RecurringExpense[]}
        initialIncomeSources={(incomeResult.data ?? []) as IncomeSource[]}
        calendars={calendars}
        currency={currencyResult.data?.[0]?.currency ?? "USD"}
      />
    </main>
  );
}
