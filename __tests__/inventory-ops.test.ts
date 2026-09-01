import { describe, expect, it } from "vitest";
import {
  hasRefCandidate,
  receiptLine,
  renderStockReceipt,
  resolveItemRef,
  resolveItemRefIncludingArchived,
  resolveStockOps,
  validateResolvedOps,
  validateStockOps,
  type ResolvableGroup,
  type ResolvableItem,
  type ResolvedStockOp,
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

  it("accepts set_priority and rejects bad priorities", () => {
    const ok = validateStockOps({
      operations: [{ op: "set_priority", item: "eggs", priority: "high" }],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value[0]).toEqual({ op: "set_priority", item: "eggs", priority: "high" });
    expect(
      validateStockOps({ operations: [{ op: "set_priority", item: "eggs", priority: "urgent" }] }).ok,
    ).toBe(false);
    expect(
      validateStockOps({ operations: [{ op: "set_priority", priority: "high" }] }).ok,
    ).toBe(false);
  });
});

describe("resolveItemRef", () => {
  it("an exact match wins over a substring collision", () => {
    const pool: ResolvableItem[] = [
      { id: "i1", name: "Milk", quantity: 1, unit: "L", archived: false },
      { id: "i2", name: "Milkshake mix", quantity: 1, unit: "", archived: false },
    ];
    const r = resolveItemRef("milk", pool);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe("i1");
  });

  it("an id match takes priority over any name matching", () => {
    const r = resolveItemRef("i-rice", ITEMS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe("Rice");
  });

  it("substring matching is case-insensitive", () => {
    const r = resolveItemRef("RIC", ITEMS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe("i-rice");
  });

  it("no match at all returns a plain error, not a candidates list", () => {
    const r = resolveItemRef("unobtainium", ITEMS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('no item matching "unobtainium"');
    }
  });
});

describe("resolveItemRefIncludingArchived", () => {
  const active = ITEMS.filter((it) => !it.archived);
  const archived = ITEMS.filter((it) => it.archived);

  it("finds an archived item the active shelf does not have", () => {
    const r = resolveItemRefIncludingArchived("sunscreen", active, archived);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ id: "i-sun", archived: true });
  });

  it("an active item wins outright over an archived one with the same name", () => {
    const shadowed: ResolvableItem[] = [
      { id: "i-old-rice", name: "Rice", quantity: 9, unit: "kg", archived: true },
    ];
    const r = resolveItemRefIncludingArchived("rice", active, shadowed);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe("i-rice");
  });

  it("the archive is a fallback, never a tiebreak for an ambiguous active ref", () => {
    // "soap" hits both Dish soap and Hand soap; an exactly-named archived Soap
    // must not quietly win that ambiguity.
    const archivedSoap: ResolvableItem[] = [
      { id: "i-soap-bar", name: "Soap", quantity: 0, unit: "", archived: true },
    ];
    const r = resolveItemRefIncludingArchived("soap", active, archivedSoap);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("ambiguous");
      expect(r.error).toContain("Dish soap");
      expect(r.error).toContain("Hand soap");
    }
  });

  // Deliberate split of responsibility: the resolver still reports the archive's
  // candidates, which an agent can act on because it holds ids. The /inventory
  // omnibox does NOT surface that — it checks hasRefCandidate against the active
  // shelf and proposes a create instead, because naming two rows the collapsed
  // "not tracking" section keeps hidden, remediable only by typing a uuid, is
  // not a usable error for a person.
  it("an ambiguous archive still reports its candidates to an id-holding caller", () => {
    const archivedRices: ResolvableItem[] = [
      { id: "i-brown", name: "Brown rice", quantity: 0, unit: "kg", archived: true },
      { id: "i-white", name: "White rice", quantity: 0, unit: "kg", archived: true },
    ];
    const noRice = active.filter((it) => it.id !== "i-rice");
    const r = resolveItemRefIncludingArchived("rice", noRice, archivedRices);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ambiguous");
    // The client's gate for that same input: nothing active matches, so it
    // takes the create path rather than showing the list above.
    expect(hasRefCandidate("rice", noRice)).toBe(false);
  });

  it("a ref matching nothing anywhere still reports a plain miss", () => {
    const r = resolveItemRefIncludingArchived("unobtainium", active, archived);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no item matching "unobtainium"');
  });

  it("hasRefCandidate reports presence, not resolvability", () => {
    expect(hasRefCandidate("soap", active)).toBe(true);
    expect(hasRefCandidate("i-eggs", active)).toBe(true);
    expect(hasRefCandidate("sunscreen", active)).toBe(false);
    expect(hasRefCandidate("sunscreen", archived)).toBe(true);
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

  it("refuses to create a second row over an archived name", () => {
    const result = resolve([{ op: "create", name: "Sunscreen", quantity: 1 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not being tracked");
      expect(result.error).toContain("set");
    }
  });

  it("recounting an archived item restores it instead of duplicating it", () => {
    const result = resolve([{ op: "set", item: "sunscreen", quantity: 3 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      kind: "recount",
      itemId: "i-sun",
      quantity: 3,
      before: 0,
      restored: true,
    });
  });

  it("recounting an active item is not flagged as a restore", () => {
    const result = resolve([{ op: "set", item: "rice", quantity: 3 }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatchObject({ itemId: "i-rice", restored: false });
    }
  });

  it("add/remove still refuse an archived item rather than restoring it", () => {
    for (const op of [
      { op: "add" as const, item: "sunscreen", amount: 1 },
      { op: "remove" as const, item: "sunscreen", amount: 1 },
    ]) {
      const result = resolve([op]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("restore");
    }
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

  it("renaming an item to a different case of its own name is not a collision", () => {
    const result = resolve([{ op: "rename", item: "eggs", name: "eggs" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]).toMatchObject({ from: "Eggs", to: "eggs" });
  });

  it("set accepts exactly zero as a valid recount", () => {
    const result = resolve([{ op: "set", item: "eggs", quantity: 0 }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]).toMatchObject({ quantity: 0, before: 6 });
  });

  it("move to an unknown group fails", () => {
    const result = resolve([{ op: "move", item: "eggs", group: "garage" }]);
    expect(result.ok).toBe(false);
  });

  it("care ops fail cleanly on a completely unknown item", () => {
    for (const op of [
      { op: "set_threshold" as const, item: "unobtainium", threshold: 1 },
      { op: "set_usage" as const, item: "unobtainium", amount: 1, period: "day" as const },
      { op: "set_priority" as const, item: "unobtainium", priority: "low" as const },
      { op: "clear_usage" as const, item: "unobtainium" },
      { op: "set_price" as const, item: "unobtainium", price: 5 },
      { op: "set_buy" as const, item: "unobtainium", buyAmount: 1 },
    ]) {
      expect(resolve([op]).ok).toBe(false);
    }
  });

  it("set_price on an archived item is a plain miss, unlike add/pin's restore hint", () => {
    const result = resolve([{ op: "set_price", item: "sunscreen", price: 5 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("restore");
  });

  it("running quantities keep clamping correctly across more than two chained ops", () => {
    const result = resolve([
      { op: "remove", item: "eggs", amount: 10 }, // 6 -> clamped to 0
      { op: "add", item: "eggs", amount: 3 }, // 0 -> 3
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ before: 6, after: 0 });
    expect(result.value[1]).toMatchObject({ before: 0, after: 3 });
  });

  it("fractional quantities round cleanly across chained ops (no float drift)", () => {
    const result = resolve([
      { op: "add", item: "milk", amount: 0.1 },
      { op: "add", item: "milk", amount: 0.2 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ kind: "adjust", after: 1.1 });
    expect(result.value[1]).toMatchObject({ kind: "adjust", after: 1.3 });
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
      { op: "set_priority", item: "eggs", priority: "high" },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const receipt = renderStockReceipt(resolved.value);
    expect(receipt).toContain("Eggs  6 → 18  (+12)");
    expect(receipt).toContain("Milk  1 → 0 L  (ran out)");
    expect(receipt).toContain("Rice  2 → 0.5 kg  (recount)");
    expect(receipt).not.toContain("restored");
    expect(receipt).toContain("paper towels  new · 3 rolls · Household");
    expect(receipt).toContain("Dish soap  stop tracking");
    expect(receipt).toContain("Sunscreen  tracking again");
    expect(receipt).toContain("Eggs  priority → high (!!!)");
  });

  it("renders move's group fallback chain and a bare create with no group or price", () => {
    const pendingMove: ResolvedStockOp = {
      kind: "move",
      itemId: "i-eggs",
      name: "Eggs",
      groupId: null,
      groupName: null,
      pendingGroup: "Pantry",
    };
    expect(receiptLine(pendingMove)).toBe("Eggs  moved to Pantry");

    const noGroupMove: ResolvedStockOp = { ...pendingMove, pendingGroup: null };
    expect(receiptLine(noGroupMove)).toBe("Eggs  moved to no group");

    const bareCreate: ResolvedStockOp = {
      kind: "create",
      name: "Flour",
      quantity: 1,
      unit: "kg",
      groupId: null,
      groupName: null,
      price: null,
    };
    expect(receiptLine(bareCreate)).toBe("Flour  new · 1 kg");
  });

  it("a restoring recount says so before it is confirmed", () => {
    const resolved = resolve([{ op: "set", item: "sunscreen", quantity: 3 }]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(receiptLine(resolved.value[0])).toBe(
      "Sunscreen  0 → 3  (recount · restored, tracking again)",
    );
  });

  it("low and med priority do not get the (!!!) suffix", () => {
    const low: ResolvedStockOp = { kind: "priority", itemId: "i-eggs", name: "Eggs", priority: "low" };
    const med: ResolvedStockOp = { ...low, priority: "med" };
    expect(receiptLine(low)).toBe("Eggs  priority → low");
    expect(receiptLine(med)).toBe("Eggs  priority → med");
  });
});

describe("validateResolvedOps", () => {
  it("round-trips resolved ops through JSON (the audit-row path)", () => {
    const resolved = resolve([
      { op: "add", item: "eggs", amount: 12 },
      { op: "create", name: "paper towels", quantity: 3, unit: "rolls" },
      { op: "archive", item: "dish soap" },
      { op: "set_priority", item: "milk", priority: "low" },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const stored = JSON.parse(JSON.stringify({ operations: resolved.value }));
    const back = validateResolvedOps(stored);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(resolved.value);
  });

  it("carries the restore flag through the audit row, and defaults it off", () => {
    const resolved = resolve([{ op: "set", item: "sunscreen", quantity: 3 }]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const back = validateResolvedOps(
      JSON.parse(JSON.stringify({ operations: resolved.value })),
    );
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value[0]).toMatchObject({ restored: true });

    // Proposals stored before this field existed must not start un-archiving.
    const legacy = validateResolvedOps({
      operations: [{ kind: "recount", itemId: "i-rice", quantity: 2 }],
    });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.value[0]).toMatchObject({ restored: false });
  });

  it("rejects malformed stored ops", () => {
    expect(validateResolvedOps({}).ok).toBe(false);
    expect(validateResolvedOps({ operations: [{ kind: "adjust", delta: 1 }] }).ok).toBe(false);
    expect(
      validateResolvedOps({ operations: [{ kind: "adjust", itemId: "x", delta: 0 }] }).ok,
    ).toBe(false);
    expect(
      validateResolvedOps({
        operations: [{ kind: "priority", itemId: "x", priority: "urgent" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed move, create_group, and recount shapes", () => {
    expect(
      validateResolvedOps({ operations: [{ kind: "move", groupId: "g-house" }] }).ok,
    ).toBe(false);
    expect(
      validateResolvedOps({ operations: [{ kind: "create_group", name: "" }] }).ok,
    ).toBe(false);
    expect(
      validateResolvedOps({
        operations: [{ kind: "recount", itemId: "x", quantity: -1 }],
      }).ok,
    ).toBe(false);
  });

  it("rejects an unknown stored operation kind", () => {
    expect(
      validateResolvedOps({ operations: [{ kind: "teleport", itemId: "x" }] }).ok,
    ).toBe(false);
  });
});

describe("care ops (threshold / usage / rename / move / groups)", () => {
  it("validates and resolves set_threshold, including a clear", () => {
    const result = resolve([
      { op: "set_threshold", item: "eggs", threshold: 4 },
      { op: "set_threshold", item: "milk", threshold: null },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ kind: "threshold", itemId: "i-eggs", threshold: 4 });
    expect(result.value[1]).toMatchObject({ kind: "threshold", itemId: "i-milk", threshold: null });
  });

  it("rejects a non-positive threshold", () => {
    expect(
      validateStockOps({ operations: [{ op: "set_threshold", item: "eggs", threshold: 0 }] }).ok,
    ).toBe(false);
  });

  it("validates set_usage cadences and requires intervalDays for custom", () => {
    const ok = resolve([
      { op: "set_usage", item: "eggs", amount: 2, period: "day" },
      { op: "set_usage", item: "milk", amount: 1, period: "week" },
      { op: "set_usage", item: "rice", amount: 1, period: "custom", intervalDays: 10 },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value[0]).toMatchObject({ kind: "usage", period: "day", intervalDays: null });
      expect(ok.value[2]).toMatchObject({ kind: "usage", period: "custom", intervalDays: 10 });
    }
    expect(
      validateStockOps({
        operations: [{ op: "set_usage", item: "rice", amount: 1, period: "custom" }],
      }).ok,
    ).toBe(false);
    expect(
      validateStockOps({
        operations: [{ op: "set_usage", item: "rice", amount: 1, period: "monthly" }],
      }).ok,
    ).toBe(false);
  });

  it("resolves clear_usage and rename, and blocks rename collisions", () => {
    const ok = resolve([
      { op: "clear_usage", item: "eggs" },
      { op: "rename", item: "rice", name: "Basmati rice" },
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value[0]).toMatchObject({ kind: "clear_usage", itemId: "i-eggs" });
      expect(ok.value[1]).toMatchObject({ kind: "rename", from: "Rice", to: "Basmati rice" });
    }
    const collision = resolve([{ op: "rename", item: "rice", name: "milk" }]);
    expect(collision.ok).toBe(false);
  });

  it("moves items to a group by name, or to none when group is omitted", () => {
    const result = resolve([
      { op: "move", item: "rice", group: "food" },
      { op: "move", item: "milk" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ kind: "move", groupId: "g-food", groupName: "Food" });
    expect(result.value[1]).toMatchObject({ kind: "move", groupId: null, groupName: null });
  });

  it("create_group is usable by later ops in the same batch (pendingGroup)", () => {
    const result = resolve([
      { op: "create_group", name: "Pantry" },
      { op: "move", item: "rice", group: "pantry" },
      { op: "create", name: "flour", quantity: 1, unit: "kg", group: "Pantry" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toEqual({ kind: "create_group", name: "Pantry" });
    expect(result.value[1]).toMatchObject({ kind: "move", groupId: null, pendingGroup: "Pantry" });
    expect(result.value[2]).toMatchObject({ kind: "create", pendingGroup: "Pantry" });
  });

  it("blocks duplicate group creates", () => {
    expect(resolve([{ op: "create_group", name: "Household" }]).ok).toBe(false);
    expect(
      resolve([
        { op: "create_group", name: "Pantry" },
        { op: "create_group", name: "pantry" },
      ]).ok,
    ).toBe(false);
  });

  it("renders receipts for the new ops", () => {
    const result = resolve([
      { op: "set_threshold", item: "eggs", threshold: 4 },
      { op: "set_usage", item: "milk", amount: 1, period: "week" },
      { op: "rename", item: "rice", name: "Basmati rice" },
      { op: "create_group", name: "Pantry" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = renderStockReceipt(result.value);
    expect(receipt).toContain("reorder at 4");
    expect(receipt).toContain("usage → 1 L per week");
    expect(receipt).toContain("renamed \"Basmati rice\"");
    expect(receipt).toContain("Pantry  new group");
  });

  it("round-trips the new resolved kinds through JSON", () => {
    const resolved = resolve([
      { op: "set_threshold", item: "eggs", threshold: 4 },
      { op: "set_usage", item: "rice", amount: 1, period: "custom", intervalDays: 10 },
      { op: "clear_usage", item: "milk" },
      { op: "rename", item: "rice", name: "Basmati rice" },
      { op: "create_group", name: "Pantry" },
      { op: "move", item: "milk", group: "Pantry" },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const stored = JSON.parse(JSON.stringify({ operations: resolved.value }));
    const back = validateResolvedOps(stored);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(resolved.value);
  });
});

describe("shopping list ops", () => {
  it("validates pin/unpin/set_price shapes", () => {
    const result = validateStockOps({
      operations: [
        { op: "pin_shopping", item: "eggs" },
        { op: "pin_shopping", item: "milk", price: 6.499 },
        { op: "unpin_shopping", item: "rice" },
        { op: "set_price", item: "eggs", price: 4.29 },
        { op: "set_price", item: "milk", price: null },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[1]).toEqual({ op: "pin_shopping", item: "milk", price: 6.5 });
      expect(result.value[4]).toEqual({ op: "set_price", item: "milk", price: null });
    }
  });

  it("rejects missing items and bad prices", () => {
    expect(validateStockOps({ operations: [{ op: "pin_shopping" }] }).ok).toBe(false);
    expect(validateStockOps({ operations: [{ op: "unpin_shopping" }] }).ok).toBe(false);
    expect(
      validateStockOps({ operations: [{ op: "pin_shopping", item: "eggs", price: -1 }] }).ok,
    ).toBe(false);
    expect(
      validateStockOps({ operations: [{ op: "set_price", item: "eggs", price: 0 }] }).ok,
    ).toBe(false);
    const unknown = validateStockOps({ operations: [{ op: "shoplift", item: "eggs" }] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("pin_shopping");
  });

  it("resolves pins fuzzily and fails on ambiguity", () => {
    const resolved = resolve([
      { op: "pin_shopping", item: "egg", price: 4.29 },
      { op: "unpin_shopping", item: "i-milk" },
    ]);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value[0]).toMatchObject({
        kind: "pin",
        itemId: "i-eggs",
        pinned: true,
        price: 4.29,
      });
      expect(resolved.value[1]).toMatchObject({
        kind: "pin",
        itemId: "i-milk",
        pinned: false,
        price: null,
      });
    }
    expect(resolve([{ op: "pin_shopping", item: "soap" }]).ok).toBe(false);
  });

  it("refuses to pin an archived item and points at restore", () => {
    const resolved = resolve([{ op: "pin_shopping", item: "sunscreen" }]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("restore");
  });

  it("create then pin in one batch resolves via pendingItem", () => {
    const resolved = resolve([
      { op: "create", name: "paper towels", quantity: 0, unit: "rolls", price: 7.99 },
      { op: "pin_shopping", item: "paper towels" },
    ]);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value[0]).toMatchObject({ kind: "create", price: 7.99 });
      expect(resolved.value[1]).toMatchObject({
        kind: "pin",
        itemId: null,
        pendingItem: "paper towels",
        pinned: true,
      });
    }
  });

  it("renders shopping receipts", () => {
    const resolved = resolve([
      { op: "pin_shopping", item: "milk", price: 6.5 },
      { op: "unpin_shopping", item: "rice" },
      { op: "set_price", item: "eggs", price: 4.29 },
      { op: "set_price", item: "milk", price: null },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(renderStockReceipt(resolved.value)).toBe(
      [
        "Milk  → shopping list · ~$6.50",
        "Rice  off shopping list",
        "Eggs  price → $4.29",
        "Milk  price cleared",
      ].join("\n"),
    );
  });

  it("round-trips resolved pin/price ops through validateResolvedOps", () => {
    const resolved = resolve([
      { op: "create", name: "paper towels", quantity: 0, price: 7.99 },
      { op: "pin_shopping", item: "paper towels" },
      { op: "pin_shopping", item: "milk", price: 6.5 },
      { op: "set_price", item: "eggs", price: null },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const stored = JSON.parse(JSON.stringify({ operations: resolved.value }));
    const back = validateResolvedOps(stored);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(resolved.value);
  });

  it("rejects malformed stored pin ops", () => {
    expect(
      validateResolvedOps({
        operations: [{ kind: "pin", itemId: "i-eggs", pendingItem: "eggs", pinned: true }],
      }).ok,
    ).toBe(false);
    expect(
      validateResolvedOps({
        operations: [{ kind: "pin", itemId: null, pendingItem: null, pinned: true }],
      }).ok,
    ).toBe(false);
    expect(
      validateResolvedOps({
        operations: [{ kind: "price", itemId: "i-eggs", price: -2 }],
      }).ok,
    ).toBe(false);
  });
});

describe("buy amount ops", () => {
  it("validates set_buy and pin buyAmount shapes", () => {
    const result = validateStockOps({
      operations: [
        { op: "set_buy", item: "eggs", buyAmount: 12 },
        { op: "set_buy", item: "milk", buyAmount: null },
        { op: "pin_shopping", item: "rice", buyAmount: 2.5, price: 8 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toEqual({ op: "set_buy", item: "eggs", buyAmount: 12 });
      expect(result.value[1]).toEqual({ op: "set_buy", item: "milk", buyAmount: null });
      expect(result.value[2]).toEqual({
        op: "pin_shopping",
        item: "rice",
        price: 8,
        buyAmount: 2.5,
      });
    }
    expect(validateStockOps({ operations: [{ op: "set_buy" }] }).ok).toBe(false);
    expect(
      validateStockOps({ operations: [{ op: "set_buy", item: "eggs", buyAmount: 0 }] }).ok,
    ).toBe(false);
    expect(
      validateStockOps({
        operations: [{ op: "pin_shopping", item: "eggs", buyAmount: -3 }],
      }).ok,
    ).toBe(false);
  });

  it("resolves set_buy with the item's unit and renders receipts", () => {
    const resolved = resolve([
      { op: "set_buy", item: "milk", buyAmount: 4 },
      { op: "set_buy", item: "eggs", buyAmount: null },
      { op: "pin_shopping", item: "rice", buyAmount: 2 },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value[0]).toEqual({
      kind: "buy",
      itemId: "i-milk",
      name: "Milk",
      unit: "L",
      amount: 4,
    });
    expect(resolved.value[2]).toMatchObject({
      kind: "pin",
      itemId: "i-rice",
      pinned: true,
      buyAmount: 2,
    });
    expect(renderStockReceipt(resolved.value)).toBe(
      [
        "Milk  will buy 4 L",
        "Eggs  buy amount cleared (one package)",
        "Rice  → shopping list · buy 2",
      ].join("\n"),
    );
  });

  it("round-trips buy ops through validateResolvedOps", () => {
    const resolved = resolve([
      { op: "set_buy", item: "milk", buyAmount: 4 },
      { op: "set_buy", item: "eggs", buyAmount: null },
      { op: "pin_shopping", item: "rice", buyAmount: 2, price: 8 },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const stored = JSON.parse(JSON.stringify({ operations: resolved.value }));
    const back = validateResolvedOps(stored);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(resolved.value);
    expect(
      validateResolvedOps({
        operations: [{ kind: "buy", itemId: "i-eggs", amount: -1 }],
      }).ok,
    ).toBe(false);
  });
});
