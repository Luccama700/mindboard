import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

import {
  buildPersonaReport,
  createStepBudget,
  dedupeFindings,
  parseActionJson,
  runPersonaScenario,
} from "../overnight/persona/lib.mjs";

describe("parseActionJson", () => {
  test("parses a fenced click action and clamps attention", () => {
    expect(
      parseActionJson('result:\n```json\n{"action":"click","target":4,"attention":120,"reason":"next"}\n```'),
    ).toEqual({
      action: "click",
      target: 4,
      attention: 100,
      observation: "",
      reason: "next",
    });
  });

  test("parses finish findings and drops ungrounded entries", () => {
    const action = parseActionJson(
      JSON.stringify({
        action: "finish",
        outcome: "bored",
        attention: 12,
        summary: "too much setup",
        findings: [
          {
            title: "Intro is too long",
            severity: "high",
            evidence: "I quit after three cards.",
            suggestion: "Show the board sooner.",
          },
          { title: "Missing evidence" },
        ],
      }),
    );

    expect(action?.action).toBe("finish");
    expect(action?.findings).toHaveLength(1);
    expect(action?.findings[0]).toMatchObject({ title: "Intro is too long", severity: "high" });
  });

  test("rejects unsafe or malformed actions", () => {
    expect(parseActionJson('{"action":"type","target":1}')).toBeNull();
    expect(parseActionJson('{"action":"click","target":0}')).toBeNull();
    expect(parseActionJson("not json")).toBeNull();
  });
});

describe("createStepBudget", () => {
  test("never allocates more than the cap", () => {
    const budget = createStepBudget(2);
    expect(budget.take()).toMatchObject({ step: 1, remaining: 1, limit: 2 });
    expect(budget.take()).toMatchObject({ step: 2, remaining: 0, limit: 2 });
    expect(budget.take()).toBeNull();
    expect(budget.snapshot()).toEqual({ used: 2, remaining: 0, limit: 2 });
  });

  test("normalizes invalid caps to one step", () => {
    const budget = createStepBudget(0);
    expect(budget.take()?.limit).toBe(1);
    expect(budget.take()).toBeNull();
  });
});

describe("runPersonaScenario dry adapter", () => {
  test("executes stub replies and exits without exceeding the shared budget", async () => {
    const budget = createStepBudget(4);
    const replies = [
      '{"action":"click","target":1,"attention":70,"reason":"continue"}',
      JSON.stringify({
        action: "finish",
        outcome: "bored",
        attention: 15,
        summary: "I stopped.",
        findings: [
          {
            title: "The useful screen arrives too late",
            severity: "high",
            evidence: "The run stopped after one onboarding click.",
            suggestion: "Add a visible skip.",
          },
        ],
      }),
    ];
    const acted: string[] = [];
    let index = 0;

    const result = await runPersonaScenario({
      scenario: { id: "stub", title: "Stub", goal: "Reach the board" },
      budget,
      observe: async ({ turn }) => ({
        authExpired: false,
        url: `http://test/${turn.step}`,
        screenshot: `step-${turn.step}.png`,
        elements: [{ id: 1, role: "button", label: "next" }],
      }),
      decide: async () => replies[index++],
      act: async (action) => acted.push(action.action),
    });

    expect(acted).toEqual(["click"]);
    expect(result.outcome).toBe("bored");
    expect(result.findings[0]).toMatchObject({ scenario: "stub", step: 2 });
    expect(budget.snapshot()).toEqual({ used: 2, remaining: 2, limit: 4 });
  });

  test("returns step_limit when the model never finishes", async () => {
    const result = await runPersonaScenario({
      scenario: { id: "loop", title: "Loop", goal: "Keep going" },
      budget: createStepBudget(2),
      observe: async ({ turn }) => ({
        authExpired: false,
        url: `http://test/${turn.step}`,
        elements: [],
      }),
      decide: async () => '{"action":"wait","milliseconds":250,"attention":50}',
      act: async () => {},
    });

    expect(result.outcome).toBe("step_limit");
    expect(result.transcript).toHaveLength(2);
  });
});

describe("persona CLI dry run", () => {
  test("runs end to end with built-in stub model replies", () => {
    const result = spawnSync(process.execPath, ["overnight/persona/run.mjs", "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Persona onboarding audit");
    expect(result.stdout).toContain("dry run complete: 2 scenarios");
  });
});

describe("persona reporting", () => {
  test("deduplicates repeated findings and renders the attention trace", () => {
    const finding = {
      title: "Too much copy",
      evidence: "The tester skimmed three cards.",
      suggestion: "Cut a card.",
      severity: "medium",
      scenario: "first-minute",
      step: 3,
    };
    const findings = dedupeFindings([finding, { ...finding }]);
    const report = buildPersonaReport({
      date: "2026-07-17",
      model: "gpt-5.6-sol",
      url: "http://localhost:3000",
      results: [
        {
          scenario: { title: "First minute" },
          outcome: "bored",
          summary: "quit",
          findings,
          transcript: [{ step: 1, action: "click", attention: 45, reason: "looking for skip" }],
        },
      ],
      findings,
    });

    expect(findings).toHaveLength(1);
    expect(report).toContain("attention 45/100");
    expect(report).toContain("[medium] Too much copy");
  });
});
