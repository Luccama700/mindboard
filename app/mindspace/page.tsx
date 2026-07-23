import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { createClient } from "@/utils/supabase/server";
import { getUserPreferences } from "@/app/lib/data/settings";
import {
  gatherMindspaceItems,
  getMindspaceTopics,
} from "@/app/lib/mindspace/read";
import {
  computeClassifications,
  getObservations,
  loadPersistedVerdicts,
  runMindspacePass,
} from "@/app/lib/mindspace/pipeline";
import { buildMindspaceView } from "@/app/lib/mindspace/aggregate";
import {
  buildSeedCandidates,
  type SeedGroup,
  type SeedNote,
} from "@/app/lib/mindspace/seed";
import {
  getVaultCorpus,
  VaultConnectionError,
} from "@/app/lib/brain/vault";
import { MindspaceClient } from "./mindspace-client";
import { SeedClient } from "./seed-client";

// Deterministic fallback palette for topics seeded without a group color.
const FALLBACK_COLORS = [
  "#b5ff3c",
  "#3cd9ff",
  "#ffb73c",
  "#c892ff",
  "#3c8fff",
  "#ff6b9d",
  "#7cff6b",
  "#fb623c",
  "#9e44f8",
  "#3cffc9",
];

export default async function MindspacePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [prefs, topics] = await Promise.all([
    getUserPreferences(user.id),
    getMindspaceTopics(user.id),
  ]);

  const header = (
    <header className="flex items-center justify-between mb-10 pr-10 lg:pr-0">
      <Link
        href="/"
        className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
      >
        ← mindboard
      </Link>
      <h1 className="text-xs tracking-widest uppercase text-muted">
        mindspace
      </h1>
    </header>
  );

  if (topics.length === 0) {
    let seedNotes: SeedNote[] = [];
    try {
      const corpus = await getVaultCorpus(user.id);
      seedNotes = [...corpus.notes.values()].map((note) => ({
        path: note.path,
        folder: note.folder,
        title: note.title,
        backlinkCount: note.backlinks.length,
      }));
    } catch (error) {
      if (!(error instanceof VaultConnectionError)) throw error;
    }
    const { data: groupRows } = await supabase
      .from("groups")
      .select("id, name, type, color")
      .eq("user_id", user.id)
      .eq("archived", false);
    const candidates = buildSeedCandidates(
      seedNotes,
      (groupRows ?? []) as SeedGroup[],
    );

    return (
      <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
        {header}
        <SeedClient candidates={candidates} />
      </main>
    );
  }

  const [{ items, vaultConnected, nowMs }, persisted, observations] =
    await Promise.all([
      gatherMindspaceItems(user.id, prefs.timezone),
      loadPersistedVerdicts(supabase, user.id),
      getObservations(user.id),
    ]);
  const { classified, pending, currentHash } = computeClassifications(
    items,
    topics,
    persisted,
  );
  const view = buildMindspaceView(classified, topics, nowMs);

  const observationsStale =
    observations.length === 0 ||
    nowMs - Date.parse(observations[0].createdAt) > 20 * 60 * 60 * 1000;
  if (pending.length > 0 || observationsStale) {
    after(() =>
      runMindspacePass({
        userId: user.id,
        topics,
        items,
        pending,
        currentHash,
        nowMs,
      }),
    );
  }

  const coloredTopics = topics.map((topic, index) => ({
    ...topic,
    color: topic.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length],
  }));

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      {header}
      <MindspaceClient
        view={view}
        topics={coloredTopics}
        nowMs={nowMs}
        vaultConnected={vaultConnected}
        observations={observations}
        pendingCount={pending.length}
      />
    </main>
  );
}
