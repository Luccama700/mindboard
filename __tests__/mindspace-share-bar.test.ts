import { describe, expect, it } from "vitest";

import { buildShareBarView } from "@/app/lib/mindspace/share-bar";
import {
  assignTopicColors,
  FALLBACK_COLORS,
} from "@/app/lib/mindspace/colors";
import type { MindspaceTopic } from "@/app/lib/mindspace/types";

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
    color: "#ffffff",
    ...overrides,
  };
}

function itemRow(
  id: string,
  mass: number,
  salience: number,
  offsetMs = -DAY,
) {
  return {
    id,
    mass,
    salience,
    occurred_at: new Date(NOW + offsetMs).toISOString(),
  };
}

function label(itemId: string, topicId: string, weight = 1) {
  return { item_id: itemId, topic_id: topicId, weight };
}

describe("buildShareBarView", () => {
  it("weights mass by salience and slices it across topic labels", () => {
    // SALIENCE_MULT = [0.5, 1, 1.6, 2.2].
    const topics = [
      topic({ id: "t1", name: "t1" }),
      topic({ id: "t2", name: "t2" }),
    ];
    const items = [
      itemRow("a", 10, 2), // eff 16 → t1
      itemRow("b", 10, 3), // eff 22 → t1 0.5 (11), t2 0.5 (11)
      itemRow("c", 10, 0), // eff 5 → t2
    ];
    const labels = [
      label("a", "t1"),
      label("b", "t1", 0.5),
      label("b", "t2", 0.5),
      label("c", "t2"),
    ];
    const bar = buildShareBarView(items, labels, topics, NOW);
    expect(bar).not.toBeNull();
    const total = 43; // 16 + 22 + 5
    expect(bar!.segments.map((s) => s.topicId)).toEqual(["t1", "t2"]);
    expect(bar!.segments[0].share).toBeCloseTo(27 / total, 6); // 16 + 11
    expect(bar!.segments[1].share).toBeCloseTo(16 / total, 6); // 11 + 5
    expect(bar!.otherShare).toBe(0);
    expect(bar!.unclassifiedShare).toBe(0);
  });

  it("keeps muted topics in the denominator but off the bar", () => {
    const topics = [
      topic({ id: "t1", name: "t1" }),
      topic({ id: "t2", name: "t2", status: "muted" }),
    ];
    const items = [itemRow("a", 10, 1), itemRow("b", 10, 1)];
    const labels = [label("a", "t1"), label("b", "t2")];
    const bar = buildShareBarView(items, labels, topics, NOW);
    expect(bar!.segments).toHaveLength(1);
    // Denominator still counts the muted topic's mass: 10 / 20, not 10 / 10.
    expect(bar!.segments[0].topicId).toBe("t1");
    expect(bar!.segments[0].share).toBeCloseTo(0.5, 6);
  });

  it("folds sub-threshold non-pinned topics but exempts pinned ones", () => {
    const topics = [
      topic({ id: "big", name: "big" }),
      topic({ id: "pin", name: "pin", pinned: true }),
      topic({ id: "small", name: "small" }),
    ];
    const items = [
      itemRow("a", 100, 1), // eff 100 → big
      itemRow("b", 1, 1), // eff 1 → pin (~0.98%)
      itemRow("c", 1, 1), // eff 1 → small (~0.98%)
    ];
    const labels = [label("a", "big"), label("b", "pin"), label("c", "small")];
    const bar = buildShareBarView(items, labels, topics, NOW);
    const ids = bar!.segments.map((s) => s.topicId);
    expect(ids).toContain("big");
    expect(ids).toContain("pin"); // pinned survives despite < 3%
    expect(ids).not.toContain("small"); // folded away
    expect(bar!.otherShare).toBeCloseTo(1 / 102, 6);
  });

  it("routes label-less mass into unclassifiedShare", () => {
    const topics = [topic({ id: "t1", name: "t1" })];
    const items = [itemRow("a", 10, 1), itemRow("b", 10, 1)];
    const labels = [label("a", "t1")];
    const bar = buildShareBarView(items, labels, topics, NOW);
    expect(bar!.segments).toHaveLength(1);
    expect(bar!.unclassifiedShare).toBeCloseTo(0.5, 6);
  });

  it("returns null when nothing lands in the 3-day window", () => {
    const topics = [topic({ id: "t1", name: "t1" })];
    expect(buildShareBarView([], [], topics, NOW)).toBeNull();
    // An item five days old is outside the window → still null.
    const stale = [itemRow("a", 10, 1, -5 * DAY)];
    expect(
      buildShareBarView(stale, [label("a", "t1")], topics, NOW),
    ).toBeNull();
  });

  it("assigns fallback colors by full-array index, shifted by earlier topics", () => {
    // Muted topic sits first in the array (getMindspaceTopics includes muted),
    // so the two active topics take FALLBACK_COLORS[1] and [2], not [0]/[1].
    const topics = [
      topic({ id: "m", name: "m", status: "muted", color: null }),
      topic({ id: "a", name: "a", color: null }),
      topic({ id: "b", name: "b", color: null }),
    ];
    const items = [
      itemRow("x", 10, 1),
      itemRow("y", 10, 1),
      itemRow("z", 10, 1),
    ];
    const labels = [label("x", "m"), label("y", "a"), label("z", "b")];
    const bar = buildShareBarView(items, labels, topics, NOW);
    const colored = assignTopicColors(topics);
    const byId = Object.fromEntries(bar!.segments.map((s) => [s.topicId, s]));
    expect(byId["a"].color).toBe(FALLBACK_COLORS[1]);
    expect(byId["b"].color).toBe(FALLBACK_COLORS[2]);
    // Parity with the /mindspace assignment over the identical full array.
    expect(byId["a"].color).toBe(colored[1].color);
    expect(byId["b"].color).toBe(colored[2].color);
  });
});
