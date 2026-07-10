import { describe, expect, test } from "vitest";
import {
  buildShoppingList,
  shoppingTotal,
  type ShoppingListItem,
} from "@/app/_components/shopping-list";
import type { UsageRule } from "@/app/_components/inventory-projection";

const TODAY = "2026-07-09";

function item(partial: Partial<ShoppingListItem> & { id: string }): ShoppingListItem {
  return {
    name: partial.id,
    quantity: 10,
    unit: "",
    reorder_threshold: null,
    archived: false,
    shopping_pinned: false,
    buy_amount: null,
    est_price: null,
    price_source: null,
    ...partial,
  };
}

function rules(
  entries: [string, UsageRule[]][],
): Map<string, UsageRule[]> {
  return new Map(entries);
}

describe("buildShoppingList reasons", () => {
  test("quantity zero is out", () => {
    const list = buildShoppingList({
      items: [item({ id: "milk", quantity: 0 })],
      rulesByItem: rules([]),
      today: TODAY,
    });
    expect(list).toHaveLength(1);
    expect(list[0].reason).toBe("out");
    expect(list[0].runOutDate).toBeNull();
  });

  test("at or below threshold is low", () => {
    const list = buildShoppingList({
      items: [item({ id: "eggs", quantity: 2, reorder_threshold: 3 })],
      rulesByItem: rules([]),
      today: TODAY,
    });
    expect(list[0].reason).toBe("low");
  });

  test("reorder-by within horizon is soon", () => {
    const list = buildShoppingList({
      items: [item({ id: "rice", quantity: 8, reorder_threshold: 2 })],
      rulesByItem: rules([
        ["rice", [{ amount: 1, period: "day", interval_days: null }]],
      ]),
      today: TODAY,
    });
    expect(list[0].reason).toBe("soon");
    expect(list[0].buyBy).toBe("2026-07-15");
  });

  test("run-out backs soon when no threshold is set", () => {
    const list = buildShoppingList({
      items: [item({ id: "oats", quantity: 5 })],
      rulesByItem: rules([
        ["oats", [{ amount: 1, period: "day", interval_days: null }]],
      ]),
      today: TODAY,
    });
    expect(list[0].reason).toBe("soon");
    expect(list[0].buyBy).toBe("2026-07-14");
  });

  test("horizon boundary: day 7 in, day 8 out", () => {
    const inside = buildShoppingList({
      items: [item({ id: "a", quantity: 7 })],
      rulesByItem: rules([
        ["a", [{ amount: 1, period: "day", interval_days: null }]],
      ]),
      today: TODAY,
    });
    expect(inside).toHaveLength(1);

    const outside = buildShoppingList({
      items: [item({ id: "b", quantity: 8 })],
      rulesByItem: rules([
        ["b", [{ amount: 1, period: "day", interval_days: null }]],
      ]),
      today: TODAY,
    });
    expect(outside).toHaveLength(0);
  });

  test("pinned item with healthy stock appears as pinned", () => {
    const list = buildShoppingList({
      items: [item({ id: "coffee", shopping_pinned: true })],
      rulesByItem: rules([]),
      today: TODAY,
    });
    expect(list[0].reason).toBe("pinned");
    expect(list[0].pinned).toBe(true);
  });

  test("stock reason outranks pinned but keeps the flag", () => {
    const list = buildShoppingList({
      items: [item({ id: "milk", quantity: 0, shopping_pinned: true })],
      rulesByItem: rules([]),
      today: TODAY,
    });
    expect(list[0].reason).toBe("out");
    expect(list[0].pinned).toBe(true);
  });

  test("archived items never appear, even pinned at zero", () => {
    const list = buildShoppingList({
      items: [
        item({ id: "old", quantity: 0, shopping_pinned: true, archived: true }),
      ],
      rulesByItem: rules([]),
      today: TODAY,
    });
    expect(list).toHaveLength(0);
  });

  test("no usage rate and healthy stock stays off the list", () => {
    const list = buildShoppingList({
      items: [item({ id: "salt", quantity: 5 })],
      rulesByItem: rules([]),
      today: TODAY,
    });
    expect(list).toHaveLength(0);
  });
});

describe("buildShoppingList sorting", () => {
  test("out, low, soon (by date), then pinned; alphabetical within tier", () => {
    const list = buildShoppingList({
      items: [
        item({ id: "pinned-z", shopping_pinned: true }),
        item({ id: "pinned-a", shopping_pinned: true }),
        item({ id: "soon-late", quantity: 6 }),
        item({ id: "soon-early", quantity: 2 }),
        item({ id: "low-1", quantity: 1, reorder_threshold: 2 }),
        item({ id: "out-1", quantity: 0 }),
      ],
      rulesByItem: rules([
        ["soon-late", [{ amount: 1, period: "day", interval_days: null }]],
        ["soon-early", [{ amount: 1, period: "day", interval_days: null }]],
      ]),
      today: TODAY,
    });
    expect(list.map((e) => e.id)).toEqual([
      "out-1",
      "low-1",
      "soon-early",
      "soon-late",
      "pinned-a",
      "pinned-z",
    ]);
  });
});

describe("shoppingTotal", () => {
  test("sums prices cent-accurately and counts unpriced", () => {
    const list = buildShoppingList({
      items: [
        item({ id: "a", quantity: 0, est_price: 5.99 }),
        item({ id: "b", quantity: 0, est_price: 0.1 }),
        item({ id: "c", quantity: 0, est_price: 0.2 }),
        item({ id: "d", quantity: 0 }),
      ],
      rulesByItem: rules([]),
      today: TODAY,
    });
    expect(shoppingTotal(list)).toEqual({ total: 6.29, unpricedCount: 1 });
  });

  test("empty list totals zero", () => {
    expect(shoppingTotal([])).toEqual({ total: 0, unpricedCount: 0 });
  });
});
