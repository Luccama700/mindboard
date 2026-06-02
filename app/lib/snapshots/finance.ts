// Pure finance rollup for the dashboard vitals strip. No React, no server
// imports — composes raw reads + the tested finance projection so it can be unit
// tested. Net worth = sum of account balances (same definition the finance
// calendar anchors on).

import {
  addDaysKey,
  ruleLandsOn,
  type RecurringRule,
} from "@/app/_components/finance-projection";
import type {
  Account,
  BalanceChange,
  RecurringExpense,
} from "@/app/_components/finance-types";

export type NextBill = { name: string; amount: number; dateKey: string };

export type FinanceVitals = {
  netWorth: number;
  currency: string;
  todayDelta: number;
  nextBill: NextBill | null;
};

// How far forward to look for the next recurring bill.
const LOOKAHEAD_DAYS = 62;

function toRule(expense: RecurringExpense): RecurringRule {
  return {
    frequency: expense.frequency,
    day_of_month: expense.day_of_month,
    weekday: expense.weekday,
    interval_days: expense.interval_days,
    start_date: expense.start_date,
    amount: Number(expense.amount),
  };
}

// The soonest recurring expense landing strictly after today, scanning forward
// day by day. If several land on the same soonest day, the first listed wins.
function findNextBill(
  expenses: RecurringExpense[],
  today: string,
  lookahead: number,
): NextBill | null {
  const rules = expenses.map((expense) => ({
    rule: toRule(expense),
    name: expense.name,
    amount: Number(expense.amount),
  }));

  for (let offset = 1; offset <= lookahead; offset++) {
    const dateKey = addDaysKey(today, offset);
    const date = new Date(`${dateKey}T00:00:00`);
    for (const { rule, name, amount } of rules) {
      if (ruleLandsOn(rule, date)) return { name, amount, dateKey };
    }
  }
  return null;
}

export function financeSnapshot(input: {
  accounts: Account[];
  todayChanges: BalanceChange[];
  recurringExpenses: RecurringExpense[];
  today: string;
}): FinanceVitals {
  const { accounts, todayChanges, recurringExpenses, today } = input;

  const netWorth = accounts.reduce((sum, a) => sum + Number(a.balance), 0);
  const currency = accounts[0]?.currency ?? "USD";

  const todayDelta = todayChanges.reduce(
    (sum, c) =>
      sum + (c.direction === "in" ? Number(c.amount) : -Number(c.amount)),
    0,
  );

  return {
    netWorth,
    currency,
    todayDelta,
    nextBill: findNextBill(recurringExpenses, today, LOOKAHEAD_DAYS),
  };
}
