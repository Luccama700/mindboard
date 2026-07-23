import "server-only";
import { cache } from "react";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { readProviderKey } from "@/app/lib/connections/keys";
import {
  mergeClassifications,
  taxonomyHash,
  type PersistedVerdict,
} from "@/app/lib/mindspace/classify";
import { buildMindspaceView } from "@/app/lib/mindspace/aggregate";
import {
  CLASSIFY_BATCH,
  MODEL_VERSION,
  classifyBatch,
  taxonomySystemPrompt,
  writeObservations,
} from "@/app/lib/mindspace/llm";
import type {
  ClassifiedItem,
  MindspaceItem,
  MindspaceObservation,
  MindspaceTopic,
} from "@/app/lib/mindspace/types";

// M2 orchestration. The read path merges gathered items with cached LLM
// verdicts; whatever is uncached or stale (taxonomy changed) is classified
// after the response (`after()` in the page — this deployment has no cron, and
// the post-response pass is the repo's established background rail). Each
// visit drains up to MAX_PASS_ITEMS from the backlog, so the board sharpens
// visit over visit and settles once everything is cached.

const MAX_PASS_ITEMS = 60;
const OBSERVATION_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const CLEANUP_AGE_DAYS = 45;

export async function loadPersistedVerdicts(
  supabase: SupabaseClient,
  userId: string,
): Promise<Map<string, PersistedVerdict>> {
  const [itemsRes, labelsRes] = await Promise.all([
    supabase
      .from("mindspace_items")
      .select("id, source, source_ref, salience, taxonomy_hash, classified_at")
      .eq("user_id", userId),
    supabase
      .from("mindspace_labels")
      .select("item_id, topic_id, weight")
      .eq("user_id", userId),
  ]);

  const labelsByItem = new Map<string, { topicId: string; weight: number }[]>();
  for (const row of (labelsRes.data ?? []) as {
    item_id: string;
    topic_id: string;
    weight: number;
  }[]) {
    const bucket = labelsByItem.get(row.item_id) ?? [];
    bucket.push({ topicId: row.topic_id, weight: Number(row.weight) });
    labelsByItem.set(row.item_id, bucket);
  }

  const verdicts = new Map<string, PersistedVerdict>();
  for (const row of (itemsRes.data ?? []) as {
    id: string;
    source: string;
    source_ref: string;
    salience: number;
    taxonomy_hash: string | null;
    classified_at: string | null;
  }[]) {
    verdicts.set(`${row.source}:${row.source_ref}`, {
      salience: row.salience,
      labels: labelsByItem.get(row.id) ?? [],
      taxonomyHash: row.taxonomy_hash,
      classified: row.classified_at !== null,
    });
  }
  return verdicts;
}

export type MindspaceComputation = {
  classified: ClassifiedItem[];
  pending: MindspaceItem[];
  currentHash: string;
};

export function computeClassifications(
  items: MindspaceItem[],
  topics: MindspaceTopic[],
  persisted: Map<string, PersistedVerdict>,
): MindspaceComputation {
  const currentHash = taxonomyHash(topics);
  const { classified, pending } = mergeClassifications(
    items,
    topics,
    persisted,
    currentHash,
  );
  return { classified, pending, currentHash };
}

export const getObservations = cache(
  async (userId: string): Promise<MindspaceObservation[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("mindspace_observations")
      .select("id, topic_id, text, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(3);
    return ((data ?? []) as {
      id: string;
      topic_id: string | null;
      text: string;
      created_at: string;
    }[]).map((row) => ({
      id: row.id,
      topicId: row.topic_id,
      text: row.text,
      createdAt: row.created_at,
    }));
  },
);

async function persistVerdicts(
  supabase: SupabaseClient,
  userId: string,
  batch: MindspaceItem[],
  verdicts: Awaited<ReturnType<typeof classifyBatch>>,
  currentHash: string,
): Promise<void> {
  const byRef = new Map(batch.map((item) => [item.ref, item]));
  for (const verdict of verdicts) {
    const item = byRef.get(verdict.ref);
    if (!item) continue;
    const { data: row, error } = await supabase
      .from("mindspace_items")
      .upsert(
        {
          user_id: userId,
          source: item.source,
          source_ref: item.ref,
          occurred_at: new Date(item.occurredAt).toISOString(),
          mass: item.mass,
          word_count: item.wordCount,
          title: item.title.slice(0, 300),
          salience: verdict.salience,
          valence: verdict.valence,
          taxonomy_hash: currentHash,
          model_version: MODEL_VERSION,
          classified_at: new Date().toISOString(),
        },
        { onConflict: "user_id,source,source_ref" },
      )
      .select("id")
      .single();
    if (error || !row) continue;

    await supabase.from("mindspace_labels").delete().eq("item_id", row.id);
    if (verdict.labels.length > 0) {
      await supabase.from("mindspace_labels").insert(
        verdict.labels.map((label) => ({
          item_id: row.id,
          topic_id: label.topicId,
          user_id: userId,
          weight: label.weight,
        })),
      );
    }
  }
}

async function refreshObservations(
  supabase: SupabaseClient,
  anthropic: Anthropic,
  userId: string,
  topics: MindspaceTopic[],
  items: MindspaceItem[],
  persisted: Map<string, PersistedVerdict>,
  nowMs: number,
): Promise<void> {
  const { data: latest } = await supabase
    .from("mindspace_observations")
    .select("created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    latest &&
    nowMs - new Date(latest.created_at as string).getTime() <
      OBSERVATION_MAX_AGE_MS
  ) {
    return;
  }

  // Recompute over the freshest verdicts (including this pass's writes).
  const { classified } = computeClassifications(items, topics, persisted);
  const view = buildMindspaceView(classified, topics, nowMs);
  if (view.windows[1].sparse) return;

  const drafts = await writeObservations(anthropic, topics, view);
  if (drafts.length === 0) return;

  await supabase.from("mindspace_observations").delete().eq("user_id", userId);
  await supabase.from("mindspace_observations").insert(
    drafts.map((draft) => ({
      user_id: userId,
      topic_id: draft.topicId,
      window_days: 7,
      text: draft.text,
    })),
  );
}

// The post-response pass. Never throws: a failure leaves items on the fast
// path for the next visit.
export async function runMindspacePass(input: {
  userId: string;
  topics: MindspaceTopic[];
  items: MindspaceItem[];
  pending: MindspaceItem[];
  currentHash: string;
  nowMs: number;
}): Promise<void> {
  const { userId, topics, items, pending, currentHash, nowMs } = input;
  try {
    // Service client, not the cookie client: `after()` runs outside the
    // request context, where `cookies()` throws. Every query below is
    // explicitly userId-scoped, per the multi-tenant invariant.
    const supabase = createServiceClient();
    const apiKey = await readProviderKey(supabase, userId, "anthropic");
    if (!apiKey) return;
    const anthropic = new Anthropic({ apiKey });

    const queue = [...pending]
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .slice(0, MAX_PASS_ITEMS);
    const system = taxonomySystemPrompt(topics);
    const topicIds = new Set(topics.map((topic) => topic.id));

    for (let i = 0; i < queue.length; i += CLASSIFY_BATCH) {
      const batch = queue.slice(i, i + CLASSIFY_BATCH);
      const verdicts = await classifyBatch(anthropic, system, batch, topicIds);
      await persistVerdicts(supabase, userId, batch, verdicts, currentHash);
    }

    // Refresh the merged picture for observations without re-reading rows:
    // re-derive persisted state from what this pass just wrote.
    const persisted = await loadPersistedVerdicts(supabase, userId);
    await refreshObservations(
      supabase,
      anthropic,
      userId,
      topics,
      items,
      persisted,
      nowMs,
    );

    await supabase
      .from("mindspace_items")
      .delete()
      .eq("user_id", userId)
      .lt(
        "occurred_at",
        new Date(nowMs - CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      );
  } catch (error) {
    console.error("mindspace pass failed", error);
  }
}
