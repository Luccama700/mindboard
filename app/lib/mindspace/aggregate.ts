// Turns classified items into the Mindspace view: per-window topic shares over
// a common attention-mass denominator, with sub-threshold topics folded into
// "everything else" and muted topics kept in the denominator but off the board
// (the honest-percentage rule from docs/mindspace-plan.md). Trend arrows come
// from the fast (3d) vs slow (30d) share comparison. Pure and unit-tested.

import type {
  ClassifiedItem,
  MindspaceTopic,
  MindspaceView,
  MindspaceWindowView,
  TopicEvidence,
  TopicShare,
  TopicTrend,
  WindowDays,
} from "@/app/lib/mindspace/types";

export const WINDOW_DAYS: WindowDays[] = [3, 7, 30];

const DAY_MS = 24 * 60 * 60 * 1000;
const FOLD_THRESHOLD = 0.03;
const SPARSE_ITEM_COUNT = 10;
const TREND_DELTA = 0.05;
const TOP_ITEMS = 4;

// Salience multiplier on attention mass: a raw 2am entry (3) outweighs a
// routine changelog (0) of equal length. Index = salience 0..3.
export const SALIENCE_MULT = [0.5, 1, 1.6, 2.2] as const;

export function salienceMult(salience: number): number {
  const index = Math.min(3, Math.max(0, Math.round(salience)));
  return SALIENCE_MULT[index];
}

type TopicAccumulator = {
  mass: number;
  rawMass: number;
  salienceMass: number; // Σ salience × rawMass, for the mass-weighted mean
  itemCount: number;
  items: TopicEvidence[];
};

function buildWindow(
  items: ClassifiedItem[],
  topics: MindspaceTopic[],
  days: WindowDays,
  nowMs: number,
): MindspaceWindowView {
  const cutoff = nowMs - days * DAY_MS;
  const inWindow = items.filter(
    (item) => item.occurredAt >= cutoff && item.occurredAt <= nowMs,
  );

  const byTopic = new Map<string, TopicAccumulator>();
  let totalMass = 0;
  let unclassifiedMass = 0;

  for (const item of inWindow) {
    const effectiveMass = item.mass * salienceMult(item.salience);
    totalMass += effectiveMass;
    if (item.labels.length === 0) {
      unclassifiedMass += effectiveMass;
      continue;
    }
    for (const label of item.labels) {
      const slice = effectiveMass * label.weight;
      const rawSlice = item.mass * label.weight;
      const acc = byTopic.get(label.topicId) ?? {
        mass: 0,
        rawMass: 0,
        salienceMass: 0,
        itemCount: 0,
        items: [],
      };
      acc.mass += slice;
      acc.rawMass += rawSlice;
      acc.salienceMass += item.salience * rawSlice;
      acc.itemCount += 1;
      acc.items.push({
        title: item.title,
        href: item.href,
        source: item.source,
        occurredAt: item.occurredAt,
        massMinutes: slice,
      });
      byTopic.set(label.topicId, acc);
    }
  }

  const shares: TopicShare[] = [];
  let foldedShare = 0;
  let mutedShare = 0;

  if (totalMass > 0) {
    for (const topic of topics) {
      const acc = byTopic.get(topic.id);
      if (!acc || acc.mass === 0) continue;
      const share = acc.mass / totalMass;
      if (topic.status === "muted") {
        mutedShare += share;
        continue;
      }
      if (share < FOLD_THRESHOLD && !topic.pinned) {
        foldedShare += share;
        continue;
      }
      shares.push({
        topicId: topic.id,
        share,
        massMinutes: acc.mass,
        rawMassMinutes: acc.rawMass,
        meanSalience: acc.rawMass > 0 ? acc.salienceMass / acc.rawMass : 1,
        itemCount: acc.itemCount,
        topItems: [...acc.items]
          .sort((a, b) => b.massMinutes - a.massMinutes)
          .slice(0, TOP_ITEMS),
      });
    }
    shares.sort((a, b) => b.share - a.share);
  }

  return {
    days,
    totalMassMinutes: totalMass,
    totalItems: inWindow.length,
    shares,
    foldedShare,
    mutedShare,
    unclassifiedShare: totalMass > 0 ? unclassifiedMass / totalMass : 0,
    sparse: inWindow.length < SPARSE_ITEM_COUNT,
  };
}

function shareOf(view: MindspaceWindowView, topicId: string): number {
  return view.shares.find((s) => s.topicId === topicId)?.share ?? 0;
}

export function buildMindspaceView(
  items: ClassifiedItem[],
  topics: MindspaceTopic[],
  nowMs: number,
): MindspaceView {
  const windows = WINDOW_DAYS.map((days) =>
    buildWindow(items, topics, days, nowMs),
  );

  const fast = windows[0];
  const slow = windows[windows.length - 1];
  const trends: Record<string, TopicTrend> = {};
  for (const topic of topics) {
    const delta = shareOf(fast, topic.id) - shareOf(slow, topic.id);
    trends[topic.id] =
      delta > TREND_DELTA ? "up" : delta < -TREND_DELTA ? "down" : "flat";
  }

  return { windows, trends };
}

// Reading time in minutes for a word count (~200 wpm), clamped so a pasted
// derivation can't swamp the week.
export function readingMinutes(wordCount: number, min = 2, max = 60): number {
  return Math.min(max, Math.max(min, Math.round(wordCount / 200)));
}

export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}
