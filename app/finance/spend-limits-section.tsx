"use client";

import { useState, useTransition } from "react";
import { formatMoney } from "@/app/_components/money";
import type {
  SpendingCategory,
  SpendLimit,
  SpendLimitPeriod,
  SpendLimitScope,
} from "@/app/_components/finance-types";
import type { SpendLimitStatus } from "@/app/_components/spend-limits";

const PERIODS: SpendLimitPeriod[] = ["daily", "weekly", "monthly"];
const PERIOD_LABELS: Record<SpendLimitPeriod, string> = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};

// under = accent (lime), approaching = danger-hover (lighter red),
// over = danger (red). Three existing status tokens, no invented amber.
function stateColor(state: SpendLimitStatus["state"]): string {
  if (state === "over") return "var(--danger)";
  if (state === "approaching") return "var(--danger-hover)";
  return "var(--accent)";
}

function limitLabel(
  limit: SpendLimit,
  categoryById: Map<string, SpendingCategory>,
): string {
  if (limit.scope === "overall") return "overall";
  const name = limit.category_id
    ? categoryById.get(limit.category_id)?.name
    : null;
  return name ?? "category";
}

function PeriodPicker({
  period,
  onChange,
}: {
  period: SpendLimitPeriod;
  onChange: (p: SpendLimitPeriod) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`inline-flex items-center min-h-11 text-xs px-3 py-2 border rounded-full transition-colors ${
            period === p
              ? "bg-fg text-page border-fg"
              : "border-line-strong text-muted hover:border-fg hover:text-fg"
          }`}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}

export function SpendLimitsSection({
  limits,
  statusById,
  categories,
  categoryById,
  currency,
  onCreate,
  onUpdate,
  onArchive,
}: {
  limits: SpendLimit[];
  statusById: Map<string, SpendLimitStatus>;
  categories: SpendingCategory[];
  categoryById: Map<string, SpendingCategory>;
  currency: string;
  onCreate: (input: {
    scope: SpendLimitScope;
    categoryId: string | null;
    period: SpendLimitPeriod;
    amount: number;
  }) => Promise<string | null>;
  onUpdate: (
    id: string,
    patch: { amount?: number; period?: SpendLimitPeriod },
  ) => void;
  onArchive: (id: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const hasOverall = limits.some((l) => l.scope === "overall");

  return (
    <section className="mt-10" data-tour="spend-limits">
      <p className="text-label uppercase text-muted">spending limits</p>

      {limits.length > 0 && (
        <ul className="mt-3 space-y-2">
          {limits.map((limit) => (
            <LimitRow
              key={limit.id}
              limit={limit}
              status={statusById.get(limit.id) ?? null}
              label={limitLabel(limit, categoryById)}
              currency={currency}
              onUpdate={onUpdate}
              onArchive={onArchive}
            />
          ))}
        </ul>
      )}

      <div className="mt-3">
        {!formOpen ? (
          <button
            onClick={() => setFormOpen(true)}
            className="w-full text-left bg-transparent border border-dashed rounded-panel border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-4 px-4 transition-colors"
          >
            + new limit
          </button>
        ) : (
          <LimitForm
            categories={categories}
            hasOverall={hasOverall}
            onCreate={onCreate}
            onClose={() => setFormOpen(false)}
          />
        )}
      </div>
    </section>
  );
}

function LimitRow({
  limit,
  status,
  label,
  currency,
  onUpdate,
  onArchive,
}: {
  limit: SpendLimit;
  status: SpendLimitStatus | null;
  label: string;
  currency: string;
  onUpdate: (
    id: string,
    patch: { amount?: number; period?: SpendLimitPeriod },
  ) => void;
  onArchive: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [amountDraft, setAmountDraft] = useState(String(Number(limit.amount)));

  const spent = status?.spent ?? 0;
  const pctUsed = status?.pctUsed ?? 0;
  const remaining = status?.remaining ?? limit.amount;
  const state = status?.state ?? "under";
  const color = stateColor(state);

  function commitAmount() {
    const next = Number(amountDraft);
    if (!Number.isFinite(next) || next <= 0) {
      setAmountDraft(String(Number(limit.amount)));
      return;
    }
    const rounded = Math.round(next * 100) / 100;
    if (rounded !== Number(limit.amount)) {
      onUpdate(limit.id, { amount: rounded });
    }
    setAmountDraft(String(rounded));
  }

  return (
    <li className="glass-panel overflow-hidden">
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1 space-y-2 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-bold text-fg">{label}</p>
            <p className="whitespace-nowrap text-sm font-bold tabular-nums text-fg">
              {formatMoney(spent, currency)}
              <span className="text-muted">
                {" "}
                / {formatMoney(Number(limit.amount), currency)}
              </span>
            </p>
          </div>

          <div
            className="h-1.5 w-full"
            style={{ backgroundColor: "var(--border-line)" }}
            role="progressbar"
            aria-valuenow={Math.round(pctUsed)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${label} ${PERIOD_LABELS[limit.period]} limit`}
          >
            <div
              className="h-full"
              style={{
                width: `${Math.min(100, Math.max(0, pctUsed))}%`,
                backgroundColor: color,
              }}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] uppercase tracking-widest text-muted">
              {PERIOD_LABELS[limit.period]}
            </p>
            <p
              className="text-[10px] tabular-nums"
              style={{ color: state === "under" ? "var(--muted)" : color }}
            >
              {pctUsed}% used ·{" "}
              {remaining >= 0
                ? `${formatMoney(remaining, currency)} left`
                : `${formatMoney(-remaining, currency)} over`}
            </p>
          </div>
        </div>

        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="limit actions"
          className="border-l border-line px-4 text-lg text-muted transition-colors hover:bg-card-hover hover:text-fg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <div className="space-y-5 border-t border-line p-4">
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-muted">
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
              aria-label="limit amount"
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-muted">
              period
            </p>
            <PeriodPicker
              period={limit.period}
              onChange={(p) => onUpdate(limit.id, { period: p })}
            />
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                setEditOpen(false);
                onArchive(limit.id);
              }}
              className="px-3 py-2 text-xs uppercase tracking-widest text-danger transition-colors hover:text-danger-hover"
            >
              delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function LimitForm({
  categories,
  hasOverall,
  onCreate,
  onClose,
}: {
  categories: SpendingCategory[];
  hasOverall: boolean;
  onCreate: (input: {
    scope: SpendLimitScope;
    categoryId: string | null;
    period: SpendLimitPeriod;
    amount: number;
  }) => Promise<string | null>;
  onClose: () => void;
}) {
  // Default to a category limit when an overall one already exists (only one
  // overall limit is allowed).
  const [scope, setScope] = useState<SpendLimitScope>(
    hasOverall ? "category" : "overall",
  );
  const [categoryId, setCategoryId] = useState<string | null>(
    categories[0]?.id ?? null,
  );
  const [period, setPeriod] = useState<SpendLimitPeriod>("monthly");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (scope === "category" && !categoryId) {
      setError("pick a category");
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("enter an amount");
      return;
    }
    startTransition(async () => {
      const err = await onCreate({
        scope,
        categoryId: scope === "category" ? categoryId : null,
        period,
        amount: amt,
      });
      if (err) {
        setError(err);
        return;
      }
      onClose();
    });
  }

  return (
    <form onSubmit={submit} className="glass-panel p-4 space-y-5">
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-muted">
          applies to
        </p>
        <div className="flex flex-wrap gap-2">
          {(["overall", "category"] as SpendLimitScope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`inline-flex items-center min-h-11 text-xs px-3 py-2 border rounded-full transition-colors ${
                scope === s
                  ? "bg-fg text-page border-fg"
                  : "border-line-strong text-muted hover:border-fg hover:text-fg"
              }`}
            >
              {s === "overall" ? "all spending" : "a category"}
            </button>
          ))}
        </div>
      </div>

      {scope === "category" && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted">
            category
          </p>
          <select
            value={categoryId ?? ""}
            onChange={(e) => setCategoryId(e.target.value || null)}
            aria-label="limit category"
            className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
          >
            {categories.length === 0 && <option value="">no categories</option>}
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-muted">period</p>
        <PeriodPicker period={period} onChange={setPeriod} />
      </div>

      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-muted">amount</p>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          placeholder="0.00"
          autoFocus
          className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
        />
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
