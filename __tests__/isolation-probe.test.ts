import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertSafeTarget,
  leakNeedles,
  probeEnv,
  PRODUCTION_PROJECT_REF,
  scanForLeak,
  stringLeaves,
} from "../test/isolation/harness.mjs";
import { diffSnapshots, OWNED_TABLES } from "../test/isolation/seed.mjs";
import { reportCoverage } from "../test/isolation/mcp-probe.mjs";
import {
  BLIND_SPOTS,
  CONDITIONAL_TOOLS,
  DECLARED_SKIPS,
  TOOL_MATRIX,
} from "../test/isolation/tool-matrix.mjs";
import { FORGERIES } from "../test/isolation/forged-proposal.mjs";
import { validateResolvedFinanceOps } from "@/app/lib/mcp/finance-ops";
import { validateResolvedOps } from "@/app/lib/mcp/inventory-ops";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

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

// The probe writes to whatever project it is pointed at: two real auth users
// and ~45 seeded tables. The rail that stops that being production is the one
// piece of this whole net that MUST be tested in CI, because by the time it
// matters it is too late to test it by hand.
describe("safety rail", () => {
  const LOCAL = "http://127.0.0.1:54321";
  const BRANCH = "https://abcdefghijklmnopqrst.supabase.co";
  const PROD = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;

  it("refuses the production project, whatever the target says", () => {
    for (const target of ["local", "branch", "anything", undefined]) {
      expect(() => assertSafeTarget(PROD, target, {})).toThrow(/production project/i);
    }
  });

  it("refuses the production ref even dressed up as a local URL", () => {
    // A tunnel, a hosts entry, a proxy: the ref is the thing that identifies
    // the database, not the scheme or the port.
    expect(() =>
      assertSafeTarget(`http://localhost:54321/${PRODUCTION_PROJECT_REF}`, "local", {}),
    ).toThrow(/production project/i);
  });

  it("refuses to guess the target", () => {
    for (const target of [undefined, "", "prod", "production", "LOCAL", true]) {
      expect(() => assertSafeTarget(LOCAL, target as never, {})).toThrow(
        /MINDBOARD_PROBE_TARGET/,
      );
    }
  });

  it("checks the host against the word", () => {
    // "local" pointed at a hosted project is the mistake that matters: it is
    // not production, so the ref check passes, and it is still someone's
    // real data.
    expect(() => assertSafeTarget(BRANCH, "local", {})).toThrow(/not a local address/);
    expect(() => assertSafeTarget(LOCAL, "branch", {})).toThrow(/not a Supabase-hosted/);
  });

  it("accepts a local stack and a Supabase branch", () => {
    expect(assertSafeTarget(LOCAL, "local", {})).toEqual({ target: "local", host: "127.0.0.1" });
    expect(assertSafeTarget("http://localhost:54321", "local", {})).toMatchObject({
      target: "local",
    });
    // supabase start inside Docker on a LAN address.
    expect(assertSafeTarget("http://192.168.1.40:54321", "local", {})).toMatchObject({
      target: "local",
    });
    expect(assertSafeTarget(BRANCH, "branch", {})).toMatchObject({ target: "branch" });
  });

  it("takes extra forbidden refs from the environment, and cannot be made to drop the built-in one", () => {
    const env = { MINDBOARD_PROBE_FORBIDDEN_REFS: "zzzzzzzzzzzzzzzzzzzz, qqqqqqqqqqqqqqqqqqqq" };
    expect(() =>
      assertSafeTarget("https://zzzzzzzzzzzzzzzzzzzz.supabase.co", "branch", env),
    ).toThrow(/production project/i);
    expect(() => assertSafeTarget(PROD, "branch", { MINDBOARD_PROBE_FORBIDDEN_REFS: "" })).toThrow(
      /production project/i,
    );
  });

  it("rejects a missing or malformed URL rather than passing it through", () => {
    expect(() => assertSafeTarget("", "local", {})).toThrow(/no Supabase URL/);
    expect(() => assertSafeTarget("not-a-url", "local", {})).toThrow(/not a URL/);
  });

  it("reads config from the environment and never from .env.local", () => {
    const src = read("test/isolation-proof.mjs");
    // The specific construct, not the word: the header explains WHY it does
    // not read that file, and a test that bans the word would ban the
    // explanation along with the defect.
    expect(src, "the runner must not default to the checkout's env file").not.toMatch(
      /["'`][.\/]*\.env\.local["'`]/,
    );
    expect(src, "loadEnv is the file reader; the runner takes process env").not.toContain(
      "loadEnv(",
    );
    expect(src).toContain("probeEnv()");
    expect(src).toContain("assertSafeTarget(");
    // An explicit process variable must win over a loaded file, so a one-off
    // override needs no edit.
    expect(probeEnv({ FOO: "bar" }).FOO).toBe("bar");
    expect(probeEnv({ FOO: "" }).FOO).toBeUndefined();
  });

  it("is wired to an npm script", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:isolation"]).toBe("node test/isolation-proof.mjs");
  });
});

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

// The live probe needs a dev server, a seeded database and two throwaway
// tenants, so its coverage checks only ever run when someone chooses to run it.
// These read the same two source files the probe measures itself against and
// assert the coverage claims statically, in plain `npm run test` — which is
// what makes "every tool, every executor" a gate rather than a sentence in a
// commit message.
describe("coverage, checked against the source rather than a live server", () => {
  const registeredTools = (): string[] => {
    const src = read("app/api/mcp/[transport]/route.ts");
    return [...src.matchAll(/registerTool\(\s*\n\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
  };

  const executorKeys = (): string[] => {
    const src = read("app/lib/mcp/writes.ts");
    const block = src.slice(src.indexOf("export const EXECUTORS"));
    const body = block.slice(block.indexOf("> = {") + 5, block.indexOf("\n};"));
    return [...body.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]).sort();
  };

  it("finds the tool and executor tables it is measuring", () => {
    // If either parser silently returns nothing, every assertion below passes
    // vacuously. Pin plausible floors so a refactor that moves these tables
    // fails loudly here instead.
    expect(registeredTools().length).toBeGreaterThan(60);
    expect(executorKeys().length).toBeGreaterThan(20);
  });

  it("has an attack-table entry for every tool the MCP route registers", () => {
    const covered = new Set<string>(TOOL_MATRIX.map((e: { tool: string }) => e.tool));
    const uncovered = registeredTools().filter(
      (name) => !covered.has(name) && !DECLARED_SKIPS[name],
    );
    expect(uncovered, "tools with no entry in test/isolation/tool-matrix.mjs").toEqual([]);
  });

  it("names no tool the MCP route does not register", () => {
    const live = new Set(registeredTools());
    const stale = [...new Set<string>(TOOL_MATRIX.map((e: { tool: string }) => e.tool))]
      .filter((name) => !live.has(name))
      .sort();
    // CONDITIONAL_TOOLS are registered behind an env check but are still in the
    // source, so they are NOT exempt here — only at runtime.
    expect(stale, "attack-table entries for tools that no longer exist").toEqual([]);
  });

  it("has a forged-proposal control for every confirm_action executor", () => {
    const covered = new Set<string>(FORGERIES.map((f: { tool: string }) => f.tool));
    const uncovered = executorKeys().filter((name) => !covered.has(name));
    expect(uncovered, "executors with no entry in test/isolation/forged-proposal.mjs").toEqual([]);
  });

  it("names no executor that EXECUTORS does not have", () => {
    // This is the check that catches the complete_recurring_task /
    // complete_recurring trap: confirmAction looks the tool up by
    // EXECUTORS[tool_name], so a forgery keyed on the MCP tool name would be
    // rejected as "unknown tool" and its refusal would prove nothing.
    const keys = new Set(executorKeys());
    const unknown = [...new Set<string>(FORGERIES.map((f: { tool: string }) => f.tool))]
      .filter((name) => !keys.has(name))
      .sort();
    expect(unknown, "forgeries keyed on something EXECUTORS cannot resolve").toEqual([]);
  });

  it("declares every tool it cannot really test, and nothing else", () => {
    const live = new Set(registeredTools());
    for (const name of Object.keys(BLIND_SPOTS)) {
      expect(live.has(name), `BLIND_SPOTS names ${name}, which is not registered`).toBe(true);
    }
    for (const name of Object.keys(CONDITIONAL_TOOLS)) {
      expect(live.has(name), `CONDITIONAL_TOOLS names ${name}, which is not registered`).toBe(true);
    }
  });

  it("snapshots every user-scoped table a migration creates", () => {
    // OWNED_TABLES is what "nothing of B's changed" can see; a table missing
    // from it is a blind spot in the strongest assertion the probe makes.
    const migrations = read("supabase/migrations/0001_init.sql");
    expect(migrations).toContain("create table public.tasks");

    const owned = new Set<string>(OWNED_TABLES);
    for (const table of [
      "people",
      "people_groups",
      "person_interactions",
      "person_mention_candidates",
      "task_dispatches",
      "urc_devices",
      "urc_jobs",
      "urc_log",
      "ai_conversations",
      "ai_messages",
    ]) {
      expect(owned.has(table), `OWNED_TABLES is missing ${table}`).toBe(true);
    }
    expect(new Set(OWNED_TABLES).size, "OWNED_TABLES has a duplicate").toBe(OWNED_TABLES.length);
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

  // The vocabulary is small on purpose: every weakening of "the control
  // applies" has to be spelled out as one of three named shapes, so a reader
  // can count how many entries are the strong kind without reading the bodies.
  it("declares a known outcome, and spells out any weaker one with a regex", () => {
    for (const entry of FORGERIES) {
      const outcome = entry.outcome ?? "applies";
      if (outcome === "applies") continue;
      expect(typeof outcome, `${entry.tool} outcome`).toBe("object");
      const keys = Object.keys(outcome);
      expect(keys.length, `${entry.tool} outcome must name exactly one shape`).toBe(1);
      expect(["reaches", "gate"], `${entry.tool} outcome key`).toContain(keys[0]);
      expect(outcome[keys[0]], `${entry.tool} outcome must carry a RegExp`).toBeInstanceOf(RegExp);
    }
  });

  // Guards the headline number: if someone downgrades an entry to a gate to
  // make a red check green, this count moves and the diff shows it.
  it("keeps the weaker outcomes to the executors that genuinely need them", () => {
    const weaker = FORGERIES.filter(
      (e: { outcome?: unknown }) => e.outcome !== undefined && e.outcome !== "applies",
    ).map((e: { tool: string }) => e.tool);
    expect(weaker.sort()).toEqual(
      // create_event / reschedule_event have no Mindboard row to own — their
      // boundary is the caller's Google credential. generate_audio_overview
      // cannot finish without a paid key. spawn_urc is refused by the owner
      // gate for any tenant this probe can create.
      ["create_event", "generate_audio_overview", "reschedule_event", "spawn_urc"],
    );
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
      // log_daily and update_settings upsert on the caller's own user_id and
      // take no foreign id at all, so there is nothing to aim at B. Their
      // victim check lives in verifyVictim (B's row never moved) instead.
      if (entry.noForeignRef) {
        expect(typeof entry.verifyVictim, `${entry.tool} still needs a victim verifier`).toBe(
          "function",
        );
        continue;
      }
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
  "groupName",
  "taskId",
  "taskTitle",
  "recurringTaskId",
  "recurringTaskTitle",
  "goalId",
  "dailyLogId",
  "dailyNote",
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
  // people (0047/0048/0049)
  "personId",
  "personName",
  "peopleGroupId",
  // agent hand-off (0051)
  "dispatchId",
  // URC (0054/0055)
  "urcDeviceId",
  "urcJobId",
  "urcFolderKey",
  // decoys (victim-only credentials)
  "googleAccessToken",
  "shoppingStore",
  "timezone",
  "userId",
  "proposalId",
];
