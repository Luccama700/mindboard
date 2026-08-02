"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  formatMonthDay,
  formatMonthYear,
  formatWeekdayMonthDay,
} from "./date-utils";
import { formatMoney } from "./money";
import {
  addDaysKey,
  buildDayRows,
  computeIncomeByDate,
  incomeDetailForDay,
  ruleLandsOn,
} from "./finance-projection";
import { estimatedSpendOn, type SpendRate } from "./spend-baseline";
import {
  deductBaseline,
  groceryAmountsByDate,
  type GroceryTrip,
} from "./grocery-forecast";
import { saveDailySpendEstimate } from "@/app/actions/settings";
import { setSpendOverride } from "@/app/actions/finance";
import type {
  BalanceChange,
  IncomeSource,
  RecurringExpense,
} from "./finance-types";

type GoogleStatus = "connected" | "connect" | "error";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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

function buildGrid(month: string) {
  const first = parseMonth(month);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return toDateKey(date);
  });
}

export function FinanceCalendar({
  month,
  currency,
  netWorthToday,
  changes,
  expenses,
  incomeSources,
  hoursBySource,
  googleStatus,
  spendRate,
  manualSpendEstimate,
  spendOverrides,
  groceryTrips,
  today,
}: {
  month: string;
  currency: string;
  netWorthToday: number;
  changes: BalanceChange[];
  expenses: RecurringExpense[];
  incomeSources: IncomeSource[];
  hoursBySource: Record<string, Record<string, number>>;
  googleStatus: GoogleStatus;
  spendRate: SpendRate;
  manualSpendEstimate: number | null;
  spendOverrides: Record<string, number>;
  // Projected grocery trips (shopping-list prices snapped to the shopping
  // day), computed server-side; empty when no shopping day is set.
  groceryTrips: Record<string, GroceryTrip>;
  // The USER'S current day (user_settings.timezone), resolved on the server and
  // threaded in. Never recompute it from the device clock here: the spend
  // baseline, the grocery forecast and this projection must agree on which day
  // is "today", and for a user whose device zone differs from their stored zone
  // that disagreement would be permanent, not a hydration flash.
  today: string;
}) {
  const gridDays = useMemo(() => buildGrid(month), [month]);

  // Per-day overrides, edited optimistically by the selected-day slider and
  // persisted via setSpendOverride.
  const [overrides, setOverrides] = useState(spendOverrides);
  const [, startOverrideSave] = useTransition();

  function handleSetOverride(dateKey: string, amount: number | null) {
    setOverrides((prev) => {
      const next = { ...prev };
      if (amount === null) delete next[dateKey];
      else next[dateKey] = amount;
      return next;
    });
    startOverrideSave(async () => {
      await setSpendOverride({ date: dateKey, amount });
    });
  }

  const incomeByDate = useMemo(() => {
    const first = gridDays[0];
    const start = first && first < today ? first : today;
    const end = gridDays[gridDays.length - 1] ?? today;
    return computeIncomeByDate(incomeSources, hoursBySource, { start, end });
  }, [incomeSources, hoursBySource, gridDays, today]);

  const groceriesByDate = useMemo(
    () => groceryAmountsByDate(groceryTrips),
    [groceryTrips],
  );

  // Everyday-spend estimate per future day, covering (today, grid end] so the
  // running total stays anchored when viewing a far-future month. Grocery
  // trips absorb the baseline that follows them (no double-counting).
  const estimatedSpendByDate = useMemo(() => {
    const out: Record<string, number> = {};
    const end = gridDays[gridDays.length - 1] ?? today;
    let cursor = addDaysKey(today, 1);
    while (cursor <= end) {
      const estimate = estimatedSpendOn(
        spendRate,
        manualSpendEstimate,
        overrides,
        cursor,
      );
      if (estimate > 0) out[cursor] = estimate;
      cursor = addDaysKey(cursor, 1);
    }
    return deductBaseline(out, groceriesByDate);
  }, [gridDays, today, spendRate, manualSpendEstimate, overrides, groceriesByDate]);

  const rows = useMemo(
    () =>
      buildDayRows({
        gridDays,
        month,
        today,
        netWorthToday,
        changes: changes.map((c) => ({
          occurred_at: c.occurred_at,
          direction: c.direction,
          amount: Number(c.amount),
          is_transfer: c.is_transfer,
        })),
        expenses,
        incomeByDate,
        estimatedSpendByDate,
        groceriesByDate,
      }),
    [gridDays, month, today, netWorthToday, changes, expenses, incomeByDate, estimatedSpendByDate, groceriesByDate],
  );

  const rowByDate = useMemo(() => {
    const map = new Map<string, (typeof rows)[number]>();
    for (const row of rows) map.set(row.dateKey, row);
    return map;
  }, [rows]);

  const initialSelected = gridDays.includes(today) ? today : `${month}-01`;
  const [selected, setSelected] = useState(initialSelected);

  const selectedRow = rowByDate.get(selected);
  const incomeLinked = incomeSources.some((s) => s.calendar_id);

  return (
    <section className="glass-panel p-3 lg:min-h-[calc(100vh-4rem)]">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-[10px] tracking-widest uppercase text-muted">
            cashflow forecast
          </p>
          <h2 className="text-xl font-bold text-fg mt-1">
            {formatMonthYear(parseMonth(month))}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/finance?fm=${addMonths(month, -1)}`}
            scroll={false}
            className="flex min-h-11 min-w-11 items-center justify-center border rounded-full border-line-strong text-muted transition-colors hover:border-fg hover:text-fg"
            aria-label="previous month"
          >
            ←
          </Link>
          <Link
            href={`/finance?fm=${addMonths(month, 1)}`}
            scroll={false}
            className="flex min-h-11 min-w-11 items-center justify-center border rounded-full border-line-strong text-muted transition-colors hover:border-fg hover:text-fg"
            aria-label="next month"
          >
            →
          </Link>
        </div>
      </header>

      <EverydaySpendRow
        rate={spendRate}
        manual={manualSpendEstimate}
        currency={currency}
      />

      {incomeLinked && googleStatus !== "connected" && (
        <div className="border border-line-strong rounded-field px-3 py-2 mb-3">
          <p className="text-xs text-muted leading-relaxed">
            {googleStatus === "connect"
              ? "connect google calendar (sign out and back in) to project wage income from your shifts."
              : "google calendar is temporarily unavailable, so wage income isn't projected right now."}
          </p>
        </div>
      )}

      <div className="grid grid-cols-7 gap-px bg-line border border-line rounded-xl overflow-hidden">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="bg-page text-[9px] tracking-widest uppercase text-muted px-1 py-2 text-center"
          >
            {day}
          </div>
        ))}

        {rows.map((row) => {
          const isSelected = selected === row.dateKey;
          const dayNumber = Number(row.dateKey.slice(8, 10));
          return (
            <button
              key={row.dateKey}
              type="button"
              onClick={() => setSelected(row.dateKey)}
              className={`min-h-24 bg-page p-1.5 text-left transition-colors ${
                isSelected ? "outline outline-1 outline-accent-ink" : ""
              } ${row.inMonth ? "text-fg" : "text-line-subtle"}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-xs ${
                    row.isToday ? "text-accent-ink font-bold" : ""
                  }`}
                >
                  {dayNumber}
                </span>
              </div>

              <p
                className={`mt-1 text-[11px] font-bold tabular-nums leading-tight ${
                  row.inMonth ? "text-fg" : "text-line-subtle"
                }`}
              >
                {formatMoney(row.runningTotal, currency)}
              </p>

              <div className="mt-1 space-y-0.5">
                {row.inflow > 0 && (
                  <p className="text-[10px] tabular-nums text-accent-ink leading-tight">
                    +{formatMoney(row.inflow, currency)}
                  </p>
                )}
                {row.outflow > 0 && (
                  <p className="text-[10px] tabular-nums text-danger leading-tight">
                    −{formatMoney(row.outflow, currency)}
                  </p>
                )}
                {row.estimatedOutflow > 0 && (
                  <p className="text-[10px] tabular-nums text-muted leading-tight">
                    ~−{formatMoney(row.estimatedOutflow, currency)}
                  </p>
                )}
                {row.estimatedGroceries > 0 && (
                  <p
                    className="text-[10px] tabular-nums text-muted leading-tight"
                    title="projected grocery trip"
                  >
                    ≈−{formatMoney(row.estimatedGroceries, currency)}
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {selectedRow && (
        <SelectedDay
          dateKey={selected}
          row={selectedRow}
          currency={currency}
          changes={changes}
          expenses={expenses}
          incomeSources={incomeSources}
          hoursBySource={hoursBySource}
          baselineEstimate={estimatedSpendOn(
            spendRate,
            manualSpendEstimate,
            {},
            selected,
          )}
          override={overrides[selected]}
          onSetOverride={handleSetOverride}
          groceryTrip={groceryTrips[selected]}
        />
      )}
    </section>
  );
}

// The everyday-spend line under the calendar header. With enough history the
// predicted-minimum rate (half the median week) drives the forecast and this
// is a read-only summary; with a thin ledger it exposes the manual flat
// estimate (saved to user_settings).
function EverydaySpendRow({
  rate,
  manual,
  currency,
}: {
  rate: SpendRate;
  manual: number | null;
  currency: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(manual !== null ? String(manual) : "");
  const [isPending, startTransition] = useTransition();

  function save(value: number | null) {
    startTransition(async () => {
      await saveDailySpendEstimate(value);
      setEditing(false);
    });
  }

  if (rate.confident) {
    return (
      <p className="mb-3 text-[10px] tracking-widest uppercase text-muted">
        everyday spend · from your last {rate.sampledWeeks} weeks · at least ~
        {formatMoney(rate.dailyRate, currency)}/day
      </p>
    );
  }

  if (!editing) {
    return (
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          everyday spend ·{" "}
          {manual !== null
            ? `manual · ~${formatMoney(manual, currency)}/day`
            : "not enough history yet"}
        </p>
        <button
          type="button"
          onClick={() => {
            setDraft(manual !== null ? String(manual) : "");
            setEditing(true);
          }}
          className="text-[10px] tracking-widest uppercase text-muted hover:text-accent-ink transition-colors py-2"
        >
          {manual !== null ? "edit" : "set estimate"}
        </button>
      </div>
    );
  }

  return (
    <form
      className="mb-3 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const value = Number(draft);
        if (draft.trim() === "" || !Number.isFinite(value) || value < 0) return;
        save(value);
      }}
    >
      <input
        type="number"
        inputMode="decimal"
        step="any"
        min="0"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="expected spend per day"
        aria-label="expected daily spend"
        className="flex-1 min-w-0 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-sm tabular-nums px-3 py-2 focus:outline-none transition-colors"
      />
      <button
        type="submit"
        disabled={isPending}
        className="text-[10px] tracking-widest uppercase text-fg border border-fg px-3 py-2 hover:bg-fg hover:text-page transition-colors disabled:opacity-50"
      >
        save
      </button>
      {manual !== null && (
        <button
          type="button"
          disabled={isPending}
          onClick={() => save(null)}
          className="text-[10px] tracking-widest uppercase text-muted hover:text-danger transition-colors px-2 py-2 disabled:opacity-50"
        >
          clear
        </button>
      )}
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors px-2 py-2"
      >
        cancel
      </button>
    </form>
  );
}

// Quick-pin multiples of the day's baseline (the predicted-minimum estimate).
const SPEND_MULTIPLIERS = [0.5, 1, 1.5, 2, 3] as const;

// Slider pinning the expected everyday spend for one future day. The pinned
// value (including an explicit $0) replaces the baseline estimate for that
// date; reset returns to the baseline. Commits on release, not per tick.
// Above the slider, quick-select buttons pin common multiples of the
// baseline in one tap (1× pins today's baseline so it survives rate drift).
function FutureSpendSlider({
  dateKey,
  baseline,
  override,
  currency,
  onSet,
}: {
  dateKey: string;
  baseline: number;
  override: number | undefined;
  currency: string;
  onSet: (dateKey: string, amount: number | null) => void;
}) {
  const effective = override ?? baseline;
  const [draft, setDraft] = useState(effective);
  const [max] = useState(() =>
    Math.max(200, Math.ceil((Math.max(baseline, effective) * 3) / 10) * 10),
  );
  const pinned = override !== undefined;

  function commit() {
    if (draft !== effective) onSet(dateKey, draft);
  }

  return (
    <div className="border border-line border-dashed rounded-xl px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <p className="flex-1 min-w-0 truncate text-sm text-muted">
          everyday spending
          <span className="text-muted"> · {pinned ? "pinned" : "estimated"}</span>
        </p>
        {pinned && (
          <button
            type="button"
            onClick={() => {
              setDraft(baseline);
              onSet(dateKey, null);
            }}
            className="text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors py-1"
          >
            reset
          </button>
        )}
        <p className="text-sm font-bold tabular-nums text-muted whitespace-nowrap">
          ~−{formatMoney(draft, currency)}
        </p>
      </div>
      {baseline > 0 && (
        <div className="flex gap-1">
          {SPEND_MULTIPLIERS.map((multiplier) => {
            const value = Math.round(baseline * multiplier * 100) / 100;
            const active = draft === value;
            return (
              <button
                key={multiplier}
                type="button"
                onClick={() => {
                  setDraft(value);
                  if (override !== value) onSet(dateKey, value);
                }}
                aria-label={`pin expected spend on ${dateKey} at ${multiplier}× the estimate`}
                className={`min-h-9 flex-1 border px-1 text-[10px] tabular-nums transition-colors ${
                  active
                    ? "border-accent text-accent-ink"
                    : "border-line-strong text-muted hover:border-fg hover:text-fg"
                }`}
              >
                {multiplier}×
              </button>
            );
          })}
        </div>
      )}
      <input
        type="range"
        min={0}
        max={max}
        step={5}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow")) commit();
        }}
        aria-label={`expected everyday spend on ${dateKey}`}
        className="w-full cursor-pointer"
        style={{ accentColor: "var(--accent)" }}
      />
    </div>
  );
}

function SelectedDay({
  dateKey,
  row,
  currency,
  changes,
  expenses,
  incomeSources,
  hoursBySource,
  baselineEstimate,
  override,
  onSetOverride,
  groceryTrip,
}: {
  dateKey: string;
  row: ReturnType<typeof buildDayRows>[number];
  currency: string;
  changes: BalanceChange[];
  expenses: RecurringExpense[];
  incomeSources: IncomeSource[];
  hoursBySource: Record<string, Record<string, number>>;
  baselineEstimate: number;
  override: number | undefined;
  onSetOverride: (dateKey: string, amount: number | null) => void;
  groceryTrip: GroceryTrip | undefined;
}) {
  const label = formatWeekdayMonthDay(new Date(`${dateKey}T00:00:00`));
  const date = new Date(`${dateKey}T00:00:00`);

  const recorded = row.isPast
    ? changes.filter((c) => c.occurred_at === dateKey)
    : [];

  const projectedExpenses = !row.isPast
    ? expenses.filter((e) =>
        ruleLandsOn(
          {
            frequency: e.frequency,
            day_of_month: e.day_of_month,
            weekday: e.weekday,
            interval_days: e.interval_days,
            start_date: e.start_date,
            amount: Number(e.amount),
          },
          date,
        ),
      )
    : [];

  const sourceById = new Map(incomeSources.map((s) => [s.id, s]));
  const projectedIncome = !row.isPast
    ? incomeDetailForDay(incomeSources, hoursBySource, dateKey).flatMap(
        (detail) => {
          const source = sourceById.get(detail.sourceId);
          return source ? [{ source, ...detail }] : [];
        },
      )
    : [];

  // Future days always render the everyday-spending slider row.
  const empty =
    row.isPast &&
    recorded.length === 0 &&
    projectedExpenses.length === 0 &&
    projectedIncome.length === 0;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          {label}
          {!row.isPast && " · forecast"}
        </p>
        <p className="text-sm font-bold tabular-nums text-fg">
          {formatMoney(row.runningTotal, currency)}
        </p>
      </div>

      {empty ? (
        <p className="text-sm text-muted">
          {row.isPast ? "no recorded changes." : "nothing projected."}
        </p>
      ) : (
        <div className="space-y-2">
          {projectedIncome.map(({ source, hours, net, periodStart, periodEnd, fixed }) => (
            <div
              key={`income-${source.id}`}
              className="flex items-center gap-2 border border-line rounded-xl px-3 py-2"
            >
              <span
                className="h-3 w-3 flex-shrink-0"
                style={{ backgroundColor: source.color }}
                aria-hidden
              />
              <p className="flex-1 min-w-0 truncate text-sm text-fg">
                {source.name}
                <span className="text-muted">
                  {" "}
                  ·{" "}
                  {fixed
                    ? "fixed monthly"
                    : periodStart && periodEnd
                      ? `payday · ${hours}h, ${formatMonthDay(
                          new Date(`${periodStart}T00:00:00`),
                        )}–${formatMonthDay(
                          new Date(`${periodEnd}T00:00:00`),
                        )}`
                      : `${hours}h @ ${formatMoney(source.hourly_wage, currency)}`}
                </span>
              </p>
              <p className="text-sm font-bold tabular-nums text-accent-ink whitespace-nowrap">
                +{formatMoney(net, currency)}
              </p>
            </div>
          ))}

          {!row.isPast && groceryTrip && (
            <div className="flex items-center gap-2 border border-line border-dashed rounded-xl px-3 py-2">
              <span className="h-3 w-3 flex-shrink-0 border border-danger" aria-hidden />
              <p className="flex-1 min-w-0 text-sm text-fg">
                grocery trip
                <span className="text-muted">
                  {" "}
                  · {groceryTrip.itemNames.join(", ")}
                </span>
              </p>
              <p className="text-sm font-bold tabular-nums text-muted whitespace-nowrap">
                ≈−{formatMoney(groceryTrip.amount, currency)}
              </p>
            </div>
          )}

          {!row.isPast && (
            <FutureSpendSlider
              key={dateKey}
              dateKey={dateKey}
              baseline={baselineEstimate}
              override={override}
              currency={currency}
              onSet={onSetOverride}
            />
          )}

          {projectedExpenses.map((expense) => (
            <div
              key={`expense-${expense.id}`}
              className="flex items-center gap-2 border border-line rounded-xl px-3 py-2"
            >
              <span
                className="h-3 w-3 flex-shrink-0 bg-danger"
                aria-hidden
              />
              <p className="flex-1 min-w-0 truncate text-sm text-fg">
                {expense.name}
                <span className="text-muted"> · recurring</span>
              </p>
              <p className="text-sm font-bold tabular-nums text-danger whitespace-nowrap">
                −{formatMoney(Number(expense.amount), currency)}
              </p>
            </div>
          ))}

          {recorded.map((change) => (
            <div
              key={`recorded-${change.id}`}
              className="flex items-center gap-2 border border-line rounded-xl px-3 py-2"
            >
              <span
                className="h-3 w-3 flex-shrink-0"
                style={{
                  backgroundColor:
                    change.direction === "in" ? "var(--accent)" : "var(--danger)",
                }}
                aria-hidden
              />
              <p className="flex-1 min-w-0 truncate text-sm text-fg">
                {change.note || (change.direction === "in" ? "income" : "spending")}
                <span className="text-muted"> · recorded</span>
              </p>
              <p
                className="text-sm font-bold tabular-nums whitespace-nowrap"
                style={{
                  color:
                    change.direction === "in" ? "var(--accent)" : "var(--danger)",
                }}
              >
                {change.direction === "in" ? "+" : "−"}
                {formatMoney(Number(change.amount), currency)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
