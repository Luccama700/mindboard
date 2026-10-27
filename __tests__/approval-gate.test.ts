import { describe, expect, it } from "vitest";

import {
  APP_APPROVAL_PATH,
  appApprovalMessage,
  confirmableInApp,
  proposalChannel,
  requiresAppApproval,
} from "@/app/lib/mcp/approval";
import { resolveFinanceOps } from "@/app/lib/mcp/finance-ops";
import { resolveAdminOps } from "@/app/lib/mcp/finance-admin-ops";
import { resolvePeopleOps } from "@/app/lib/mcp/people-ops";
import { resolveStockOps } from "@/app/lib/mcp/inventory-ops";

// The predicate reads a proposal's STORED input, so these fixtures go through
// the real resolvers wherever that is cheap: if the stored op shape ever drifts
// (kind renamed, operations nested differently) these break instead of silently
// un-gating a destructive write.

const TODAY = "2026-10-27";

const ACCOUNTS = [
  { id: "a-chq", name: "Chequing", type: "checking", currency: "CAD", balance: 1000, archived: false },
  { id: "a-visa", name: "Visa", type: "credit", currency: "CAD", balance: -200, archived: false },
];
const CATEGORIES = [{ id: "c-food", name: "Food" }];
const RECURRING = [{ id: "r-rent", name: "Rent" }];
const EXISTING = [
  {
    id: "ch-1",
    account_id: "a-chq",
    direction: "out" as const,
    amount: 12.5,
    occurred_at: `${TODAY}T00:00:00Z`,
    fingerprint: `${TODAY}|out|1250`,
    is_transfer: false,
  },
];

function financeInput(ops: Parameters<typeof resolveFinanceOps>[0]) {
  const resolved = resolveFinanceOps(ops, {
    accounts: ACCOUNTS,
    categories: CATEGORIES,
    recurring: RECURRING,
    existingChanges: EXISTING,
    today: TODAY,
  });
  if (!resolved.ok) throw new Error(resolved.error);
  return { operations: resolved.value };
}

function adminInput(ops: Parameters<typeof resolveAdminOps>[0]) {
  const resolved = resolveAdminOps(ops, {
    accounts: ACCOUNTS.map((a) => ({ id: a.id, name: a.name })),
    categories: CATEGORIES,
    recurring: RECURRING,
    incomeSources: [{ id: "i-cafe", name: "Cafe" }],
    today: TODAY,
  });
  if (!resolved.ok) throw new Error(resolved.error);
  return { operations: resolved.value };
}

function peopleInput(ops: Parameters<typeof resolvePeopleOps>[0]) {
  const resolved = resolvePeopleOps(
    ops,
    [
      { id: "p-davi", name: "Davi", archived: false },
      { id: "p-old", name: "Old Friend", archived: true },
    ],
    [{ id: "g-fam", name: "family" }],
  );
  if (!resolved.ok) throw new Error(resolved.error);
  return { operations: resolved.value };
}

function stockInput(ops: Parameters<typeof resolveStockOps>[0]) {
  const resolved = resolveStockOps(
    ops,
    [
      { id: "i-eggs", name: "Eggs", quantity: 6, unit: "", archived: false },
      { id: "i-sun", name: "Sunscreen", quantity: 0, unit: "", archived: true },
    ],
    [{ id: "g-food", name: "Food" }],
  );
  if (!resolved.ok) throw new Error(resolved.error);
  return { operations: resolved.value };
}

describe("requiresAppApproval — always gated", () => {
  it.each([
    ["delete_task", { taskId: "t-1" }],
    ["delete_spend_limit", { limitId: "l-1" }],
    ["update_settings", { timezone: "America/Vancouver" }],
    ["generate_audio_overview", { course: "Phil 220", flavor: "brief" }],
  ])("%s", (tool, input) => {
    expect(requiresAppApproval(tool, input)).toBe(true);
  });
});

describe("requiresAppApproval — never gated", () => {
  it.each([
    // URC: an `mcp:` credential is already required, the session starts idle,
    // and the link is bound to the owner's own claude.ai account.
    ["spawn_urc", { folder: "mindboard", deviceId: "d-1" }],
    ["create_task", { title: "buy milk" }],
    ["complete_task", { taskId: "t-1" }],
    ["miss_task", { taskId: "t-1" }],
    ["log_spend", { accountId: "a-chq", amount: 12 }],
    ["log_daily", { mood: 4 }],
    ["manage_group", { action: "create", name: "school" }],
    ["upsert_goal", { title: "ship the audit fixes" }],
    ["create_event", { title: "gym", start: `${TODAY}T18:00:00Z` }],
    ["reschedule_event", { eventId: "e-1" }],
    ["set_spend_limit", { amount: 200 }],
    ["capture_to_brain", { title: "note" }],
    ["schedule_task", { taskId: "t-1", dueDate: TODAY, dueTime: "09:00" }],
    ["some_future_tool", {}],
  ])("%s", (tool, input) => {
    expect(requiresAppApproval(tool, input)).toBe(false);
  });

  it("tolerates a malformed or missing input", () => {
    expect(requiresAppApproval("update_finance", null)).toBe(false);
    expect(requiresAppApproval("update_finance", {})).toBe(false);
    expect(requiresAppApproval("update_finance", { operations: "nope" })).toBe(false);
    expect(requiresAppApproval("update_stock", { operations: [null, 3, "x"] })).toBe(false);
    expect(requiresAppApproval("update_task", undefined)).toBe(false);
  });
});

describe("update_task — only the build-approval transition", () => {
  it("gates aiState 'approved'", () => {
    expect(requiresAppApproval("update_task", { taskId: "t-1", aiState: "approved" })).toBe(true);
  });

  it.each(["planned", "building", "built", "failed", "declined", null])(
    "leaves aiState %s alone",
    (aiState) => {
      expect(requiresAppApproval("update_task", { taskId: "t-1", aiState })).toBe(false);
    },
  );

  it("leaves ordinary edits alone", () => {
    expect(requiresAppApproval("update_task", { taskId: "t-1", dueDate: TODAY })).toBe(false);
    expect(requiresAppApproval("update_task", { taskId: "t-1", notes: "approved" })).toBe(false);
  });
});

describe("update_finance — corrections gated, imports not", () => {
  it("lets a pure additive statement import through", () => {
    const input = financeInput([
      { op: "spend", account: "Chequing", amount: 40, date: TODAY, category: "Food" },
      { op: "income", account: "Chequing", amount: 500, date: TODAY },
      { op: "transfer", from: "Chequing", to: "Visa", amount: 200, date: TODAY },
      { op: "create_category", name: "Transit" },
      {
        op: "create_recurring",
        name: "Spotify",
        amount: 12,
        frequency: "monthly",
        dayOfMonth: 3,
      },
    ]);
    expect(requiresAppApproval("update_finance", input)).toBe(false);
  });

  it.each([
    ["remove", [{ op: "remove" as const, changeId: "ch-1" }]],
    ["adjust", [{ op: "adjust" as const, changeId: "ch-1", amount: 15 }]],
    [
      "reconcile",
      [{ op: "reconcile" as const, account: "Chequing", balance: 900, asOf: TODAY }],
    ],
  ])("gates a batch containing %s", (_label, ops) => {
    expect(requiresAppApproval("update_finance", financeInput(ops))).toBe(true);
  });

  it("gates a mixed batch where only one op is a correction", () => {
    const input = financeInput([
      { op: "spend", account: "Chequing", amount: 40, date: TODAY },
      { op: "remove", changeId: "ch-1" },
    ]);
    expect(requiresAppApproval("update_finance", input)).toBe(true);
  });

  it("also catches the raw `op` spelling a forged proposal row could carry", () => {
    expect(
      requiresAppApproval("update_finance", { operations: [{ op: "remove", changeId: "ch-1" }] }),
    ).toBe(true);
  });
});

describe("manage_finance — archive-type actions gated", () => {
  it("lets configuration edits through", () => {
    const input = adminInput([
      { op: "update_account", account: "Chequing", name: "Daily" },
      { op: "set_daily_spend_estimate", amount: 25 },
      { op: "set_spend_override", date: "2026-11-01", amount: 0 },
    ]);
    expect(requiresAppApproval("manage_finance", input)).toBe(false);
  });

  it.each([
    ["account", [{ op: "update_account" as const, account: "Visa", archived: true }]],
    ["category", [{ op: "update_category" as const, category: "Food", archived: true }]],
    ["recurring rule", [{ op: "update_recurring" as const, rule: "Rent", archived: true }]],
    ["income source", [{ op: "update_income" as const, source: "Cafe", archived: true }]],
  ])("gates archiving an %s", (_label, ops) => {
    expect(requiresAppApproval("manage_finance", adminInput(ops))).toBe(true);
  });

  it("does not gate un-archiving", () => {
    const input = adminInput([{ op: "update_account", account: "Visa", archived: false }]);
    expect(requiresAppApproval("manage_finance", input)).toBe(false);
  });
});

describe("update_people — archive gated", () => {
  it("lets logging, cadence and grouping through", () => {
    const input = peopleInput([
      { op: "log_interaction", person: "Davi", summary: "coffee" },
      { op: "create_person", name: "Nina" },
      { op: "set_checkin", person: "Davi", days: 30 },
      { op: "set_group", person: "Davi", group: "family" },
      { op: "restore", person: "Old Friend" },
    ]);
    expect(requiresAppApproval("update_people", input)).toBe(false);
  });

  it("gates archive", () => {
    expect(requiresAppApproval("update_people", peopleInput([{ op: "archive", person: "Davi" }]))).toBe(
      true,
    );
  });
});

describe("update_stock — quantity work stays chat-confirmable", () => {
  it("lets the whole stock vocabulary through (there is no hard-delete op today)", () => {
    const input = stockInput([
      { op: "add", item: "Eggs", amount: 6 },
      { op: "remove", item: "Eggs", amount: 2 },
      { op: "set", item: "Eggs", quantity: 12 },
      { op: "archive", item: "Eggs" },
      { op: "restore", item: "Sunscreen" },
    ]);
    expect(requiresAppApproval("update_stock", input)).toBe(false);
  });

  it("gates a hard delete the day one is added", () => {
    expect(
      requiresAppApproval("update_stock", { operations: [{ kind: "delete", itemId: "i-eggs" }] }),
    ).toBe(true);
  });
});

describe("proposalChannel — what the approvals inbox labels a row", () => {
  it("reads the in-app copilot off source", () => {
    expect(proposalChannel("assistant", { taskId: "t-1" })).toBe("copilot");
  });

  it("tells the watch from a chat client by its idempotency key", () => {
    // The watch records source 'mcp' like any external client; the key is the
    // only thing that distinguishes it (app/lib/watch/writes.ts).
    expect(proposalChannel("mcp", { taskId: "t-1", idempotencyKey: "abc" })).toBe("watch");
    expect(proposalChannel("mcp", { taskId: "t-1" })).toBe("chat");
    expect(proposalChannel("mcp", { taskId: "t-1", idempotencyKey: "" })).toBe("chat");
    expect(proposalChannel("mcp", { taskId: "t-1", idempotencyKey: 7 })).toBe("chat");
  });

  it("never throws on a missing or odd row", () => {
    expect(proposalChannel("mcp", null)).toBe("chat");
    expect(proposalChannel(null, null)).toBe("unknown");
    expect(proposalChannel("something-new", {})).toBe("unknown");
  });
});

describe("confirmableInApp", () => {
  it("excludes spawn_urc, whose executor demands an mcp: credential", () => {
    expect(confirmableInApp("spawn_urc")).toBe(false);
  });

  it.each(["delete_task", "update_finance", "create_task", "update_settings"])(
    "allows %s",
    (tool) => {
      expect(confirmableInApp(tool)).toBe(true);
    },
  );
});

describe("appApprovalMessage", () => {
  it("names the tool and points at the approvals inbox", () => {
    const message = appApprovalMessage("delete_task");
    expect(message).toContain("delete_task");
    expect(message).toContain(APP_APPROVAL_PATH);
    expect(APP_APPROVAL_PATH).toBe("/approvals");
  });
});
