import { describe, expect, test } from "vitest";

import {
  MODEL_CHOICES,
  appendSection,
  branchNameFor,
  clip,
  execPrompt,
  extractPlan,
  extractSection,
  ensureProxy,
  parseToolResult,
  parseTriage,
  pickBuildTasks,
  pickExecTasks,
  pickLifeTasks,
  pickPlanTasks,
  previewUrl,
  quoteArg,
  resolveModel,
  slugify,
  triagePrompt,
} from "../overnight/lib.mjs";

describe("slugify / branchNameFor", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Add Siri capture endpoint!")).toBe("add-siri-capture-endpoint");
  });

  test("caps length and never ends on a dash", () => {
    const slug = slugify("a".repeat(30) + " " + "b".repeat(30));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("falls back for empty/symbol-only titles", () => {
    expect(slugify("???")).toBe("task");
  });

  test("branch is ai/<slug>-<id prefix>", () => {
    expect(branchNameFor("Fix dock", "0f2a7c31-aaaa-bbbb")).toBe("ai/fix-dock-0f2a7c31");
  });
});

describe("clip / appendSection", () => {
  test("clip passes short text through untouched", () => {
    expect(clip("hello", 10)).toBe("hello");
  });

  test("clip truncates with a marker inside the cap", () => {
    const out = clip("x".repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("[truncated]")).toBe(true);
  });

  test("appends a dated section after user notes with a divider", () => {
    const out = appendSection("buy milk idea", "AI plan — 2026-07-16", "the plan");
    expect(out).toBe("buy milk idea\n\n---\n\n## AI plan — 2026-07-16\n\nthe plan");
  });

  test("no divider when notes were empty", () => {
    expect(appendSection(null, "AI plan", "p")).toBe("## AI plan\n\np");
    expect(appendSection("  ", "AI plan", "p")).toBe("## AI plan\n\np");
  });

  test("caps the total notes size, preserving what the user wrote", () => {
    const out = appendSection("user context", "AI plan", "y".repeat(20000), 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.startsWith("user context")).toBe(true);
    expect(out).toContain("[truncated]");
  });

  test("hard cap trims old notes but the new section always survives", () => {
    const out = appendSection("n".repeat(3000), "AI plan", "THE PLAN BODY", 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("## AI plan");
    expect(out).toContain("THE PLAN BODY");
    // the user's own text lives at the top and its start is kept
    expect(out.startsWith("n")).toBe(true);
  });
});

describe("previewUrl", () => {
  test("slugs the branch into the template", () => {
    expect(
      previewUrl("https://mindboard-git-{branch}-me.vercel.app", "ai/fix-dock-0f2a7c31"),
    ).toBe("https://mindboard-git-ai-fix-dock-0f2a7c31-me.vercel.app");
  });

  test("null without a template", () => {
    expect(previewUrl("", "ai/x")).toBeNull();
  });
});

describe("parseToolResult", () => {
  test("parses JSON text content", () => {
    const value = parseToolResult({
      content: [{ type: "text", text: '{"group":{"id":"g"},"tasks":[]}' }],
    });
    expect(value).toEqual({ group: { id: "g" }, tasks: [] });
  });

  test("returns raw text when not JSON", () => {
    expect(parseToolResult({ content: [{ type: "text", text: "done" }] })).toBe("done");
  });

  test("throws on isError results", () => {
    expect(() =>
      parseToolResult({ isError: true, content: [{ type: "text", text: "Error: nope" }] }),
    ).toThrow("nope");
  });
});

describe("task picking", () => {
  type Pickable = { id: string; title: string; ai_state: string | null };
  const tasks: Pickable[] = [
    { id: "1", title: "a", ai_state: null },
    { id: "2", title: "b", ai_state: "planned" },
    { id: "3", title: "c", ai_state: "approved" },
    { id: "4", title: "d", ai_state: null },
    { id: "5", title: "e", ai_state: "approved" },
    { id: "6", title: "f", ai_state: "failed" },
    { id: "7", title: "g", ai_state: "building" },
  ];

  test("plan queue is untouched tasks only, capped", () => {
    expect(pickPlanTasks(tasks, 1).map((t: Pickable) => t.id)).toEqual(["1"]);
    expect(pickPlanTasks(tasks, 5).map((t: Pickable) => t.id)).toEqual(["1", "4"]);
  });

  test("build queue is approved plus stale building claims — failed needs an explicit retry", () => {
    expect(pickBuildTasks(tasks, 5).map((t: Pickable) => t.id)).toEqual(["3", "5", "7"]);
  });
});

describe("extractPlan", () => {
  test("pulls the last AI plan section from the notes", () => {
    const notes = [
      "user idea",
      "",
      "---",
      "",
      "## AI plan — 2026-07-15",
      "",
      "old plan",
      "",
      "---",
      "",
      "## AI plan — 2026-07-16",
      "",
      "new plan line one",
      "line two",
    ].join("\n");
    expect(extractPlan(notes)).toBe("new plan line one\nline two");
  });

  test("stops at a following section divider", () => {
    const notes = "## AI plan — d\n\nthe plan\n\n---\n\n## AI build — d\n\nreport";
    expect(extractPlan(notes)).toBe("the plan");
  });

  test("a markdown horizontal rule inside the plan is content, not a divider", () => {
    const notes = "## AI plan — d\n\npart one\n\n---\n\npart two after an hr";
    expect(extractPlan(notes)).toBe("part one\n\n---\n\npart two after an hr");
  });

  test("null when no plan section exists", () => {
    expect(extractPlan("just notes")).toBeNull();
    expect(extractPlan(null)).toBeNull();
  });
});

describe("extractSection (Track B approach)", () => {
  test("reads the approach section independently of a plan section", () => {
    const notes =
      "idea\n\n---\n\n## AI plan — d\n\ncode plan\n\n---\n\n## AI approach — d\n\nresearch approach";
    expect(extractSection(notes, "AI approach")).toBe("research approach");
    expect(extractSection(notes, "AI plan")).toBe("code plan");
  });
});

describe("Track B task picking", () => {
  type Life = {
    id: string;
    title: string;
    status: string;
    ai_state: string | null;
    group_id: string | null;
    group_name?: string | null;
    notes?: string | null;
  };
  const CODE = "g-code";
  const tasks: Life[] = [
    { id: "1", title: "find apartment", status: "todo", ai_state: null, group_id: null },
    { id: "2", title: "mindboard idea", status: "todo", ai_state: null, group_id: CODE },
    { id: "3", title: "compare gyms", status: "todo", ai_state: "planned", group_id: "g-life" },
    { id: "4", title: "plan trip", status: "todo", ai_state: "approved", group_id: "g-life" },
    { id: "5", title: "done thing", status: "done", ai_state: null, group_id: null },
    { id: "6", title: "take out trash", status: "todo", ai_state: null, group_id: null },
    { id: "7", title: "stale claim", status: "todo", ai_state: "building", group_id: "g-life" },
    { id: "8", title: "approved code", status: "todo", ai_state: "approved", group_id: CODE },
  ];

  test("pickLifeTasks: untouched, open, non-code, not cached infeasible", () => {
    const cache = { "6": { title: "take out trash", reason: "reminder" } };
    expect(pickLifeTasks(tasks, CODE, cache).map((t: Life) => t.id)).toEqual(["1"]);
  });

  test("pickLifeTasks: a retitled task escapes the infeasible cache", () => {
    const cache = { "6": { title: "old title", reason: "reminder" } };
    expect(pickLifeTasks(tasks, CODE, cache).map((t: Life) => t.id)).toEqual(["1", "6"]);
  });

  test("pickExecTasks: approved + stale building, never code-group tasks, capped", () => {
    expect(pickExecTasks(tasks, CODE, 5).map((t: Life) => t.id)).toEqual(["4", "7"]);
    expect(pickExecTasks(tasks, CODE, 1).map((t: Life) => t.id)).toEqual(["4"]);
  });
});

describe("parseTriage", () => {
  const ids = ["a", "b", "c"];

  test("parses a clean array and keeps only valid entries", () => {
    const text = JSON.stringify([
      { id: "a", feasible: true, approach: "research it" },
      { id: "b", feasible: false, reason: "physical task" },
      { id: "zzz", feasible: true, approach: "unknown id" },
      { id: "c", feasible: true }, // feasible without approach → dropped
    ]);
    const parsed = parseTriage(text, ids);
    expect(parsed?.map((v: { id: string }) => v.id)).toEqual(["a", "b"]);
  });

  test("tolerates prose and code fences around the array", () => {
    const text = 'Here you go:\n```json\n[{"id":"a","feasible":false,"reason":"r"}]\n```';
    expect(parseTriage(text, ids)?.length).toBe(1);
  });

  test("bracketed prose after the array does not break the parse", () => {
    const text =
      '[{"id":"a","feasible":true,"approach":"look [into] it"}]\n\nLet me know [if you need more].';
    const parsed = parseTriage(text, ids);
    expect(parsed?.length).toBe(1);
    expect(parsed?.[0].approach).toBe("look [into] it");
  });

  test("null on garbage", () => {
    expect(parseTriage("no json here", ids)).toBeNull();
    expect(parseTriage('["not-an-object"]', ids)).toEqual([]);
  });
});

describe("Track B prompts", () => {
  test("triage prompt carries ids, notes excerpt, and the manifest", () => {
    const prompt = triagePrompt(
      [{ id: "t1", title: "find apartment", group_name: null, notes: "2 bed, near campus" }],
      "MANIFEST BODY",
    );
    expect(prompt).toContain("id: t1");
    expect(prompt).toContain("2 bed, near campus");
    expect(prompt).toContain("MANIFEST BODY");
    expect(prompt).toContain("ONLY a JSON array");
  });

  test("exec prompt embeds the hard rules and the approved approach", () => {
    const prompt = execPrompt({ title: "find apartment", notes: null }, "compare listings");
    expect(prompt).toContain("never submit, send, purchase");
    expect(prompt).toContain("compare listings");
  });
});

describe("resolveModel", () => {
  test("maps choices to CLI models", () => {
    expect(resolveModel("fable-5", false)).toMatchObject({ id: "fable-5", model: "fable" });
    expect(resolveModel("opus-4.8", false)).toMatchObject({ id: "opus-4.8", model: "opus" });
    expect(resolveModel("gpt-5.6-sol", true)).toMatchObject({
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      proxy: true,
    });
  });

  test("proxy model with the proxy down degrades to opus, flagged", () => {
    expect(resolveModel("gpt-5.6-sol", false)).toMatchObject({
      id: "opus-4.8",
      model: "opus",
      fellBack: true,
    });
  });

  test("unknown ids take the phase default", () => {
    expect(resolveModel("gpt-9000", false, "fable-5").id).toBe("fable-5");
    expect(resolveModel(null, true, "gpt-5.6-sol").id).toBe("gpt-5.6-sol");
  });

  test("choice ids stay in sync with the app's whitelist", () => {
    expect(Object.keys(MODEL_CHOICES).sort()).toEqual(
      ["fable-5", "gpt-5.6-sol", "opus-4.8"].sort(),
    );
  });
});

describe("ensureProxy", () => {
  test("returns immediately when the proxy is reachable", async () => {
    let starts = 0;
    const reachable = await ensureProxy({
      proxyUrl: "http://proxy.test",
      fetchImpl: async () => ({ ok: true }),
      startProxy: async () => {
        starts += 1;
      },
    });
    expect(reachable).toBe(true);
    expect(starts).toBe(0);
  });

  test("starts a configured proxy and checks it again", async () => {
    let checks = 0;
    let starts = 0;
    const reachable = await ensureProxy({
      proxyUrl: "http://proxy.test",
      proxyExe: "proxy.exe",
      fetchImpl: async () => ({ ok: ++checks > 1 }),
      startProxy: async () => {
        starts += 1;
      },
      wait: async () => {},
    });
    expect(reachable).toBe(true);
    expect(starts).toBe(1);
    expect(checks).toBe(2);
  });
});

describe("quoteArg", () => {
  test("leaves simple tokens bare", () => {
    expect(quoteArg("--max-turns")).toBe("--max-turns");
    expect(quoteArg("origin/main")).toBe("origin/main");
  });

  test("quotes spaces and cmd specials", () => {
    expect(quoteArg("Bash(npm run lint)")).toBe('"Bash(npm run lint)"');
    expect(quoteArg('say "hi"')).toBe('"say ""hi"""');
  });
});
