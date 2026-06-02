"use client";

import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import { ColorPicker, PALETTE } from "@/app/_components/color-picker";
import { FinanceCalendar } from "@/app/_components/finance-calendar";
import { formatDue, todayISO } from "@/app/_components/date-utils";
import { addDaysKey } from "@/app/_components/finance-projection";
import {
  formatMoney,
  formatSignedChange,
  splitEvenly,
  sumMoney,
} from "@/app/_components/money";
import type {
  Account,
  AccountType,
  BalanceChange,
  IncomeSource,
  PayFrequency,
  RecurringExpense,
  RecurringFrequency,
  SpendingCategory,
} from "@/app/_components/finance-types";
import type { CalendarListEntry } from "@/utils/google/calendar";
import {
  archiveAccount,
  archiveCategory,
  archiveIncomeSource,
  archiveRecurringExpense,
  createAccount,
  createCategory,
  createIncomeSource,
  createRecurringExpense,
  recordBalanceChange,
  updateAccount,
  updateBalanceChange,
  updateCategory,
  updateIncomeSource,
  updateRecurringExpense,
} from "@/app/actions/finance";

const ACCOUNT_TYPES: AccountType[] = [
  "checking",
  "savings",
  "cash",
  "credit",
  "investment",
  "other",
];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type AccountAction =
  | { kind: "add"; account: Account }
  | { kind: "replace"; tempId: string; account: Account }
  | { kind: "update"; id: string; patch: Partial<Account> }
  | { kind: "remove"; id: string };

type CategoryAction =
  | { kind: "add"; category: SpendingCategory }
  | { kind: "replace"; tempId: string; category: SpendingCategory }
  | { kind: "update"; id: string; patch: Partial<SpendingCategory> }
  | { kind: "remove"; id: string };

type ChangeAction =
  | { kind: "add"; change: BalanceChange }
  | { kind: "addMany"; changes: BalanceChange[] }
  | { kind: "replace"; tempId: string; change: BalanceChange }
  | { kind: "replaceMany"; tempIds: string[]; changes: BalanceChange[] }
  | { kind: "update"; id: string; patch: Partial<BalanceChange> };

type ExpenseAction =
  | { kind: "add"; expense: RecurringExpense }
  | { kind: "update"; id: string; patch: Partial<RecurringExpense> }
  | { kind: "remove"; id: string };

type IncomeAction =
  | { kind: "add"; source: IncomeSource }
  | { kind: "update"; id: string; patch: Partial<IncomeSource> }
  | { kind: "remove"; id: string };

function toCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatSchedule(expense: RecurringExpense): string {
  switch (expense.frequency) {
    case "daily":
      return "every day";
    case "weekly": {
      const label =
        expense.weekday !== null ? WEEKDAY_LABELS[expense.weekday] : "—";
      return `weekly · ${label}`;
    }
    case "custom": {
      const n = expense.interval_days ?? 0;
      return n === 1 ? "every day" : `every ${n} days`;
    }
    default:
      return `monthly · day ${expense.day_of_month ?? "—"}`;
  }
}

export function FinanceClient({
  initialAccounts,
  initialCategories,
  initialChanges,
  initialExpenses,
  initialIncomeSources,
  calendars,
  financeMonth,
  hoursBySource,
  googleStatus,
}: {
  initialAccounts: Account[];
  initialCategories: SpendingCategory[];
  initialChanges: BalanceChange[];
  initialExpenses: RecurringExpense[];
  initialIncomeSources: IncomeSource[];
  calendars: CalendarListEntry[];
  financeMonth: string;
  hoursBySource: Record<string, Record<string, number>>;
  googleStatus: "connected" | "connect" | "error";
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

  const [categories, dispatchCategories] = useOptimistic<
    SpendingCategory[],
    CategoryAction
  >(initialCategories, (state, action) => {
    switch (action.kind) {
      case "add":
        return [action.category, ...state];
      case "replace":
        return state.map((c) =>
          c.id === action.tempId ? action.category : c,
        );
      case "update":
        return state.map((c) =>
          c.id === action.id ? { ...c, ...action.patch } : c,
        );
      case "remove":
        return state.filter((c) => c.id !== action.id);
    }
  });

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
      }
    },
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
      // row per allocation, with a running balance_after ending at newBalance.
      if (direction === "out" && input.allocations.length > 0) {
        let running = current;
        const tempRows: BalanceChange[] = input.allocations.map((a) => {
          running = toCents(running - a.amount);
          return {
            id: `temp-${crypto.randomUUID()}`,
            account_id: account.id,
            category_id: a.categoryId,
            direction: "out",
            amount: a.amount,
            balance_after: running,
            note: input.note,
            occurred_at: input.occurredAt,
            created_at: new Date().toISOString(),
          };
        });
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
        balance_after: toCents(input.newBalance),
        note: input.note,
        occurred_at: input.occurredAt,
        created_at: new Date().toISOString(),
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
      });
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
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-16 lg:items-start">
      <div className="min-w-0 space-y-8">
        <section className="border border-line bg-card p-5">
          <p className="text-[10px] tracking-widest uppercase text-muted">
            net worth
          </p>
          <p className="mt-1 text-4xl font-bold tracking-tight text-fg tabular-nums">
            {formatMoney(netWorth, baseCurrency)}
          </p>
          <p className="mt-1 text-xs text-muted">
            {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
            {mixedCurrency && " · mixed currencies, totaled as " + baseCurrency}
          </p>
        </section>

        <section className="space-y-3">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              categories={categories}
              categoryById={categoryById}
              changes={changesByAccount.get(account.id) ?? []}
              onRecordBalance={onRecordBalance}
              onUpdateAccount={onUpdateAccount}
              onArchiveAccount={onArchiveAccount}
              onUpdateChange={onUpdateChange}
              onCreateCategory={onCreateCategory}
            />
          ))}

          {!addOpen ? (
            <button
              onClick={() => setAddOpen(true)}
              className="w-full text-left bg-transparent border border-dashed border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-5 px-4 transition-colors"
            >
              + add account
            </button>
          ) : (
            <AddAccountForm
              onCreate={onCreateAccount}
              onCancel={() => setAddOpen(false)}
            />
          )}
        </section>

        <ExpensesManager
          expenses={expenses}
          categories={categories}
          categoryById={categoryById}
          currency={baseCurrency}
          onCreate={onCreateExpense}
          onUpdate={onUpdateExpense}
          onArchive={onArchiveExpense}
        />

        <IncomeManager
          incomeSources={incomeSources}
          calendars={calendars}
          currency={baseCurrency}
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

      <aside className="min-w-0 lg:sticky lg:top-8">
        <FinanceCalendar
          month={financeMonth}
          currency={baseCurrency}
          netWorthToday={netWorth}
          changes={changes}
          expenses={expenses}
          incomeSources={incomeSources}
          hoursBySource={hoursBySource}
          googleStatus={googleStatus}
        />
      </aside>
    </div>
  );
}

function AccountTypePicker({
  value,
  onChange,
}: {
  value: AccountType;
  onChange: (t: AccountType) => void;
}) {
  return (
    <div>
      <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
        type
      </p>
      <div className="flex flex-wrap gap-2">
        {ACCOUNT_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={`text-xs px-3 py-2 border transition-colors ${
              value === t
                ? "bg-fg text-accent-fg border-fg"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function AccountCard({
  account,
  categories,
  categoryById,
  changes,
  onRecordBalance,
  onUpdateAccount,
  onArchiveAccount,
  onUpdateChange,
  onCreateCategory,
}: {
  account: Account;
  categories: SpendingCategory[];
  categoryById: Map<string, SpendingCategory>;
  changes: BalanceChange[];
  onRecordBalance: (
    account: Account,
    input: {
      newBalance: number;
      occurredAt: string;
      allocations: { categoryId: string | null; amount: number }[];
      note: string | null;
    },
  ) => void;
  onUpdateAccount: (id: string, patch: Partial<Account>) => void;
  onArchiveAccount: (id: string) => void;
  onUpdateChange: (id: string, patch: Partial<BalanceChange>) => void;
  onCreateCategory: (input: {
    name: string;
    color: string;
  }) => Promise<SpendingCategory | null>;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);

  const visibleChanges = showAllHistory ? changes : changes.slice(0, 5);

  return (
    <div className="border border-line bg-card">
      <div className="flex items-stretch">
        <div className="flex flex-1 items-center gap-3 px-4 py-4 min-w-0">
          <span
            className="w-2 h-12 flex-shrink-0"
            style={{ backgroundColor: account.color }}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-fg text-base font-bold truncate">
              {account.name}
            </p>
            <p className="text-muted text-xs tracking-widest uppercase mt-0.5">
              {account.type}
            </p>
          </div>
          <p className="text-fg text-xl font-bold tabular-nums whitespace-nowrap">
            {formatMoney(Number(account.balance), account.currency)}
          </p>
        </div>
        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="account actions"
          className="px-4 border-l border-line text-muted hover:text-fg hover:bg-card-hover transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <AccountEditPanel
          account={account}
          onUpdate={onUpdateAccount}
          onArchive={(id) => {
            setEditOpen(false);
            onArchiveAccount(id);
          }}
        />
      )}

      <div className="border-t border-line px-4 py-3">
        {!updateOpen ? (
          <button
            onClick={() => setUpdateOpen(true)}
            className="text-xs tracking-widest uppercase px-3 py-2 border border-fg text-fg hover:bg-fg hover:text-page transition-colors"
          >
            update balance
          </button>
        ) : (
          <BalanceUpdatePanel
            account={account}
            categories={categories}
            onCreateCategory={onCreateCategory}
            onSubmit={(input) => {
              onRecordBalance(account, input);
              setUpdateOpen(false);
            }}
            onCancel={() => setUpdateOpen(false)}
          />
        )}
      </div>

      {changes.length > 0 && (
        <div className="border-t border-line">
          <ul>
            {visibleChanges.map((change) => (
              <HistoryRow
                key={change.id}
                change={change}
                categories={categories}
                categoryById={categoryById}
                currency={account.currency}
                onUpdateChange={onUpdateChange}
              />
            ))}
          </ul>
          {changes.length > 5 && (
            <button
              onClick={() => setShowAllHistory((v) => !v)}
              className="w-full text-[10px] tracking-widest uppercase text-muted hover:text-fg py-2 transition-colors"
            >
              {showAllHistory ? "show less" : `show all ${changes.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AccountEditPanel({
  account,
  onUpdate,
  onArchive,
}: {
  account: Account;
  onUpdate: (id: string, patch: Partial<Account>) => void;
  onArchive: (id: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(account.name);

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === account.name) {
      setNameDraft(account.name);
      return;
    }
    onUpdate(account.id, { name: next });
  }

  return (
    <div className="border-t border-line p-4 space-y-5">
      <input
        type="text"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setNameDraft(account.name);
            e.currentTarget.blur();
          }
        }}
        maxLength={64}
        aria-label="account name"
        className="w-full bg-transparent text-fg text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />

      <AccountTypePicker
        value={account.type}
        onChange={(t) => onUpdate(account.id, { type: t })}
      />

      <ColorPicker
        value={account.color}
        onChange={(c) => onUpdate(account.id, { color: c })}
      />

      <div className="flex justify-end pt-2">
        <button
          onClick={() => onArchive(account.id)}
          className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-2 px-3"
        >
          archive
        </button>
      </div>
    </div>
  );
}

function BalanceUpdatePanel({
  account,
  categories,
  onCreateCategory,
  onSubmit,
  onCancel,
}: {
  account: Account;
  categories: SpendingCategory[];
  onCreateCategory: (input: {
    name: string;
    color: string;
  }) => Promise<SpendingCategory | null>;
  onSubmit: (input: {
    newBalance: number;
    occurredAt: string;
    allocations: { categoryId: string | null; amount: number }[];
    note: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const current = Number(account.balance);
  const [amountDraft, setAmountDraft] = useState(String(current));
  const [occurredAt, setOccurredAt] = useState(todayISO());
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // null = single-category mode; an array = split across multiple categories.
  const [splits, setSplits] = useState<
    { categoryId: string | null; amount: string }[] | null
  >(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    amountRef.current?.focus();
    amountRef.current?.select();
  }, []);

  const parsed = Number(amountDraft);
  const valid = amountDraft.trim() !== "" && Number.isFinite(parsed);
  const delta = valid ? toCents(parsed - current) : 0;
  const isDeduction = delta < 0;
  const total = Math.abs(delta);

  const splitSum = splits
    ? sumMoney(splits.map((s) => Number(s.amount) || 0))
    : total;
  const remaining = toCents(total - splitSum);
  const splitBalanced = splits
    ? remaining === 0 && splits.every((s) => (Number(s.amount) || 0) > 0)
    : true;

  function enterSplit() {
    const even = splitEvenly(total, 2);
    setSplits([
      { categoryId, amount: String(even[0]) },
      { categoryId: null, amount: String(even[1]) },
    ]);
  }

  function exitSplit() {
    setCategoryId(splits?.[0]?.categoryId ?? categoryId);
    setSplits(null);
  }

  function addSplitRow() {
    if (!splits) return;
    setSplits([
      ...splits,
      { categoryId: null, amount: String(remaining > 0 ? remaining : 0) },
    ]);
  }

  function removeSplitRow(index: number) {
    if (!splits) return;
    const next = splits.filter((_, i) => i !== index);
    if (next.length <= 1) {
      setCategoryId(next[0]?.categoryId ?? null);
      setSplits(null);
    } else {
      setSplits(next);
    }
  }

  function evenSplit() {
    if (!splits) return;
    const even = splitEvenly(total, splits.length);
    setSplits(splits.map((s, i) => ({ ...s, amount: String(even[i]) })));
  }

  function setSplitCategory(index: number, catId: string | null) {
    if (!splits) return;
    setSplits(
      splits.map((s, i) => (i === index ? { ...s, categoryId: catId } : s)),
    );
  }

  function setSplitAmount(index: number, amount: string) {
    if (!splits) return;
    setSplits(splits.map((s, i) => (i === index ? { ...s, amount } : s)));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) {
      setError("enter a valid amount");
      return;
    }
    if (delta === 0) {
      onCancel();
      return;
    }

    let allocations: { categoryId: string | null; amount: number }[] = [];
    if (isDeduction) {
      if (splits) {
        if (!splitBalanced) {
          setError(
            `splits must add up to ${formatMoney(total, account.currency)}`,
          );
          return;
        }
        allocations = splits.map((s) => ({
          categoryId: s.categoryId,
          amount: Number(s.amount),
        }));
      } else {
        allocations = [{ categoryId, amount: total }];
      }
    }

    onSubmit({
      newBalance: parsed,
      occurredAt,
      allocations,
      note: note.trim() || null,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <label
          htmlFor={`balance-${account.id}`}
          className="text-[10px] tracking-widest uppercase text-muted"
        >
          new balance
        </label>
        <input
          ref={amountRef}
          id={`balance-${account.id}`}
          type="number"
          inputMode="decimal"
          step="any"
          value={amountDraft}
          onChange={(e) => setAmountDraft(e.target.value)}
          className="w-full bg-card border border-line-strong focus:border-accent text-fg text-lg font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
        />
      </div>

      {valid && delta !== 0 && (
        <p
          className="text-xs font-bold tabular-nums"
          style={{ color: isDeduction ? "var(--danger)" : "var(--accent)" }}
        >
          {formatSignedChange(delta, isDeduction ? "out" : "in", account.currency)}
          {isDeduction ? " · where did it go?" : " · added as income"}
        </p>
      )}

      {isDeduction && !splits && (
        <div className="space-y-2">
          <CategoryField
            value={categoryId}
            categories={categories}
            onChange={setCategoryId}
            onCreateCategory={onCreateCategory}
          />
          <button
            type="button"
            onClick={enterSplit}
            className="text-[10px] tracking-widest uppercase text-muted hover:text-accent transition-colors"
          >
            + split across categories
          </button>
        </div>
      )}

      {isDeduction && splits && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              split · where did it go?
            </p>
            <button
              type="button"
              onClick={exitSplit}
              className="text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
            >
              single category
            </button>
          </div>

          <div className="space-y-2">
            {splits.map((s, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-1 min-w-0">
                  <CategoryField
                    value={s.categoryId}
                    categories={categories}
                    onChange={(catId) => setSplitCategory(i, catId)}
                    onCreateCategory={onCreateCategory}
                    hideLabel
                  />
                </div>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={s.amount}
                  onChange={(e) => setSplitAmount(i, e.target.value)}
                  aria-label="split amount"
                  className="w-24 bg-card border border-line-strong focus:border-accent text-fg text-sm tabular-nums px-2 py-2 focus:outline-none transition-colors"
                />
                <button
                  type="button"
                  onClick={() => removeSplitRow(i)}
                  aria-label="remove split"
                  className="px-2 py-2 text-muted hover:text-danger transition-colors"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <div className="flex gap-3">
              <button
                type="button"
                onClick={addSplitRow}
                className="text-[10px] tracking-widest uppercase text-muted hover:text-accent transition-colors"
              >
                + add
              </button>
              <button
                type="button"
                onClick={evenSplit}
                className="text-[10px] tracking-widest uppercase text-muted hover:text-accent transition-colors"
              >
                even
              </button>
            </div>
            <p
              className="text-[10px] tracking-widest uppercase tabular-nums"
              style={{
                color: remaining === 0 ? "var(--muted)" : "var(--danger)",
              }}
            >
              {remaining === 0
                ? `${formatMoney(total, account.currency)} allocated`
                : remaining > 0
                  ? `${formatMoney(remaining, account.currency)} left`
                  : `${formatMoney(-remaining, account.currency)} over`}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <label
          htmlFor={`date-${account.id}`}
          className="text-[10px] tracking-widest uppercase text-muted"
        >
          date
        </label>
        <input
          id={`date-${account.id}`}
          type="date"
          value={occurredAt}
          onChange={(e) => setOccurredAt(e.target.value || todayISO())}
          className="w-full bg-card border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
        />
      </div>

      <div className="space-y-2">
        <label
          htmlFor={`note-${account.id}`}
          className="text-[10px] tracking-widest uppercase text-muted"
        >
          note
        </label>
        <input
          id={`note-${account.id}`}
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="optional"
          maxLength={200}
          className="w-full bg-card border border-line-strong focus:border-accent text-fg placeholder-muted text-sm px-3 py-2 focus:outline-none transition-colors"
        />
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isDeduction && !!splits && !splitBalanced}
          className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors disabled:opacity-50"
        >
          record
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 text-muted text-sm hover:text-fg transition-colors"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

function CategoryField({
  value,
  categories,
  onChange,
  onCreateCategory,
  hideLabel = false,
}: {
  value: string | null;
  categories: SpendingCategory[];
  onChange: (id: string | null) => void;
  onCreateCategory: (input: {
    name: string;
    color: string;
  }) => Promise<SpendingCategory | null>;
  hideLabel?: boolean;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [isPending, startTransition] = useTransition();

  function createNew() {
    const n = name.trim();
    if (!n) return;
    startTransition(async () => {
      const created = await onCreateCategory({ name: n, color });
      if (created) {
        onChange(created.id);
        setNewOpen(false);
        setName("");
        setColor(PALETTE[0]);
      }
    });
  }

  return (
    <div className="space-y-2">
      {!hideLabel && (
        <p className="text-[10px] tracking-widest uppercase text-muted">
          category
        </p>
      )}
      <div className="flex items-center gap-2">
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label="spending category"
          className="flex-1 min-w-0 bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
        >
          <option value="">uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setNewOpen((v) => !v)}
          aria-expanded={newOpen}
          className="px-3 py-2 border border-dashed border-line-strong text-muted text-xs hover:border-accent hover:text-accent transition-colors"
        >
          + new
        </button>
      </div>

      {newOpen && (
        <div className="border border-line p-3 space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            type="text"
            placeholder="category name"
            maxLength={64}
            autoComplete="off"
            className="w-full bg-transparent text-fg placeholder-muted text-sm font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
          />
          <ColorPicker value={color} onChange={setColor} />
          <button
            type="button"
            onClick={createNew}
            disabled={isPending}
            className="text-xs tracking-widest uppercase px-3 py-2 border border-fg text-fg hover:bg-fg hover:text-page transition-colors disabled:opacity-50"
          >
            add category
          </button>
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  change,
  categories,
  categoryById,
  currency,
  onUpdateChange,
}: {
  change: BalanceChange;
  categories: SpendingCategory[];
  categoryById: Map<string, SpendingCategory>;
  currency: string;
  onUpdateChange: (id: string, patch: Partial<BalanceChange>) => void;
}) {
  const [open, setOpen] = useState(false);
  const category = change.category_id
    ? (categoryById.get(change.category_id) ?? null)
    : null;
  const isOut = change.direction === "out";
  const label = isOut
    ? (category?.name ?? "uncategorized")
    : (change.note || "income");
  const swatch = isOut ? (category?.color ?? "var(--muted)") : "var(--accent)";

  return (
    <li className="border-t border-line first:border-t-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-card-hover transition-colors"
      >
        <span
          className="w-2.5 h-2.5 flex-shrink-0"
          style={{ backgroundColor: swatch }}
          aria-hidden
        />
        <span className="flex-1 min-w-0 truncate text-sm text-fg">{label}</span>
        <span className="text-[10px] tracking-widest uppercase text-muted">
          {formatDue(change.occurred_at)}
        </span>
        <span
          className="text-sm font-bold tabular-nums whitespace-nowrap"
          style={{ color: isOut ? "var(--danger)" : "var(--accent)" }}
        >
          {formatSignedChange(Number(change.amount), change.direction, currency)}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-3">
          {isOut && (
            <div className="space-y-1">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                category
              </p>
              <select
                value={change.category_id ?? ""}
                onChange={(e) =>
                  onUpdateChange(change.id, {
                    category_id: e.target.value || null,
                  })
                }
                aria-label="change category"
                className="w-full bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
              >
                <option value="">uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              note
            </p>
            <input
              type="text"
              defaultValue={change.note ?? ""}
              onBlur={(e) => {
                const next = e.target.value.trim() || null;
                if (next !== (change.note ?? null)) {
                  onUpdateChange(change.id, { note: next });
                }
              }}
              placeholder="optional"
              maxLength={200}
              className="w-full bg-card border border-line-strong focus:border-accent text-fg placeholder-muted text-sm px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
          <p className="text-[10px] text-muted tabular-nums">
            balance after ·{" "}
            {formatMoney(Number(change.balance_after), currency)}
          </p>
        </div>
      )}
    </li>
  );
}

function AddAccountForm({
  onCreate,
  onCancel,
}: {
  onCreate: (input: {
    name: string;
    type: AccountType;
    color: string;
    currency: string;
    balance: number;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [currency, setCurrency] = useState("USD");
  const [balance, setBalance] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("name required");
      return;
    }
    const opening = Number(balance);
    if (!Number.isFinite(opening)) {
      setError("invalid opening balance");
      return;
    }
    onCreate({
      name: n,
      type,
      color,
      currency: currency.trim().toUpperCase() || "USD",
      balance: opening,
    });
  }

  return (
    <form onSubmit={submit} className="border border-line bg-card p-4 space-y-5">
      <p className="text-[10px] tracking-widest uppercase text-muted">
        new account
      </p>
      <input
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        type="text"
        placeholder="account name"
        maxLength={64}
        autoComplete="off"
        className="w-full bg-transparent text-fg placeholder-muted text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />

      <AccountTypePicker value={type} onChange={setType} />
      <ColorPicker value={color} onChange={setColor} />

      <div className="flex gap-3">
        <div className="flex-1 space-y-2">
          <label
            htmlFor="opening-balance"
            className="text-[10px] tracking-widest uppercase text-muted"
          >
            opening balance
          </label>
          <input
            id="opening-balance"
            type="number"
            inputMode="decimal"
            step="any"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            className="w-full bg-card border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
          />
        </div>
        <div className="w-24 space-y-2">
          <label
            htmlFor="currency"
            className="text-[10px] tracking-widest uppercase text-muted"
          >
            currency
          </label>
          <input
            id="currency"
            type="text"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            maxLength={3}
            className="w-full bg-card border border-line-strong focus:border-accent text-fg text-base uppercase px-3 py-2 focus:outline-none transition-colors"
          />
        </div>
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors"
        >
          create
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 text-muted text-sm hover:text-fg transition-colors"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

function CollapsibleSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-line pt-6">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[10px] tracking-widest uppercase text-muted">
          {title} · {count}
        </span>
        <span className="text-muted text-xs">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="mt-4 space-y-3">{children}</div>}
    </section>
  );
}

const FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  monthly: "monthly",
  weekly: "weekly",
  daily: "everyday",
  custom: "custom",
};

function RecurrencePicker({
  frequency,
  dayOfMonth,
  weekday,
  intervalDays,
  startDate,
  onFrequency,
  onDayOfMonth,
  onWeekday,
  onIntervalDays,
  onStartDate,
}: {
  frequency: RecurringFrequency;
  dayOfMonth: number;
  weekday: number;
  intervalDays: number;
  startDate: string;
  onFrequency: (f: RecurringFrequency) => void;
  onDayOfMonth: (d: number) => void;
  onWeekday: (w: number) => void;
  onIntervalDays: (n: number) => void;
  onStartDate: (d: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
          frequency
        </p>
        <div className="flex flex-wrap gap-2">
          {(["monthly", "weekly", "daily", "custom"] as RecurringFrequency[]).map(
            (f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFrequency(f)}
                className={`text-xs px-3 py-2 border transition-colors ${
                  frequency === f
                    ? "bg-fg text-accent-fg border-fg"
                    : "border-line-strong text-muted hover:border-fg hover:text-fg"
                }`}
              >
                {FREQUENCY_LABELS[f]}
              </button>
            ),
          )}
        </div>
      </div>

      {frequency === "monthly" && (
        <div>
          <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
            day of month
          </p>
          <input
            type="number"
            min={1}
            max={31}
            value={dayOfMonth}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) onDayOfMonth(Math.min(31, Math.max(1, n)));
            }}
            className="w-24 bg-card border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
          />
          <p className="mt-1 text-[10px] text-muted">
            days past the month&apos;s length land on its last day.
          </p>
        </div>
      )}

      {frequency === "weekly" && (
        <div>
          <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
            weekday
          </p>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_LABELS.map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => onWeekday(index)}
                className={`text-[11px] px-2.5 py-2 border transition-colors ${
                  weekday === index
                    ? "bg-fg text-accent-fg border-fg"
                    : "border-line-strong text-muted hover:border-fg hover:text-fg"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {frequency === "daily" && (
        <p className="text-[10px] text-muted">lands every day.</p>
      )}

      {frequency === "custom" && (
        <div className="flex gap-3">
          <div className="space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              every N days
            </p>
            <input
              type="number"
              min={1}
              max={366}
              value={intervalDays}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) {
                  onIntervalDays(Math.min(366, Math.max(1, n)));
                }
              }}
              className="w-24 bg-card border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
          <div className="flex-1 space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              starting
            </p>
            <input
              type="date"
              value={startDate}
              onChange={(e) => onStartDate(e.target.value || todayISO())}
              className="w-full bg-card border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ExpensesManager({
  expenses,
  categories,
  categoryById,
  currency,
  onCreate,
  onUpdate,
  onArchive,
}: {
  expenses: RecurringExpense[];
  categories: SpendingCategory[];
  categoryById: Map<string, SpendingCategory>;
  currency: string;
  onCreate: (input: {
    name: string;
    amount: number;
    categoryId: string | null;
    frequency: RecurringFrequency;
    dayOfMonth: number | null;
    weekday: number | null;
    intervalDays: number | null;
    startDate: string | null;
  }) => Promise<boolean>;
  onUpdate: (id: string, patch: Partial<RecurringExpense>) => void;
  onArchive: (id: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

  return (
    <CollapsibleSection title="recurring expenses" count={expenses.length}>
      <ul className="space-y-2">
        {expenses.map((expense) => (
          <ExpenseRow
            key={expense.id}
            expense={expense}
            categories={categories}
            categoryById={categoryById}
            currency={currency}
            onUpdate={onUpdate}
            onArchive={onArchive}
          />
        ))}
      </ul>

      {!formOpen ? (
        <button
          onClick={() => setFormOpen(true)}
          className="w-full text-left bg-transparent border border-dashed border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-4 px-4 transition-colors"
        >
          + new recurring expense
        </button>
      ) : (
        <ExpenseForm
          categories={categories}
          onCreate={onCreate}
          onClose={() => setFormOpen(false)}
        />
      )}
    </CollapsibleSection>
  );
}

function ExpenseForm({
  categories,
  onCreate,
  onClose,
}: {
  categories: SpendingCategory[];
  onCreate: (input: {
    name: string;
    amount: number;
    categoryId: string | null;
    frequency: RecurringFrequency;
    dayOfMonth: number | null;
    weekday: number | null;
    intervalDays: number | null;
    startDate: string | null;
  }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<RecurringFrequency>("monthly");
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [weekday, setWeekday] = useState(1);
  const [intervalDays, setIntervalDays] = useState(14);
  const [startDate, setStartDate] = useState(todayISO());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("name required");
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("enter an amount");
      return;
    }
    startTransition(async () => {
      const ok = await onCreate({
        name: n,
        amount: amt,
        categoryId,
        frequency,
        dayOfMonth: frequency === "monthly" ? dayOfMonth : null,
        weekday: frequency === "weekly" ? weekday : null,
        intervalDays: frequency === "custom" ? intervalDays : null,
        startDate: frequency === "custom" ? startDate : null,
      });
      if (!ok) {
        setError("could not save expense");
        return;
      }
      onClose();
    });
  }

  return (
    <form onSubmit={submit} className="border border-line bg-card p-4 space-y-5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        type="text"
        placeholder="expense name (e.g. rent)"
        maxLength={64}
        autoComplete="off"
        autoFocus
        className="w-full bg-transparent text-fg placeholder-muted text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />

      <div className="space-y-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">amount</p>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          placeholder="0.00"
          className="w-full bg-card border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
        />
      </div>

      <RecurrencePicker
        frequency={frequency}
        dayOfMonth={dayOfMonth}
        weekday={weekday}
        intervalDays={intervalDays}
        startDate={startDate}
        onFrequency={setFrequency}
        onDayOfMonth={setDayOfMonth}
        onWeekday={setWeekday}
        onIntervalDays={setIntervalDays}
        onStartDate={setStartDate}
      />

      <div className="space-y-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          category
        </p>
        <select
          value={categoryId ?? ""}
          onChange={(e) => setCategoryId(e.target.value || null)}
          aria-label="expense category"
          className="w-full bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
        >
          <option value="">uncategorized</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors disabled:opacity-50"
        >
          create
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-4 text-muted text-sm hover:text-fg transition-colors"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

function ExpenseRow({
  expense,
  categories,
  categoryById,
  currency,
  onUpdate,
  onArchive,
}: {
  expense: RecurringExpense;
  categories: SpendingCategory[];
  categoryById: Map<string, SpendingCategory>;
  currency: string;
  onUpdate: (id: string, patch: Partial<RecurringExpense>) => void;
  onArchive: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(expense.name);
  const [amountDraft, setAmountDraft] = useState(String(Number(expense.amount)));
  const category = expense.category_id
    ? (categoryById.get(expense.category_id) ?? null)
    : null;

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === expense.name) {
      setNameDraft(expense.name);
      return;
    }
    onUpdate(expense.id, { name: next });
  }

  function commitAmount() {
    const next = Number(amountDraft);
    if (!Number.isFinite(next) || next <= 0) {
      setAmountDraft(String(Number(expense.amount)));
      return;
    }
    const rounded = Math.round(next * 100) / 100;
    if (rounded !== Number(expense.amount)) {
      onUpdate(expense.id, { amount: rounded });
    }
    setAmountDraft(String(rounded));
  }

  return (
    <li className="border border-line bg-card">
      <div className="flex items-stretch">
        <div className="flex flex-1 items-center gap-3 px-4 py-3 min-w-0">
          <span
            className="w-2 h-8 flex-shrink-0 bg-danger"
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-fg text-sm font-bold truncate">{expense.name}</p>
            <p className="text-muted text-[10px] tracking-widest uppercase mt-0.5">
              {formatSchedule(expense)}
              {category ? ` · ${category.name}` : ""}
            </p>
          </div>
          <p className="text-danger text-sm font-bold tabular-nums whitespace-nowrap">
            −{formatMoney(Number(expense.amount), currency)}
          </p>
        </div>
        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="expense actions"
          className="px-4 border-l border-line text-muted hover:text-fg hover:bg-card-hover transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <div className="border-t border-line p-4 space-y-5">
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            maxLength={64}
            aria-label="expense name"
            className="w-full bg-transparent text-fg text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
          />

          <div className="space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              amount
            </p>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={amountDraft}
              onChange={(e) => setAmountDraft(e.target.value)}
              onBlur={commitAmount}
              className="w-full bg-card border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
            />
          </div>

          <RecurrencePicker
            frequency={expense.frequency}
            dayOfMonth={expense.day_of_month ?? 1}
            weekday={expense.weekday ?? 1}
            intervalDays={expense.interval_days ?? 14}
            startDate={expense.start_date ?? todayISO()}
            onFrequency={(f) =>
              onUpdate(expense.id, {
                frequency: f,
                day_of_month: f === "monthly" ? (expense.day_of_month ?? 1) : null,
                weekday: f === "weekly" ? (expense.weekday ?? 1) : null,
                interval_days: f === "custom" ? (expense.interval_days ?? 14) : null,
                start_date:
                  f === "custom" ? (expense.start_date ?? todayISO()) : null,
              })
            }
            onDayOfMonth={(d) => onUpdate(expense.id, { day_of_month: d })}
            onWeekday={(w) => onUpdate(expense.id, { weekday: w })}
            onIntervalDays={(n) => onUpdate(expense.id, { interval_days: n })}
            onStartDate={(d) => onUpdate(expense.id, { start_date: d })}
          />

          <div className="space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              category
            </p>
            <select
              value={expense.category_id ?? ""}
              onChange={(e) =>
                onUpdate(expense.id, { category_id: e.target.value || null })
              }
              aria-label="expense category"
              className="w-full bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
            >
              <option value="">uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                setEditOpen(false);
                onArchive(expense.id);
              }}
              className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-2 px-3"
            >
              delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function CalendarSelect({
  value,
  calendars,
  onChange,
}: {
  value: string | null;
  calendars: CalendarListEntry[];
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] tracking-widest uppercase text-muted">
        worked-hours calendar
      </p>
      {calendars.length === 0 ? (
        <p className="text-muted text-xs">
          sign in with calendar access to read your shifts.
        </p>
      ) : (
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label="worked-hours calendar"
          className="w-full bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
        >
          <option value="">none</option>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.summary}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

type PaySchedule = {
  payFrequency: PayFrequency | null;
  anchorPayday: string;
  periodStart: string;
  periodEnd: string;
};

const PAY_FREQUENCIES: PayFrequency[] = ["weekly", "biweekly", "monthly"];

function defaultSchedule(source?: IncomeSource): PaySchedule {
  return {
    payFrequency: source?.pay_frequency ?? null,
    anchorPayday: source?.anchor_payday ?? todayISO(),
    periodStart: source?.period_start ?? addDaysKey(todayISO(), -13),
    periodEnd: source?.period_end ?? addDaysKey(todayISO(), -1),
  };
}

// Income pay schedules are validated server-side as a unit, so the picker emits
// the whole schedule on every change rather than partial patches.
function PaySchedulePicker({
  value,
  onChange,
}: {
  value: PaySchedule;
  onChange: (next: PaySchedule) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
          pay schedule
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...value, payFrequency: null })}
            className={`text-xs px-3 py-2 border transition-colors ${
              value.payFrequency === null
                ? "bg-fg text-accent-fg border-fg"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            each shift
          </button>
          {PAY_FREQUENCIES.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onChange({ ...value, payFrequency: f })}
              className={`text-xs px-3 py-2 border transition-colors ${
                value.payFrequency === f
                  ? "bg-fg text-accent-fg border-fg"
                  : "border-line-strong text-muted hover:border-fg hover:text-fg"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {value.payFrequency && (
        <>
          <div className="space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              next payday
            </p>
            <input
              type="date"
              value={value.anchorPayday}
              onChange={(e) =>
                onChange({ ...value, anchorPayday: e.target.value || todayISO() })
              }
              className="w-full bg-card border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1 space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                pays for · from
              </p>
              <input
                type="date"
                value={value.periodStart}
                onChange={(e) =>
                  onChange({
                    ...value,
                    periodStart: e.target.value || value.periodStart,
                  })
                }
                className="w-full bg-card border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
            <div className="flex-1 space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                to
              </p>
              <input
                type="date"
                value={value.periodEnd}
                onChange={(e) =>
                  onChange({
                    ...value,
                    periodEnd: e.target.value || value.periodEnd,
                  })
                }
                className="w-full bg-card border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted">
            paydays repeat {value.payFrequency}; each covers a window that shifts
            the same way.
          </p>
        </>
      )}
    </div>
  );
}

function scheduleToPatch(next: PaySchedule): Partial<IncomeSource> {
  return {
    pay_frequency: next.payFrequency,
    anchor_payday: next.payFrequency ? next.anchorPayday : null,
    period_start: next.payFrequency ? next.periodStart : null,
    period_end: next.payFrequency ? next.periodEnd : null,
  };
}

function IncomeManager({
  incomeSources,
  calendars,
  currency,
  onCreate,
  onUpdate,
  onArchive,
}: {
  incomeSources: IncomeSource[];
  calendars: CalendarListEntry[];
  currency: string;
  onCreate: (input: {
    name: string;
    hourlyWage: number;
    taxRate: number;
    calendarId: string | null;
    color: string;
    payFrequency: PayFrequency | null;
    anchorPayday: string | null;
    periodStart: string | null;
    periodEnd: string | null;
  }) => Promise<boolean>;
  onUpdate: (id: string, patch: Partial<IncomeSource>) => void;
  onArchive: (id: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

  return (
    <CollapsibleSection title="income" count={incomeSources.length}>
      <p className="text-[11px] text-muted leading-relaxed">
        each job reads worked hours from a linked Google Calendar. pay = hours ×
        wage × (1 − tax%). with a pay schedule, it lands as a lump on each payday
        for that period&apos;s shifts; otherwise it lands on the day worked.
      </p>

      <ul className="space-y-2">
        {incomeSources.map((source) => (
          <IncomeRow
            key={source.id}
            source={source}
            calendars={calendars}
            currency={currency}
            onUpdate={onUpdate}
            onArchive={onArchive}
          />
        ))}
      </ul>

      {!formOpen ? (
        <button
          onClick={() => setFormOpen(true)}
          className="w-full text-left bg-transparent border border-dashed border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-4 px-4 transition-colors"
        >
          + new income source
        </button>
      ) : (
        <IncomeForm
          calendars={calendars}
          onCreate={onCreate}
          onClose={() => setFormOpen(false)}
        />
      )}
    </CollapsibleSection>
  );
}

function IncomeForm({
  calendars,
  onCreate,
  onClose,
}: {
  calendars: CalendarListEntry[];
  onCreate: (input: {
    name: string;
    hourlyWage: number;
    taxRate: number;
    calendarId: string | null;
    color: string;
    payFrequency: PayFrequency | null;
    anchorPayday: string | null;
    periodStart: string | null;
    periodEnd: string | null;
  }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [wage, setWage] = useState("");
  const [tax, setTax] = useState("0");
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [color, setColor] = useState<string>(PALETTE[1]);
  const [schedule, setSchedule] = useState<PaySchedule>(defaultSchedule());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("name required");
      return;
    }
    const w = Number(wage);
    if (!Number.isFinite(w) || w < 0) {
      setError("enter an hourly wage");
      return;
    }
    const t = Number(tax);
    if (!Number.isFinite(t) || t < 0 || t > 100) {
      setError("tax must be 0–100");
      return;
    }
    startTransition(async () => {
      const ok = await onCreate({
        name: n,
        hourlyWage: w,
        taxRate: t,
        calendarId,
        color,
        payFrequency: schedule.payFrequency,
        anchorPayday: schedule.payFrequency ? schedule.anchorPayday : null,
        periodStart: schedule.payFrequency ? schedule.periodStart : null,
        periodEnd: schedule.payFrequency ? schedule.periodEnd : null,
      });
      if (!ok) {
        setError("could not save income source");
        return;
      }
      onClose();
    });
  }

  return (
    <form onSubmit={submit} className="border border-line bg-card p-4 space-y-5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        type="text"
        placeholder="job name (e.g. day job)"
        maxLength={64}
        autoComplete="off"
        autoFocus
        className="w-full bg-transparent text-fg placeholder-muted text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />

      <div className="flex gap-3">
        <div className="flex-1 space-y-2">
          <p className="text-[10px] tracking-widest uppercase text-muted">
            hourly wage
          </p>
          <input
            value={wage}
            onChange={(e) => setWage(e.target.value)}
            type="number"
            inputMode="decimal"
            step="any"
            min={0}
            placeholder="0.00"
            className="w-full bg-card border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
          />
        </div>
        <div className="w-24 space-y-2">
          <p className="text-[10px] tracking-widest uppercase text-muted">
            tax %
          </p>
          <input
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            type="number"
            inputMode="decimal"
            step="any"
            min={0}
            max={100}
            className="w-full bg-card border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
          />
        </div>
      </div>

      <CalendarSelect
        value={calendarId}
        calendars={calendars}
        onChange={setCalendarId}
      />

      <PaySchedulePicker value={schedule} onChange={setSchedule} />

      <ColorPicker value={color} onChange={setColor} />

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors disabled:opacity-50"
        >
          create
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-4 text-muted text-sm hover:text-fg transition-colors"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

function IncomeRow({
  source,
  calendars,
  currency,
  onUpdate,
  onArchive,
}: {
  source: IncomeSource;
  calendars: CalendarListEntry[];
  currency: string;
  onUpdate: (id: string, patch: Partial<IncomeSource>) => void;
  onArchive: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(source.name);
  const [wageDraft, setWageDraft] = useState(String(Number(source.hourly_wage)));
  const [taxDraft, setTaxDraft] = useState(String(Number(source.tax_rate)));
  const linkedCalendar = source.calendar_id
    ? (calendars.find((c) => c.id === source.calendar_id) ?? null)
    : null;

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === source.name) {
      setNameDraft(source.name);
      return;
    }
    onUpdate(source.id, { name: next });
  }

  function commitWage() {
    const next = Number(wageDraft);
    if (!Number.isFinite(next) || next < 0) {
      setWageDraft(String(Number(source.hourly_wage)));
      return;
    }
    const rounded = Math.round(next * 100) / 100;
    if (rounded !== Number(source.hourly_wage)) {
      onUpdate(source.id, { hourly_wage: rounded });
    }
    setWageDraft(String(rounded));
  }

  function commitTax() {
    const next = Number(taxDraft);
    if (!Number.isFinite(next) || next < 0 || next > 100) {
      setTaxDraft(String(Number(source.tax_rate)));
      return;
    }
    const rounded = Math.round(next * 100) / 100;
    if (rounded !== Number(source.tax_rate)) {
      onUpdate(source.id, { tax_rate: rounded });
    }
    setTaxDraft(String(rounded));
  }

  return (
    <li className="border border-line bg-card">
      <div className="flex items-stretch">
        <div className="flex flex-1 items-center gap-3 px-4 py-3 min-w-0">
          <span
            className="w-2 h-8 flex-shrink-0"
            style={{ backgroundColor: source.color }}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-fg text-sm font-bold truncate">{source.name}</p>
            <p className="text-muted text-[10px] tracking-widest uppercase mt-0.5 truncate">
              {formatMoney(Number(source.hourly_wage), currency)}/h
              {Number(source.tax_rate) > 0 ? ` · ${Number(source.tax_rate)}% tax` : ""}
              {linkedCalendar
                ? ` · ${linkedCalendar.summary}`
                : source.calendar_id
                  ? " · linked"
                  : " · no calendar"}
              {source.pay_frequency && source.anchor_payday
                ? ` · ${source.pay_frequency} · pays ${formatDue(source.anchor_payday)}`
                : " · each shift"}
            </p>
          </div>
        </div>
        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="income actions"
          className="px-4 border-l border-line text-muted hover:text-fg hover:bg-card-hover transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <div className="border-t border-line p-4 space-y-5">
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            maxLength={64}
            aria-label="income name"
            className="w-full bg-transparent text-fg text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
          />

          <div className="flex gap-3">
            <div className="flex-1 space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                hourly wage
              </p>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                value={wageDraft}
                onChange={(e) => setWageDraft(e.target.value)}
                onBlur={commitWage}
                className="w-full bg-card border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
            <div className="w-24 space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                tax %
              </p>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                max={100}
                value={taxDraft}
                onChange={(e) => setTaxDraft(e.target.value)}
                onBlur={commitTax}
                className="w-full bg-card border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
          </div>

          <CalendarSelect
            value={source.calendar_id}
            calendars={calendars}
            onChange={(id) => onUpdate(source.id, { calendar_id: id })}
          />

          <PaySchedulePicker
            value={defaultSchedule(source)}
            onChange={(next) => onUpdate(source.id, scheduleToPatch(next))}
          />

          <ColorPicker
            value={source.color}
            onChange={(c) => onUpdate(source.id, { color: c })}
          />

          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                setEditOpen(false);
                onArchive(source.id);
              }}
              className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-2 px-3"
            >
              delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function CategoriesManager({
  categories,
  onCreate,
  onUpdate,
  onArchive,
}: {
  categories: SpendingCategory[];
  onCreate: (input: {
    name: string;
    color: string;
  }) => Promise<SpendingCategory | null>;
  onUpdate: (id: string, patch: Partial<SpendingCategory>) => void;
  onArchive: (id: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function createCat(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("name required");
      return;
    }
    startTransition(async () => {
      const created = await onCreate({ name: n, color });
      if (!created) {
        setError("could not create category");
        return;
      }
      setName("");
      setColor(PALETTE[0]);
      setFormOpen(false);
      setError(null);
    });
  }

  return (
    <CollapsibleSection title="spending categories" count={categories.length}>
      <ul className="space-y-2">
        {categories.map((c) => (
          <CategoryRow
            key={c.id}
            category={c}
            onUpdate={onUpdate}
            onArchive={onArchive}
          />
        ))}
      </ul>

      {!formOpen ? (
        <button
          onClick={() => setFormOpen(true)}
          className="w-full text-left bg-transparent border border-dashed border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-4 px-4 transition-colors"
        >
          + new category
        </button>
      ) : (
        <form
          onSubmit={createCat}
          className="border border-line bg-card p-4 space-y-5"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            type="text"
            placeholder="category name"
            maxLength={64}
            autoComplete="off"
            autoFocus
            className="w-full bg-transparent text-fg placeholder-muted text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
          />
          <ColorPicker value={color} onChange={setColor} />
          {error && <p className="text-danger text-xs">{error}</p>}
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors disabled:opacity-50"
            >
              create
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="px-4 text-muted text-sm hover:text-fg transition-colors"
            >
              cancel
            </button>
          </div>
        </form>
      )}
    </CollapsibleSection>
  );
}

function CategoryRow({
  category,
  onUpdate,
  onArchive,
}: {
  category: SpendingCategory;
  onUpdate: (id: string, patch: Partial<SpendingCategory>) => void;
  onArchive: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(category.name);

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === category.name) {
      setNameDraft(category.name);
      return;
    }
    onUpdate(category.id, { name: next });
  }

  return (
    <li className="border border-line bg-card">
      <div className="flex items-stretch">
        <div className="flex flex-1 items-center gap-3 px-4 py-3 min-w-0">
          <span
            className="w-2 h-6 flex-shrink-0"
            style={{ backgroundColor: category.color }}
            aria-hidden
          />
          <span className="flex-1 truncate text-fg text-sm font-bold">
            {category.name}
          </span>
        </div>
        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="category actions"
          className="px-4 border-l border-line text-muted hover:text-fg hover:bg-card-hover transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <div className="border-t border-line p-4 space-y-5">
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                setNameDraft(category.name);
                e.currentTarget.blur();
              }
            }}
            maxLength={64}
            aria-label="category name"
            className="w-full bg-transparent text-fg text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
          />
          <ColorPicker
            value={category.color}
            onChange={(c) => onUpdate(category.id, { color: c })}
          />
          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                setEditOpen(false);
                onArchive(category.id);
              }}
              className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-2 px-3"
            >
              archive
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
