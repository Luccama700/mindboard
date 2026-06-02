"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  formatMonthDay,
  formatMonthYear,
  formatWeekdayMonthDay,
  todayISO,
} from "./date-utils";
import { formatMoney } from "./money";
import {
  buildDayRows,
  computeIncomeByDate,
  incomeDetailForDay,
  ruleLandsOn,
} from "./finance-projection";
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
}: {
  month: string;
  currency: string;
  netWorthToday: number;
  changes: BalanceChange[];
  expenses: RecurringExpense[];
  incomeSources: IncomeSource[];
  hoursBySource: Record<string, Record<string, number>>;
  googleStatus: GoogleStatus;
}) {
  const today = todayISO();
  const gridDays = useMemo(() => buildGrid(month), [month]);

  const incomeByDate = useMemo(() => {
    const first = gridDays[0];
    const start = first && first < today ? first : today;
    const end = gridDays[gridDays.length - 1] ?? today;
    return computeIncomeByDate(incomeSources, hoursBySource, { start, end });
  }, [incomeSources, hoursBySource, gridDays, today]);

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
        })),
        expenses,
        incomeByDate,
      }),
    [gridDays, month, today, netWorthToday, changes, expenses, incomeByDate],
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
    <section className="border border-line bg-popover p-3 lg:min-h-[calc(100vh-4rem)]">
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
            className="flex h-9 min-w-9 items-center justify-center border border-line-strong text-muted transition-colors hover:border-fg hover:text-fg"
            aria-label="previous month"
          >
            ←
          </Link>
          <Link
            href={`/finance?fm=${addMonths(month, 1)}`}
            scroll={false}
            className="flex h-9 min-w-9 items-center justify-center border border-line-strong text-muted transition-colors hover:border-fg hover:text-fg"
            aria-label="next month"
          >
            →
          </Link>
        </div>
      </header>

      {incomeLinked && googleStatus !== "connected" && (
        <div className="border border-line-strong px-3 py-2 mb-3">
          <p className="text-xs text-muted leading-relaxed">
            {googleStatus === "connect"
              ? "connect google calendar (sign out and back in) to project wage income from your shifts."
              : "google calendar is temporarily unavailable, so wage income isn't projected right now."}
          </p>
        </div>
      )}

      <div className="grid grid-cols-7 gap-px bg-line border border-line">
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
                isSelected ? "outline outline-1 outline-accent" : ""
              } ${row.inMonth ? "text-fg" : "text-line-subtle"}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-xs ${
                    row.isToday ? "text-accent font-bold" : ""
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
                  <p className="text-[10px] tabular-nums text-accent leading-tight">
                    +{formatMoney(row.inflow, currency)}
                  </p>
                )}
                {row.outflow > 0 && (
                  <p className="text-[10px] tabular-nums text-danger leading-tight">
                    −{formatMoney(row.outflow, currency)}
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
        />
      )}
    </section>
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
}: {
  dateKey: string;
  row: ReturnType<typeof buildDayRows>[number];
  currency: string;
  changes: BalanceChange[];
  expenses: RecurringExpense[];
  incomeSources: IncomeSource[];
  hoursBySource: Record<string, Record<string, number>>;
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

  const empty =
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
          {projectedIncome.map(({ source, hours, net, periodStart, periodEnd }) => (
            <div
              key={`income-${source.id}`}
              className="flex items-center gap-2 border border-line px-3 py-2"
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
                  {periodStart && periodEnd
                    ? `payday · ${hours}h, ${formatMonthDay(
                        new Date(`${periodStart}T00:00:00`),
                      )}–${formatMonthDay(
                        new Date(`${periodEnd}T00:00:00`),
                      )}`
                    : `${hours}h @ ${formatMoney(source.hourly_wage, currency)}`}
                </span>
              </p>
              <p className="text-sm font-bold tabular-nums text-accent whitespace-nowrap">
                +{formatMoney(net, currency)}
              </p>
            </div>
          ))}

          {projectedExpenses.map((expense) => (
            <div
              key={`expense-${expense.id}`}
              className="flex items-center gap-2 border border-line px-3 py-2"
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
              className="flex items-center gap-2 border border-line px-3 py-2"
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
