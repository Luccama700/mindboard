// The sample desk's money.
//
// EVERYTHING HERE IS INVENTED: two accounts, two bills, one pay, an everyday
// estimate typed in by hand, and fifteen ledger lines. The figures are round
// and unremarkable on purpose; none describes anybody.
//
// The forecast is built here, in the fixture, because the sample has no app to
// have computed it. It is seeded from the accounts' own sum, so the Accounts
// pane and the forecast's first day agree, and every bill and the pay land on a
// day and an amount the marks can name. The view model never does this sum; it
// only shows what a source hands it.
//
// Deterministic: a pure function of the sample day's date and clock.

import { shiftDateKey } from "@/app/lib/v2/plan/day";
import type { DateKey } from "@/app/lib/v2/types";
import type {
  MoneyAccount,
  MoneyBill,
  MoneyDay,
  MoneyIncome,
  MoneyRow,
  MoneyScreenData,
} from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

const CURRENCY = "USD";
const FORECAST_DAYS = 60;
/** The everyday estimate, as if typed in by hand. */
const EVERYDAY = 40;
/** How many days before the sample day the newest ledger line is. */
const FRESH_DAYS_BACK = 2;
/** The same, for the stale twin. */
const STALE_DAYS_BACK = 80;

const ACCOUNTS: MoneyAccount[] = [
  { id: "sample-everyday", name: "Everyday", kind: "checking", balance: 1850, currency: CURRENCY },
  { id: "sample-savings", name: "Savings", kind: "savings", balance: 4000, currency: CURRENCY },
];

/** Each bill with the day of the month it lands on; the schedule says the same day. */
const BILLS: Array<MoneyBill & { day: number }> = [
  { id: "sample-rent", name: "Rent", amount: 1200, schedule: "monthly on day 1", day: 1 },
  { id: "sample-phone", name: "Phone", amount: 50, schedule: "monthly on day 20", day: 20 },
];

const INCOME: MoneyIncome[] = [
  { id: "sample-shop-pay", name: "Shop pay", fixedMonthly: { amount: 2000, dayOfMonth: 25 } },
];

/** Newest first: days before the newest line, then the line itself. */
const LINES: Array<{ back: number } & Omit<MoneyRow, "id" | "on">> = [
  { back: 0, direction: "out", amount: 18, account: "Everyday", category: "Food", note: "Lunch with the study group" },
  { back: 0, direction: "out", amount: 6, account: "Everyday", category: "Food", note: "Coffee" },
  { back: 1, direction: "out", amount: 45, account: "Everyday", category: "Food", note: "Groceries for the week" },
  { back: 2, direction: "out", amount: 3, account: "Everyday", category: "Transport", note: "Bus fare" },
  {
    back: 3,
    direction: "out",
    amount: 120,
    account: "Everyday",
    category: "Home",
    note: "Desk lamp and a long extension cord for the corner by the window, after returning the first one",
  },
  { back: 4, direction: "in", amount: 60, account: "Everyday", category: "Clothes", note: "Refund for a returned jacket" },
  { back: 6, direction: "out", amount: 50, account: "Everyday", category: "Bills", note: "Phone" },
  { back: 7, direction: "out", amount: 12, account: "Everyday", category: "Food", note: "Bakery" },
  { back: 8, direction: "out", amount: 30, account: "Everyday", category: "Fun", note: "Cinema tickets" },
  { back: 10, direction: "in", amount: 2000, account: "Everyday", category: null, note: "Shop pay" },
  { back: 11, direction: "out", amount: 25, account: "Everyday", category: "Food", note: "Market" },
  { back: 13, direction: "out", amount: 9, account: "Everyday", category: "Transport", note: "Bus pass top up" },
  { back: 14, direction: "out", amount: 20, account: "Everyday", category: "Health", note: "Pharmacy" },
  { back: 16, direction: "out", amount: 15, account: "Everyday", category: "Food", note: "Takeaway" },
  { back: 18, direction: "out", amount: 200, account: "Savings", category: null, note: "Moved to Everyday" },
];

/**
 * Sixty days from the sample day. Day one is what the accounts hold; every
 * later day is the day before, plus pay, less bills and the everyday estimate.
 */
function forecastFrom(today: DateKey): MoneyDay[] {
  const held = ACCOUNTS.reduce((sum, account) => sum + account.balance, 0);
  const days: MoneyDay[] = [];
  for (let index = 0; index < FORECAST_DAYS; index += 1) {
    const date = shiftDateKey(today, index);
    const dayOfMonth = Number(date.slice(8, 10));
    const inflow = INCOME.reduce(
      (sum, income) =>
        income.fixedMonthly !== null && income.fixedMonthly.dayOfMonth === dayOfMonth
          ? sum + income.fixedMonthly.amount
          : sum,
      0,
    );
    const outflow = BILLS.reduce((sum, bill) => (bill.day === dayOfMonth ? sum + bill.amount : sum), 0);
    const everyday = index === 0 ? 0 : EVERYDAY;
    const projected =
      index === 0 ? held : days[index - 1].projected + inflow - outflow - everyday;
    days.push({ date, inflow, outflow, everyday, groceries: 0, projected });
  }
  return days;
}

function ledgerFrom(today: DateKey, daysBack: number): MoneyRow[] {
  return LINES.map(({ back, ...line }, index) => ({
    id: `sample-line-${index + 1}`,
    on: shiftDateKey(today, -(daysBack + back)),
    ...line,
  }));
}

function moneyFor(today: TodayScreenData, daysBack: number): MoneyScreenData {
  const date = today.input.date;
  const rows = ledgerFrom(date, daysBack);
  return {
    today: date,
    currency: CURRENCY,
    takenAt: today.input.now,
    ledgerLastOn: rows[0].on,
    accounts: ACCOUNTS.map((account) => ({ ...account })),
    forecast: forecastFrom(date),
    everyday: { dailyRate: 0, confident: false, manualFallback: EVERYDAY },
    bills: BILLS.map(({ id, name, amount, schedule }) => ({ id, name, amount, schedule })),
    income: INCOME.map((income) => ({
      ...income,
      fixedMonthly: income.fixedMonthly === null ? null : { ...income.fixedMonthly },
    })),
    rows,
  };
}

/** Takes the sample day so its clock and its planned day are the desk's own. */
export function sampleMoney(today: TodayScreenData): MoneyScreenData {
  return moneyFor(today, FRESH_DAYS_BACK);
}

/**
 * The same money with its newest ledger line 80 days back: what every Money
 * pane looks like when it has to lead with how old its numbers are. For tests
 * and the gallery.
 */
export function sampleMoneyStale(today: TodayScreenData): MoneyScreenData {
  return moneyFor(today, STALE_DAYS_BACK);
}
