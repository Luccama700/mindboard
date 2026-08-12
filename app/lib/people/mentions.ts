import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "@/utils/supabase/service";
import { safeTimeZone } from "@/app/_components/date-utils";
import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { termPattern } from "@/app/lib/mindspace/classify";

// People M4: mention candidates from mindspace sessions (docs/people-plan.md
// §10 M4). A mention is evidence that a person was ON YOUR MIND. It becomes
// evidence of contact only when a human taps confirm — this module never writes
// a person_interactions row.
//
// SCAN INCREMENTALLY ON INGEST, NEVER SEARCH ON READ. An ILIKE/regex pass per
// person over an indefinitely-retained corpus gets permanently slower and would
// ship large volumes of raw session text into a page render. Each session is
// scanned ONCE against the whole roster, behind a per-user watermark; the person
// page then reads candidates by index and never scans.
//
// VAULT BODIES ARE NOT MENTION EVENTS. Sessions carry ended_at, an unambiguous
// instant; note bodies carry no per-sentence date, so a name appearing five
// times in one note is not five dated attention events. The 'noted' signal
// already covers the vault.

// The mindspace matcher's only false-positive defence (classify.ts:21), applied
// here for the same reason: two-letter names hit far too much prose.
const MIN_TERM_LENGTH = 3;
// THE defensive chokepoint for scan cost. normalizeAliases (app/actions/people.ts)
// caps the EDIT path at the same numbers, but aliases also arrive from
// seedAliases and from curated mindspace_topics rows, neither of which is
// bounded — and this is the one place any of them becomes a regex run against
// every new session inside after(). Capping here defends regardless of how the
// row got its aliases, including writers that do not exist yet.
const MAX_TERMS_PER_PERSON = 10;
const MAX_TERM_LENGTH = 40;
const EXCERPT_CHARS = 200;
// Sessions per incremental pass. A backlog drains over successive visits rather
// than making one page load pay for it; scanAllSessions is the explicit one-off.
const SCAN_BATCH = 200;

export type ScannablePerson = {
  id: string;
  name: string;
  aliases: string[] | null;
  archived: boolean;
};

export type ScannableSession = {
  provider: string;
  session_ref: string;
  ended_at: string; // timestamptz ISO
  user_text: string;
};

// mindspace_sessions is unique on (user_id, provider, session_ref) — session_ref
// ALONE is not unique, so storing it bare would let a claude_ai session and a
// claude_code session sharing a ref collide on
// person_mention_candidates_evidence_key, and the second one's candidate would
// be silently swallowed as a duplicate. Qualify it.
export function evidenceRef(provider: string, sessionRef: string): string {
  return `${provider}:${sessionRef}`;
}

export type CandidateDraft = {
  personId: string;
  sourceKind: "session";
  sourceRef: string;
  occurredAt: string; // the EVIDENCE's day, in the owner's zone
  excerpt: string;
  matchedTerm: string;
};

export type ScanResult = {
  candidates: CandidateDraft[];
  // Newest ended_at seen in this batch, or null when the batch was empty.
  // Advances even when NOTHING matched — a session that hit no one still counts
  // as scanned, which is precisely why the watermark cannot be derived from the
  // candidate rows.
  watermark: string | null;
};

type PersonMatcher = { id: string; terms: { term: string; re: RegExp }[] };

// Terms are the person's name plus their aliases, deduped case-insensitively
// and floored at 3 characters. Accents are NOT folded: "Daví" and "Davi" are
// distinct terms, the same accepted limitation the roster's lower(name) key has
// (§5) — folding correctly would need the unaccent extension.
export function buildPersonMatchers(
  people: ScannablePerson[],
): PersonMatcher[] {
  const matchers: PersonMatcher[] = [];
  for (const person of people) {
    if (person.archived) continue;
    const seen = new Set<string>();
    const terms: { term: string; re: RegExp }[] = [];
    for (const raw of [person.name, ...(person.aliases ?? [])]) {
      const term = (raw ?? "").trim();
      if (term.length < MIN_TERM_LENGTH) continue;
      if (term.length > MAX_TERM_LENGTH) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push({ term, re: termPattern(term) });
      if (terms.length >= MAX_TERMS_PER_PERSON) break;
    }
    // A person whose every term is under the floor is unmatchable, not a
    // match-everything wildcard.
    if (terms.length > 0) matchers.push({ id: person.id, terms });
  }
  return matchers;
}

// ~200 characters centred on the hit, sliced from the ORIGINAL text (the
// pattern is case-insensitive, so the match index refers to the original), with
// ellipses marking truncation. Never the whole session: the excerpt is the
// smallest thing that makes a candidate reviewable.
export function buildExcerpt(
  text: string,
  matchIndex: number,
  matchLength: number,
): string {
  const pad = Math.max(0, Math.floor((EXCERPT_CHARS - matchLength) / 2));
  const start = Math.max(0, matchIndex - pad);
  const end = Math.min(text.length, matchIndex + matchLength + pad);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

// The pure core: rows in, candidate rows out. No fetching, no writing, and the
// timezone is injected — so the whole matcher is unit-tested.
//
// ONE candidate per person × session, by construction: the first hit wins and
// the loop moves to the next person. Two people in one session yield two
// candidates; the same person named five times yields one, because a session is
// one piece of evidence, not five.
export function scanSessionsForMentions(input: {
  sessions: ScannableSession[];
  people: ScannablePerson[];
  timeZone: string | null;
}): ScanResult {
  const { sessions, people, timeZone } = input;
  const matchers = buildPersonMatchers(people);

  let watermark: string | null = null;
  const candidates: CandidateDraft[] = [];

  for (const session of sessions) {
    // Advance the watermark for EVERY session read, matched or not.
    if (watermark === null || session.ended_at > watermark) {
      watermark = session.ended_at;
    }
    if (matchers.length === 0) continue;

    const text = session.user_text ?? "";
    if (!text) continue;
    // The evidence's date is a day-grain fact in the OWNER'S zone: a session
    // ending 01:30Z is the previous day in Vancouver and the same day in Tokyo,
    // and this value lands in a `date` column.
    const occurredAt = zonedDateKey(Date.parse(session.ended_at), timeZone);

    for (const matcher of matchers) {
      for (const { term, re } of matcher.terms) {
        const hit = re.exec(text);
        if (!hit || hit.index === undefined) continue;
        candidates.push({
          personId: matcher.id,
          sourceKind: "session",
          sourceRef: evidenceRef(session.provider, session.session_ref),
          occurredAt,
          excerpt: buildExcerpt(text, hit.index, hit[0].length),
          matchedTerm: term,
        });
        break; // one candidate per person per session
      }
    }
  }

  return { candidates, watermark };
}

// ---------- the fetch/write shell ----------

async function readRoster(
  supabase: SupabaseClient,
  userId: string,
): Promise<ScannablePerson[]> {
  const { data } = await supabase
    .from("people")
    .select("id, name, aliases, archived")
    .eq("user_id", userId)
    .eq("archived", false);
  return (data ?? []) as ScannablePerson[];
}

async function readSettings(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ timeZone: string | null; watermark: string | null }> {
  const { data } = await supabase
    .from("user_settings")
    .select("timezone, people_scan_watermark")
    .eq("user_id", userId)
    .maybeSingle();
  const row = data as {
    timezone: string | null;
    people_scan_watermark: string | null;
  } | null;
  return {
    timeZone: safeTimeZone(row?.timezone ?? null),
    watermark: row?.people_scan_watermark ?? null,
  };
}

// user_settings.user_id is the table's PRIMARY KEY (0011), so this upserts
// rather than silently matching zero rows for a user who has no settings row —
// an .update() there would leave the watermark null forever and rescan the
// whole corpus on every visit.
async function saveWatermark(
  supabase: SupabaseClient,
  userId: string,
  watermark: string,
): Promise<void> {
  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: userId, people_scan_watermark: watermark },
      { onConflict: "user_id" },
    );
  if (error) throw error;
}

async function writeCandidates(
  supabase: SupabaseClient,
  userId: string,
  drafts: CandidateDraft[],
): Promise<void> {
  if (drafts.length === 0) return;
  // ignoreDuplicates on person_mention_candidates_evidence_key: a rescan or two
  // concurrent scans settle to one row per piece of evidence rather than
  // throwing inside after().
  const { error } = await supabase.from("person_mention_candidates").upsert(
    drafts.map((draft) => ({
      user_id: userId,
      person_id: draft.personId,
      source_kind: draft.sourceKind,
      source_ref: draft.sourceRef,
      occurred_at: draft.occurredAt,
      excerpt: draft.excerpt,
      matched_term: draft.matchedTerm,
    })),
    {
      onConflict: "user_id,person_id,source_kind,source_ref",
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;
}

// The incremental pass, chained from the people page's after() sync. Sessions
// live in Postgres, so this needs no vault credentials at all.
//
// Throws on failure: the caller (syncPeopleFromVault) owns the single try/catch,
// because an after() throw is silent.
export async function scanMentionsForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ scanned: number; created: number }> {
  const people = await readRoster(supabase, userId);
  if (people.length === 0) return { scanned: 0, created: 0 };

  const { timeZone, watermark } = await readSettings(supabase, userId);

  // NULL watermark = never scanned. Initialize it to the newest session and
  // write NOTHING: historical backfill is an explicit, paginated one-off
  // (scanAllSessions), not read-path behaviour (§10 M4). Otherwise a first
  // visit would scan an indefinitely-retained corpus inside after().
  if (watermark === null) {
    const { data } = await supabase
      .from("mindspace_sessions")
      .select("ended_at")
      .eq("user_id", userId)
      .order("ended_at", { ascending: false })
      .limit(1);
    const newest = (data ?? [])[0] as { ended_at: string } | undefined;
    if (newest) await saveWatermark(supabase, userId, newest.ended_at);
    return { scanned: 0, created: 0 };
  }

  const { data: sessionData, error } = await supabase
    .from("mindspace_sessions")
    .select("provider, session_ref, ended_at, user_text")
    .eq("user_id", userId)
    // gte, not gt: the watermark IS the newest session already scanned, so `gt`
    // permanently skips any session sharing that exact instant — two sessions
    // ending in the same millisecond, or the boundary session itself after an
    // initialize. Re-covering it is free, because the evidence key makes a
    // repeat candidate a no-op.
    .gte("ended_at", watermark)
    .order("ended_at", { ascending: true })
    .limit(SCAN_BATCH);
  if (error) throw error;

  const sessions = (sessionData ?? []) as ScannableSession[];
  if (sessions.length === 0) return { scanned: 0, created: 0 };

  const result = scanSessionsForMentions({ sessions, people, timeZone });

  // Candidates first, watermark second: a crash between them re-scans sessions
  // whose candidates already landed, and the evidence key makes that a no-op.
  // The reverse order would lose them permanently.
  await writeCandidates(supabase, userId, result.candidates);
  if (result.watermark) await saveWatermark(supabase, userId, result.watermark);

  return { scanned: sessions.length, created: result.candidates.length };
}

// Explicit, paginated historical backfill. NOT wired to any read path — call it
// deliberately (a script or an admin action) when a user wants their existing
// session corpus mined.
//
// PAGE WITH THE CURSOR, or it loops: each call walks `limit` sessions with
// ended_at > `after` and returns the newest one it saw. Feed that back as the
// next call's `after` and stop when `scanned` is 0. Omitting `after` starts at
// the beginning of time — deliberately ignoring the incremental watermark,
// since the whole point is to reach sessions it has already skipped past. The
// evidence key makes re-covering old ground a no-op.
export async function scanAllSessions(
  userId: string,
  options?: { limit?: number; after?: string | null },
): Promise<{ scanned: number; created: number; watermark: string | null }> {
  const supabase = createServiceClient();
  const limit = Math.min(Math.max(1, options?.limit ?? 500), 2000);

  const people = await readRoster(supabase, userId);
  if (people.length === 0) {
    return { scanned: 0, created: 0, watermark: null };
  }
  const { timeZone } = await readSettings(supabase, userId);

  let query = supabase
    .from("mindspace_sessions")
    .select("provider, session_ref, ended_at, user_text")
    .eq("user_id", userId)
    .order("ended_at", { ascending: true })
    .limit(limit);
  // gt here, not gte: this cursor pages FORWARD through a finite corpus, so
  // re-including the previous page's last row would stall the walk. The
  // incremental watermark has the opposite requirement (see scanMentionsForUser).
  if (options?.after) query = query.gt("ended_at", options.after);
  const { data, error } = await query;
  if (error) throw error;

  const sessions = (data ?? []) as ScannableSession[];
  if (sessions.length === 0) {
    return { scanned: 0, created: 0, watermark: null };
  }

  const result = scanSessionsForMentions({ sessions, people, timeZone });
  await writeCandidates(supabase, userId, result.candidates);

  return {
    scanned: sessions.length,
    created: result.candidates.length,
    watermark: result.watermark,
  };
}
