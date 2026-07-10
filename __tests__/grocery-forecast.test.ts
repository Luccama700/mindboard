import { describe, expect, test } from "vitest";
import {
  buildGroceriesByDate,
  deductBaseline,
  groceryAmountsByDate,
  snapToShoppingDay,
} from "@/app/_components/grocery-forecast";
import type { ShoppingEntry } from "@/app/_components/shopping-list";

// 2026-07-09 is a Thursday; Saturday (day 6) that week is 2026-07-11.
const TODAY = "2026-07-09";
const SATURDAY = 6;

function entry(partial: Partial<ShoppingEntry> & { id: string }): ShoppingEntry {
  return {
    name: partial.id,
    quantity: 0,
    unit: "",
    reason: "out",
    runOutDate: null,
    buyBy: null,
    pinned: false,
    buyAmount: null,
    estPrice: null,
    priceSource: null,
    ...partial,
  };
}

describe("snapToShoppingDay", () => {
  test("a shopping day snaps to itself", () => {
    expect(snapToShoppingDay("2026-07-11", SATURDAY)).toBe("2026-07-11");
  });

  test("mid-week dates snap forward", () => {
    expect(snapToShoppingDay("2026-07-09", SATURDAY)).toBe("2026-07-11");
  });

  test("day after a shopping day waits a full week", () => {
    expect(snapToShoppingDay("2026-07-12", SATURDAY)).toBe("2026-07-18");
  });
});

describe("buildGroceriesByDate", () => {
  test("undated entries land at the next trip", () => {
    const trips = buildGroceriesByDate({
      entries: [entry({ id: "milk", estPrice: 6.5 })],
      today: TODAY,
      shoppingDay: SATURDAY,
      horizonDays: 30,
    });
    expect(trips).toEqual({
      "2026-07-11": { amount: 6.5, itemNames: ["milk"] },
    });
  });

  test("dated entries snap to the first shopping day on/after buy-by", () => {
    const trips = buildGroceriesByDate({
      entries: [entry({ id: "rice", reason: "soon", buyBy: "2026-07-13", estPrice: 4 })],
      today: TODAY,
      shoppingDay: SATURDAY,
      horizonDays: 30,
    });
    expect(Object.keys(trips)).toEqual(["2026-07-18"]);
  });

  test("a stale buy-by lands at the next trip like undated", () => {
    const trips = buildGroceriesByDate({
      entries: [entry({ id: "eggs", reason: "soon", buyBy: "2026-07-01", estPrice: 3 })],
      today: TODAY,
      shoppingDay: SATURDAY,
      horizonDays: 30,
    });
    expect(Object.keys(trips)).toEqual(["2026-07-11"]);
  });

  test("items on the same trip aggregate", () => {
    const trips = buildGroceriesByDate({
      entries: [
        entry({ id: "milk", estPrice: 6.5 }),
        entry({ id: "bread", estPrice: 3.2 }),
      ],
      today: TODAY,
      shoppingDay: SATURDAY,
      horizonDays: 30,
    });
    expect(trips["2026-07-11"].amount).toBeCloseTo(9.7);
    expect(trips["2026-07-11"].itemNames).toEqual(["milk", "bread"]);
  });

  test("unpriced and zero-priced entries contribute nothing", () => {
    const trips = buildGroceriesByDate({
      entries: [
        entry({ id: "milk" }),
        entry({ id: "bread", estPrice: 0 }),
      ],
      today: TODAY,
      shoppingDay: SATURDAY,
      horizonDays: 30,
    });
    expect(trips).toEqual({});
  });

  test("trips beyond the horizon are dropped", () => {
    const trips = buildGroceriesByDate({
      entries: [entry({ id: "rice", reason: "soon", buyBy: "2026-07-13", estPrice: 4 })],
      today: TODAY,
      shoppingDay: SATURDAY,
      horizonDays: 7,
    });
    expect(trips).toEqual({});
  });

  test("groceryAmountsByDate flattens trips to amounts", () => {
    const trips = buildGroceriesByDate({
      entries: [entry({ id: "milk", estPrice: 6.5 })],
      today: TODAY,
      shoppingDay: SATURDAY,
      horizonDays: 30,
    });
    expect(groceryAmountsByDate(trips)).toEqual({ "2026-07-11": 6.5 });
  });
});

describe("deductBaseline", () => {
  function flatBaseline(startKey: string, days: number, perDay: number) {
    const map: Record<string, number> = {};
    let cursor = startKey;
    for (let i = 0; i < days; i += 1) {
      map[cursor] = perDay;
      const next = new Date(`${cursor}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
    }
    return map;
  }

  test("a trip absorbs baseline day-by-day from the trip day", () => {
    const baseline = flatBaseline("2026-07-11", 7, 10);
    const adjusted = deductBaseline(baseline, { "2026-07-11": 40 });
    expect(adjusted["2026-07-11"]).toBe(0);
    expect(adjusted["2026-07-12"]).toBe(0);
    expect(adjusted["2026-07-13"]).toBe(0);
    expect(adjusted["2026-07-14"]).toBe(0);
    expect(adjusted["2026-07-15"]).toBe(10);
  });

  test("partial absorption leaves a remainder day", () => {
    const baseline = flatBaseline("2026-07-11", 4, 10);
    const adjusted = deductBaseline(baseline, { "2026-07-11": 25 });
    expect(adjusted["2026-07-11"]).toBe(0);
    expect(adjusted["2026-07-12"]).toBe(0);
    expect(adjusted["2026-07-13"]).toBe(5);
    expect(adjusted["2026-07-14"]).toBe(10);
  });

  test("a trip's window stops at the next trip", () => {
    const baseline = flatBaseline("2026-07-11", 6, 10);
    const adjusted = deductBaseline(baseline, {
      "2026-07-11": 100,
      "2026-07-13": 20,
    });
    // Trip one only reaches 07-11 and 07-12; the excess is real extra spend.
    expect(adjusted["2026-07-11"]).toBe(0);
    expect(adjusted["2026-07-12"]).toBe(0);
    // Trip two absorbs from 07-13 forward.
    expect(adjusted["2026-07-13"]).toBe(0);
    expect(adjusted["2026-07-14"]).toBe(0);
    expect(adjusted["2026-07-15"]).toBe(10);
  });

  test("window is capped at seven days", () => {
    const baseline = flatBaseline("2026-07-11", 10, 1);
    const adjusted = deductBaseline(baseline, { "2026-07-11": 100 });
    for (let i = 0; i < 7; i += 1) {
      const key = Object.keys(baseline).sort()[i];
      expect(adjusted[key]).toBe(0);
    }
    expect(adjusted["2026-07-18"]).toBe(1);
  });

  test("missing baseline days are skipped, inputs are not mutated", () => {
    const baseline = { "2026-07-12": 10 };
    const adjusted = deductBaseline(baseline, { "2026-07-11": 15 });
    expect(adjusted["2026-07-12"]).toBe(0);
    expect(adjusted["2026-07-11"]).toBeUndefined();
    expect(baseline["2026-07-12"]).toBe(10);
  });
});
