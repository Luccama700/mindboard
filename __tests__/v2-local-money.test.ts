// @vitest-environment node
// PLAN-DESK Task 4, the money of a local snapshot folder.
//
// EVERYTHING IN THIS FILE IS INVENTED. Each folder is built in a temp directory
// with made up accounts, bills, pay and ledger lines; nothing here reads the
// owner's export, and nothing here writes anywhere but the temp dir.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { LocalSnapshotError } from "@/app/lib/v2/local/files";
import { MONEY_FILE, loadLocalMoney } from "@/app/lib/v2/local/money";

const made: string[] = [];

afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A folder holding `money.json` with this body, or no money file at all. */
async function folder(body: string | null): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-local-money-"));
  made.push(dir);
  if (body !== null) await writeFile(path.join(dir, MONEY_FILE), body, "utf8");
  return dir;
}

/** The desk's day: the sample's, which is not the day the money file was taken. */
const DESK = sampleDay();

function moneyFile(): Record<string, unknown> {
  return {
    version: 1,
    takenAt: "2026-04-14T18:30:00Z",
    today: "2026-04-14",
    currency: "USD",
    netWorth: 4800,
    accounts: [
      { id: "acc-1", name: "Everyday", type: "checking", balance: 1300, currency: "USD", extra: "ignored" },
      { id: "acc-2", name: "Card", type: "credit", balance: -500, currency: "USD" },
    ],
    recurring: [
      { id: "bill-1", name: "Phone", amount: 50, category: "Bills", schedule: "monthly on day 20" },
      { id: "bill-2", name: "Water", amount: 40, category: null, schedule: "monthly on day 28" },
    ],
    income: [
      {
        id: "inc-1",
        name: "Shop pay",
        hourlyWage: null,
        taxRatePct: 0,
        calendarId: null,
        paySchedule: { frequency: "monthly", anchorPayday: "2026-03-25" },
        fixedMonthly: { amount: 2000, dayOfMonth: 25 },
      },
      {
        id: "inc-2",
        name: "Tutoring",
        hourlyWage: 20,
        taxRatePct: 10,
        calendarId: "cal-tutor",
        paySchedule: { frequency: "weekly", anchorPayday: "2026-04-10" },
        fixedMonthly: null,
      },
    ],
    categories: [{ name: "Food", color: "#336699" }],
    limits: [{ label: "Food", period: "monthly", amount: 300, spent: 100, remaining: 200, state: "under" }],
    forecast: {
      everydaySpend: { dailyRate: 30, sampledWeeks: 6, confident: true, manualFallback: null },
      groceryTrips: [{ date: "2026-04-18", amount: 60, items: 4 }],
      days: [
        { date: "2026-04-14", inflow: 0, outflow: 0, everyday: 0, groceries: 0, projected: 4800 },
        { date: "2026-04-15", inflow: 0, outflow: 0, everyday: 30, groceries: 0, projected: 4770 },
        { date: "2026-04-16", inflow: 0, outflow: 0, everyday: 30, groceries: 0, projected: 4740 },
        { date: "2026-04-17", inflow: 0, outflow: 50, everyday: 30, groceries: 0, projected: 4660 },
      ],
    },
    ledger: {
      lastOn: "2026-04-12",
      rows: [
        { id: "row-1", on: "2026-04-12", direction: "out", amount: 12, account: "Everyday", category: "Food", note: "Bakery" },
        { id: "row-2", on: "2026-04-10", direction: "in", amount: 60, account: "Everyday", category: null, note: "" },
      ],
    },
  };
}

async function load(file: Record<string, unknown> | string | null) {
  const body = file === null ? null : typeof file === "string" ? file : JSON.stringify(file);
  return loadLocalMoney(await folder(body), DESK);
}

async function refusal(file: Record<string, unknown> | string): Promise<LocalSnapshotError> {
  try {
    await load(file);
  } catch (error) {
    if (error instanceof LocalSnapshotError) return error;
    throw error;
  }
  throw new Error("the file loaded when it should not have");
}

/** A deep copy of the file with one path replaced. */
function withValue(at: string, value: unknown): Record<string, unknown> {
  const file = moneyFile();
  const keys = at.split(".");
  let node = file as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
  return file;
}

describe("the money file of a local folder", () => {
  test("is null when the folder has no money file", async () => {
    expect(MONEY_FILE).toBe("money.json");
    expect(await load(null)).toBeNull();
  });

  test("maps the file onto the desk's money, on the desk's own day", async () => {
    const money = await load(moneyFile());
    expect(money).toEqual({
      // The desk's planned day, not the day the copy was taken.
      today: DESK.input.date,
      currency: "USD",
      takenAt: "2026-04-14T18:30:00Z",
      ledgerLastOn: "2026-04-12",
      accounts: [
        { id: "acc-1", name: "Everyday", kind: "checking", balance: 1300, currency: "USD" },
        { id: "acc-2", name: "Card", kind: "credit", balance: -500, currency: "USD" },
      ],
      forecast: [
        { date: "2026-04-14", inflow: 0, outflow: 0, everyday: 0, groceries: 0, projected: 4800 },
        { date: "2026-04-15", inflow: 0, outflow: 0, everyday: 30, groceries: 0, projected: 4770 },
        { date: "2026-04-16", inflow: 0, outflow: 0, everyday: 30, groceries: 0, projected: 4740 },
        { date: "2026-04-17", inflow: 0, outflow: 50, everyday: 30, groceries: 0, projected: 4660 },
      ],
      everyday: { dailyRate: 30, confident: true, manualFallback: null },
      bills: [
        { id: "bill-1", name: "Phone", amount: 50, schedule: "monthly on day 20" },
        { id: "bill-2", name: "Water", amount: 40, schedule: "monthly on day 28" },
      ],
      income: [
        { id: "inc-1", name: "Shop pay", fixedMonthly: { amount: 2000, dayOfMonth: 25 } },
        { id: "inc-2", name: "Tutoring", fixedMonthly: null },
      ],
      rows: [
        { id: "row-1", on: "2026-04-12", direction: "out", amount: 12, account: "Everyday", category: "Food", note: "Bakery" },
        { id: "row-2", on: "2026-04-10", direction: "in", amount: 60, account: "Everyday", category: null, note: "" },
      ],
    });
  });

  test("takes an empty ledger with no last day", async () => {
    const money = await load(withValue("ledger", { lastOn: null, rows: [] }));
    expect(money?.ledgerLastOn).toBeNull();
    expect(money?.rows).toEqual([]);
  });

  test("takes the newest row's day when the ledger names no last day", async () => {
    const money = await load(
      withValue("ledger", {
        lastOn: null,
        rows: [
          { id: "row-a", on: "2026-04-10", direction: "out", amount: 5, account: "Everyday", category: null, note: "" },
          { id: "row-b", on: "2026-04-12", direction: "out", amount: 7, account: "Everyday", category: null, note: "" },
        ],
      }),
    );
    expect(money?.ledgerLastOn).toBe("2026-04-12");
  });

  test("keeps the first of two entries with one id, and drops the rest quietly", async () => {
    const file = moneyFile();
    const accounts = file.accounts as Array<Record<string, unknown>>;
    accounts.push({ ...accounts[0], name: "Everyday again", balance: 9 });
    const recurring = file.recurring as Array<Record<string, unknown>>;
    recurring.push({ ...recurring[1], name: "Water again" });
    const income = file.income as Array<Record<string, unknown>>;
    income.unshift({ ...income[1], name: "Tutoring first" });
    const ledger = file.ledger as { rows: Array<Record<string, unknown>> };
    ledger.rows.push({ ...ledger.rows[0], note: "Bakery again" });

    const money = await load(file);
    expect(money?.accounts.map((account) => `${account.id} ${account.name}`)).toEqual([
      "acc-1 Everyday",
      "acc-2 Card",
    ]);
    expect(money?.bills.map((bill) => `${bill.id} ${bill.name}`)).toEqual([
      "bill-1 Phone",
      "bill-2 Water",
    ]);
    expect(money?.income.map((entry) => `${entry.id} ${entry.name}`)).toEqual([
      "inc-2 Tutoring first",
      "inc-1 Shop pay",
    ]);
    expect(money?.rows.map((line) => `${line.id} ${line.note}`)).toEqual(["row-1 Bakery", "row-2 "]);
  });

  test("takes a manual everyday figure", async () => {
    const money = await load(
      withValue("forecast.everydaySpend", { dailyRate: 0, sampledWeeks: 0, confident: false, manualFallback: 45 }),
    );
    expect(money?.everyday).toEqual({ dailyRate: 0, confident: false, manualFallback: 45 });
  });

  // The parts nothing on the desk reads are not judged: a refusal over a field
  // nobody shows would cost the whole of Money.
  test("does not refuse a file over the parts the desk never reads", async () => {
    const file = moneyFile();
    delete file.limits;
    delete file.categories;
    delete file.netWorth;
    (file.forecast as Record<string, unknown>).groceryTrips = null;
    ((file.income as Array<Record<string, unknown>>)[0]).paySchedule = null;
    file.unknownKey = { anything: true };
    const money = await load(file);
    expect(money?.income).toHaveLength(2);
    expect(Object.keys(money ?? {})).not.toContain("unknownKey");
  });
});

describe("a money file that is there and wrong", () => {
  const MARKER = "MARKER-7731";

  test("names money.json and the field's path, never the value", async () => {
    const error = await refusal(withValue("forecast.days", [
      { date: "2026-04-14", inflow: 0, outflow: 0, everyday: 0, groceries: 0, projected: MARKER },
    ]));
    expect(error.file).toBe(MONEY_FILE);
    expect(error.message).toBe(
      "money.json does not have the shape this screen needs (at forecast.days.0.projected).",
    );
    expect(error.message).not.toContain(MARKER);
  });

  test("refuses a day that does not exist", async () => {
    const error = await refusal(withValue("ledger.rows", [
      { id: "row-1", on: "2026-13-45", direction: "out", amount: 12, account: "Everyday", category: null, note: MARKER },
    ]));
    expect(error.message).toContain("(at ledger.rows.0.on)");
    expect(error.message).not.toContain("2026-13-45");
    expect(error.message).not.toContain(MARKER);
  });

  test("refuses an instant that cannot be read", async () => {
    const error = await refusal(withValue("takenAt", MARKER));
    expect(error.message).toContain("(at takenAt)");
    expect(error.message).not.toContain(MARKER);
  });

  test("refuses a direction it does not know", async () => {
    const error = await refusal(withValue("ledger.rows", [
      { id: "row-1", on: "2026-04-12", direction: MARKER, amount: 12, account: "Everyday", category: null, note: "" },
    ]));
    expect(error.message).toContain("(at ledger.rows.0.direction)");
    expect(error.message).not.toContain(MARKER);
  });

  test("refuses a version it does not know", async () => {
    const error = await refusal(withValue("version", 2));
    expect(error.message).toContain("(at version)");
  });

  test("refuses a missing account balance", async () => {
    const error = await refusal(withValue("accounts", [{ id: "acc-1", name: "Everyday", type: "checking", currency: "USD" }]));
    expect(error.message).toContain("(at accounts.0.balance)");
  });

  test("says the file is not JSON without quoting it", async () => {
    const error = await refusal(`{ "version": 1, "currency": "${MARKER}" `);
    expect(error.message).toBe("money.json is not valid JSON.");
  });
});
