import { describe, expect, test } from "vitest";
import {
  formatMoneyCompact,
  splitEvenly,
  sumMoney,
} from "@/app/_components/money";

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

// The cashflow calendar's day cells on a phone: about 34px of text each, so
// the figure has to fit in five characters or it is clipped mid-number.
describe("formatMoneyCompact", () => {
  test("whole units below a thousand, no symbol and no cents", () => {
    expect(formatMoneyCompact(0)).toBe("0");
    expect(formatMoneyCompact(18.4)).toBe("18");
    expect(formatMoneyCompact(318.42)).toBe("318");
    expect(formatMoneyCompact(999.4)).toBe("999");
  });

  test("thousands as k, one decimal below ten", () => {
    expect(formatMoneyCompact(999.5)).toBe("1k");
    expect(formatMoneyCompact(1284.5)).toBe("1.3k");
    expect(formatMoneyCompact(6166.08)).toBe("6.2k");
    expect(formatMoneyCompact(9960)).toBe("10k");
    expect(formatMoneyCompact(12500)).toBe("13k");
    expect(formatMoneyCompact(250000)).toBe("250k");
  });

  test("millions as m", () => {
    expect(formatMoneyCompact(999_500)).toBe("1m");
    expect(formatMoneyCompact(1_250_000)).toBe("1.3m");
  });

  test("a negative keeps a real minus sign", () => {
    expect(formatMoneyCompact(-318.42)).toBe("−318");
    expect(formatMoneyCompact(-6166.08)).toBe("−6.2k");
  });

  test("never longer than five characters for any everyday balance", () => {
    for (const amount of [0, 7, 42.5, 999, 1000, 9949, 9950, 99_999, 999_499, -99_999]) {
      expect(formatMoneyCompact(amount).length).toBeLessThanOrEqual(5);
    }
  });

  test("a non-finite amount reads as zero", () => {
    expect(formatMoneyCompact(Number.NaN)).toBe("0");
  });
});
