import { describe, expect, it } from "vitest";
import {
  financeOpsDateSpan,
  financeReceiptLine,
  MAX_FINANCE_OPS,
  renderFinanceReceipt,
  resolveFinanceOps,
  validateFinanceOps,
  validateResolvedFinanceOps,
  type ExistingChange,
  type FinanceOp,
  type ResolvableAccount,
  type ResolvableCategory,
  type ResolvedFinanceOp,
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

  it("rejects zero and negative amounts but allows a negative reconcile balance", () => {
    expect(
      validateFinanceOps({
        operations: [{ op: "spend", account: "chase", amount: 0, date: "2026-07-01" }],
      }).ok,
    ).toBe(false);
    expect(
      validateFinanceOps({
        operations: [{ op: "spend", account: "chase", amount: -5, date: "2026-07-01" }],
      }).ok,
    ).toBe(false);
    // credit accounts store owed balance as negative
    expect(
      validateFinanceOps({
        operations: [{ op: "reconcile", account: "visa", balance: -250, asOf: "2026-07-01" }],
      }).ok,
    ).toBe(true);
  });

  it("validates create_category name length and hex color format", () => {
    expect(
      validateFinanceOps({
        operations: [{ op: "create_category", name: "x".repeat(65) }],
      }).ok,
    ).toBe(false);
    expect(
      validateFinanceOps({
        operations: [{ op: "create_category", name: "snacks", color: "not-a-color" }],
      }).ok,
    ).toBe(false);
    expect(
      validateFinanceOps({
        operations: [{ op: "create_category", name: "snacks", color: "#ff8800" }],
      }).ok,
    ).toBe(true);
  });

  it("accepts a note-only adjust with nothing else changed", () => {
    const r = validateFinanceOps({
      operations: [{ op: "adjust", changeId: "ch-1", note: "corrected merchant" }],
    });
    expect(r.ok).toBe(true);
  });

  it("truncates fractional schedule fields and enforces weekday/interval bounds", () => {
    const monthly = validateFinanceOps({
      operations: [
        { op: "create_recurring", name: "gym", amount: 30, frequency: "monthly", dayOfMonth: 15.9 },
      ],
    });
    expect(monthly.ok).toBe(true);
    if (monthly.ok && monthly.value[0].op === "create_recurring") {
      expect(monthly.value[0].dayOfMonth).toBe(15);
    }

    expect(
      validateFinanceOps({
        operations: [{ op: "create_recurring", name: "trash", amount: 5, frequency: "weekly", weekday: 7 }],
      }).ok,
    ).toBe(false);
    expect(
      validateFinanceOps({
        operations: [{ op: "create_recurring", name: "trash", amount: 5, frequency: "weekly", weekday: 0 }],
      }).ok,
    ).toBe(true);
    expect(
      validateFinanceOps({
        operations: [{ op: "create_recurring", name: "x", amount: 5, frequency: "weekly", weekday: 6 }],
      }).ok,
    ).toBe(true);

    expect(
      validateFinanceOps({
        operations: [
          { op: "create_recurring", name: "x", amount: 5, frequency: "custom", intervalDays: 367, startDate: "2026-07-01" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateFinanceOps({
        operations: [
          { op: "create_recurring", name: "x", amount: 5, frequency: "custom", intervalDays: 366, startDate: "2026-07-01" },
        ],
      }).ok,
    ).toBe(true);
  });

  it("enforces the MAX_FINANCE_OPS batch-size limit", () => {
    const removeOps = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ op: "remove", changeId: `ch-${i}` }));
    expect(validateFinanceOps({ operations: removeOps(MAX_FINANCE_OPS) }).ok).toBe(true);
    expect(validateFinanceOps({ operations: removeOps(MAX_FINANCE_OPS + 1) }).ok).toBe(
      false,
    );
  });
});

describe("resolveFinanceOps transfer dedup", () => {
  const transferLegs: ExistingChange[] = [
    { id: "t-out", account_id: "acc-chase", occurred_at: "2026-07-05", direction: "out", amount: 200, note: "card payment", is_transfer: true },
    { id: "t-in", account_id: "acc-visa", occurred_at: "2026-07-05", direction: "in", amount: 200, note: "card payment", is_transfer: true },
  ];
  const dupTransfer: FinanceOp = {
    op: "transfer",
    from: "chase",
    to: "visa",
    amount: 200,
    date: "2026-07-05",
  };

  it("skips a transfer whose both legs already exist (re-import)", () => {
    const r = resolve([dupTransfer], { existingChanges: transferLegs });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0].kind).toBe("skip_duplicate");
    }
  });

  it("records the transfer when forced", () => {
    const r = resolve([{ ...dupTransfer, force: true }], {
      existingChanges: transferLegs,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0].kind).toBe("transfer");
  });

  it("does not skip when only one leg matches an existing row", () => {
    const r = resolve([dupTransfer], { existingChanges: [transferLegs[0]] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0].kind).toBe("transfer");
  });

  it("does not skip when the matching rows are not transfers (coincidental spend+income)", () => {
    const coincidental: ExistingChange[] = [
      { id: "s-out", account_id: "acc-chase", occurred_at: "2026-07-05", direction: "out", amount: 200, note: "walmart", is_transfer: false },
      { id: "i-in", account_id: "acc-visa", occurred_at: "2026-07-05", direction: "in", amount: 200, note: "refund", is_transfer: false },
    ];
    const r = resolve([dupTransfer], { existingChanges: coincidental });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0].kind).toBe("transfer");
  });

  it("does not skip against transfer rows removed earlier in the same batch", () => {
    // A correction batch: delete both old legs, then re-add the transfer.
    const r = resolve(
      [
        { op: "remove", changeId: "t-out" },
        { op: "remove", changeId: "t-in" },
        dupTransfer,
      ],
      { existingChanges: transferLegs },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const kinds = r.value.map((o) => o.kind);
      expect(kinds).toContain("transfer");
      expect(kinds).not.toContain("skip_duplicate");
    }
  });

  // The transfer pool matches on fingerprint AND transfer-ness, so an adjust
  // that reclassifies a leg as regular spending invalidates its membership
  // even though the fingerprint is untouched.
  it("does not skip against a leg this batch reclassifies as regular spending", () => {
    const r = resolve(
      [{ op: "adjust", changeId: "t-out", markTransfer: false }, dupTransfer],
      { existingChanges: transferLegs },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((o) => o.kind)).toEqual(["adjust", "transfer"]);
  });

  // But a note-only adjust leaves both legs intact and still transfers, so
  // re-sending the same movement is a genuine duplicate.
  it("still skips when the adjust on a leg only changes the note", () => {
    const r = resolve(
      [{ op: "adjust", changeId: "t-out", note: "visa payment" }, dupTransfer],
      { existingChanges: transferLegs },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((o) => o.kind)).toEqual(["adjust", "skip_duplicate"]);
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

  // A correction batch is [remove the wrong row, re-add the right one]. When the
  // replacement shares the removed row's fingerprint (same account/date/amount,
  // only the note or category was wrong) the dedup pool must not count the row
  // this very batch deletes — otherwise the remove lands and the replacement is
  // silently dropped, losing the transaction outright.
  it("does not skip a spend against a row removed earlier in the same batch", () => {
    const r = resolve([
      { op: "remove", changeId: "ch-1" },
      {
        op: "spend",
        account: "chase checking",
        amount: 54.1,
        date: "2026-06-30",
        note: "costco, not walmart",
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const kinds = r.value.map((o) => o.kind);
      expect(kinds).toEqual(["remove", "spend"]);
      expect(kinds).not.toContain("skip_duplicate");
    }
  });

  // Order-independent: the guard is computed over the whole batch, so it holds
  // whether the replacement is sent before or after the remove.
  it("does not skip a spend sent before the remove that clears the row", () => {
    const r = resolve([
      {
        op: "spend",
        account: "chase checking",
        amount: 54.1,
        date: "2026-06-30",
        note: "costco, not walmart",
      },
      { op: "remove", changeId: "ch-1" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((o) => o.kind)).toEqual(["spend", "remove"]);
    }
  });

  // An adjust that MOVES the fingerprint leaves nothing at the old one, so the
  // row stops guarding it — otherwise the spend is skipped against an identity
  // that will not exist once the batch applies.
  it("does not skip a spend against a row whose amount this batch adjusts", () => {
    const r = resolve([
      { op: "adjust", changeId: "ch-1", amount: 61.4 },
      { op: "spend", account: "chase checking", amount: 54.1, date: "2026-06-30" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const kinds = r.value.map((o) => o.kind);
      expect(kinds).toEqual(["adjust", "spend"]);
      expect(kinds).not.toContain("skip_duplicate");
    }
  });

  it("does not skip a spend against a row whose date this batch adjusts", () => {
    const r = resolve([
      { op: "adjust", changeId: "ch-1", date: "2026-07-02" },
      { op: "spend", account: "chase checking", amount: 54.1, date: "2026-06-30" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((o) => o.kind)).toEqual(["adjust", "spend"]);
    }
  });

  // The other half of the rule: an adjust that leaves the fingerprint intact
  // leaves the row exactly as the dedup pool describes it, so it keeps
  // guarding. A silently corrupted total is worse than a visibly skipped row.
  it("still skips a duplicate when the adjust only changes the note", () => {
    const r = resolve([
      { op: "adjust", changeId: "ch-1", note: "costco" },
      { op: "spend", account: "chase checking", amount: 54.1, date: "2026-06-30" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((o) => o.kind)).toEqual(["adjust", "skip_duplicate"]);
  });

  it("still skips a duplicate when the adjust only recategorizes", () => {
    const r = resolve([
      { op: "adjust", changeId: "ch-1", category: "dining" },
      { op: "spend", account: "chase checking", amount: 54.1, date: "2026-06-30" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((o) => o.kind)).toEqual(["adjust", "skip_duplicate"]);
  });

  // A no-op adjust (same amount restated) does not move the fingerprint, so it
  // must not open a dedup hole either.
  it("still skips a duplicate when the adjust restates the same amount", () => {
    const r = resolve([
      { op: "adjust", changeId: "ch-1", amount: 54.1 },
      { op: "spend", account: "chase checking", amount: 54.1, date: "2026-06-30" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((o) => o.kind)).toEqual(["adjust", "skip_duplicate"]);
  });

  // The mutated-row exemption is per-row, not a blanket opt-out: an untouched
  // row still guards against its own duplicate in the same batch.
  it("still skips a duplicate of an untouched row when another row is removed", () => {
    const twoRows: ExistingChange[] = [
      ...existing,
      {
        id: "ch-2",
        account_id: "acc-cash",
        occurred_at: "2026-07-01",
        direction: "out",
        amount: 12,
        note: "bus fare",
      },
    ];
    const r = resolve(
      [
        { op: "remove", changeId: "ch-1" },
        { op: "spend", account: "cash", amount: 12, date: "2026-07-01" },
      ],
      { existingChanges: twoRows },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((o) => o.kind)).toEqual(["remove", "skip_duplicate"]);
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

  it("an exact account match wins over a substring collision", () => {
    // "cash" is an exact match for one account and a substring of another —
    // the exact match must win without even considering ambiguity.
    const r = resolveFinanceOps(
      [{ op: "spend", account: "cash", amount: 5, date: "2026-07-01" }],
      {
        accounts: [
          { id: "a1", name: "cash", currency: "USD" },
          { id: "a2", name: "cashback rewards", currency: "USD" },
        ],
        categories: [],
        recurring: [],
        existingChanges: [],
        today: TODAY,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.value[0].kind === "spend") expect(r.value[0].accountId).toBe("a1");
  });

  it("pending-category matching is case-insensitive and keeps the canonical created name", () => {
    const r = resolve([
      { op: "create_category", name: "Pharmacy" },
      {
        op: "spend",
        account: "cash",
        amount: 9.99,
        date: "2026-07-01",
        category: "pharmacy", // different case than the batch create
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const spend = r.value.find((o) => o.kind === "spend");
      expect(spend && spend.kind === "spend" && spend.pendingCategory).toBe("Pharmacy");
    }
  });

  it("rejects a duplicate create_category differing only by case", () => {
    const r = resolve([
      { op: "create_category", name: "pharmacy" },
      { op: "create_category", name: "Pharmacy" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("duplicate");
  });

  it("scopes duplicate-fingerprint detection per account", () => {
    const r = resolve([
      { op: "spend", account: "chase checking", amount: 50, date: "2026-07-01" },
      { op: "spend", account: "cash", amount: 50, date: "2026-07-01" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0].kind).toBe("spend");
      expect(r.value[1].kind).toBe("spend"); // not a duplicate — different account
    }
  });

  it("rejects double-removing or adjusting a row removed earlier in the batch", () => {
    const doubleRemove = resolve([
      { op: "remove", changeId: "ch-1" },
      { op: "remove", changeId: "ch-1" },
    ]);
    expect(doubleRemove.ok).toBe(false);
    if (!doubleRemove.ok) expect(doubleRemove.error).toContain("removed twice");

    const adjustAfterRemove = resolve([
      { op: "remove", changeId: "ch-1" },
      { op: "adjust", changeId: "ch-1", amount: 10 },
    ]);
    expect(adjustAfterRemove.ok).toBe(false);
    if (!adjustAfterRemove.ok) {
      expect(adjustAfterRemove.error).toContain("removed earlier");
    }
  });

  it("rejects a future-dated adjust and resolves a category ref on adjust", () => {
    const future = resolve([{ op: "adjust", changeId: "ch-1", date: "2027-01-01" }]);
    expect(future.ok).toBe(false);

    const categorized = resolve([
      { op: "adjust", changeId: "ch-1", category: "housing" },
    ]);
    expect(categorized.ok).toBe(true);
    if (categorized.ok && categorized.value[0].kind === "adjust") {
      expect(categorized.value[0].categoryId).toBe("cat-housing");
    }
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

  it("a single dated op yields a one-day span", () => {
    const parsed = validateFinanceOps({
      operations: [{ op: "spend", account: "cash", amount: 1, date: "2026-06-29" }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(financeOpsDateSpan(parsed.value)).toEqual({
        min: "2026-06-29",
        max: "2026-06-29",
      });
    }
  });
});

describe("financeReceiptLine", () => {
  it("renders a pending category and falls back to uncategorized", () => {
    const pending: ResolvedFinanceOp = {
      kind: "spend",
      accountId: "a1",
      accountName: "cash",
      currency: "USD",
      amount: 10,
      date: "2026-07-01",
      categoryId: null,
      categoryName: null,
      pendingCategory: "pharmacy",
      note: null,
    };
    expect(financeReceiptLine(pending)).toContain("pharmacy");

    const uncategorized: ResolvedFinanceOp = { ...pending, pendingCategory: null };
    expect(financeReceiptLine(uncategorized)).toContain("uncategorized");
  });

  it("renders markTransfer:false as regular spending", () => {
    const adjust: ResolvedFinanceOp = {
      kind: "adjust",
      changeId: "ch-1",
      accountId: "acc-chase",
      label: "2026-06-30 −$54.10",
      amount: null,
      categoryId: null,
      pendingCategory: null,
      date: null,
      note: null,
      markTransfer: false,
    };
    expect(financeReceiptLine(adjust)).toContain("regular spending");
  });

  it("renders a pending category on create_recurring", () => {
    const op: ResolvedFinanceOp = {
      kind: "create_recurring",
      name: "spotify",
      amount: 11.99,
      frequency: "monthly",
      dayOfMonth: 3,
      weekday: null,
      intervalDays: null,
      startDate: null,
      categoryId: null,
      categoryName: null,
      pendingCategory: "subscriptions",
    };
    expect(financeReceiptLine(op)).toContain("subscriptions");
  });
});

describe("validateResolvedFinanceOps malformed shapes", () => {
  it("rejects a stored spend missing accountId", () => {
    const r = validateResolvedFinanceOps({
      operations: [
        {
          kind: "spend",
          accountName: "cash",
          currency: "USD",
          amount: 10,
          date: "2026-07-01",
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a stored adjust with an invalid amount", () => {
    const r = validateResolvedFinanceOps({
      operations: [
        {
          kind: "adjust",
          changeId: "ch-1",
          accountId: "acc-chase",
          label: "x",
          amount: -5,
          categoryId: null,
          pendingCategory: null,
          date: null,
          note: null,
          markTransfer: null,
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown stored operation kind", () => {
    const r = validateResolvedFinanceOps({
      operations: [{ kind: "teleport", label: "x" }],
    });
    expect(r.ok).toBe(false);
  });
});
