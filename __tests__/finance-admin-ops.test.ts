import { describe, expect, it } from "vitest";
import {
  renderAdminReceipt,
  resolveAdminOps,
  validateAdminOps,
  validateResolvedAdminOps,
  type AdminResolveContext,
  type FinanceAdminOp,
} from "@/app/lib/mcp/finance-admin-ops";

const CTX: AdminResolveContext = {
  accounts: [
    { id: "a-check", name: "Checking" },
    { id: "a-save", name: "Savings" },
    { id: "a-visa", name: "Visa" },
  ],
  categories: [
    { id: "c-food", name: "Food" },
    { id: "c-fun", name: "Fun" },
  ],
  recurring: [
    { id: "r-rent", name: "Rent" },
    { id: "r-spotify", name: "Spotify" },
  ],
  incomeSources: [{ id: "s-cafe", name: "Cafe job" }],
  today: "2026-07-07",
};

function resolve(ops: FinanceAdminOp[]) {
  return resolveAdminOps(ops, CTX);
}

describe("validateAdminOps", () => {
  it("accepts a mixed configuration batch", () => {
    const result = validateAdminOps({
      operations: [
        { op: "create_account", name: "Cash", type: "cash", balance: 40 },
        { op: "update_account", account: "visa", archived: true },
        { op: "update_category", category: "fun", color: "#ff00aa" },
        { op: "update_recurring", rule: "spotify", amount: 12.99 },
        {
          op: "create_income",
          name: "Tutoring",
          hourlyWage: 30,
          taxRate: 15,
        },
        { op: "set_spend_override", date: "2026-07-10", amount: 0 },
        { op: "set_daily_spend_estimate", amount: 25 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(7);
  });

  it("rejects empty batches, bad types, and no-op patches", () => {
    expect(validateAdminOps({ operations: [] }).ok).toBe(false);
    expect(
      validateAdminOps({
        operations: [{ op: "create_account", name: "X", type: "crypto", balance: 1 }],
      }).ok,
    ).toBe(false);
    expect(
      validateAdminOps({ operations: [{ op: "update_account", account: "visa" }] }).ok,
    ).toBe(false);
    expect(
      validateAdminOps({ operations: [{ op: "update_category", category: "fun", color: "red" }] })
        .ok,
    ).toBe(false);
  });

  it("requires frequency fields to match the cadence on update_recurring", () => {
    expect(
      validateAdminOps({
        operations: [{ op: "update_recurring", rule: "rent", frequency: "monthly" }],
      }).ok,
    ).toBe(false);
    expect(
      validateAdminOps({
        operations: [
          { op: "update_recurring", rule: "rent", frequency: "monthly", dayOfMonth: 1 },
        ],
      }).ok,
    ).toBe(true);
    expect(
      validateAdminOps({
        operations: [
          { op: "update_recurring", rule: "rent", frequency: "custom", intervalDays: 14 },
        ],
      }).ok,
    ).toBe(false); // custom also needs startDate
  });

  it("treats a pay schedule as all-or-nothing", () => {
    expect(
      validateAdminOps({
        operations: [
          {
            op: "create_income",
            name: "Bar",
            hourlyWage: 20,
            taxRate: 10,
            payFrequency: "biweekly",
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateAdminOps({
        operations: [
          {
            op: "create_income",
            name: "Bar",
            hourlyWage: 20,
            taxRate: 10,
            payFrequency: "biweekly",
            anchorPayday: "2026-07-10",
            periodStart: "2026-06-22",
            periodEnd: "2026-07-05",
          },
        ],
      }).ok,
    ).toBe(true);
    // null clears an existing schedule
    const clear = validateAdminOps({
      operations: [{ op: "update_income", source: "cafe", payFrequency: null }],
    });
    expect(clear.ok).toBe(true);
  });
});

describe("resolveAdminOps", () => {
  it("resolves references by id, exact name, and unique substring", () => {
    const result = resolve([
      { op: "update_account", account: "a-save", archived: true },
      { op: "update_account", account: "checking", name: "Main checking" },
      { op: "update_recurring", rule: "spot", amount: 13 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ kind: "update_account", accountId: "a-save" });
    expect(result.value[1]).toMatchObject({ kind: "update_account", accountId: "a-check" });
    expect(result.value[2]).toMatchObject({ kind: "update_recurring", ruleId: "r-spotify" });
  });

  it("fails loudly on ambiguity and misses", () => {
    // "s" matches Checking? no — Savings and Visa? substring 's' is in Savings only... use 'a' which hits all three
    const ambiguous = resolve([{ op: "update_account", account: "a", archived: true }]);
    expect(ambiguous.ok).toBe(false);
    const missing = resolve([{ op: "update_category", category: "transport", name: "x" }]);
    expect(missing.ok).toBe(false);
  });

  it("blocks duplicate account/income names", () => {
    expect(
      resolve([{ op: "create_account", name: "checking", type: "checking", balance: 0 }]).ok,
    ).toBe(false);
    expect(
      resolve([
        { op: "create_account", name: "Cash", type: "cash", balance: 0 },
        { op: "create_account", name: "cash", type: "cash", balance: 0 },
      ]).ok,
    ).toBe(false);
    expect(resolve([{ op: "create_income", name: "Cafe job", hourlyWage: 1, taxRate: 0 }]).ok).toBe(
      false,
    );
  });

  it("only pins spend overrides on future days", () => {
    expect(resolve([{ op: "set_spend_override", date: "2026-07-07", amount: 10 }]).ok).toBe(false);
    expect(resolve([{ op: "set_spend_override", date: "2026-07-08", amount: 10 }]).ok).toBe(true);
  });

  it("resolves category clears vs sets on update_recurring", () => {
    const result = resolve([
      { op: "update_recurring", rule: "rent", category: null },
      { op: "update_recurring", rule: "spotify", category: "fun" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ kind: "update_recurring", clearCategory: true });
    expect(result.value[1]).toMatchObject({
      kind: "update_recurring",
      categoryId: "c-fun",
      clearCategory: false,
    });
  });
});

describe("receipts + stored-op re-validation", () => {
  it("renders a readable receipt", () => {
    const result = resolve([
      { op: "create_account", name: "Cash", type: "cash", balance: 40 },
      { op: "update_account", account: "visa", archived: true },
      { op: "set_spend_override", date: "2026-07-10", amount: 0 },
      { op: "set_daily_spend_estimate", amount: null },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = renderAdminReceipt(result.value);
    expect(receipt).toContain("new cash account");
    expect(receipt).toContain("Visa  archive");
    expect(receipt).toContain("pinned at $0.00");
    expect(receipt).toContain("daily spend estimate cleared");
  });

  it("round-trips resolved ops through JSON (the audit-row path)", () => {
    const result = resolve([
      { op: "create_account", name: "Cash", type: "cash", balance: 40 },
      { op: "update_account", account: "visa", archived: true },
      { op: "update_category", category: "fun", color: "#ff00aa" },
      {
        op: "update_recurring",
        rule: "rent",
        amount: 900,
        frequency: "monthly",
        dayOfMonth: 1,
      },
      {
        op: "create_income",
        name: "Tutoring",
        hourlyWage: 30,
        taxRate: 15,
        payFrequency: "biweekly",
        anchorPayday: "2026-07-10",
        periodStart: "2026-06-22",
        periodEnd: "2026-07-05",
      },
      { op: "update_income", source: "cafe", payFrequency: null },
      { op: "set_spend_override", date: "2026-07-10", amount: 12.5 },
      { op: "set_daily_spend_estimate", amount: 25 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = JSON.parse(JSON.stringify({ operations: result.value }));
    const back = validateResolvedAdminOps(stored);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(result.value);
  });

  it("rejects malformed stored ops", () => {
    expect(validateResolvedAdminOps({}).ok).toBe(false);
    expect(
      validateResolvedAdminOps({ operations: [{ kind: "update_account" }] }).ok,
    ).toBe(false);
    expect(
      validateResolvedAdminOps({
        operations: [{ kind: "create_account", name: "X", type: "crypto", balance: 1 }],
      }).ok,
    ).toBe(false);
    expect(
      validateResolvedAdminOps({
        operations: [{ kind: "set_spend_override", date: "july 4" }],
      }).ok,
    ).toBe(false);
  });
});
