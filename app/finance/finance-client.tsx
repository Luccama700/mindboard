"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { FinanceCalendar } from "@/app/_components/finance-calendar";
import { todayISO } from "@/app/_components/date-utils";
import {
  formatMoney,
  formatSignedChange,
  sumMoney,
} from "@/app/_components/money";
import type {
  Account,
  AccountType,
  BalanceChange,
  IncomeSource,
  RecurringExpense,
  SpendingCategory,
  SpendLimit,
  SpendLimitPeriod,
  SpendLimitScope,
} from "@/app/_components/finance-types";
import type { SpendRate } from "@/app/_components/spend-baseline";
import { computeLimitStatuses } from "@/app/_components/spend-limits";
import {
  archiveAccount,
  archiveSpendLimit,
  createAccount,
  createCategory,
  createSpendLimit,
  deleteBalanceChange,
  recordBalanceChange,
  updateAccount,
  updateBalanceChange,
  updateSpendLimit,
} from "@/app/actions/finance";
import { AccountRow, AddAccountForm } from "./accounts-section";
import { categoriesReducer, toCents } from "./finance-shared";
import { SpendLimitsSection } from "./spend-limits-section";

type AccountAction =
  | { kind: "add"; account: Account }
  | { kind: "replace"; tempId: string; account: Account }
  | { kind: "update"; id: string; patch: Partial<Account> }
  | { kind: "remove"; id: string };

type ChangeAction =
  | { kind: "add"; change: BalanceChange }
  | { kind: "addMany"; changes: BalanceChange[] }
  | { kind: "replace"; tempId: string; change: BalanceChange }
  | { kind: "replaceMany"; tempIds: string[]; changes: BalanceChange[] }
  | { kind: "update"; id: string; patch: Partial<BalanceChange> }
  | { kind: "remove"; id: string };

type LimitAction =
  | { kind: "add"; limit: SpendLimit }
  | { kind: "replace"; tempId: string; limit: SpendLimit }
  | { kind: "update"; id: string; patch: Partial<SpendLimit> }
  | { kind: "remove"; id: string };

export function FinanceClient({
  initialAccounts,
  initialCategories,
  initialChanges,
  expenses,
  incomeSources,
  financeMonth,
  hoursBySource,
  googleStatus,
  spendRate,
  manualSpendEstimate,
  spendOverrides,
  initialSpendLimits,
}: {
  initialAccounts: Account[];
  initialCategories: SpendingCategory[];
  initialChanges: BalanceChange[];
  expenses: RecurringExpense[];
  incomeSources: IncomeSource[];
  financeMonth: string;
  hoursBySource: Record<string, Record<string, number>>;
  googleStatus: "connected" | "connect" | "error";
  spendRate: SpendRate;
  manualSpendEstimate: number | null;
  spendOverrides: Record<string, number>;
  initialSpendLimits: SpendLimit[];
}) {
  const [accounts, dispatchAccounts] = useOptimistic<Account[], AccountAction>(
    initialAccounts,
    (state, action) => {
      switch (action.kind) {
        case "add":
          return [...state, action.account];
        case "replace":
          return state.map((a) =>
            a.id === action.tempId ? action.account : a,
          );
        case "update":
          return state.map((a) =>
            a.id === action.id ? { ...a, ...action.patch } : a,
          );
        case "remove":
          return state.filter((a) => a.id !== action.id);
      }
    },
  );

  const [categories, dispatchCategories] = useOptimistic(
    initialCategories,
    categoriesReducer,
  );

  const [changes, dispatchChanges] = useOptimistic<BalanceChange[], ChangeAction>(
    initialChanges,
    (state, action) => {
      switch (action.kind) {
        case "add":
          return [action.change, ...state];
        case "addMany":
          return [...action.changes, ...state];
        case "replace":
          return state.map((c) =>
            c.id === action.tempId ? action.change : c,
          );
        case "replaceMany": {
          const replacements = new Map(
            action.tempIds.map((id, i) => [id, action.changes[i]]),
          );
          return state.map((c) => replacements.get(c.id) ?? c);
        }
        case "update":
          return state.map((c) =>
            c.id === action.id ? { ...c, ...action.patch } : c,
          );
        case "remove":
          return state.filter((c) => c.id !== action.id);
      }
    },
  );

  const [spendLimits, dispatchLimits] = useOptimistic<SpendLimit[], LimitAction>(
    initialSpendLimits,
    (state, action) => {
      switch (action.kind) {
        case "add":
          return [...state, action.limit];
        case "replace":
          return state.map((l) =>
            l.id === action.tempId ? action.limit : l,
          );
        case "update":
          return state.map((l) =>
            l.id === action.id ? { ...l, ...action.patch } : l,
          );
        case "remove":
          return state.filter((l) => l.id !== action.id);
      }
    },
  );

  const [, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);

  const categoryById = useMemo(() => {
    const map = new Map<string, SpendingCategory>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  const changesByAccount = useMemo(() => {
    const map = new Map<string, BalanceChange[]>();
    for (const ch of changes) {
      const bucket = map.get(ch.account_id);
      if (bucket) bucket.push(ch);
      else map.set(ch.account_id, [ch]);
    }
    return map;
  }, [changes]);

  const baseCurrency = accounts[0]?.currency ?? "USD";
  const mixedCurrency = accounts.some((a) => a.currency !== baseCurrency);
  const netWorth = accounts.reduce((sum, a) => sum + Number(a.balance), 0);

  const today = todayISO();
  const todayDeltaByAccount = useMemo(() => {
    const map = new Map<string, number>();
    for (const ch of changes) {
      if (ch.occurred_at.slice(0, 10) !== today) continue;
      const signed =
        ch.direction === "out" ? -Number(ch.amount) : Number(ch.amount);
      map.set(ch.account_id, sumMoney([map.get(ch.account_id) ?? 0, signed]));
    }
    return map;
  }, [changes, today]);
  const todayDelta = sumMoney([...todayDeltaByAccount.values()]);

  // Spending-limit status: actual discretionary spend this period vs each cap,
  // recomputed from the same (optimistic) ledger rows and bill rules the
  // forecast baseline uses, so logging a spend moves the meters live.
  const limitStatusById = useMemo(() => {
    const rules = expenses.map((e) => ({
      amount: Number(e.amount),
      category_id: e.category_id,
    }));
    const statuses = computeLimitStatuses({
      limits: spendLimits,
      rows: changes,
      rules,
      today,
    });
    return new Map(statuses.map((s) => [s.limitId, s]));
  }, [spendLimits, changes, expenses, today]);

  function onCreateAccount(input: {
    name: string;
    type: AccountType;
    color: string;
    currency: string;
    balance: number;
  }) {
    const tempId = `temp-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimistic: Account = {
      id: tempId,
      name: input.name,
      type: input.type,
      color: input.color,
      balance: toCents(input.balance),
      currency: input.currency,
      archived: false,
      created_at: now,
      updated_at: now,
    };
    setAddOpen(false);
    startTransition(async () => {
      dispatchAccounts({ kind: "add", account: optimistic });
      const result = await createAccount(input);
      if (!result.error && result.account) {
        dispatchAccounts({
          kind: "replace",
          tempId,
          account: result.account as Account,
        });
      }
    });
  }

  function onUpdateAccount(id: string, patch: Partial<Account>) {
    startTransition(async () => {
      dispatchAccounts({ kind: "update", id, patch });
      await updateAccount({
        id,
        name: patch.name,
        type: patch.type,
        color: patch.color,
      });
    });
  }

  function onArchiveAccount(id: string) {
    startTransition(async () => {
      dispatchAccounts({ kind: "remove", id });
      await archiveAccount(id);
    });
  }

  function onRecordBalance(
    account: Account,
    input: {
      newBalance: number;
      occurredAt: string;
      allocations: { categoryId: string | null; amount: number }[];
      note: string | null;
    },
  ) {
    const current = Number(account.balance);
    const delta = toCents(input.newBalance - current);
    if (delta === 0) return;

    const direction: "in" | "out" = delta < 0 ? "out" : "in";

    startTransition(async () => {
      dispatchAccounts({
        kind: "update",
        id: account.id,
        patch: { balance: toCents(input.newBalance) },
      });

      // A categorized decrease, possibly split across categories -> one 'out'
      // row per allocation.
      if (direction === "out" && input.allocations.length > 0) {
        const tempRows: BalanceChange[] = input.allocations.map((a) => ({
          id: `temp-${crypto.randomUUID()}`,
          account_id: account.id,
          category_id: a.categoryId,
          direction: "out" as const,
          amount: a.amount,
          note: input.note,
          occurred_at: input.occurredAt,
          created_at: new Date().toISOString(),
          source: "manual" as const,
          is_transfer: false,
        }));
        dispatchChanges({ kind: "addMany", changes: tempRows });
        const result = await recordBalanceChange({
          accountId: account.id,
          newBalance: input.newBalance,
          occurredAt: input.occurredAt,
          allocations: input.allocations,
          note: input.note,
        });
        const inserted = "changes" in result ? result.changes : undefined;
        if (!result.error && inserted && inserted.length > 0) {
          dispatchChanges({
            kind: "replaceMany",
            tempIds: tempRows.map((r) => r.id),
            changes: inserted as BalanceChange[],
          });
        }
        return;
      }

      // A deposit (income): a single uncategorized row.
      const tempId = `temp-${crypto.randomUUID()}`;
      const optimistic: BalanceChange = {
        id: tempId,
        account_id: account.id,
        category_id: null,
        direction,
        amount: Math.abs(delta),
        note: input.note,
        occurred_at: input.occurredAt,
        created_at: new Date().toISOString(),
        source: "manual",
        is_transfer: false,
      };
      dispatchChanges({ kind: "add", change: optimistic });
      const result = await recordBalanceChange({
        accountId: account.id,
        newBalance: input.newBalance,
        occurredAt: input.occurredAt,
        note: input.note,
      });
      const inserted = "changes" in result ? result.changes : undefined;
      if (!result.error && inserted && inserted[0]) {
        dispatchChanges({
          kind: "replace",
          tempId,
          change: inserted[0] as BalanceChange,
        });
      }
    });
  }

  function onUpdateChange(id: string, patch: Partial<BalanceChange>) {
    startTransition(async () => {
      dispatchChanges({ kind: "update", id, patch });
      await updateBalanceChange({
        id,
        categoryId: patch.category_id,
        note: patch.note,
        occurredAt: patch.occurred_at,
        amount: patch.amount,
      });
    });
  }

  function onDeleteChange(id: string) {
    startTransition(async () => {
      dispatchChanges({ kind: "remove", id });
      await deleteBalanceChange(id);
    });
  }

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

  async function onCreateLimit(input: {
    scope: SpendLimitScope;
    categoryId: string | null;
    period: SpendLimitPeriod;
    amount: number;
  }): Promise<string | null> {
    const tempId = `temp-${crypto.randomUUID()}`;
    const optimistic: SpendLimit = {
      id: tempId,
      scope: input.scope,
      category_id: input.categoryId,
      period: input.period,
      amount: toCents(input.amount),
      archived: false,
      created_at: new Date().toISOString(),
    };
    startTransition(() => {
      dispatchLimits({ kind: "add", limit: optimistic });
    });
    const result = await createSpendLimit(input);
    if (result.error) {
      startTransition(() => {
        dispatchLimits({ kind: "remove", id: tempId });
      });
      return result.error;
    }
    if (result.limit) {
      startTransition(() => {
        dispatchLimits({
          kind: "replace",
          tempId,
          limit: result.limit as SpendLimit,
        });
      });
    }
    return null;
  }

  function onUpdateLimit(
    id: string,
    patch: { amount?: number; period?: SpendLimitPeriod },
  ) {
    startTransition(async () => {
      dispatchLimits({ kind: "update", id, patch });
      await updateSpendLimit({ id, amount: patch.amount, period: patch.period });
    });
  }

  function onArchiveLimit(id: string) {
    startTransition(async () => {
      dispatchLimits({ kind: "remove", id });
      await archiveSpendLimit(id);
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-16 lg:items-start">
      <div className="min-w-0" data-tour="accounts">
        <section>
          <p className="text-label uppercase text-muted">net worth</p>
          <p className="mt-1 text-display tabular-nums text-fg">
            {formatMoney(netWorth, baseCurrency)}
          </p>
          <p className="mt-1 text-meta tabular-nums">
            {todayDelta !== 0 ? (
              <span
                className={todayDelta > 0 ? "text-positive" : "text-danger"}
              >
                {formatSignedChange(
                  todayDelta,
                  todayDelta < 0 ? "out" : "in",
                  baseCurrency,
                )}{" "}
                today
              </span>
            ) : (
              <span className="text-muted">no change today</span>
            )}
            {mixedCurrency && (
              <span className="text-muted">
                {" "}
                · mixed currencies, totaled as {baseCurrency}
              </span>
            )}
          </p>
        </section>

        <ul className="mt-8" data-tour="ledger">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              todayDelta={todayDeltaByAccount.get(account.id) ?? 0}
              categories={categories}
              categoryById={categoryById}
              changes={changesByAccount.get(account.id) ?? []}
              onRecordBalance={onRecordBalance}
              onUpdateAccount={onUpdateAccount}
              onArchiveAccount={onArchiveAccount}
              onUpdateChange={onUpdateChange}
              onDeleteChange={onDeleteChange}
              onCreateCategory={onCreateCategory}
            />
          ))}
        </ul>

        {!addOpen ? (
          <button
            onClick={() => setAddOpen(true)}
            className="flex min-h-11 w-full items-center border-t border-b border-hairline text-left text-action lowercase text-muted hover:text-fg transition-colors"
          >
            + add account
          </button>
        ) : (
          <div className="border-t border-hairline pt-3">
            <AddAccountForm
              onCreate={onCreateAccount}
              onCancel={() => setAddOpen(false)}
            />
          </div>
        )}

        <SpendLimitsSection
          limits={spendLimits}
          statusById={limitStatusById}
          categories={categories}
          categoryById={categoryById}
          currency={baseCurrency}
          onCreate={onCreateLimit}
          onUpdate={onUpdateLimit}
          onArchive={onArchiveLimit}
        />
      </div>

      <aside className="min-w-0 lg:sticky lg:top-8" data-tour="finance-calendar">
        <FinanceCalendar
          month={financeMonth}
          currency={baseCurrency}
          netWorthToday={netWorth}
          changes={changes}
          expenses={expenses}
          incomeSources={incomeSources}
          hoursBySource={hoursBySource}
          googleStatus={googleStatus}
          spendRate={spendRate}
          manualSpendEstimate={manualSpendEstimate}
          spendOverrides={spendOverrides}
        />
      </aside>

      <Link
        href="/finance/setup"
        data-tour="recurring"
        className="flex min-h-11 items-center justify-between gap-3 border-t border-b border-hairline text-action lowercase text-fg hover:bg-card-hover transition-colors lg:col-start-1"
      >
        <span className="whitespace-nowrap">configure ▸</span>
        <span className="text-meta text-muted truncate">
          recurring · income · categories
        </span>
      </Link>
    </div>
  );
}
