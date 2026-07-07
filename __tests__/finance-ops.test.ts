import { describe, expect, it } from "vitest";
import {
  financeOpsDateSpan,
  renderFinanceReceipt,
  resolveFinanceOps,
  validateFinanceOps,
  validateResolvedFinanceOps,
  type ExistingChange,
  type FinanceOp,
  type ResolvableAccount,
  type ResolvableCategory,
} from "@/app/lib/mcp/finance-ops";

const TODAY = "2026-07-07";

const accounts: ResolvableAccount[] = [
  { id: "acc-chase", name: "chase checking", currency: "USD" },
  { id: "acc-visa", name: "visa card", currency: "USD" },
  { id: "acc-cash", name: "cash", currency: "USD" },
];

const categories: ResolvableCategory[] = [
  { id: "cat-dining", name: "dining" },
  { id: "cat-housing", name: "housing" },
];

const existing: ExistingChange[] = [
  {
    id: "ch-1",
    account_id: "acc-chase",
    occurred_at: "2026-06-30",
    direction: "out",
    amount: 54.1,
    note: "walmart",
  },
];

function resolve(ops: FinanceOp[], overrides?: Partial<Parameters<typeof resolveFinanceOps>[1]>) {
  return resolveFinanceOps(ops, {
    accounts,
    categories,
    recurring: [{ id: "re-1", name: "netflix" }],
    existingChanges: existing,
    today: TODAY,
    ...overrides,
  });
}

describe("validateFinanceOps", () => {
  it("rejects an empty batch", () => {
    const r = validateFinanceOps({ operations: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects a spend without a date", () => {
    const r = validateFinanceOps({
      operations: [{ op: "spend", account: "chase", amount: 5 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("date");
  });

  it("rejects an adjust with nothing to change", () => {
    const r = validateFinanceOps({ operations: [{ op: "adjust", changeId: "x" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nothing to change");
  });

  it("requires schedule fields per frequency on create_recurring", () => {
    const bad = validateFinanceOps({
      operations: [
        { op: "create_recurring", name: "gym", amount: 30, frequency: "monthly" },
      ],
    });
    expect(bad.ok).toBe(false);
    const good = validateFinanceOps({
      operations: [
        {
          op: "create_recurring",
          name: "gym",
          amount: 30,
          frequency: "monthly",
          dayOfMonth: 1,
        },
      ],
    });
    expect(good.ok).toBe(true);
  });

  it("rounds amounts to cents", () => {
    const r = validateFinanceOps({
      operations: [
        { op: "spend", account: "chase", amount: 6.401, date: "2026-07-01" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value[0].op === "spend") expect(r.value[0].amount).toBe(6.4);
  });
});

describe("resolveFinanceOps", () => {
  it("resolves accounts by unique substring and categories by name", () => {
    const r = resolve([
      {
        op: "spend",
        account: "chase",
        amount: 6.4,
        date: "2026-06-29",
        category: "dining",
        note: "coffee",
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok && r.value[0].kind === "spend") {
      expect(r.value[0].accountId).toBe("acc-chase");
      expect(r.value[0].categoryId).toBe("cat-dining");
    }
  });

  it("fails loudly on ambiguous account refs", () => {
    const r = resolve([
      { op: "spend", account: "c", amount: 1, date: "2026-07-01" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ambiguous");
  });

  it("skips a spend matching an existing fingerprint, imports it with force", () => {
    const dupe: FinanceOp = {
      op: "spend",
      account: "chase checking",
      amount: 54.1,
      date: "2026-06-30",
    };
    const skipped = resolve([dupe]);
    expect(skipped.ok).toBe(true);
    if (skipped.ok) {
      expect(skipped.value[0].kind).toBe("skip_duplicate");
    }

    const forced = resolve([{ ...dupe, force: true }]);
    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.value[0].kind).toBe("spend");
  });

  it("dedupes within the batch too", () => {
    const op: FinanceOp = {
      op: "spend",
      account: "cash",
      amount: 12,
      date: "2026-07-01",
    };
    const r = resolve([op, { ...op }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0].kind).toBe("spend");
      expect(r.value[1].kind).toBe("skip_duplicate");
    }
  });

  it("rejects future-dated transactions and reconciles", () => {
    expect(
      resolve([{ op: "spend", account: "cash", amount: 1, date: "2027-01-01" }]).ok,
    ).toBe(false);
    expect(
      resolve([{ op: "reconcile", account: "cash", balance: 10, asOf: "2027-01-01" }])
        .ok,
    ).toBe(false);
  });

  it("lets a spend reference a category created earlier in the batch", () => {
    const r = resolve([
      { op: "create_category", name: "pharmacy" },
      {
        op: "spend",
        account: "cash",
        amount: 9.99,
        date: "2026-07-01",
        category: "pharmacy",
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const spend = r.value.find((o) => o.kind === "spend");
      expect(spend && spend.kind === "spend" && spend.pendingCategory).toBe(
        "pharmacy",
      );
    }
  });

  it("rejects creating a category or recurring that already exists", () => {
    expect(resolve([{ op: "create_category", name: "Dining" }]).ok).toBe(false);
    expect(
      resolve([
        {
          op: "create_recurring",
          name: "NETFLIX",
          amount: 15.49,
          frequency: "monthly",
          dayOfMonth: 14,
        },
      ]).ok,
    ).toBe(false);
  });

  it("orders category creates first and reconciles last", () => {
    const r = resolve([
      { op: "reconcile", account: "chase checking", balance: 2410.22, asOf: "2026-07-04" },
      { op: "spend", account: "chase checking", amount: 6.4, date: "2026-06-29" },
      { op: "create_category", name: "pharmacy" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((o) => o.kind)).toEqual([
        "create_category",
        "spend",
        "reconcile",
      ]);
    }
  });

  it("keeps a transfer's legs out of later dedup collisions", () => {
    const r = resolve([
      {
        op: "transfer",
        from: "chase checking",
        to: "visa card",
        amount: 250,
        date: "2026-07-02",
      },
      // same movement sent again as a spend — must be caught as a duplicate
      { op: "spend", account: "chase checking", amount: 250, date: "2026-07-02" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0].kind).toBe("transfer");
      expect(r.value[1].kind).toBe("skip_duplicate");
    }
  });

  it("supports markTransfer as the only change on an adjust", () => {
    const parsed = validateFinanceOps({
      operations: [{ op: "adjust", changeId: "ch-1", markTransfer: true }],
    });
    expect(parsed.ok).toBe(true);

    const r = resolve([{ op: "adjust", changeId: "ch-1", markTransfer: true }]);
    expect(r.ok).toBe(true);
    if (r.ok && r.value[0].kind === "adjust") {
      expect(r.value[0].markTransfer).toBe(true);
      expect(renderFinanceReceipt(r.value)).toContain("transfer");
      const stored = JSON.parse(JSON.stringify({ operations: r.value }));
      const revalidated = validateResolvedFinanceOps(stored);
      expect(revalidated.ok).toBe(true);
      if (revalidated.ok && revalidated.value[0].kind === "adjust") {
        expect(revalidated.value[0].markTransfer).toBe(true);
      }
    }
  });

  it("resolves adjust/remove against provided rows and rejects unknown ids", () => {
    const good = resolve([
      { op: "adjust", changeId: "ch-1", amount: 21 },
      { op: "remove", changeId: "ch-1" },
    ]);
    expect(good.ok).toBe(true);

    const bad = resolve([{ op: "remove", changeId: "nope" }]);
    expect(bad.ok).toBe(false);
  });

  it("rejects a transfer to the same account", () => {
    const r = resolve([
      { op: "transfer", from: "cash", to: "cash", amount: 5, date: "2026-07-01" },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("receipt + stored-shape round trip", () => {
  it("renders one line per op and survives re-validation", () => {
    const r = resolve([
      { op: "create_category", name: "pharmacy" },
      {
        op: "spend",
        account: "chase checking",
        amount: 6.4,
        date: "2026-06-29",
        category: "dining",
        note: "coffee shop",
      },
      { op: "income", account: "chase checking", amount: 1834, date: "2026-07-03" },
      {
        op: "transfer",
        from: "chase checking",
        to: "visa card",
        amount: 250,
        date: "2026-07-02",
      },
      {
        op: "create_recurring",
        name: "spotify",
        amount: 11.99,
        frequency: "monthly",
        dayOfMonth: 3,
      },
      { op: "adjust", changeId: "ch-1", amount: 21 },
      { op: "reconcile", account: "chase checking", balance: 2410.22, asOf: "2026-07-04" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const receipt = renderFinanceReceipt(r.value);
    expect(receipt.split("\n")).toHaveLength(r.value.length);
    expect(receipt).toContain("−$6.40");
    expect(receipt).toContain("reconcile to $2,410.22 as of 2026-07-04");

    // what recordProposal stores must re-validate at execute time
    const stored = JSON.parse(JSON.stringify({ operations: r.value }));
    const revalidated = validateResolvedFinanceOps(stored);
    expect(revalidated.ok).toBe(true);
    if (revalidated.ok) expect(revalidated.value).toHaveLength(r.value.length);
  });
});

describe("financeOpsDateSpan", () => {
  it("spans dated ops and ignores undated ones", () => {
    const parsed = validateFinanceOps({
      operations: [
        { op: "spend", account: "cash", amount: 1, date: "2026-06-29" },
        { op: "income", account: "cash", amount: 2, date: "2026-07-03" },
        { op: "create_category", name: "x" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(financeOpsDateSpan(parsed.value)).toEqual({
        min: "2026-06-29",
        max: "2026-07-03",
      });
      expect(financeOpsDateSpan([parsed.value[2]])).toBeNull();
    }
  });
});
