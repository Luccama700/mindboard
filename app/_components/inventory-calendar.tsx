"use client";

import { useMemo, useState } from "react";
import type { InventoryUsage } from "./inventory-types";
import { todayISO, formatMonthYear } from "./date-utils";
import {
  buildProjectionDays,
  daysUntilEmpty,
  effectiveDailyRate,
  reorderDateKey,
  runOutDateKey,
  type UsagePeriod,
} from "./inventory-projection";

const WEEKDAYS = ["s", "m", "t", "w", "t", "f", "s"];

function parseMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(year, monthNumber - 1, 1);
}

function monthKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function addMonths(month: string, count: number) {
  const date = parseMonth(month);
  date.setMonth(date.getMonth() + count);
  return monthKey(date);
}

function dateKeyOf(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildGrid(month: string): string[] {
  const first = parseMonth(month);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return dateKeyOf(date);
  });
}

function fmtQty(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return String(rounded);
}

function fmtDateKey(key: string): string {
  return new Date(`${key}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function InventoryCalendar({
  item,
  usages,
  onCreateUsage,
  onUpdateUsage,
  onDeleteUsage,
  onUpdateThreshold,
}: {
  item: { id: string; quantity: number; unit: string; reorder_threshold: number | null };
  usages: InventoryUsage[];
  onCreateUsage: (input: {
    amount: number;
    period: UsagePeriod;
    intervalDays: number | null;
  }) => void;
  onUpdateUsage: (
    id: string,
    input: { amount: number; period: UsagePeriod; intervalDays: number | null },
  ) => void;
  onDeleteUsage: (id: string) => void;
  onUpdateThreshold: (value: number | null) => void;
}) {
  const today = todayISO();
  const [month, setMonth] = useState(() => today.slice(0, 7));

  const quantityToday = Number(item.quantity);
  const threshold = item.reorder_threshold;
  const unit = item.unit.trim();

  const dailyRate = useMemo(
    () =>
      effectiveDailyRate(
        usages.map((u) => ({
          amount: Number(u.amount),
          period: u.period,
          interval_days: u.interval_days,
        })),
      ),
    [usages],
  );

  const daysLeft = daysUntilEmpty(quantityToday, dailyRate);
  const runOut = runOutDateKey(today, quantityToday, dailyRate);
  const reorder = reorderDateKey(today, quantityToday, dailyRate, threshold);

  const gridDays = useMemo(() => buildGrid(month), [month]);
  const projection = useMemo(
    () =>
      buildProjectionDays({ gridDays, today, quantityToday, dailyRate }),
    [gridDays, today, quantityToday, dailyRate],
  );

  const unitSuffix = unit ? ` ${unit}` : "";

  return (
    <div className="space-y-4">
      <p className="text-[10px] tracking-widest uppercase text-muted">forecast</p>

      <div className="rounded-field border border-line bg-page px-3 py-3 text-sm">
        {dailyRate <= 0 ? (
          <p className="text-muted">
            add a usage below to project when this runs out.
          </p>
        ) : (
          <div className="space-y-1">
            <p className="text-fg">
              {daysLeft === 0 ? (
                <span className="text-danger font-bold">out</span>
              ) : (
                <>
                  <span className="text-accent-ink font-bold tabular-nums">
                    ≈ {daysLeft}
                  </span>{" "}
                  {daysLeft === 1 ? "day" : "days"} left
                </>
              )}
            </p>
            {runOut && daysLeft !== 0 && (
              <p className="text-muted text-xs">
                runs out{" "}
                <span className="text-fg tabular-nums">{fmtDateKey(runOut)}</span>
              </p>
            )}
            {reorder && (
              <p className="text-muted text-xs">
                reorder by{" "}
                <span className="text-danger tabular-nums">
                  {fmtDateKey(reorder)}
                </span>
              </p>
            )}
            <p className="text-muted text-[10px] tracking-widest uppercase pt-1">
              {fmtQty(dailyRate)}
              {unitSuffix} / day
            </p>
          </div>
        )}
      </div>

      <div className="glass-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setMonth((m) => addMonths(m, -1))}
            aria-label="previous month"
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted hover:text-fg transition-colors"
          >
            ‹
          </button>
          <span className="text-xs tracking-widest uppercase text-fg">
            {formatMonthYear(parseMonth(month))}
          </span>
          <button
            type="button"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            aria-label="next month"
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted hover:text-fg transition-colors"
          >
            ›
          </button>
        </div>

        <div className="grid grid-cols-7 border-b border-line">
          {WEEKDAYS.map((d, i) => (
            <div
              key={i}
              className="py-1 text-center text-[9px] tracking-widest uppercase text-muted"
            >
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {projection.map((day) => {
            const date = new Date(`${day.dateKey}T00:00:00`);
            const inMonth = day.dateKey.slice(0, 7) === month;
            const isRunOut = runOut !== null && day.dateKey === runOut;
            const isReorder = reorder !== null && day.dateKey === reorder;
            const depleted = dailyRate > 0 && !day.isPast && day.quantity <= 0;

            return (
              <div
                key={day.dateKey}
                className={`relative min-h-12 border-b border-r border-line px-1 py-1 last:border-r-0 ${
                  inMonth ? "" : "opacity-40"
                } ${day.isToday ? "ring-1 ring-inset ring-accent-ink" : ""} ${
                  isRunOut ? "bg-danger/15" : ""
                }`}
              >
                <span
                  className={`block text-[9px] tabular-nums ${
                    day.isToday ? "text-accent-ink font-bold" : "text-muted"
                  }`}
                >
                  {date.getDate()}
                </span>
                {!day.isPast && dailyRate > 0 && (
                  <span
                    className={`mt-0.5 block text-[11px] leading-tight tabular-nums ${
                      depleted
                        ? "text-danger font-bold"
                        : isReorder
                          ? "text-danger"
                          : "text-fg"
                    }`}
                  >
                    {fmtQty(day.quantity)}
                  </span>
                )}
                {isReorder && !isRunOut && (
                  <span
                    className="absolute inset-0 ring-1 ring-inset ring-danger/60 pointer-events-none"
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <UsagesEditor
        usages={usages}
        onCreate={onCreateUsage}
        onUpdate={onUpdateUsage}
        onDelete={onDeleteUsage}
      />

      <ThresholdField
        value={threshold}
        unit={unit}
        onCommit={onUpdateThreshold}
      />
    </div>
  );
}

function UsagesEditor({
  usages,
  onCreate,
  onUpdate,
  onDelete,
}: {
  usages: InventoryUsage[];
  onCreate: (input: {
    amount: number;
    period: UsagePeriod;
    intervalDays: number | null;
  }) => void;
  onUpdate: (
    id: string,
    input: { amount: number; period: UsagePeriod; intervalDays: number | null },
  ) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-2">
      <p className="text-[10px] tracking-widest uppercase text-muted">usage</p>

      {usages.length > 0 && (
        <ul className="space-y-px">
          {usages.map((u) => (
            <li key={u.id}>
              <UsageRowEditor
                usage={u}
                onUpdate={(input) => onUpdate(u.id, input)}
                onDelete={() => onDelete(u.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <UsageRowEditor
          onUpdate={(input) => {
            onCreate(input);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full rounded-full border border-dashed border-line-strong text-muted text-xs px-3 py-2 hover:border-accent-ink hover:text-accent-ink transition-colors"
        >
          + add usage
        </button>
      )}
    </div>
  );
}

function UsageRowEditor({
  usage,
  onUpdate,
  onDelete,
  onCancel,
}: {
  usage?: InventoryUsage;
  onUpdate: (input: {
    amount: number;
    period: UsagePeriod;
    intervalDays: number | null;
  }) => void;
  onDelete?: () => void;
  onCancel?: () => void;
}) {
  const [amount, setAmount] = useState(usage ? String(usage.amount) : "1");
  const [period, setPeriod] = useState<UsagePeriod>(usage?.period ?? "day");
  const [intervalDays, setIntervalDays] = useState(
    usage?.interval_days ? String(usage.interval_days) : "3",
  );

  const isNew = !usage;

  function commit(next?: {
    amount?: string;
    period?: UsagePeriod;
    intervalDays?: string;
  }) {
    const a = Number(next?.amount ?? amount);
    const p = next?.period ?? period;
    const n = p === "custom" ? Number(next?.intervalDays ?? intervalDays) : null;
    if (!Number.isFinite(a) || a <= 0) return;
    if (p === "custom" && (!Number.isInteger(n) || (n ?? 0) < 1)) return;
    onUpdate({ amount: a, period: p, intervalDays: n });
  }

  return (
    <div className="flex items-stretch gap-px rounded-full overflow-hidden bg-line">
      <input
        type="number"
        inputMode="decimal"
        step="any"
        min={0}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onBlur={() => !isNew && commit()}
        aria-label="usage amount"
        className="w-16 bg-card text-center text-fg text-sm focus:outline-none focus:bg-card-hover py-2"
      />
      <select
        value={period}
        onChange={(e) => {
          const p = e.target.value as UsagePeriod;
          setPeriod(p);
          if (!isNew) commit({ period: p });
        }}
        aria-label="usage period"
        className="flex-1 min-w-0 bg-card text-fg text-xs px-2 py-2 focus:outline-none focus:bg-card-hover"
      >
        <option value="day">per day</option>
        <option value="week">per week</option>
        <option value="custom">every N days</option>
      </select>
      {period === "custom" && (
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={intervalDays}
          onChange={(e) => setIntervalDays(e.target.value)}
          onBlur={() => !isNew && commit()}
          aria-label="interval in days"
          className="w-14 bg-card text-center text-fg text-sm focus:outline-none focus:bg-card-hover py-2"
        />
      )}
      {isNew ? (
        <>
          <button
            type="button"
            onClick={() => commit()}
            className="px-3 bg-accent text-accent-fg text-xs font-bold hover:opacity-90 transition-colors"
          >
            add
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="cancel"
            className="px-3 bg-card text-muted text-sm hover:text-fg transition-colors"
          >
            ×
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onDelete}
          aria-label="remove usage"
          className="px-3 bg-card text-muted hover:text-danger transition-colors"
        >
          ×
        </button>
      )}
    </div>
  );
}

function ThresholdField({
  value,
  unit,
  onCommit,
}: {
  value: number | null;
  unit: string;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setDraft(value === null ? "" : String(value));
  }

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      setDraft(value === null ? "" : String(value));
      return;
    }
    if (n !== value) onCommit(n);
  }

  return (
    <div className="space-y-2">
      <label
        htmlFor="reorder-threshold"
        className="text-[10px] tracking-widest uppercase text-muted"
      >
        reorder threshold
      </label>
      <div className="flex items-center gap-2">
        <input
          id="reorder-threshold"
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder="none"
          className="w-24 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-sm text-center px-2 py-2 focus:outline-none transition-colors"
        />
        <span className="text-muted text-xs">
          {unit ? `${unit} — flag as low at or below this` : "flag as low at or below this"}
        </span>
      </div>
    </div>
  );
}
