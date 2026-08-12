import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { createClient } from "@/utils/supabase/server";
import { getUserPreferences } from "@/app/lib/data/settings";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import {
  getCandidates,
  getLatestInteractions,
  getPeople,
  getPeopleGroups,
} from "@/app/lib/data/people";
import {
  listEligibleNotes,
  seedingDone,
  syncPeopleFromVault,
} from "@/app/lib/people/sync";
import {
  findNote,
  getVaultCorpus,
  VaultConnectionError,
  VaultNotConfiguredError,
  type VaultCorpus,
} from "@/app/lib/brain/vault";
import { extractIntro, extractSectionBullets } from "@/app/lib/brain/parse";
import {
  computePeopleAttention,
  hydratePeopleAttention,
  type PersonAttention,
} from "@/app/lib/snapshots/people";
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

  // Unconditional: the checklist gate lives INSIDE the sync's vault phase,
  // and the mention scan must run even for a vault-less, hand-created
  // roster — the Denise case (§5, review finding 2).
  after(() => syncPeopleFromVault(user.id));

  const [people, latest, newCandidates, peopleGroups] = await Promise.all([
    getPeople(user.id),
    getLatestInteractions(user.id),
    getCandidates(user.id),
    getPeopleGroups(user.id),
  ]);

  const active = people.filter((p) => !p.archived);
  const archived = people.filter((p) => p.archived);

  const linkedPaths = new Set(
    people.map((p) => p.vault_path).filter((p): p is string => p !== null),
  );

  const entries: RosterEntry[] = active.map((person) => {
    // findNote, not notes.get: a case-only vault rename must not hide the
    // note from the UI while MCP still sees it (review finding 10).
    const note =
      person.vault_path !== null && corpus
        ? findNote(corpus, person.vault_path)
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
      // Same predicate as the sync's isPersonNote — a laxer filter here
      // renders ghost rows the sync will never persist (review finding 5).
      if (note.frontmatter.type !== "person") continue;
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

  // The single "worth a message" card (§7, §8): attention[0] hydrated with
  // open loops straight from the corpus this page already paid for.
  const vitals = computePeopleAttention({
    people,
    interactions: [...latest.values()],
    candidates: newCandidates,
    today,
  });
  let suggestion: PersonAttention | null = null;
  if (vitals.attention.length > 0) {
    const top = vitals.attention.slice(0, 1);
    const loops: Record<string, string[]> = {};
    for (const entry of top) {
      const path = people.find((p) => p.id === entry.personId)?.vault_path;
      const note = path && corpus ? findNote(corpus, path) : null;
      loops[entry.personId] = note
        ? extractSectionBullets(note.body, "Open questions")
        : [];
    }
    suggestion = hydratePeopleAttention(top, loops)[0] ?? null;
  }

  return (
    <Shell>
      <PeopleClient
        entries={entries}
        archived={archived}
        vaultConnected={vaultConnected}
        today={today}
        suggestion={suggestion}
        quieted={vitals.quieted}
        groups={peopleGroups}
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
