"use client";

import { useState, useTransition } from "react";
import { saveDailyLog } from "@/app/actions/daily-log";
import { recordBalanceChange } from "@/app/actions/finance";
import { Button, INPUT_CLASS } from "./ui";
import { formatMoney } from "./money";

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label={title}>
      <button
        type="button"
        aria-label="close"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <div className="absolute left-0 right-0 bottom-0 rounded-t-[8px] border border-line bg-popover p-4 pb-[max(env(safe-area-inset-bottom),1rem)] max-h-[80vh] overflow-y-auto lg:left-1/2 lg:right-auto lg:w-[28rem] lg:-translate-x-1/2">
        <div className="flex items-center justify-between mb-4">
          <p className="text-label uppercase text-muted">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="close sheet"
            className="min-h-11 px-3 text-muted hover:text-fg transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ScaleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <p className="text-label uppercase text-muted mb-1.5">{label}</p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={value === n}
            className={`flex-1 min-h-11 border text-action transition-colors ${
              value !== null && n <= value
                ? "border-accent bg-accent text-accent-fg"
                : "border-line-strong text-muted hover:text-fg"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DailyLogSheet({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (mood: number) => void;
}) {
  const [mood, setMood] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const [sleep, setSleep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    if (mood === null || energy === null) {
      setError("mood and energy are the minimum");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await saveDailyLog({
        mood,
        energy,
        sleepHours: sleep.trim() === "" ? null : Number(sleep),
      });
      if (result.error) setError(result.error);
      else {
        onSaved(mood);
        onClose();
      }
    });
  };

  return (
    <Sheet title="log today" onClose={onClose}>
      <div className="space-y-4">
        <ScaleRow label="mood" value={mood} onChange={setMood} />
        <ScaleRow label="energy" value={energy} onChange={setEnergy} />
        <div>
          <p className="text-label uppercase text-muted mb-1.5">
            sleep last night (hours)
          </p>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={24}
            step={0.5}
            value={sleep}
            onChange={(e) => setSleep(e.target.value)}
            placeholder="7.5"
            className={INPUT_CLASS}
          />
        </div>
        {error && <p className="text-action text-danger">{error}</p>}
        <Button variant="accent" onClick={submit} disabled={pending}>
          {pending ? "saving…" : "save"}
        </Button>
      </div>
    </Sheet>
  );
}

export type SpendAccount = {
  id: string;
  name: string;
  balance: number;
  currency: string;
};

export type SpendCategory = { id: string; name: string; color: string };

export function SpendSheet({
  billName,
  amount: initialAmount,
  accounts,
  categories,
  onClose,
  onLogged,
}: {
  billName: string;
  amount: number;
  accounts: SpendAccount[];
  categories: SpendCategory[];
  onClose: () => void;
  onLogged: () => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState<string>("");
  const [amount, setAmount] = useState(String(initialAmount));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const parsed = Number(amount);
  const valid = account && Number.isFinite(parsed) && parsed > 0;

  const submit = () => {
    if (!valid || !account) {
      setError("pick an account and a positive amount");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await recordBalanceChange({
        accountId: account.id,
        newBalance: account.balance - parsed,
        categoryId: categoryId || null,
        note: billName,
      });
      if (result.error) setError(result.error);
      else {
        onLogged();
        onClose();
      }
    });
  };

  return (
    <Sheet title={`log ${billName}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <p className="text-label uppercase text-muted mb-1.5">amount</p>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <p className="text-label uppercase text-muted mb-1.5">from account</p>
          <div className="space-y-px">
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAccountId(a.id)}
                aria-pressed={accountId === a.id}
                className={`flex w-full items-center justify-between min-h-11 px-3 text-action transition-colors border ${
                  accountId === a.id
                    ? "border-accent text-fg"
                    : "border-hairline text-muted hover:text-fg"
                }`}
              >
                <span className="lowercase">{a.name}</span>
                <span className="text-meta">
                  {formatMoney(a.balance, a.currency)}
                </span>
              </button>
            ))}
            {accounts.length === 0 && (
              <p className="text-meta text-muted">
                no accounts yet — add one in money.
              </p>
            )}
          </div>
        </div>

        <div>
          <p className="text-label uppercase text-muted mb-1.5">category</p>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setCategoryId("")}
              aria-pressed={categoryId === ""}
              className={`min-h-11 px-3 text-action lowercase border transition-colors ${
                categoryId === ""
                  ? "border-accent text-fg"
                  : "border-hairline text-muted hover:text-fg"
              }`}
            >
              uncategorized
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategoryId(c.id)}
                aria-pressed={categoryId === c.id}
                className={`inline-flex items-center gap-1.5 min-h-11 px-3 text-action lowercase border transition-colors ${
                  categoryId === c.id
                    ? "border-accent text-fg"
                    : "border-hairline text-muted hover:text-fg"
                }`}
              >
                <span
                  className="h-2 w-2"
                  style={{ backgroundColor: c.color }}
                  aria-hidden
                />
                {c.name}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-action text-danger">{error}</p>}
        <Button variant="accent" onClick={submit} disabled={pending || !valid}>
          {pending
            ? "logging…"
            : account
              ? `log ${formatMoney(parsed || 0, account.currency)}`
              : "log"}
        </Button>
      </div>
    </Sheet>
  );
}
