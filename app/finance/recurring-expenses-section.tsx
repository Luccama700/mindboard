"use client";

import { useState, useTransition } from "react";
import { todayISO } from "@/app/_components/date-utils";
import { formatMoney } from "@/app/_components/money";
import type {
  RecurringExpense,
  RecurringFrequency,
  SpendingCategory,
} from "@/app/_components/finance-types";
import { CollapsibleSection, WEEKDAY_LABELS } from "./finance-shared";

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
                className={`inline-flex items-center min-h-11 text-xs px-3 py-2 border rounded-full transition-colors ${
                  frequency === f
                    ? "bg-fg text-page border-fg"
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
            className="w-24 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
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
                className={`inline-flex items-center min-h-11 text-[11px] px-2.5 py-2 border rounded-full transition-colors ${
                  weekday === index
                    ? "bg-fg text-page border-fg"
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
              className="w-24 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
          <div className="flex-1 space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              starting
            </p>
            <input
              type="date"
              value={startDate}
              onChange={(e) => onStartDate(e.target.value || todayISO(null))}
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function ExpensesManager({
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
          className="w-full text-left bg-transparent border border-dashed rounded-panel border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-4 px-4 transition-colors"
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
  const [startDate, setStartDate] = useState(todayISO(null));
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
    <form onSubmit={submit} className="glass-panel p-4 space-y-5">
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
          className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
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
          className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
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
          className="flex-1 bg-accent text-accent-fg text-sm font-bold rounded-full py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:opacity-90 transition-colors disabled:opacity-50"
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
    <li className="glass-panel overflow-hidden">
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
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
            />
          </div>

          <RecurrencePicker
            frequency={expense.frequency}
            dayOfMonth={expense.day_of_month ?? 1}
            weekday={expense.weekday ?? 1}
            intervalDays={expense.interval_days ?? 14}
            startDate={expense.start_date ?? todayISO(null)}
            onFrequency={(f) =>
              onUpdate(expense.id, {
                frequency: f,
                day_of_month: f === "monthly" ? (expense.day_of_month ?? 1) : null,
                weekday: f === "weekly" ? (expense.weekday ?? 1) : null,
                interval_days: f === "custom" ? (expense.interval_days ?? 14) : null,
                start_date:
                  f === "custom" ? (expense.start_date ?? todayISO(null)) : null,
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
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
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
