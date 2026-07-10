// The shopping list is derived, not stored: an item belongs on it when it is
// out, at/below its reorder threshold, projected to run out within the
// horizon, or manually pinned (shopping_pinned). Only the pin persists —
// everything else recomputes from live quantities and usage rules. Pure and
// shared by the /inventory panel, the MCP server, and the in-app assistant.

import {
  daysBetween,
  effectiveDailyRate,
  reorderDateKey,
  runOutDateKey,
  stockStatus,
  type UsageRule,
} from "./inventory-projection";

export const SHOPPING_HORIZON_DAYS = 7;

export type ShoppingReason = "out" | "low" | "soon" | "pinned";

export type ShoppingListItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  reorder_threshold: number | null;
  archived: boolean;
  shopping_pinned: boolean;
  buy_amount: number | null;
  est_price: number | null;
  price_source: "ai" | "manual" | null;
};

export type ShoppingEntry = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  // Highest-severity reason wins: out > low > soon > pinned.
  reason: ShoppingReason;
  runOutDate: string | null;
  // The projected buy-by date backing a "soon" reason (reorder-by when a
  // threshold is set, else run-out). Null means "buy at the next trip".
  buyBy: string | null;
  pinned: boolean;
  // Planned purchase amount in the item's own unit (null = one typical
  // package); estPrice is the projected TOTAL for that purchase.
  buyAmount: number | null;
  estPrice: number | null;
  priceSource: "ai" | "manual" | null;
};

const REASON_ORDER: Record<ShoppingReason, number> = {
  out: 0,
  low: 1,
  soon: 2,
  pinned: 3,
};

export function buildShoppingList(input: {
  items: ShoppingListItem[];
  rulesByItem: Map<string, UsageRule[]>;
  today: string;
  horizonDays?: number;
}): ShoppingEntry[] {
  const horizon = input.horizonDays ?? SHOPPING_HORIZON_DAYS;
  const entries: ShoppingEntry[] = [];

  for (const item of input.items) {
    if (item.archived) continue;
    const qty = Number(item.quantity);
    const status = stockStatus(qty, item.reorder_threshold);
    const rate = effectiveDailyRate(input.rulesByItem.get(item.id) ?? []);
    const runOut = qty > 0 ? runOutDateKey(input.today, qty, rate) : null;

    let reason: ShoppingReason | null = null;
    let buyBy: string | null = null;
    if (status === "out") {
      reason = "out";
    } else if (status === "low") {
      reason = "low";
    } else {
      const reorderBy = reorderDateKey(
        input.today,
        qty,
        rate,
        item.reorder_threshold,
      );
      const soonBy = reorderBy ?? runOut;
      if (soonBy !== null && daysBetween(input.today, soonBy) <= horizon) {
        reason = "soon";
        buyBy = soonBy;
      } else if (item.shopping_pinned) {
        reason = "pinned";
      }
    }
    if (!reason) continue;

    entries.push({
      id: item.id,
      name: item.name,
      quantity: qty,
      unit: item.unit,
      reason,
      runOutDate: runOut,
      buyBy,
      pinned: item.shopping_pinned,
      buyAmount: item.buy_amount === null ? null : Number(item.buy_amount),
      estPrice: item.est_price === null ? null : Number(item.est_price),
      priceSource: item.price_source,
    });
  }

  entries.sort((a, b) => {
    const tier = REASON_ORDER[a.reason] - REASON_ORDER[b.reason];
    if (tier !== 0) return tier;
    const aDate = a.buyBy ?? "9999-12-31";
    const bDate = b.buyBy ?? "9999-12-31";
    if (aDate !== bDate) return aDate < bDate ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export function shoppingTotal(entries: ShoppingEntry[]): {
  total: number;
  unpricedCount: number;
} {
  let cents = 0;
  let unpricedCount = 0;
  for (const entry of entries) {
    if (entry.estPrice === null) unpricedCount += 1;
    else cents += Math.round(entry.estPrice * 100);
  }
  return { total: cents / 100, unpricedCount };
}
