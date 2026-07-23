import { describe, expect, it } from "vitest";

import { classifyItem, buildMatchers, classifyItems } from "@/app/lib/mindspace/classify";
import {
  buildMindspaceView,
  countWords,
  readingMinutes,
} from "@/app/lib/mindspace/aggregate";
import { buildSeedCandidates } from "@/app/lib/mindspace/seed";
import type {
  ClassifiedItem,
  MindspaceItem,
  MindspaceTopic,
} from "@/app/lib/mindspace/types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);

function topic(overrides: Partial<MindspaceTopic>): MindspaceTopic {
  return {
    id: "t1",
    name: "Emma",
    kind: "person",
    description: null,
    aliases: [],
    seedVaultPath: null,
    seedGroupId: null,
    status: "active",
    pinned: false,
    color: null,
    ...overrides,
  };
}

function item(overrides: Partial<MindspaceItem>): MindspaceItem {
  return {
    source: "capture",
    ref: "x",
    title: "untitled",
    href: null,
    occurredAt: NOW - DAY,
    mass: 10,
    wordCount: 100,
    text: "",
    frontmatterTopics: [],
    wikilinkPaths: [],
    groupId: null,
    ...overrides,
  };
}

describe("classifyItem", () => {
  it("matches frontmatter topics case-insensitively", () => {
    const matchers = buildMatchers([topic({ id: "emma" })]);
    const labels = classifyItem(
      item({ frontmatterTopics: ["emma", "wellbeing"] }),
      matchers,
    );
    expect(labels).toEqual([{ topicId: "emma", weight: 1 }]);
  });

  it("matches a wikilink to the topic's seed page", () => {
    const matchers = buildMatchers([
      topic({ id: "emma", seedVaultPath: "People/Emma.md" }),
    ]);
    const labels = classifyItem(
      item({ wikilinkPaths: ["People/Emma.md"], title: "a rough sunday" }),
      matchers,
    );
    expect(labels).toEqual([{ topicId: "emma", weight: 1 }]);
  });

  it("matches a task to its group topic", () => {
    const matchers = buildMatchers([
      topic({ id: "bb", name: "Best Buy Shifts", seedGroupId: "g1" }),
    ]);
    const labels = classifyItem(
      item({ source: "task", groupId: "g1", title: "close the register" }),
      matchers,
    );
    expect(labels).toEqual([{ topicId: "bb", weight: 1 }]);
  });

  it("weights structured hits above free-text body hits", () => {
    const matchers = buildMatchers([
      topic({ id: "emma" }),
      topic({ id: "mb", name: "Mindboard" }),
    ]);
    const labels = classifyItem(
      item({
        frontmatterTopics: ["Emma"],
        text: "shipped a mindboard migration then talked for hours",
      }),
      matchers,
    );
    const emma = labels.find((l) => l.topicId === "emma")!;
    const mb = labels.find((l) => l.topicId === "mb")!;
    expect(emma.weight).toBeGreaterThan(mb.weight);
    expect(emma.weight + mb.weight).toBeCloseTo(1);
  });

  it("requires word boundaries for name matches", () => {
    const matchers = buildMatchers([topic({ id: "emma" })]);
    expect(
      classifyItem(item({ text: "a dilemma about dinner" }), matchers),
    ).toEqual([]);
    expect(
      classifyItem(item({ text: "talked with emma about dinner" }), matchers),
    ).toHaveLength(1);
  });

  it("skips terms shorter than three characters", () => {
    const matchers = buildMatchers([
      topic({ id: "ea", name: "EA", aliases: [] }),
    ]);
    expect(classifyItem(item({ text: "ea sports" }), matchers)).toEqual([]);
  });

  it("matches aliases in titles", () => {
    const matchers = buildMatchers([
      topic({ id: "bb", name: "Best Buy Shifts", aliases: ["best buy"] }),
    ]);
    const labels = classifyItem(
      item({ title: "Best Buy schedule for next week" }),
      matchers,
    );
    expect(labels).toEqual([{ topicId: "bb", weight: 1 }]);
  });

  it("ignores archived topics", () => {
    const matchers = buildMatchers([
      topic({ id: "emma", status: "archived" }),
    ]);
    expect(
      classifyItem(item({ frontmatterTopics: ["Emma"] }), matchers),
    ).toEqual([]);
  });
});

describe("buildMindspaceView", () => {
  const topics = [
    topic({ id: "emma" }),
    topic({ id: "mb", name: "Mindboard" }),
    topic({ id: "quiet", name: "Quiet Topic" }),
  ];

  function classified(
    topicId: string | null,
    mass: number,
    ageDays: number,
  ): ClassifiedItem {
    return {
      ...item({ mass, occurredAt: NOW - ageDays * DAY, ref: `${topicId}-${ageDays}-${mass}` }),
      labels: topicId ? [{ topicId, weight: 1 }] : [],
    };
  }

  it("computes shares over the window's total mass", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) =>
        classified("emma", 30, 1 + (i % 2)),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        classified("mb", 10, 1 + (i % 2)),
      ),
    ];
    const view = buildMindspaceView(items, topics, NOW);
    const week = view.windows[1];
    expect(week.sparse).toBe(false);
    const emma = week.shares.find((s) => s.topicId === "emma")!;
    expect(emma.share).toBeCloseTo(180 / 240);
    expect(week.shares[0].topicId).toBe("emma");
  });

  it("folds sub-threshold topics unless pinned and keeps muted mass in the denominator", () => {
    const manyTopics = [
      topic({ id: "big", name: "Big" }),
      topic({ id: "tiny", name: "Tiny" }),
      topic({ id: "muted", name: "Muted", status: "muted" }),
    ];
    const items = [
      ...Array.from({ length: 10 }, (_, i) => classified("big", 96, 1 + (i % 5))),
      classified("tiny", 10, 2),
      classified("muted", 30, 2),
    ];
    const view = buildMindspaceView(items, manyTopics, NOW);
    const week = view.windows[1];
    expect(week.shares.map((s) => s.topicId)).toEqual(["big"]);
    expect(week.foldedShare).toBeCloseTo(10 / 1000);
    expect(week.mutedShare).toBeCloseTo(30 / 1000);
    const big = week.shares[0];
    expect(big.share).toBeCloseTo(960 / 1000);

    const pinnedView = buildMindspaceView(
      items,
      [
        manyTopics[0],
        topic({ id: "tiny", name: "Tiny", pinned: true }),
        manyTopics[2],
      ],
      NOW,
    );
    expect(
      pinnedView.windows[1].shares.some((s) => s.topicId === "tiny"),
    ).toBe(true);
  });

  it("tracks unclassified mass separately", () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) => classified("emma", 10, 1 + (i % 3))),
      ...Array.from({ length: 4 }, (_, i) => classified(null, 20, 1 + (i % 3))),
    ];
    const view = buildMindspaceView(items, topics, NOW);
    const week = view.windows[1];
    expect(week.unclassifiedShare).toBeCloseTo(80 / 160);
  });

  it("marks sparse windows and reports trends from 3d vs 30d shares", () => {
    const items = [
      // Emma: all mass in the last 2 days → rising.
      ...Array.from({ length: 6 }, (_, i) => classified("emma", 60, i % 2)),
      // Mindboard: mass only 10-25 days ago → fading.
      ...Array.from({ length: 6 }, (_, i) => classified("mb", 60, 10 + i * 3)),
    ];
    const view = buildMindspaceView(items, topics, NOW);
    expect(view.trends["emma"]).toBe("up");
    expect(view.trends["mb"]).toBe("down");
    expect(view.windows[0].sparse).toBe(true); // 6 items < 10
    expect(view.windows[2].sparse).toBe(false);
  });

  it("splits an item's mass across its labels", () => {
    const split: ClassifiedItem = {
      ...item({ mass: 30 }),
      labels: [
        { topicId: "emma", weight: 2 / 3 },
        { topicId: "mb", weight: 1 / 3 },
      ],
    };
    const filler = Array.from({ length: 10 }, (_, i) =>
      classified("emma", 3, 1 + (i % 3)),
    );
    const view = buildMindspaceView([split, ...filler], topics, NOW);
    const week = view.windows[1];
    const emma = week.shares.find((s) => s.topicId === "emma")!;
    const mb = week.shares.find((s) => s.topicId === "mb")!;
    expect(emma.massMinutes).toBeCloseTo(20 + 30);
    expect(mb.massMinutes).toBeCloseTo(10);
  });
});

describe("classifyItems", () => {
  it("classifies a realistic capture end to end", () => {
    const topics = [
      topic({ id: "emma", seedVaultPath: "People/Emma.md" }),
      topic({ id: "ave", name: "AI video editor" }),
    ];
    const capture = item({
      title: "Late-night debrief — Emma, headspace, and a new project",
      frontmatterTopics: ["Emma", "AI video editor", "wellbeing"],
      wikilinkPaths: ["People/Emma.md", "People/Taiga.md"],
      text: "the date didn't go as hoped… new project: ai video editor",
    });
    const [result] = classifyItems([capture], topics);
    expect(result.labels).toHaveLength(2);
    const emma = result.labels.find((l) => l.topicId === "emma")!;
    const ave = result.labels.find((l) => l.topicId === "ave")!;
    expect(emma.weight).toBeGreaterThan(ave.weight);
  });
});

describe("buildSeedCandidates", () => {
  it("maps vault folders and groups to kinds, merging duplicates", () => {
    const candidates = buildSeedCandidates(
      [
        { path: "People/Emma.md", folder: "People", title: "Emma", backlinkCount: 5 },
        { path: "People/Stub.md", folder: "People", title: "Stub", backlinkCount: 0 },
        { path: "Projects/Mindboard.md", folder: "Projects", title: "Mindboard", backlinkCount: 9 },
        { path: "Areas/Money.md", folder: "Areas", title: "Money", backlinkCount: 2 },
        { path: "Papers/Attention.md", folder: "Papers", title: "Attention", backlinkCount: 0 },
      ],
      [
        { id: "g1", name: "Mindboard", type: "project", color: "#B5FF3C" },
        { id: "g2", name: "Best Buy Shifts", type: "work", color: "#3C8FFF" },
      ],
    );

    expect(candidates.find((c) => c.name === "Attention")).toBeUndefined();

    const mindboard = candidates.find((c) => c.name === "Mindboard")!;
    expect(mindboard.vaultPath).toBe("Projects/Mindboard.md");
    expect(mindboard.groupId).toBe("g1");
    expect(mindboard.color).toBe("#B5FF3C");

    const bestBuy = candidates.find((c) => c.name === "Best Buy Shifts")!;
    expect(bestBuy.kind).toBe("work");

    expect(candidates.find((c) => c.name === "Emma")!.defaultSelected).toBe(true);
    expect(candidates.find((c) => c.name === "Stub")!.defaultSelected).toBe(false);

    // people sort before projects
    expect(candidates[0].kind).toBe("person");
  });
});

describe("mass helpers", () => {
  it("computes reading minutes with clamps", () => {
    expect(readingMinutes(100)).toBe(2);
    expect(readingMinutes(1000)).toBe(5);
    expect(readingMinutes(100_000)).toBe(60);
    expect(readingMinutes(10, 1, 10)).toBe(1);
  });

  it("counts words", () => {
    expect(countWords("one two  three\nfour")).toBe(4);
    expect(countWords("")).toBe(0);
  });
});
