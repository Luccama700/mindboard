// Projected grocery spend for the finance forecast. Groceries are bought in
// trips, not the moment something empties, so each priced shopping-list entry
// lands on the first shopping-day (user's weekly shopping weekday) on or after
// its buy-by date — entries with no date (out, low, pinned) land at the next
// trip. The everyday-spend baseline already contains historical grocery
// spending, so deductBaseline absorbs each trip into the following days'
// baseline to avoid double-counting. Pure; shared by the /finance page and
// buildFinanceForecast.

import { addDaysKey, daysBetween } from "./inventory-projection";
import type { ShoppingEntry } from "./shopping-list";

export type GroceryTrip = { amount: number; itemNames: string[] };

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

// First date on/after dateKey that falls on shoppingDay (0 = Sunday).
export function snapToShoppingDay(
  dateKey: string,
  shoppingDay: number,
): string {
  const delta = (shoppingDay - weekdayOf(dateKey) + 7) % 7;
  return delta === 0 ? dateKey : addDaysKey(dateKey, delta);
}

export function buildGroceriesByDate(input: {
  entries: ShoppingEntry[];
  today: string;
  shoppingDay: number;
  horizonDays: number;
}): Record<string, GroceryTrip> {
  const trips: Record<string, GroceryTrip> = {};
  const tomorrow = addDaysKey(input.today, 1);

  for (const entry of input.entries) {
    if (entry.estPrice === null || entry.estPrice <= 0) continue;
    const ready =
      entry.buyBy !== null && entry.buyBy > input.today ? entry.buyBy : tomorrow;
    const tripDay = snapToShoppingDay(ready, input.shoppingDay);
    if (daysBetween(input.today, tripDay) > input.horizonDays) continue;

    const trip = trips[tripDay] ?? { amount: 0, itemNames: [] };
    trip.amount =
      Math.round((trip.amount + entry.estPrice) * 100) / 100;
    trip.itemNames.push(entry.name);
    trips[tripDay] = trip;
  }
  return trips;
}

export function groceryAmountsByDate(
  trips: Record<string, GroceryTrip>,
): Record<string, number> {
  const amounts: Record<string, number> = {};
  for (const [dateKey, trip] of Object.entries(trips)) {
    amounts[dateKey] = trip.amount;
  }
  return amounts;
}

// Absorb each trip into the everyday baseline that follows it: from the trip
// day forward (until the next trip or seven days, whichever comes first),
// baseline days are zeroed day-by-day until the trip amount is consumed.
// Returns a new map; never negative.
export function deductBaseline(
  estimatedSpendByDate: Record<string, number>,
  groceriesByDate: Record<string, number>,
): Record<string, number> {
  const adjusted: Record<string, number> = { ...estimatedSpendByDate };
  const tripDays = Object.keys(groceriesByDate).sort();

  for (let i = 0; i < tripDays.length; i += 1) {
    const tripDay = tripDays[i];
    const nextTrip = tripDays[i + 1] ?? null;
    let remaining = groceriesByDate[tripDay];
    for (let offset = 0; offset < 7 && remaining > 0; offset += 1) {
      const day = offset === 0 ? tripDay : addDaysKey(tripDay, offset);
      if (nextTrip !== null && day >= nextTrip) break;
      const baseline = adjusted[day];
      if (baseline === undefined || baseline <= 0) continue;
      const take = Math.min(baseline, remaining);
      adjusted[day] = Math.round((baseline - take) * 100) / 100;
      remaining = Math.round((remaining - take) * 100) / 100;
    }
  }
  return adjusted;
}
