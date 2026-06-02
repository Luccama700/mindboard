// Pure inventory rollup for the dashboard vitals strip. Reuses the tested
// depletion projection: counts items at/below their reorder threshold and finds
// the item projected to run out soonest.

import {
  effectiveDailyRate,
  runOutDateKey,
  stockStatus,
  type UsageRule,
} from "@/app/_components/inventory-projection";
import type {
  InventoryItem,
  InventoryUsage,
} from "@/app/_components/inventory-types";

export type InventoryVitals = {
  lowCount: number;
  outCount: number;
  soonestRunOut: { name: string; dateKey: string } | null;
};

function usageRulesByItem(
  usages: InventoryUsage[],
): Map<string, UsageRule[]> {
  const byItem = new Map<string, UsageRule[]>();
  for (const u of usages) {
    const list = byItem.get(u.inventory_item_id) ?? [];
    list.push({
      amount: Number(u.amount),
      period: u.period,
      interval_days: u.interval_days,
    });
    byItem.set(u.inventory_item_id, list);
  }
  return byItem;
}

export function inventorySnapshot(input: {
  items: InventoryItem[];
  usages: InventoryUsage[];
  today: string;
}): InventoryVitals {
  const { items, usages, today } = input;
  const rulesByItem = usageRulesByItem(usages);

  let lowCount = 0;
  let outCount = 0;
  let soonestRunOut: { name: string; dateKey: string } | null = null;

  for (const item of items) {
    const status = stockStatus(Number(item.quantity), item.reorder_threshold);
    if (status === "low") lowCount++;
    if (status === "out") outCount++;

    const rate = effectiveDailyRate(rulesByItem.get(item.id) ?? []);
    const runOut = runOutDateKey(today, Number(item.quantity), rate);
    if (runOut && (!soonestRunOut || runOut < soonestRunOut.dateKey)) {
      soonestRunOut = { name: item.name, dateKey: runOut };
    }
  }

  return { lowCount, outCount, soonestRunOut };
}
