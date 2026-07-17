import { describe, expect, test } from "vitest";

import {
  appendSection,
  branchNameFor,
  clip,
  extractPlan,
  parseToolResult,
  pickBuildTasks,
  pickPlanTasks,
  previewUrl,
  quoteArg,
  slugify,
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
