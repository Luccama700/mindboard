// The sample desk's money.
//
// STUB, written with the contracts so every other part of the desk can be built
// against a function that exists. PLAN-DESK Task 4 replaces the body with an
// invented set of accounts and a forecast; the signature does not change.

import type { MoneyScreenData } from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

/** Takes the sample day so its clock and its planned day are the desk's own. */
export function sampleMoney(today: TodayScreenData): MoneyScreenData {
  return {
    today: today.input.date,
    currency: "USD",
    takenAt: today.input.now,
    ledgerLastOn: null,
    accounts: [],
    forecast: [],
    everyday: { dailyRate: 0, confident: false, manualFallback: null },
    bills: [],
    income: [],
    rows: [],
  };
}
