import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { createClient } from "@/utils/supabase/server";
import { getUserPreferences } from "@/app/lib/data/settings";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { getPeople, getLatestInteractions } from "@/app/lib/data/people";
import {
  listEligibleNotes,
  seedingDone,
  syncPeopleFromVault,
} from "@/app/lib/people/sync";
import {
  getVaultCorpus,
  VaultConnectionError,
  VaultNotConfiguredError,
  type VaultCorpus,
} from "@/app/lib/brain/vault";
import { extractIntro } from "@/app/lib/brain/parse";
import type { RosterEntry } from "@/app/_components/people-types";
import { PeopleClient } from "./people-client";
import { SeedingChecklist } from "./seeding-checklist";

export default async function PeoplePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const timeZone = safeTimeZone((await getUserPreferences(user.id)).timezone);
  // Every date fact on this page keys off the user's day, not the server's.
  const today = todayISO(timeZone);

  // The no-vault case is normal, not an error (§5): the roster then shows
  // only hand-created people and a quiet connect hint in the empty state.
  let corpus: VaultCorpus | null = null;
  let vaultConnected = true;
  try {
    corpus = await getVaultCorpus(user.id);
  } catch (error) {
    if (error instanceof VaultNotConfiguredError) {
      vaultConnected = false;
    } else if (!(error instanceof VaultConnectionError)) {
      throw error;
    }
  }

  const seeded = await seedingDone(user.id);

  // First visit with a vault: the seeding checklist IS the first render (§5).
  // The sync stays off until the user has said who counts as a person.
  if (!seeded && corpus) {
    const eligible = await listEligibleNotes(user.id);
    if (eligible.length > 0) {
      const displayName = (
        (user.user_metadata?.full_name as string | undefined) ??
        (user.user_metadata?.name as string | undefined) ??
        ""
      ).toLowerCase();
      const candidates = eligible.map((note) => ({
        path: note.path,
        title: note.title,
        preticked:
          note.frontmatterType === "person" &&
          note.title.toLowerCase() !== displayName,
      }));
      return (
        <Shell>
          <SeedingChecklist candidates={candidates} />
        </Shell>
      );
    }
  }

  if (seeded) {
    // Visibility is immediate, persistence is eventual (§5): the sync
    // backfills new notes after the response, never gating this render.
    after(() => syncPeopleFromVault(user.id));
  }

  const [people, latest] = await Promise.all([
    getPeople(user.id),
    getLatestInteractions(user.id),
  ]);

  const active = people.filter((p) => !p.archived);
  const archived = people.filter((p) => p.archived);

  const linkedPaths = new Set(
    people.map((p) => p.vault_path).filter((p): p is string => p !== null),
  );

  const entries: RosterEntry[] = active.map((person) => {
    const note =
      person.vault_path !== null
        ? (corpus?.notes.get(person.vault_path) ?? null)
        : null;
    return {
      person,
      vaultPath: person.vault_path,
      name: person.name,
      intro: note ? extractIntro(note.body) : null,
      lastTalked: latest.get(person.id) ?? null,
      noteUpdated: note ? ((note.frontmatter.updated as string) ?? null) : null,
    };
  });

  // Union rule (§5): eligible notes with no row yet render read-only until
  // the after() sync lands them.
  if (seeded && corpus) {
    const peopleNotes = corpus.folders.get("People") ?? [];
    for (const note of peopleNotes) {
      if (linkedPaths.has(note.path)) continue;
      if ((note.frontmatter.type ?? "person") !== "person") continue;
      entries.push({
        person: null,
        vaultPath: note.path,
        name: note.title,
        intro: extractIntro(note.body),
        lastTalked: null,
        noteUpdated: (note.frontmatter.updated as string) ?? null,
      });
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Shell>
      <PeopleClient
        entries={entries}
        archived={archived}
        vaultConnected={vaultConnected}
        today={today}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-10 pr-10 lg:pr-0">
        <Link
          href="/"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← mindboard
        </Link>
        <h1 className="text-xs tracking-widest uppercase text-muted">people</h1>
      </header>
      {children}
    </main>
  );
}
