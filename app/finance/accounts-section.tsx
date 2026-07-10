"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ColorPicker, PALETTE } from "@/app/_components/color-picker";
import { formatDue, todayISO } from "@/app/_components/date-utils";
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
  SpendingCategory,
} from "@/app/_components/finance-types";
import { toCents } from "./finance-shared";

const ACCOUNT_TYPES: AccountType[] = [
  "checking",
  "savings",
  "cash",
  "credit",
  "investment",
  "other",
];

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
            className={`inline-flex items-center min-h-11 text-xs px-3 py-2 border transition-colors ${
              value === t
                ? "bg-fg text-page border-fg"
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

// One hairline-separated ledger row per account: name + delta arrow + balance,
// then text verbs. `update balance` opens the untouched BalanceUpdatePanel
// inline; history and account edit are demoted behind their own disclosures
// and never render by default.
export function AccountRow({
  account,
  todayDelta,
  categories,
  categoryById,
  changes,
  onRecordBalance,
  onUpdateAccount,
  onArchiveAccount,
  onUpdateChange,
  onDeleteChange,
  onCreateCategory,
}: {
  account: Account;
  todayDelta: number;
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
  onDeleteChange: (id: string) => void;
  onCreateCategory: (input: {
    name: string;
    color: string;
  }) => Promise<SpendingCategory | null>;
}) {
  const [panel, setPanel] = useState<"update" | "history" | "edit" | null>(
    null,
  );
  const [showAllHistory, setShowAllHistory] = useState(false);

  const visibleChanges = showAllHistory ? changes : changes.slice(0, 5);

  function toggle(next: "update" | "history" | "edit") {
    setPanel((p) => (p === next ? null : next));
  }

  return (
    <li className="border-t border-hairline">
      <div className="flex items-center gap-3 pt-3">
        <span
          className="h-2.5 w-2.5 flex-shrink-0"
          style={{ backgroundColor: account.color }}
          aria-hidden
        />
        <p className="flex-1 min-w-0 truncate text-body text-fg">
          {account.name}
        </p>
        {todayDelta !== 0 && (
          <span
            className={`text-meta tabular-nums whitespace-nowrap ${
              todayDelta > 0 ? "text-positive" : "text-danger"
            }`}
          >
            {todayDelta > 0 ? "↑" : "↓"}{" "}
            {formatMoney(Math.abs(todayDelta), account.currency)}
          </span>
        )}
        <p className="text-body tabular-nums whitespace-nowrap text-fg">
          {formatMoney(Number(account.balance), account.currency)}
        </p>
      </div>

      <div className="flex items-center gap-5 pb-1">
        <button
          type="button"
          onClick={() => toggle("update")}
          className="min-h-11 text-action lowercase text-fg hover:text-accent transition-colors"
        >
          update balance
        </button>
        <button
          type="button"
          onClick={() => toggle("history")}
          className="min-h-11 text-action lowercase text-muted hover:text-fg transition-colors"
        >
          history {panel === "history" ? "↓" : "→"}
        </button>
        <button
          type="button"
          onClick={() => toggle("edit")}
          aria-label={`edit ${account.name}`}
          className="ml-auto min-h-11 min-w-11 text-action text-muted hover:text-fg transition-colors"
        >
          ···
        </button>
      </div>

      {panel === "update" && (
        <div className="mb-3 border border-hairline bg-card p-4">
          <BalanceUpdatePanel
            account={account}
            categories={categories}
            onCreateCategory={onCreateCategory}
            onSubmit={(input) => {
              onRecordBalance(account, input);
              setPanel(null);
            }}
            onCancel={() => setPanel(null)}
          />
        </div>
      )}

      {panel === "history" && (
        <div className="mb-3 border border-hairline bg-card">
          {changes.length === 0 ? (
            <p className="px-4 py-3 text-meta text-muted">no changes yet</p>
          ) : (
            <>
              <ul>
                {visibleChanges.map((change) => (
                  <HistoryRow
                    key={change.id}
                    change={change}
                    categories={categories}
                    categoryById={categoryById}
                    currency={account.currency}
                    onUpdateChange={onUpdateChange}
                    onDeleteChange={onDeleteChange}
                  />
                ))}
              </ul>
              {changes.length > 5 && (
                <button
                  onClick={() => setShowAllHistory((v) => !v)}
                  className="min-h-11 w-full text-label uppercase text-muted hover:text-fg transition-colors"
                >
                  {showAllHistory ? "show less" : `show all ${changes.length}`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {panel === "edit" && (
        <div className="mb-3 border border-hairline bg-card">
          <AccountEditPanel
            account={account}
            onUpdate={onUpdateAccount}
            onArchive={(id) => {
              setPanel(null);
              onArchiveAccount(id);
            }}
          />
        </div>
      )}
    </li>
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
    <div className="p-4 space-y-5">
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

export function BalanceUpdatePanel({
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
  onDeleteChange,
}: {
  change: BalanceChange;
  categories: SpendingCategory[];
  categoryById: Map<string, SpendingCategory>;
  currency: string;
  onUpdateChange: (id: string, patch: Partial<BalanceChange>) => void;
  onDeleteChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                amount
              </p>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0.01"
                defaultValue={String(Number(change.amount))}
                onBlur={(e) => {
                  const next = Number(e.target.value);
                  if (
                    Number.isFinite(next) &&
                    next > 0 &&
                    Math.round(next * 100) !== Math.round(Number(change.amount) * 100)
                  ) {
                    onUpdateChange(change.id, {
                      amount: Math.round(next * 100) / 100,
                    });
                  } else {
                    e.target.value = String(Number(change.amount));
                  }
                }}
                aria-label="amount"
                className="w-full bg-card border border-line-strong focus:border-accent text-fg text-sm tabular-nums px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
            <div className="flex-1 space-y-1">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                date
              </p>
              <input
                type="date"
                defaultValue={change.occurred_at.slice(0, 10)}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next && next !== change.occurred_at.slice(0, 10)) {
                    onUpdateChange(change.id, { occurred_at: next });
                  }
                }}
                aria-label="date"
                className="w-full bg-card border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
          </div>
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
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted">
              {change.is_transfer
                ? "transfer"
                : change.source !== "manual"
                  ? `via ${change.source}`
                  : " "}
            </p>
            {confirmDelete ? (
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onDeleteChange(change.id)}
                  className="text-danger text-[10px] tracking-widest uppercase hover:text-danger-hover transition-colors py-2"
                >
                  delete — sure?
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-muted text-[10px] tracking-widest uppercase hover:text-fg transition-colors py-2"
                >
                  keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-muted text-[10px] tracking-widest uppercase hover:text-danger transition-colors py-2"
              >
                delete
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function AddAccountForm({
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
