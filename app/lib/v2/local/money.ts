// The money of a local snapshot folder: one file, `money.json`, written outside
// git by whoever builds the folder, and read here through the folder's one door
// (files.ts `readOptionalFile`), so a file that is there and wrong is the same
// LocalSnapshotError every other file reports: a literal file name and a fixed
// phrase, with the path of the field, never a value.
//
// ONLY WHAT THE DESK READS IS JUDGED. The file carries more than the panes show
// (net worth, wages, pay schedules, categories, limits, grocery trips), and an
// unknown or unread key is dropped rather than refused, as files.ts does for
// every export: a refusal over a field nobody shows would cost the whole of
// Money. What IS read is held hard: every date names a day that exists, the
// instant can be read, every amount is a finite number, and only the fields the
// file's own shape lets be null may be.
//
// THE DAY IS THE DESK'S. The file says which day it was taken on; the desk shows
// the planned day the same request already loaded, and the view drops the
// forecast's rows before it.
//
// Server only: reads files. Never imported by anything a browser loads.

import { z } from "zod";

import { dayDiff } from "@/app/lib/v2/plan/day";
import type { MoneyScreenData } from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

import { isRealDateKey, readOptionalFile } from "./files";

/** The folder's money file. A fixed name: nothing is ever derived from a request. */
export const MONEY_FILE = "money.json";

const day = z.string().refine(isRealDateKey);

/**
 * An ISO 8601 instant with an explicit offset or "Z", as types.ts defines one.
 * The shape is checked as well as the parse because V8's `Date.parse` is
 * lenient: it reads a year out of "anything-2026" and answers a real instant.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = z
  .string()
  .refine((value) => ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value)));
const amount = z.number().finite();
const id = z.string().min(1);

const moneySchema = z.object({
  version: z.literal(1),
  takenAt: instant,
  currency: z.string().min(1),
  accounts: z.array(
    z.object({ id, name: z.string(), type: z.string(), balance: amount, currency: z.string() }),
  ),
  recurring: z.array(z.object({ id, name: z.string(), amount, schedule: z.string() })),
  income: z.array(
    z.object({
      id,
      name: z.string(),
      fixedMonthly: z
        .object({ amount, dayOfMonth: z.number().int().min(1).max(31) })
        .nullish()
        .transform((value) => value ?? null),
    }),
  ),
  forecast: z.object({
    everydaySpend: z.object({
      dailyRate: amount,
      confident: z.boolean(),
      manualFallback: amount.nullish().transform((value) => value ?? null),
    }),
    days: z.array(
      z.object({
        date: day,
        inflow: amount,
        outflow: amount,
        everyday: amount,
        groceries: amount,
        projected: amount,
      }),
    ),
  }),
  ledger: z.object({
    lastOn: day.nullish().transform((value) => value ?? null),
    rows: z.array(
      z.object({
        id,
        on: day,
        direction: z.enum(["in", "out"]),
        amount,
        account: z.string(),
        category: z
          .string()
          .nullish()
          .transform((value) => value ?? null),
        note: z.string(),
      }),
    ),
  }),
});

/**
 * The first entry of each id, in the file's order; later ones are dropped
 * without a word. The panes key their rows by id, and these lists are for
 * reading, not a ledger of record, so a repeated id is not worth refusing the
 * whole of Money over.
 */
function firstOfEachId<T extends { id: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/**
 * Takes the day the same request already loaded, for its clock and its planned
 * day. Null when the folder holds no money file: the panes then say so.
 */
export async function loadLocalMoney(
  dir: string,
  today: TodayScreenData,
): Promise<MoneyScreenData | null> {
  const file = await readOptionalFile(dir, MONEY_FILE, moneySchema);
  if (file === null) return null;
  const rows = firstOfEachId(file.ledger.rows);
  // A ledger that names no last day but holds lines is as old as its newest
  // line: null would make the panes say nothing was ever recorded.
  const newest = rows.reduce<string | null>(
    (latest, line) => (latest === null || dayDiff(latest, line.on) > 0 ? line.on : latest),
    null,
  );
  return {
    today: today.input.date,
    currency: file.currency,
    takenAt: file.takenAt,
    ledgerLastOn: file.ledger.lastOn ?? newest,
    accounts: firstOfEachId(file.accounts).map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.type,
      balance: account.balance,
      currency: account.currency,
    })),
    forecast: file.forecast.days.map((entry) => ({
      date: entry.date,
      inflow: entry.inflow,
      outflow: entry.outflow,
      everyday: entry.everyday,
      groceries: entry.groceries,
      projected: entry.projected,
    })),
    everyday: {
      dailyRate: file.forecast.everydaySpend.dailyRate,
      confident: file.forecast.everydaySpend.confident,
      manualFallback: file.forecast.everydaySpend.manualFallback,
    },
    bills: firstOfEachId(file.recurring).map((bill) => ({
      id: bill.id,
      name: bill.name,
      amount: bill.amount,
      schedule: bill.schedule,
    })),
    income: firstOfEachId(file.income).map((income) => ({
      id: income.id,
      name: income.name,
      fixedMonthly: income.fixedMonthly,
    })),
    rows: rows.map((line) => ({
      id: line.id,
      on: line.on,
      direction: line.direction,
      amount: line.amount,
      account: line.account,
      category: line.category,
      note: line.note,
    })),
  };
}
