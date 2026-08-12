// Pure people-attention rollup (docs/people-plan.md §7). No fetching, no React,
// no server imports: `today` is injected, so the whole thing is unit-tested —
// the house snapshot pattern (app/lib/snapshots/tasks.ts).
//
// TWO functions, not one. A single peopleSnapshot({ ..., openLoops }) cannot be
// assembled the way the callers require: the assembler must know WHO survived
// before it fetches loops for them, but it cannot know that without having
// already called the function. Splitting resolves the circularity and is what
// makes the "at most three" bound expressible at all.

import type { Person, PersonInteraction } from "@/app/_components/people-types";
import { daysBetweenKeys } from "@/app/_components/people-recency";
import { addDaysKey } from "@/app/_components/finance-projection";

export type PersonAttention = {
  personId: string;
  name: string;
  vaultPath: string | null;
  // Non-null BY CONSTRUCTION: a person with a cadence but nothing logged is
  // excluded entirely (see the rules below), which is what lets this type as
  // `number`. Allowing null would make overdueBy NaN, silently degrade the
  // ordering, and force a non-null assertion at the exact site where the
  // exclusion rule is meant to be load-bearing.
  daysSinceTalked: number;
  checkinDays: number;
  overdueBy: number;
  lastInteraction:
    | { summary: string | null; occurredAt: string; precision: "exact" | "approx" }
    | null;
  // Filled by hydratePeopleAttention; [] out of computePeopleAttention.
  openLoops: string[];
};

export type PeopleVitals = {
  total: number;
  tracked: number;
  attention: PersonAttention[];
};

export type PeopleAttentionInput = {
  people: Person[];
  // Only the newest row per person is read, but passing the full log is
  // harmless — the reducer keeps the most recent occurred_at per person.
  interactions: PersonInteraction[];
  // M4's person_mention_candidates. Empty until then; typed loosely on purpose
  // so the migration that introduces the row type does not have to land first.
  // Drives suppression (§2's asymmetry rule) when it arrives.
  candidates: unknown[];
  today: string;
};

// Returns the COMPLETE ranked set, unbounded: if thirty people are overdue,
// thirty survive. "At most one" (/people) and "at most three" (get_snapshot)
// are properties of the CALLER, not of this function.
export function computePeopleAttention(
  input: PeopleAttentionInput,
): PeopleVitals {
  const { people, interactions, today } = input;

  const active = people.filter((person) => !person.archived);

  // Newest logged interaction per person. 'talked' only — vault `updated` never
  // enters this math, because editing a note about someone is being informed,
  // not being in touch (§2). 'approx' rows count normally: the date is real
  // enough for cadence, it just must not be RENDERED as a firm day.
  const latest = new Map<string, PersonInteraction>();
  for (const row of interactions) {
    const held = latest.get(row.person_id);
    if (!held || row.occurred_at > held.occurred_at) latest.set(row.person_id, row);
  }

  const attention: PersonAttention[] = [];
  let tracked = 0;

  for (const person of active) {
    const checkinDays = person.checkin_days;
    // Attention is opt-in: no cadence means this person never surfaces (§3.2).
    if (checkinDays === null) continue;
    // Snoozed people are still TRACKED — the cadence is set, it is just quiet
    // for now — so the count reflects what the user opted into, not what the
    // page happens to be showing today.
    tracked += 1;

    // A persisted "not now" (§8). The snooze covers days strictly BEFORE the
    // stored date; on the date itself the person is eligible again, so
    // "snoozed until the 18th" means the 18th is when they come back.
    const snoozedUntil = person.attention_snoozed_until;
    if (snoozedUntil !== null && snoozedUntil > today) continue;

    const last = latest.get(person.id);
    // Eligible and never logged → excluded entirely. A cadence with no logged
    // interaction is a setup gap, not an overdue relationship, and the backfill
    // prompt (§2) is what closes it.
    if (!last) continue;

    const daysSinceTalked = daysBetweenKeys(last.occurred_at, today);
    if (daysSinceTalked <= checkinDays) continue;

    attention.push({
      personId: person.id,
      name: person.name,
      vaultPath: person.vault_path,
      daysSinceTalked,
      checkinDays,
      overdueBy: daysSinceTalked - checkinDays,
      lastInteraction: {
        summary: last.summary,
        occurredAt: last.occurred_at,
        precision: last.occurred_precision,
      },
      openLoops: [],
    });
  }

  // Total on purpose, so the order never depends on the input's row order:
  // most overdue first, then alphabetically, then by id.
  attention.sort(
    (a, b) =>
      b.overdueBy - a.overdueBy ||
      a.name.localeCompare(b.name) ||
      a.personId.localeCompare(b.personId),
  );

  return { total: active.length, tracked, attention };
}

// Attach vault prose to an ALREADY-BOUNDED slice: the caller passes
// attention.slice(0, N), never the unbounded array, because the only way to
// produce loops for an unknown set of people is a corpus-weight read (§7).
//
// Keyed by personId, NOT vaultPath: vault_path is nullable, and Denise — the
// brief's own motivating example — has no note, so a vaultPath-keyed map has no
// slot for her at all and would make the type quietly lie about which people
// can carry loops.
export function hydratePeopleAttention(
  attention: PersonAttention[],
  openLoops: Record<string, string[]>,
): PersonAttention[] {
  return attention.map((entry) => ({
    ...entry,
    openLoops: openLoops[entry.personId] ?? [],
  }));
}

// ---------- backfill chips ----------

export type BackfillChoice =
  | "today"
  | "this_week"
  | "this_month"
  | "longer_ago"
  | "not_sure";

export type BackfillResult = {
  occurredAt: string;
  precision: "exact" | "approx";
};

// Setting a cadence prompts ONE backfill question, and each answer resolves to
// a concrete day by arithmetic on the page's resolved `today` — never a device
// clock, never a bare new Date() — because the answer lands in a `date` column
// and therefore persists instead of healing on hydration (§2.4).
//
// Only "today" is exact. The other three write 'approx' so the page says "about
// a week ago" rather than inventing "aug 4", which is the fabricated-precision
// failure this doctrine exists to refuse.
//
// Shared by the chip UI and the server action deliberately: one definition
// means the chips cannot drift from what the action accepts.
export function backfillToDate(
  choice: BackfillChoice,
  today: string,
): BackfillResult | null {
  switch (choice) {
    case "today":
      return { occurredAt: today, precision: "exact" };
    case "this_week":
      return { occurredAt: addDaysKey(today, -3), precision: "approx" };
    case "this_month":
      return { occurredAt: addDaysKey(today, -14), precision: "approx" };
    case "longer_ago":
      return { occurredAt: addDaysKey(today, -60), precision: "approx" };
    // A legitimate terminal state, not an error: no row is written, and §7's
    // exclusion rule keeps that person quiet until there is one.
    case "not_sure":
      return null;
  }
}
