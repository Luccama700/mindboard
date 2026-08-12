import "server-only";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import type {
  MentionCandidate,
  Person,
  PersonGroup,
  PersonInteraction,
} from "@/app/_components/people-types";

// Reusable People reads. Selects mirror app/people/page.tsx; RLS scopes every
// row to the caller, and the explicit user_id filter matches the house pattern
// in app/lib/data/finance.ts. Each read is React-cache()'d, so the roster, the
// dossier and (later) the stream hit the database once per request. userId is
// the cache key.

const PEOPLE_COLUMNS =
  "id, name, vault_path, aliases, group_id, checkin_days, attention_snoozed_until, archived, archived_at, created_at, updated_at";
const GROUP_COLUMNS = "id, name, color, created_at";
const INTERACTION_COLUMNS =
  "id, person_id, summary, occurred_at, occurred_precision, source, created_at";
const CANDIDATE_COLUMNS =
  "id, person_id, source_kind, source_ref, occurred_at, excerpt, matched_term, status, reviewed_at, created_at";
// Review is PULL, not push: the affordance is quiet and the list is short.
const MAX_CANDIDATES = 50;

// A FAILED QUERY IS NOT AN EMPTY ROSTER. `data ?? []` collapses the two, so a
// missing column or table — the state between a code deploy and its migration
// being applied — renders a calm "nobody yet" over a live roster of twenty
// people, and the user's reasonable next move is to start re-adding them.
// Throwing instead lets the page's error boundary say something is broken,
// which is the truth. Applied to every read that touches 0049's new column or
// table; the interaction and candidate reads are unchanged.
function orThrow<T>(
  what: string,
  result: { data: unknown; error: { message: string } | null },
): T[] {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return (result.data ?? []) as T[];
}

// Archived rows are RETURNED, not filtered. The roster needs them for two
// separate reasons: the collapsed "not tracking" section renders them, and the
// vault-note union keys off vault_path — an archived row still holds one, and
// dropping it here would resurrect an excluded note (the self-note, a pet) as
// an unpersisted entry on every visit. Split on `.archived` in the client.
export const getPeople = cache(async (userId: string): Promise<Person[]> => {
  const supabase = await createClient();
  const result = await supabase
    .from("people")
    .select(PEOPLE_COLUMNS)
    .eq("user_id", userId)
    .order("name", { ascending: true })
    .order("id", { ascending: true });
  return orThrow<Person>("could not load people", result);
});

// The roster's optional CONTEXTS (family / ubc / work — never closeness
// tiers, see 0049_people_groups.sql). Ordered by name so the page renders a
// stable, alphabetical set of sections; the order ends in id to stay total if
// two groups ever collide case-insensitively across a rename race.
export const getPeopleGroups = cache(
  async (userId: string): Promise<PersonGroup[]> => {
    const supabase = await createClient();
    const result = await supabase
      .from("people_groups")
      .select(GROUP_COLUMNS)
      .eq("user_id", userId)
      .order("name", { ascending: true })
      .order("id", { ascending: true });
    return orThrow<PersonGroup>("could not load groups", result);
  },
);

// null means "no such person", which the dossier renders as a 404. A broken
// query must not arrive as that same null — see orThrow above.
export const getPerson = cache(
  async (userId: string, personId: string): Promise<Person | null> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("people")
      .select(PEOPLE_COLUMNS)
      .eq("user_id", userId)
      .eq("id", personId)
      .maybeSingle();
    if (error) throw new Error(`could not load person: ${error.message}`);
    return (data as Person | null) ?? null;
  },
);

// One person's log, newest first. The order ends in `id` to make it TOTAL:
// occurred_at is a `date`, so a day with two conversations would otherwise
// order arbitrarily between renders.
export const getPersonInteractions = cache(
  async (userId: string, personId: string): Promise<PersonInteraction[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("person_interactions")
      .select(INTERACTION_COLUMNS)
      .eq("user_id", userId)
      .eq("person_id", personId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true });
    return (data ?? []) as PersonInteraction[];
  },
);

// Unreviewed mention candidates, newest evidence first — read BY INDEX
// (person_mention_candidates_review_idx), never by scanning session text. Only
// 'new' rows: confirmed and dismissed ones are settled and must not resurface.
export const getCandidates = cache(
  async (userId: string, personId?: string): Promise<MentionCandidate[]> => {
    const supabase = await createClient();
    let query = supabase
      .from("person_mention_candidates")
      .select(CANDIDATE_COLUMNS)
      .eq("user_id", userId)
      .eq("status", "new");
    if (personId) query = query.eq("person_id", personId);
    const { data } = await query
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(MAX_CANDIDATES);
    return (data ?? []) as MentionCandidate[];
  },
);

// personId → unreviewed count, for the roster's quiet "worth a look" affordance.
// Rendered as a band rather than a tally per §3.1 — the count exists inside the
// read, it just should not reach the page as a number.
export const getCandidateCounts = cache(
  async (userId: string): Promise<Map<string, number>> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("person_mention_candidates")
      .select("person_id")
      .eq("user_id", userId)
      .eq("status", "new");
    const counts = new Map<string, number>();
    for (const row of (data ?? []) as { person_id: string }[]) {
      counts.set(row.person_id, (counts.get(row.person_id) ?? 0) + 1);
    }
    return counts;
  },
);

// Last talked, for every person at once: the roster needs it on ~20-100 rows
// and must not issue a query per row. One descending read, first row per
// person_id wins.
//
// The cap is generous rather than exact. Ordering descending means an
// overflowing log costs the oldest history first, so the only way to lose a
// person's entry is for them to have no interaction inside the newest
// INTERACTION_SCAN_LIMIT rows — unreachable at this feature's scale, and the
// per-person read above is unbounded and authoritative for the dossier.
const INTERACTION_SCAN_LIMIT = 5000;

export const getLatestInteractions = cache(
  async (userId: string): Promise<Map<string, PersonInteraction>> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("person_interactions")
      .select(INTERACTION_COLUMNS)
      .eq("user_id", userId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(INTERACTION_SCAN_LIMIT);
    const latest = new Map<string, PersonInteraction>();
    for (const row of (data ?? []) as PersonInteraction[]) {
      if (!latest.has(row.person_id)) latest.set(row.person_id, row);
    }
    return latest;
  },
);
