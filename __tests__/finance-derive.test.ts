import { describe, expect, it } from "vitest";
import {
  changeFingerprint,
  deriveBalance,
  rowAfterAnchor,
  signedAmount,
  type LedgerRow,
  type ReconciliationAnchor,
} from "@/app/lib/finance/derive";

const anchor: ReconciliationAnchor = {
  balance: 100,
  as_of: "2026-07-04",
  created_at: "2026-07-04T09:00:00Z",
};

function row(
  occurred_at: string,
  direction: "in" | "out",
  amount: number,
  created_at = "2026-07-05T12:00:00Z",
): LedgerRow {
  return { occurred_at, direction, amount, created_at };
}

describe("rowAfterAnchor", () => {
  it("counts rows dated after as_of", () => {
    expect(rowAfterAnchor(anchor, row("2026-07-05", "out", 10))).toBe(true);
  });

  it("ignores rows dated before as_of", () => {
    expect(rowAfterAnchor(anchor, row("2026-07-03", "out", 10))).toBe(false);
  });

  it("splits same-day rows by creation time relative to the anchor", () => {
    expect(
      rowAfterAnchor(anchor, row("2026-07-04", "out", 10, "2026-07-04T08:00:00Z")),
    ).toBe(false);
    expect(
      rowAfterAnchor(anchor, row("2026-07-04", "out", 10, "2026-07-04T12:00:00Z")),
    ).toBe(true);
  });

  it("a row created at the exact same instant as the anchor is not counted", () => {
    expect(
      rowAfterAnchor(anchor, row("2026-07-04", "out", 10, anchor.created_at)),
    ).toBe(false);
  });
});

describe("signedAmount", () => {
  it("is positive for inflows and negative for outflows", () => {
    expect(signedAmount({ direction: "in", amount: 12.5 })).toBe(12.5);
    expect(signedAmount({ direction: "out", amount: 12.5 })).toBe(-12.5);
  });

  it("treats a non-numeric amount as zero rather than NaN", () => {
    expect(signedAmount({ direction: "in", amount: Number("not-a-number") })).toBe(0);
  });
});

describe("deriveBalance", () => {
  it("returns the anchor balance when nothing came after", () => {
    expect(
      deriveBalance(anchor, [
        row("2026-07-01", "out", 40),
        row("2026-07-04", "in", 5, "2026-07-04T08:59:00Z"),
      ]),
    ).toBe(100);
  });

  it("applies signed later transactions", () => {
    expect(
      deriveBalance(anchor, [
        row("2026-07-05", "out", 6.4),
        row("2026-07-06", "in", 20),
        row("2026-07-03", "out", 999), // inside the anchor — already reconciled
      ]),
    ).toBe(113.6);
  });

  it("counts a same-day spend logged after a morning balance update", () => {
    expect(
      deriveBalance(anchor, [
        row("2026-07-04", "out", 12.5, "2026-07-04T13:00:00Z"),
      ]),
    ).toBe(87.5);
  });

  it("rounds to cents", () => {
    expect(
      deriveBalance(anchor, [
        row("2026-07-05", "out", 0.1),
        row("2026-07-05", "out", 0.2),
      ]),
    ).toBe(99.7);
  });

  it("sums from zero with no anchor", () => {
    expect(
      deriveBalance(null, [row("2026-07-01", "in", 50), row("2026-07-02", "out", 20)]),
    ).toBe(30);
  });

  it("supports negative balances (credit accounts store owed as negative)", () => {
    const credit: ReconciliationAnchor = { ...anchor, balance: -250 };
    expect(deriveBalance(credit, [row("2026-07-05", "out", 54.1)])).toBe(-304.1);
  });

  it("returns exactly the anchor balance with no rows at all", () => {
    expect(deriveBalance(anchor, [])).toBe(100);
  });

  it("returns zero with no anchor and no rows", () => {
    expect(deriveBalance(null, [])).toBe(0);
  });

  it("splits multiple same-day rows individually by creation time, not by day", () => {
    expect(
      deriveBalance(anchor, [
        row("2026-07-04", "out", 10, "2026-07-04T08:00:00Z"), // before anchor — excluded
        row("2026-07-04", "in", 30, "2026-07-04T10:00:00Z"), // after anchor — included
        row("2026-07-04", "out", 5, "2026-07-04T08:30:00Z"), // before anchor — excluded
      ]),
    ).toBe(130);
  });
});

describe("changeFingerprint", () => {
  it("is date|direction|cents", () => {
    expect(changeFingerprint("2026-07-05", "out", 6.4)).toBe("2026-07-05|out|640");
    expect(changeFingerprint("2026-07-05", "in", 1834)).toBe("2026-07-05|in|183400");
  });

  it("rounds float drift into whole cents", () => {
    expect(changeFingerprint("2026-07-05", "out", 0.1 + 0.2)).toBe(
      "2026-07-05|out|30",
    );
  });

  it("preserves a negative sign for correction amounts", () => {
    expect(changeFingerprint("2026-07-05", "out", -6.4)).toBe("2026-07-05|out|-640");
  });
});
