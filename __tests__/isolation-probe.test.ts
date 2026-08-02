import { describe, expect, it } from "vitest";

import { leakNeedles, scanForLeak, stringLeaves } from "../test/isolation/harness.mjs";
import { diffSnapshots } from "../test/isolation/seed.mjs";
import { reportCoverage } from "../test/isolation/mcp-probe.mjs";
import { TOOL_MATRIX } from "../test/isolation/tool-matrix.mjs";
import { FORGERIES } from "../test/isolation/forged-proposal.mjs";
import { validateResolvedFinanceOps } from "@/app/lib/mcp/finance-ops";
import { validateResolvedOps } from "@/app/lib/mcp/inventory-ops";

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
    dailyNote: "zzpaaab-daily-note",
  };
  const needles = leakNeedles(b);

  it("builds a needle for every seeded value", () => {
    expect(needles.map((n) => n.label).sort()).toEqual([
      "B marker",
      "B.accountName",
      "B.dailyNote",
      "B.taskId",
    ]);
  });

  it("flags a response that contains the victim's data", () => {
    const leaked = scanForLeak(JSON.stringify([{ id: b.taskId, name: b.accountName }]), needles, []);
    expect(leaked).toContain("B.taskId");
    expect(leaked).toContain("B.accountName");
  });

  it("does not flag an id the attacker supplied in the request", () => {
    const leaked = scanForLeak(`Error: task ${b.taskId} not found`, needles, [b.taskId]);
    expect(leaked).toEqual([]);
  });

  it("still flags data resolved FROM an id the attacker supplied", () => {
    const leaked = scanForLeak(
      JSON.stringify({ taskId: b.taskId, account: b.accountName }),
      needles,
      [b.taskId],
    );
    expect(leaked).toContain("B.accountName");
    expect(leaked).not.toContain("B.taskId");
  });

  // The regression this scanner nearly shipped with: the run marker prefixes
  // every one of B's names, so a per-needle subtraction would let ONE request
  // mentioning a marker-bearing string blind the scanner to every other B
  // string. Occurrence-level subtraction has to keep the unrelated hits.
  it("a sent superstring does not blind the scanner to other occurrences", () => {
    const leaked = scanForLeak(
      JSON.stringify({ echoed: b.accountName, leaked: b.dailyNote }),
      needles,
      [b.accountName],
    );
    expect(leaked).toContain("B.dailyNote");
    // The marker occurs inside the leaked note too, so it must fire as well.
    expect(leaked).toContain("B marker");
  });

  it("a sent substring does not mask a longer needle that contains it", () => {
    const leaked = scanForLeak(JSON.stringify({ item: b.accountName }), needles, [b.marker]);
    expect(leaked).toContain("B.accountName");
  });

  // Deliberate: an echo is an echo however many times it appears ("no item
  // matches 'X'; candidates for 'X': none" is one error message, not a leak).
  // Safety comes from every B string having its own needle, not from counting.
  it("does not flag a string the request sent, however often it is echoed", () => {
    const leaked = scanForLeak(`no match for ${b.marker}; tried ${b.marker}`, needles, [b.marker]);
    expect(leaked).toEqual([]);
  });

  it("passes a clean response", () => {
    expect(scanForLeak(JSON.stringify([{ id: "other" }]), needles, [])).toEqual([]);
  });

  it("collects every string the request supplied, at any depth", () => {
    expect(
      stringLeaves({ operations: [{ item: "a", amount: 3 }, { item: "b" }], flag: true }).sort(),
    ).toEqual(["a", "b"]);
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

describe("forged-proposal table", () => {
  // The discipline the tools/list coverage check enforces, applied to the
  // executors: an entry without a control is an entry whose refusal proves
  // nothing, because a drifted op shape fails validation before the ownership
  // guard and still reads as "refused".
  it("gives every executor entry a control and both verifiers", () => {
    expect(FORGERIES.length).toBeGreaterThan(0);
    for (const entry of FORGERIES) {
      expect(typeof entry.tool, JSON.stringify(entry)).toBe("string");
      expect(typeof entry.what, entry.tool).toBe("string");
      for (const field of ["victim", "control", "verifyVictim", "verifyControl"]) {
        expect(typeof entry[field], `${entry.tool} is missing ${field}`).toBe("function");
      }
    }
  });

  it("aims every victim at B and every control at A's scratch fixtures", () => {
    const ctx = {
      a: Object.fromEntries(FIELDS.map((f) => [f, `A-${f}`])),
      b: Object.fromEntries(FIELDS.map((f) => [f, `B-${f}`])),
    };
    const scratch = new Proxy(
      { marker: "S-marker" },
      { get: (t, k) => (k in t ? t[k as string] : `S-${String(k)}`) },
    );
    for (const entry of FORGERIES) {
      const victim = JSON.stringify(entry.victim(ctx));
      expect(victim.includes("B-"), `${entry.tool} victim must reference B`).toBe(true);
      expect(victim.includes("A-"), `${entry.tool} victim must not reference A`).toBe(false);

      const control = JSON.stringify(entry.control(ctx, scratch));
      expect(control.includes("S-"), `${entry.tool} control must use a scratch row`).toBe(true);
      expect(control.includes("B-"), `${entry.tool} control must not reference B`).toBe(false);
    }
  });

  // The concrete drift this file's control exists to catch, pinned against the
  // real validators so it cannot regress silently. The FIRST version of the
  // forged update_finance op used {kind, changeId, summary}; the executor
  // requires {kind, changeId, accountId, label}, so it was rejected as
  // malformed BEFORE any ownership check and the "refused" check passed
  // vacuously. These assert the validators still draw that line, and that the
  // shapes now in FORGERIES land on the accepted side of it.
  it("rejects the drifted update_finance shape that made the old forgery vacuous", () => {
    const drifted = validateResolvedFinanceOps({
      operations: [{ kind: "remove", changeId: "c1", summary: "forged remove" }],
    });
    expect(drifted.ok).toBe(false);

    const corrected = validateResolvedFinanceOps({
      operations: [
        { kind: "remove", changeId: "c1", accountId: "a1", label: "forged remove" },
      ],
    });
    expect(corrected.ok).toBe(true);
  });

  it("accepts the resolved-op shapes the forgeries actually send", () => {
    const ctx = {
      a: Object.fromEntries(FIELDS.map((f) => [f, `A-${f}`])),
      b: Object.fromEntries(FIELDS.map((f) => [f, `B-${f}`])),
    };
    const finance = FORGERIES.find((f) => f.tool === "update_finance");
    const stock = FORGERIES.find((f) => f.tool === "update_stock");
    expect(validateResolvedFinanceOps(finance!.victim(ctx)).ok).toBe(true);
    expect(validateResolvedOps(stock!.victim(ctx)).ok).toBe(true);
  });

  it("keeps victim and control structurally identical", () => {
    // A control that does not mirror the victim's shape cannot vouch for it.
    const ctx = {
      a: Object.fromEntries(FIELDS.map((f) => [f, `A-${f}`])),
      b: Object.fromEntries(FIELDS.map((f) => [f, `B-${f}`])),
    };
    const scratch = new Proxy(
      { marker: "S-marker" },
      { get: (t, k) => (k in t ? t[k as string] : `S-${String(k)}`) },
    );
    const shape = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(shape);
      if (v && typeof v === "object") {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, val]) => [k, shape(val)]),
        );
      }
      return typeof v;
    };
    for (const entry of FORGERIES) {
      expect(shape(entry.control(ctx, scratch)), `${entry.tool} control/victim shape`).toEqual(
        shape(entry.victim(ctx)),
      );
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
