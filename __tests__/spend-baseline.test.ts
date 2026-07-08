import { describe, expect, it } from "vitest";
import {
  computeSpendRate,
  estimatedSpendOn,
  matchesBill,
  MIN_CONFIDENT_WEEKS,
  MIN_SPEND_FACTOR,
  type BillRule,
  type SpendHistoryRow,
  type SpendRate,
} from "@/app/_components/spend-baseline";
import { buildDayRows } from "@/app/_components/finance-projection";

// 2026-07-07: trailing 7-day blocks end yesterday (jul 6) — block 0 is
// jun 30–jul 6, block 1 jun 23–29, block 2 jun 16–22, block 3 jun 9–15,
// block 4 jun 2–8.
const TODAY = "2026-07-07";

function spend(
  occurred_at: string,
  amount: number,
  extra?: Partial<SpendHistoryRow>,
): SpendHistoryRow {
  return {
    occurred_at,
    direction: "out",
    amount,
    category_id: null,
    is_transfer: false,
    ...extra,
  };
}

// anchors `earliest` without adding any discretionary spend
function income(occurred_at: string): SpendHistoryRow {
  return {
    occurred_at,
    direction: "in",
    amount: 1,
    category_id: null,
    is_transfer: false,
  };
}

const rentRule: BillRule = { amount: 1400, category_id: null };

describe("matchesBill", () => {
  it("matches amount within 2% with a compatible category, on ANY date", () => {
    // rent posted mid-month, nowhere near its nominal landing day — still a bill
    expect(matchesBill({ amount: 1400, category_id: null }, [rentRule])).toBe(true);
    expect(matchesBill({ amount: 1420, category_id: "cat-x" }, [rentRule])).toBe(true);
  });

  it("rejects wrong amounts and conflicting categories", () => {
    expect(matchesBill({ amount: 900, category_id: null }, [rentRule])).toBe(false);
    const categorized: BillRule = { amount: 100, category_id: "cat-housing" };
    expect(matchesBill({ amount: 100, category_id: "cat-dining" }, [categorized])).toBe(
      false,
    );
    expect(matchesBill({ amount: 100, category_id: "cat-housing" }, [categorized])).toBe(
      true,
    );
  });
});

describe("computeSpendRate", () => {
  it("returns an unconfident zero rate with no history", () => {
    const r = computeSpendRate({ history: [], rules: [], today: TODAY });
    expect(r.confident).toBe(false);
    expect(r.dailyRate).toBe(0);
  });

  it("halves the median weekly total over trailing 7-day blocks (predicted minimum)", () => {
    // weekly totals: [70, 140, 70, 700, 0] → median 70 → × 0.5 ÷ 7 = $5/day
    const history = [
      income("2026-06-02"), // anchors coverage at block 4's start
      spend("2026-07-01", 70), // block 0
      spend("2026-06-25", 140), // block 1
      spend("2026-06-17", 70), // block 2
      spend("2026-06-10", 700), // block 3 — outlier week, median steps over it
      // block 4: no spend → counts as $0
    ];
    const r = computeSpendRate({ history, rules: [], today: TODAY });
    expect(r.sampledWeeks).toBe(5);
    expect(r.confident).toBe(true);
    expect(r.dailyRate).toBe(5);
  });

  it("projects a floor at half the median week, rounded to cents", () => {
    // one fully covered $75 week → 75 × 0.5 ÷ 7 = 5.357… → $5.36/day
    const history = [income("2026-06-30"), spend("2026-07-02", 75)];
    const r = computeSpendRate({ history, rules: [], today: TODAY });
    expect(MIN_SPEND_FACTOR).toBe(0.5);
    expect(r.dailyRate).toBe(5.36);
  });

  it("spreads within-week posting clumps evenly (the Monday problem)", () => {
    // the bank posts the whole weekend on Monday — weekly totals don't care
    const history = [
      income("2026-06-02"),
      spend("2026-07-06", 70), // all of block 0 posted on monday
      spend("2026-06-29", 70), // all of block 1 posted on monday
      spend("2026-06-22", 70),
      spend("2026-06-15", 70),
      spend("2026-06-08", 70),
    ];
    const r = computeSpendRate({ history, rules: [], today: TODAY });
    expect(r.dailyRate).toBe(5); // flat $5/day floor, weekends included
  });

  it("excludes bill payments (any date) and transfers", () => {
    const history = [
      income("2026-06-02"),
      spend("2026-06-19", 1400), // rent posted on a random day — excluded
      spend("2026-06-09", 300, { is_transfer: true }), // excluded
      spend("2026-07-01", 70),
      spend("2026-06-25", 70),
      spend("2026-06-17", 70),
      spend("2026-06-10", 70),
      spend("2026-06-03", 70),
    ];
    const r = computeSpendRate({ history, rules: [rentRule], today: TODAY });
    expect(r.dailyRate).toBe(5);
  });

  it("only counts fully covered weeks and reports confidence", () => {
    // history starts jul 1 — block 0 (jun 30–jul 6) is not fully covered
    const young = computeSpendRate({
      history: [spend("2026-07-01", 50)],
      rules: [],
      today: TODAY,
    });
    expect(young.sampledWeeks).toBe(0);
    expect(young.confident).toBe(false);

    // exactly 4 covered weeks → confident
    const four = computeSpendRate({
      history: [income("2026-06-09"), spend("2026-06-15", 70)],
      rules: [],
      today: TODAY,
    });
    expect(four.sampledWeeks).toBe(4);
    expect(four.confident).toBe(true);
    expect(MIN_CONFIDENT_WEEKS).toBe(4);
  });
});

describe("estimatedSpendOn", () => {
  const confident: SpendRate = { dailyRate: 31, sampledWeeks: 8, confident: true };
  const thin: SpendRate = { dailyRate: 0, sampledWeeks: 1, confident: false };

  it("prefers a per-day override, including an explicit zero", () => {
    expect(estimatedSpendOn(confident, null, { "2026-07-11": 120 }, "2026-07-11")).toBe(
      120,
    );
    expect(estimatedSpendOn(confident, null, { "2026-07-11": 0 }, "2026-07-11")).toBe(0);
  });

  it("falls through override → history → manual → zero", () => {
    expect(estimatedSpendOn(confident, 99, {}, "2026-07-11")).toBe(31);
    expect(estimatedSpendOn(thin, 22, {}, "2026-07-11")).toBe(22);
    expect(estimatedSpendOn(thin, null, {}, "2026-07-11")).toBe(0);
  });
});

describe("buildDayRows with an estimated-spend layer", () => {
  it("subtracts estimates from future running totals but not past days", () => {
    const gridDays = ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09"];
    const rows = buildDayRows({
      gridDays,
      month: "2026-07",
      today: TODAY,
      netWorthToday: 1000,
      changes: [],
      expenses: [],
      incomeByDate: {},
      estimatedSpendByDate: { "2026-07-08": 20, "2026-07-09": 30 },
    });
    const byDate = new Map(rows.map((r) => [r.dateKey, r]));
    expect(byDate.get("2026-07-07")?.runningTotal).toBe(1000);
    expect(byDate.get("2026-07-07")?.estimatedOutflow).toBe(0);
    expect(byDate.get("2026-07-08")?.runningTotal).toBe(980);
    expect(byDate.get("2026-07-08")?.estimatedOutflow).toBe(20);
    expect(byDate.get("2026-07-09")?.runningTotal).toBe(950);
    expect(byDate.get("2026-07-06")?.runningTotal).toBe(1000);
  });
});
