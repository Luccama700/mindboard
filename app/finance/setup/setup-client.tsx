"use client";

import { useMemo, useOptimistic, useTransition } from "react";
import type {
  IncomeSource,
  PayFrequency,
  RecurringExpense,
  RecurringFrequency,
  SpendingCategory,
} from "@/app/_components/finance-types";
import type { CalendarListEntry } from "@/utils/google/calendar";
import {
  archiveCategory,
  archiveIncomeSource,
  archiveRecurringExpense,
  createCategory,
  createIncomeSource,
  createRecurringExpense,
  updateCategory,
  updateIncomeSource,
  updateRecurringExpense,
} from "@/app/actions/finance";
import { CategoriesManager } from "../categories-section";
import { categoriesReducer } from "../finance-shared";
import { ExpensesManager } from "../recurring-expenses-section";
import { IncomeManager } from "../income-sources-section";

type ExpenseAction =
  | { kind: "add"; expense: RecurringExpense }
  | { kind: "update"; id: string; patch: Partial<RecurringExpense> }
  | { kind: "remove"; id: string };

type IncomeAction =
  | { kind: "add"; source: IncomeSource }
  | { kind: "update"; id: string; patch: Partial<IncomeSource> }
  | { kind: "remove"; id: string };

export function FinanceSetupClient({
  initialCategories,
  initialExpenses,
  initialIncomeSources,
  calendars,
  currency,
}: {
  initialCategories: SpendingCategory[];
  initialExpenses: RecurringExpense[];
  initialIncomeSources: IncomeSource[];
  calendars: CalendarListEntry[];
  currency: string;
}) {
  const [categories, dispatchCategories] = useOptimistic(
    initialCategories,
    categoriesReducer,
  );

  const [expenses, dispatchExpenses] = useOptimistic<
    RecurringExpense[],
    ExpenseAction
  >(initialExpenses, (state, action) => {
    switch (action.kind) {
      case "add":
        return [action.expense, ...state];
      case "update":
        return state.map((e) =>
          e.id === action.id ? { ...e, ...action.patch } : e,
        );
      case "remove":
        return state.filter((e) => e.id !== action.id);
    }
  });

  const [incomeSources, dispatchIncome] = useOptimistic<
    IncomeSource[],
    IncomeAction
  >(initialIncomeSources, (state, action) => {
    switch (action.kind) {
      case "add":
        return [action.source, ...state];
      case "update":
        return state.map((s) =>
          s.id === action.id ? { ...s, ...action.patch } : s,
        );
      case "remove":
        return state.filter((s) => s.id !== action.id);
    }
  });

  const [, startTransition] = useTransition();

  const categoryById = useMemo(() => {
    const map = new Map<string, SpendingCategory>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  async function onCreateCategory(input: {
    name: string;
    color: string;
  }): Promise<SpendingCategory | null> {
    const result = await createCategory(input);
    if (result.error || !result.category) return null;
    const category = result.category as SpendingCategory;
    startTransition(() => {
      dispatchCategories({ kind: "add", category });
    });
    return category;
  }

  function onUpdateCategory(id: string, patch: Partial<SpendingCategory>) {
    startTransition(async () => {
      dispatchCategories({ kind: "update", id, patch });
      await updateCategory({ id, name: patch.name, color: patch.color });
    });
  }

  function onArchiveCategory(id: string) {
    startTransition(async () => {
      dispatchCategories({ kind: "remove", id });
      await archiveCategory(id);
    });
  }

  async function onCreateExpense(input: {
    name: string;
    amount: number;
    categoryId: string | null;
    frequency: RecurringFrequency;
    dayOfMonth: number | null;
    weekday: number | null;
    intervalDays: number | null;
    startDate: string | null;
  }): Promise<boolean> {
    const result = await createRecurringExpense(input);
    if (result.error || !result.expense) return false;
    const expense = result.expense as RecurringExpense;
    startTransition(() => {
      dispatchExpenses({ kind: "add", expense });
    });
    return true;
  }

  function onUpdateExpense(id: string, patch: Partial<RecurringExpense>) {
    startTransition(async () => {
      dispatchExpenses({ kind: "update", id, patch });
      await updateRecurringExpense({
        id,
        name: patch.name,
        amount: patch.amount,
        categoryId: patch.category_id,
        frequency: patch.frequency,
        dayOfMonth: patch.day_of_month,
        weekday: patch.weekday,
        intervalDays: patch.interval_days,
        startDate: patch.start_date,
      });
    });
  }

  function onArchiveExpense(id: string) {
    startTransition(async () => {
      dispatchExpenses({ kind: "remove", id });
      await archiveRecurringExpense(id);
    });
  }

  async function onCreateIncome(input: {
    name: string;
    hourlyWage: number;
    taxRate: number;
    calendarId: string | null;
    color: string;
    payFrequency: PayFrequency | null;
    anchorPayday: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    fixedAmount: number | null;
    fixedDay: number | null;
  }): Promise<boolean> {
    const result = await createIncomeSource(input);
    if (result.error || !result.source) return false;
    const source = result.source as IncomeSource;
    startTransition(() => {
      dispatchIncome({ kind: "add", source });
    });
    return true;
  }

  function onUpdateIncome(id: string, patch: Partial<IncomeSource>) {
    startTransition(async () => {
      dispatchIncome({ kind: "update", id, patch });
      await updateIncomeSource({
        id,
        name: patch.name,
        hourlyWage: patch.hourly_wage,
        taxRate: patch.tax_rate,
        calendarId: patch.calendar_id,
        color: patch.color,
        payFrequency: patch.pay_frequency,
        anchorPayday: patch.anchor_payday,
        periodStart: patch.period_start,
        periodEnd: patch.period_end,
        fixedAmount: patch.fixed_amount,
        fixedDay: patch.fixed_day,
      });
    });
  }

  function onArchiveIncome(id: string) {
    startTransition(async () => {
      dispatchIncome({ kind: "remove", id });
      await archiveIncomeSource(id);
    });
  }

  return (
    <div className="space-y-8">
      <ExpensesManager
        expenses={expenses}
        categories={categories}
        categoryById={categoryById}
        currency={currency}
        onCreate={onCreateExpense}
        onUpdate={onUpdateExpense}
        onArchive={onArchiveExpense}
      />

      <IncomeManager
        incomeSources={incomeSources}
        calendars={calendars}
        currency={currency}
        onCreate={onCreateIncome}
        onUpdate={onUpdateIncome}
        onArchive={onArchiveIncome}
      />

      <CategoriesManager
        categories={categories}
        onCreate={onCreateCategory}
        onUpdate={onUpdateCategory}
        onArchive={onArchiveCategory}
      />
    </div>
  );
}
