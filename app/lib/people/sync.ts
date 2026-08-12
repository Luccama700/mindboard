import "server-only";
import { cache } from "react";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { noteTitle, parseFrontmatter } from "@/app/lib/brain/parse";
import { scanMentionsForUser } from "@/app/lib/people/mentions";
import {
  getVaultCorpus,
  listVaultNotePaths,
  readVaultCredentials,
  readVaultNoteRaw,
  vaultTag,
} from "@/app/lib/brain/vault";

// The lazy upsert from the vault (docs/people-plan.md §5).
//
// NOT in app/actions/people.ts: every export of a "use server" file is a
// publicly invocable POST endpoint, so a syncPeopleFromVault(userId) running
// the service client there would be a cross-tenant write endpoint. The house
// precedent is runMindspacePass (app/lib/mindspace/pipeline.ts), which lives in
// lib/ and is called by the page.

export const PEOPLE_FOLDER = "People";
const PERSON_TYPE = "person";
// The mindspace matcher's only false-positive defence (classify.ts:21), applied
// to the alias seed for the same reason.
const MIN_ALIAS_LENGTH = 3;
const UNIQUE_VIOLATION = "23505";

export type EligibleNote = {
  path: string;
  title: string;
  frontmatterType: string | null;
};

type PersonRowLite = {
  id: string;
  name: string;
  vault_path: string | null;
  archived: boolean;
};

type PeopleInsert = {
  user_id: string;
  name: string;
  vault_path: string | null;
  aliases: string[];
  archived: boolean;
  archived_at: string | null;
  updated_at: string;
};

function isUniqueViolation(error: PostgrestError | null): boolean {
  return error?.code === UNIQUE_VIOLATION;
}

// Vault paths are compared case-insensitively throughout, matching
// readVaultNoteRaw's own case-insensitive lookup. Storing the path verbatim and
// comparing it lowercased is what keeps a `People/davi.md` rename from looking
// like a brand-new note.
function pathKey(path: string): string {
  return path.toLowerCase();
}

function isPersonNote(folder: string, frontmatterType: string | null): boolean {
  return (
    folder === PEOPLE_FOLDER &&
    (frontmatterType ?? "").trim().toLowerCase() === PERSON_TYPE
  );
}

// Aliases seed ONCE, at row creation, and never again: people.aliases and
// mindspace_topics.aliases are two registries that will drift, and each owns
// its own edits after this (§5). Curated aliases win when the user already
// tuned them on /mindspace; otherwise seed the FIRST name token only —
// seeding surnames adds terms that match relatives and strangers, which turns
// M4's precision layer into cleanup.
export function seedAliases(
  name: string,
  curated?: string[] | null,
): string[] {
  const source =
    curated && curated.length > 0 ? curated : [name.trim().split(/\s+/)[0] ?? ""];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source) {
    const alias = (raw ?? "").trim();
    if (alias.length < MIN_ALIAS_LENGTH) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

// vaultPath (lowercased) -> the topic's curated aliases. Takes a client so the
// after() sync (service) and confirmSeeding (session) share one implementation.
export async function readCuratedAliases(
  supabase: SupabaseClient,
  userId: string,
): Promise<Map<string, string[]>> {
  const { data } = await supabase
    .from("mindspace_topics")
    .select("aliases, seed_ref")
    .eq("user_id", userId)
    .eq("status", "active");
  const out = new Map<string, string[]>();
  for (const row of (data ?? []) as {
    aliases: string[] | null;
    seed_ref: { vaultPath?: string } | null;
  }[]) {
    const path = row.seed_ref?.vaultPath;
    if (typeof path !== "string" || !path) continue;
    out.set(pathKey(path), row.aliases ?? []);
  }
  return out;
}

// The one insert path, shared by the sync and confirmSeeding.
//
// onConflict is the vault_path arbiter (see the index comment in
// 0047_people.sql for why that index is not partial), with ignoreDuplicates so
// two tabs racing on the same note settle to one row instead of throwing inside
// after(). A NAME collision is a different index and still errors, so the batch
// is retried row by row and the losers are skipped: the note stays unlinked,
// the roster's vault union still shows it read-only, and the adoption step
// picks it up once the colliding row's vault_path is free.
// Returns how many rows were ACTUALLY written, which is not always rows.length:
// name collisions are skipped by design, and ignoreDuplicates means an existing
// vault_path is a silent no-op. Callers that report a count to the user must use
// this number — telling someone "20 people added" when four were skipped is a
// small lie that makes the roster look broken.
export async function upsertPeopleRows(
  supabase: SupabaseClient,
  rows: PeopleInsert[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { data, error } = await supabase
    .from("people")
    .upsert(rows, { onConflict: "user_id,vault_path", ignoreDuplicates: true })
    .select("id");
  if (!error) return (data ?? []).length;
  if (!isUniqueViolation(error)) throw error;

  let written = 0;
  for (const row of rows) {
    const { data: rowData, error: rowError } = await supabase
      .from("people")
      .upsert([row], {
        onConflict: "user_id,vault_path",
        ignoreDuplicates: true,
      })
      .select("id");
    if (rowError && !isUniqueViolation(rowError)) throw rowError;
    if (!rowError) written += (rowData ?? []).length;
  }
  return written;
}

async function countSeededRows(
  supabase: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count } = await supabase
    .from("people")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .not("vault_path", "is", null);
  return count ?? 0;
}

// Has the first-run seeding checklist been answered? The marker IS the data:
// confirmSeeding writes a row for every listed note — included ones active,
// excluded ones archived — so "any row carries a vault_path" is true exactly
// once the user has answered, even if they excluded everything. A hand-created
// person (vault_path null) deliberately does NOT count: creating Denise from
// the search field must not swallow the checklist for a vault full of notes.
export const seedingDone = cache(async (userId: string): Promise<boolean> => {
  const supabase = await createClient();
  return (await countSeededRows(supabase, userId)) > 0;
});

// Every People/ note with no row yet — the first-run checklist's contents, and
// the roster's read-only union entries.
//
// Runs inside a normal request (the page calls it), so the corpus's own
// session-derived credential path is fine here; only the after() sync has to
// thread credentials explicitly. The corpus is cache()-deduped and /people pays
// for it anyway to render intro lines, so this adds no fetch.
//
// A missing or unreachable vault is normal, not an error (§5): it yields an
// empty list rather than taking the page down. The page distinguishes
// "no vault" from "vault broken" via getVaultSettings, not via this read.
export async function listEligibleNotes(
  userId: string,
): Promise<EligibleNote[]> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("people")
      .select("vault_path")
      .eq("user_id", userId)
      .not("vault_path", "is", null);
    // Archived rows count as linked: an excluded note holds its vault_path on
    // an archived row precisely so it stops reappearing here.
    const linked = new Set(
      ((data ?? []) as { vault_path: string }[]).map((row) =>
        pathKey(row.vault_path),
      ),
    );

    const corpus = await getVaultCorpus(userId);
    return (corpus.folders.get(PEOPLE_FOLDER) ?? [])
      .filter((note) => !linked.has(pathKey(note.path)))
      .map((note) => ({
        path: note.path,
        title: note.title,
        frontmatterType: note.frontmatter.type ?? null,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  } catch (error) {
    console.warn("people eligible-note listing failed", error);
    return [];
  }
}

// Phase 1: reconcile the roster against the vault's People/ notes.
//
// Its early exits are PHASE-LOCAL on purpose (M4 restructure): they used to
// return from the whole pass, which would have put the mention scan behind the
// no-vault check — but the scan is Postgres-only, and a user whose people are
// all hand-created (the Denise case, no vault at all) must still get candidates.
async function syncVaultNotes(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  {
    // The checklist decides the initial roster, not the sync. Before it is
    // answered this phase must not create anything — otherwise the self-note and
    // the pets are rows before the user is ever asked about them.
    //
    // Scoped to THIS phase, not the whole pass: countSeededRows counts rows with
    // a vault_path, so a user whose people are all hand-created has zero forever.
    // Gating the pass on it would have permanently starved exactly the Denise
    // case the phase split exists to serve — and the mention scan creates no
    // people rows, so it has no business behind a checklist gate.
    if ((await countSeededRows(supabase, userId)) === 0) return;

    // Credentials are THREADED, never resolved: getVaultCorpus and the
    // userId-only wrappers reach them through the cookie client (vault.ts:122),
    // which throws in after().
    const credentials = await readVaultCredentials(supabase, userId);
    if (!credentials) return; // no vault is normal, not an error

    const tag = vaultTag(userId);
    const entries = await listVaultNotePaths(credentials, tag);
    // Reaching here means the tree fetch SUCCEEDED, which is the only condition
    // under which stale-path nulling below is safe.
    const treePaths = new Set(entries.map((entry) => pathKey(entry.path)));

    const { data: rowData, error: readError } = await supabase
      .from("people")
      .select("id, name, vault_path, archived")
      .eq("user_id", userId);
    if (readError) throw readError;
    const rows = (rowData ?? []) as PersonRowLite[];

    const linked = new Map<string, PersonRowLite>();
    for (const row of rows) {
      if (row.vault_path) linked.set(pathKey(row.vault_path), row);
    }
    // Adoption targets only rows that hold NO vault_path, and only active ones.
    // The null restriction stops a renamed-away note's row from being retargeted
    // onto a stranger's new note; skipping archived rows stops a fresh note from
    // being adopted into the collapsed "not tracking" section, where its person
    // would silently never appear.
    const adoptable = new Map<string, PersonRowLite>();
    for (const row of rows) {
      if (row.vault_path || row.archived) continue;
      const key = row.name.trim().toLowerCase();
      if (!adoptable.has(key)) adoptable.set(key, row);
    }

    const unlinked = entries.filter(
      (entry) =>
        entry.folder === PEOPLE_FOLDER && !linked.has(pathKey(entry.path)),
    );

    const stamp = new Date().toISOString();
    const inserts: PeopleInsert[] = [];
    let curated: Map<string, string[]> | null = null;

    for (const entry of unlinked) {
      // Bodies are read ONLY for notes with no row yet, so the steady state is
      // zero blob fetches. { fresh: false } shares the cached tree rather than
      // forcing a second uncached listing per note; the cost is that a note
      // added in the last few minutes can miss one cycle and get picked up on
      // the next visit, which is fine for a backfill.
      const note = await readVaultNoteRaw(credentials, tag, entry.path, {
        fresh: false,
      });
      if (!note) continue;
      const { frontmatter } = parseFrontmatter(note.markdown);
      if (!isPersonNote(entry.folder, frontmatter.type ?? null)) continue;

      const name = noteTitle(entry.path);
      const adopted = adoptable.get(name.trim().toLowerCase());
      if (adopted) {
        adoptable.delete(name.trim().toLowerCase());
        // Adoption links an existing row; it does NOT reseed aliases, which are
        // a create-time, one-way copy (§5).
        const { error } = await supabase
          .from("people")
          .update({ vault_path: entry.path, updated_at: stamp })
          .eq("user_id", userId)
          .eq("id", adopted.id);
        if (error && !isUniqueViolation(error)) throw error;
        continue;
      }

      if (!curated) curated = await readCuratedAliases(supabase, userId);
      inserts.push({
        user_id: userId,
        name,
        vault_path: entry.path,
        aliases: seedAliases(name, curated.get(pathKey(entry.path))),
        archived: false,
        archived_at: null,
        updated_at: stamp,
      });
    }

    await upsertPeopleRows(supabase, inserts);

    // Stale paths: a rename leaves a row pointing at a note that no longer
    // exists. Nulling it collapses "corpus miss" and "never had a note" into
    // ONE state, so the person page has no unspecified third case.
    const stale = rows.filter(
      (row) => row.vault_path && !treePaths.has(pathKey(row.vault_path)),
    );
    if (stale.length > 0) {
      const { error } = await supabase
        .from("people")
        .update({ vault_path: null, updated_at: stamp })
        .eq("user_id", userId)
        .in(
          "id",
          stale.map((row) => row.id),
        );
      if (error) throw error;
    }
  }
}

// The post-response pass. Never throws: an after() throw is silent, so an
// uncaught one means the sync just stops happening with nothing in the UI to
// show for it (runMindspacePass, pipeline.ts:273-275).
export async function syncPeopleFromVault(userId: string): Promise<void> {
  try {
    // Service client, not the cookie client: after() runs outside the request
    // context, where cookies() throws. Every query below is explicitly
    // userId-scoped, per the multi-tenant invariant.
    const supabase = createServiceClient();

    await syncVaultNotes(supabase, userId);

    // Phase 2 (M4): mine new mindspace sessions for mentions of the roster.
    // Runs whether or not a vault is connected, and whether or not the seeding
    // checklist has been answered — sessions live in Postgres, and the scan
    // self-gates on an empty roster. Deliberately AFTER the upsert, so a person
    // created by this very pass can pick up candidates on the same run.
    await scanMentionsForUser(supabase, userId);
  } catch (error) {
    console.error("people sync failed", error);
  }
}
