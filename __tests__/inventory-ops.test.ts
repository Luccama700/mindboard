import { describe, expect, it } from "vitest";
import {
  renderStockReceipt,
  resolveStockOps,
  validateResolvedOps,
  validateStockOps,
  type ResolvableGroup,
  type ResolvableItem,
  type StockOp,
} from "@/app/lib/mcp/inventory-ops";

const ITEMS: ResolvableItem[] = [
  { id: "i-eggs", name: "Eggs", quantity: 6, unit: "", archived: false },
  { id: "i-milk", name: "Milk", quantity: 1, unit: "L", archived: false },
  { id: "i-rice", name: "Rice", quantity: 2, unit: "kg", archived: false },
  { id: "i-soap-dish", name: "Dish soap", quantity: 1, unit: "", archived: false },
  { id: "i-soap-hand", name: "Hand soap", quantity: 2, unit: "", archived: false },
  { id: "i-sun", name: "Sunscreen", quantity: 0, unit: "", archived: true },
];

const GROUPS: ResolvableGroup[] = [
  { id: "g-house", name: "Household" },
  { id: "g-food", name: "Food" },
];

function resolve(ops: StockOp[]) {
  return resolveStockOps(ops, ITEMS, GROUPS);
}

describe("validateStockOps", () => {
  it("accepts a mixed batch", () => {
    const result = validateStockOps({
      operations: [
        { op: "add", item: "eggs", amount: 12 },
        { op: "remove", item: "milk", amount: 1 },
        { op: "set", item: "rice", quantity: 0.5 },
        { op: "create", name: "paper towels", quantity: 3, unit: "rolls", group: "household" },
        { op: "archive", item: "dish soap" },
        { op: "restore", item: "sunscreen" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(6);
  });

  it("rejects empty, non-array, and oversized batches", () => {
    expect(validateStockOps({}).ok).toBe(false);
    expect(validateStockOps({ operations: [] }).ok).toBe(false);
    const many = Array.from({ length: 51 }, () => ({ op: "add", item: "x", amount: 1 }));
    expect(validateStockOps({ operations: many }).ok).toBe(false);
  });

  it("rejects bad amounts and unknown ops", () => {
    expect(validateStockOps({ operations: [{ op: "add", item: "eggs", amount: 0 }] }).ok).toBe(false);
    expect(validateStockOps({ operations: [{ op: "add", item: "eggs", amount: -2 }] }).ok).toBe(false);
    expect(validateStockOps({ operations: [{ op: "set", item: "eggs", quantity: -1 }] }).ok).toBe(false);
    expect(validateStockOps({ operations: [{ op: "eat", item: "eggs" }] }).ok).toBe(false);
    expect(validateStockOps({ operations: [{ op: "create", quantity: 1 }] }).ok).toBe(false);
  });
});

describe("resolveStockOps", () => {
  it("resolves names case-insensitively and computes before/after", () => {
    const result = resolve([{ op: "add", item: "eggs", amount: 12 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      kind: "adjust",
      itemId: "i-eggs",
      before: 6,
      after: 18,
      delta: 12,
    });
  });

  it("clamps removals at zero", () => {
    const result = resolve([{ op: "remove", item: "milk", amount: 5 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ before: 1, after: 0 });
  });

  it("threads running quantities through repeated ops on one item", () => {
    const result = resolve([
      { op: "add", item: "eggs", amount: 6 },
      { op: "remove", item: "eggs", amount: 2 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[1]).toMatchObject({ before: 12, after: 10 });
  });

  it("resolves unique substrings but fails ambiguous ones with candidates", () => {
    const unique = resolve([{ op: "add", item: "ric", amount: 1 }]);
    expect(unique.ok).toBe(true);

    const ambiguous = resolve([{ op: "add", item: "soap", amount: 1 }]);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error).toContain("Dish soap");
      expect(ambiguous.error).toContain("Hand soap");
    }
  });

  it("fails the whole batch on one unknown item", () => {
    const result = resolve([
      { op: "add", item: "eggs", amount: 1 },
      { op: "add", item: "unobtainium", amount: 1 },
    ]);
    expect(result.ok).toBe(false);
  });

  it("points at restore when adjusting an archived item", () => {
    const result = resolve([{ op: "add", item: "sunscreen", amount: 1 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("restore");
  });

  it("restore only matches archived items; archive only active ones", () => {
    expect(resolve([{ op: "restore", item: "sunscreen" }]).ok).toBe(true);
    expect(resolve([{ op: "restore", item: "eggs" }]).ok).toBe(false);
    expect(resolve([{ op: "archive", item: "sunscreen" }]).ok).toBe(false);
  });

  it("rejects create when an active item already has that name", () => {
    const result = resolve([{ op: "create", name: "eggs", quantity: 12 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("add/set");
  });

  it("resolves create groups by name and fails unknown groups", () => {
    const ok = resolve([
      { op: "create", name: "paper towels", quantity: 3, unit: "rolls", group: "household" },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value[0]).toMatchObject({ groupId: "g-house", groupName: "Household" });

    const bad = resolve([
      { op: "create", name: "paper towels", quantity: 3, group: "garage" },
    ]);
    expect(bad.ok).toBe(false);
  });
});

describe("renderStockReceipt", () => {
  it("renders one line per op in receipt style", () => {
    const resolved = resolve([
      { op: "add", item: "eggs", amount: 12 },
      { op: "remove", item: "milk", amount: 1 },
      { op: "set", item: "rice", quantity: 0.5 },
      { op: "create", name: "paper towels", quantity: 3, unit: "rolls", group: "household" },
      { op: "archive", item: "dish soap" },
      { op: "restore", item: "sunscreen" },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const receipt = renderStockReceipt(resolved.value);
    expect(receipt).toContain("Eggs  6 → 18  (+12)");
    expect(receipt).toContain("Milk  1 → 0 L  (ran out)");
    expect(receipt).toContain("Rice  2 → 0.5 kg  (recount)");
    expect(receipt).toContain("paper towels  new · 3 rolls · Household");
    expect(receipt).toContain("Dish soap  stop tracking");
    expect(receipt).toContain("Sunscreen  tracking again");
  });
});

describe("validateResolvedOps", () => {
  it("round-trips resolved ops through JSON (the audit-row path)", () => {
    const resolved = resolve([
      { op: "add", item: "eggs", amount: 12 },
      { op: "create", name: "paper towels", quantity: 3, unit: "rolls" },
      { op: "archive", item: "dish soap" },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const stored = JSON.parse(JSON.stringify({ operations: resolved.value }));
    const back = validateResolvedOps(stored);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(resolved.value);
  });

  it("rejects malformed stored ops", () => {
    expect(validateResolvedOps({}).ok).toBe(false);
    expect(validateResolvedOps({ operations: [{ kind: "adjust", delta: 1 }] }).ok).toBe(false);
    expect(
      validateResolvedOps({ operations: [{ kind: "adjust", itemId: "x", delta: 0 }] }).ok,
    ).toBe(false);
  });
});
