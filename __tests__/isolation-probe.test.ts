import { describe, expect, it } from "vitest";

import { leakNeedles, scanForLeak } from "../test/isolation/harness.mjs";
import { diffSnapshots } from "../test/isolation/seed.mjs";
import { reportCoverage } from "../test/isolation/mcp-probe.mjs";
import { TOOL_MATRIX } from "../test/isolation/tool-matrix.mjs";

// The two-tenant probe (test/isolation-proof.mjs) is only worth running if its
// own detectors work. A leak scanner that never matches, a snapshot diff that
// never differs, or a coverage report that never notices a missing tool would
// all pass silently forever. These are those detectors, exercised directly.

function stubReporter() {
  const checks: { label: string; ok: boolean; detail: string }[] = [];
  return {
    checks,
    section: () => {},
    info: () => {},
    check: (label: string, ok: boolean, detail = "") => {
      checks.push({ label, ok: Boolean(ok), detail });
      return Boolean(ok);
    },
    fail: (label: string, detail = "") => {
      checks.push({ label, ok: false, detail });
      return false;
    },
  };
}

describe("leak scanner", () => {
  const b = {
    marker: "zzpaaab",
    taskId: "11111111-1111-1111-1111-111111111111",
    accountName: "zzpaaab-account",
  };
  const needles = leakNeedles(b);

  it("builds a needle for every seeded value", () => {
    expect(needles.map((n) => n.label).sort()).toEqual([
      "B marker",
      "B.accountName",
      "B.taskId",
    ]);
  });

  it("flags a response that contains the victim's data", () => {
    const leaked = scanForLeak(
      JSON.stringify([{ id: b.taskId, name: b.accountName }]),
      needles,
      "{}",
    );
    expect(leaked).toContain("B.taskId");
    expect(leaked).toContain("B.accountName");
  });

  it("does not flag an id the attacker supplied in the request", () => {
    const args = JSON.stringify({ taskId: b.taskId });
    const leaked = scanForLeak(`Error: task ${b.taskId} not found`, needles, args);
    expect(leaked).toEqual([]);
  });

  it("still flags data resolved FROM an id the attacker supplied", () => {
    const args = JSON.stringify({ taskId: b.taskId });
    const leaked = scanForLeak(
      JSON.stringify({ taskId: b.taskId, account: b.accountName }),
      needles,
      args,
    );
    expect(leaked).toContain("B.accountName");
    expect(leaked).not.toContain("B.taskId");
  });

  it("passes a clean response", () => {
    expect(scanForLeak(JSON.stringify([{ id: "other" }]), needles, "{}")).toEqual([]);
  });
});

describe("tenant snapshot diff", () => {
  const before = { tasks: ['{"id":"1","title":"a"}'], goals: [] };

  it("reports nothing when the rows are identical", () => {
    expect(diffSnapshots(before, { ...before })).toEqual([]);
  });

  it("reports a table whose row changed", () => {
    const after = { tasks: ['{"id":"1","title":"vandalized"}'], goals: [] };
    expect(diffSnapshots(before, after)).toEqual(["tasks (1 rows → 1 rows)"]);
  });

  it("reports a table that gained a row", () => {
    const after = { tasks: [...before.tasks, '{"id":"2"}'], goals: [] };
    expect(diffSnapshots(before, after)[0]).toContain("tasks (1 rows → 2 rows)");
  });
});

describe("coverage report", () => {
  const exercised = (names: string[]) =>
    new Map(names.map((name) => [name, { calls: 1, attacks: ["probe"] }]));

  const listToolsStub = (names: string[]) => ({
    listTools: async () => ({ tools: names.map((name) => ({ name })) }),
  });

  it("passes when every registered tool has an entry", async () => {
    const reporter = stubReporter();
    await reportCoverage({
      mcpA: listToolsStub(["list_tasks", "create_task"]),
      exercised: exercised(["list_tasks", "create_task"]),
      reporter,
    });
    expect(reporter.checks.every((c) => c.ok)).toBe(true);
  });

  // The failure mode the whole table exists to prevent: a tool registered on
  // the server that nobody wrote an attack for.
  it("fails when the server registers a tool the matrix never calls", async () => {
    const reporter = stubReporter();
    const result = await reportCoverage({
      mcpA: listToolsStub(["list_tasks", "brand_new_tool"]),
      exercised: exercised(["list_tasks"]),
      reporter,
    });
    expect(result.uncovered).toEqual(["brand_new_tool"]);
    expect(
      reporter.checks.find((c) => c.label.includes("attack-table entry"))?.ok,
    ).toBe(false);
  });

  it("fails when the matrix names a tool the server no longer registers", async () => {
    const reporter = stubReporter();
    const result = await reportCoverage({
      mcpA: listToolsStub(["list_tasks"]),
      exercised: exercised(["list_tasks", "retired_tool"]),
      reporter,
    });
    expect(result.stale).toEqual(["retired_tool"]);
    expect(
      reporter.checks.find((c) => c.label.includes("does not register"))?.ok,
    ).toBe(false);
  });
});

describe("attack table", () => {
  it("gives every entry an attack description and either args or a skip reason", () => {
    for (const entry of TOOL_MATRIX) {
      expect(typeof entry.tool, JSON.stringify(entry)).toBe("string");
      expect(typeof entry.attack, entry.tool).toBe("string");
      if (!entry.skip) {
        expect(typeof entry.args, entry.tool).toBe("function");
        expect(typeof entry.assert, entry.tool).toBe("function");
      }
    }
  });

  it("never points an entry at the caller's own rows alone", () => {
    // Guards against an entry that quietly attacks A's own rows and therefore
    // proves nothing: any entry that reaches for one of A's ids must reach for
    // one of B's in the same call.
    const ctx = {
      a: Object.fromEntries(FIELDS.map((f) => [f, `A-${f}`])),
      b: Object.fromEntries(FIELDS.map((f) => [f, `B-${f}`])),
    };
    for (const entry of TOOL_MATRIX) {
      if (entry.skip) continue;
      const args = JSON.stringify(entry.args(ctx));
      if (!args.includes("A-")) continue;
      expect(args.includes("B-"), `${entry.tool}: ${entry.attack}`).toBe(true);
    }
  });
});

const FIELDS = [
  "marker",
  "groupId",
  "taskId",
  "recurringTaskId",
  "goalId",
  "itemId",
  "itemName",
  "inventoryGroupName",
  "accountId",
  "accountName",
  "categoryId",
  "changeId",
  "recurringExpenseId",
  "incomeSourceId",
  "spendLimitId",
  "courseId",
  "courseName",
  "courseSourceId",
  "sessionRef",
  "userId",
  "proposalId",
];
