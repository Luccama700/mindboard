import "server-only";
import { cache } from "react";

import { createClient } from "@/utils/supabase/server";
import { buildWindow } from "@/app/lib/mindspace/aggregate";
import { assignTopicColors } from "@/app/lib/mindspace/colors";
import { getMindspaceTopics } from "@/app/lib/mindspace/read";
import type {
  ClassifiedItem,
  ItemLabel,
  MindspaceTopic,
} from "@/app/lib/mindspace/types";

// A slim stacked "mindshare" bar for the dashboard stream header: the last-3-day
// slice of the Mindspace board, Postgres-only (persisted verdicts, never the
// full network gather). Color parity with /mindspace comes from running the
// same fallback-palette assignment over the FULL topic list before any window
// filtering, so index-based colors line up exactly.

const DAY_MS = 24 * 60 * 60 * 1000;

export type MindshareBar = {
  segments: Array<{
    topicId: string;
    name: string;
    color: string;
    share: number;
  }>;
  otherShare: number;
  unclassifiedShare: number;
};

type ItemRow = { id: string; mass: number; salience: number; occurred_at: string };
type LabelRow = { item_id: string; topic_id: string; weight: number };

export function buildShareBarView(
  itemRows: ItemRow[],
  labelRows: LabelRow[],
  topics: MindspaceTopic[],
  nowMs: number,
): MindshareBar | null {
  const coloredTopics = assignTopicColors(topics);

  const labelsByItem = new Map<string, ItemLabel[]>();
  for (const row of labelRows) {
    const bucket = labelsByItem.get(row.item_id) ?? [];
    bucket.push({ topicId: row.topic_id, weight: row.weight });
    labelsByItem.set(row.item_id, bucket);
  }

  const items: ClassifiedItem[] = itemRows.map((row) => ({
    source: "note",
    ref: row.id,
    title: "",
    href: null,
    occurredAt: Date.parse(row.occurred_at),
    mass: row.mass,
    wordCount: 0,
    text: "",
    frontmatterTopics: [],
    wikilinkPaths: [],
    groupId: null,
    labels: labelsByItem.get(row.id) ?? [],
    salience: row.salience,
  }));

  const view = buildWindow(items, coloredTopics, 3, nowMs);
  if (view.totalItems === 0) return null;

  const byId = new Map(coloredTopics.map((topic) => [topic.id, topic]));
  const segments = view.shares.flatMap((share) => {
    const topic = byId.get(share.topicId);
    if (!topic) return [];
    return [
      {
        topicId: share.topicId,
        name: topic.name,
        color: topic.color,
        share: share.share,
      },
    ];
  });

  return {
    segments,
    otherShare: view.foldedShare,
    unclassifiedShare: view.unclassifiedShare,
  };
}

export const getMindspaceShareBar = cache(
  async (userId: string): Promise<MindshareBar | null> => {
    const topics = await getMindspaceTopics(userId);
    if (topics.length === 0) return null;

    const nowMs = Date.now();
    const cutoffIso = new Date(nowMs - 3 * DAY_MS).toISOString();
    const supabase = await createClient();

    const [itemsRes, labelsRes] = await Promise.all([
      supabase
        .from("mindspace_items")
        .select("id, mass, salience, occurred_at")
        .eq("user_id", userId)
        .gte("occurred_at", cutoffIso),
      supabase
        .from("mindspace_labels")
        .select("item_id, topic_id, weight")
        .eq("user_id", userId),
    ]);

    const itemRows = ((itemsRes.data ?? []) as {
      id: string;
      mass: number | string;
      salience: number | string;
      occurred_at: string;
    }[]).map((row) => ({
      id: row.id,
      mass: Number(row.mass),
      salience: Number(row.salience),
      occurred_at: row.occurred_at,
    }));

    const labelRows = ((labelsRes.data ?? []) as {
      item_id: string;
      topic_id: string;
      weight: number | string;
    }[]).map((row) => ({
      item_id: row.item_id,
      topic_id: row.topic_id,
      weight: Number(row.weight),
    }));

    return buildShareBarView(itemRows, labelRows, topics, nowMs);
  },
);
