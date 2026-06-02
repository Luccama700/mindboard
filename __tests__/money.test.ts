import { describe, expect, test } from "vitest";
import { splitEvenly, sumMoney } from "@/app/_components/money";

describe("splitEvenly", () => {
  test("divides evenly when it divides cleanly", () => {
    expect(splitEvenly(100, 2)).toEqual([50, 50]);
    expect(splitEvenly(90, 3)).toEqual([30, 30, 30]);
  });

  test("hands leftover pennies to the earliest parts", () => {
    expect(splitEvenly(100, 3)).toEqual([33.34, 33.33, 33.33]);
    expect(splitEvenly(10, 3)).toEqual([3.34, 3.33, 3.33]);
  });

  test("the parts always sum back to the original total", () => {
    for (const [total, parts] of [
      [100, 3],
      [49.99, 4],
      [12.5, 7],
      [0.05, 4],
    ] as const) {
      expect(sumMoney(splitEvenly(total, parts))).toBe(total);
    }
  });

  test("a single part is the whole total", () => {
    expect(splitEvenly(73.21, 1)).toEqual([73.21]);
  });

  test("zero or negative parts yield nothing", () => {
    expect(splitEvenly(100, 0)).toEqual([]);
  });
});

describe("sumMoney", () => {
  test("rounds away float drift", () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([33.34, 33.33, 33.33])).toBe(100);
  });

  test("empty sums to zero", () => {
    expect(sumMoney([])).toBe(0);
  });
});
