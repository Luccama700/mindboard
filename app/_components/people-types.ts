// Shared People types, mirroring the inventory-types.ts / finance-types.ts
// pattern. The WHO lives in the vault note; these rows are the WHEN layer
// (docs/people-plan.md §2, §5).

export type Person = {
  id: string;
  name: string;
  vault_path: string | null;
  aliases: string[];
  // Optional context, never a closeness tier (family / school / brazil —
  // the docs/people-plan.md §3 anti-ranking rule applies to groups too).
  group_id: string | null;
  checkin_days: number | null;
  attention_snoozed_until: string | null;
  archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PersonGroup = {
  id: string;
  name: string;
  color: string;
  created_at: string;
};

export type PersonInteraction = {
  id: string;
  person_id: string;
  summary: string | null;
  occurred_at: string;
  // 'approx' rows never render a fabricated date — "about a week ago",
  // never "aug 4" (docs/people-plan.md §2.4).
  occurred_precision: "exact" | "approx";
  source: "logged" | "confirmed";
  created_at: string;
};

export type MentionCandidate = {
  id: string;
  person_id: string;
  source_kind: "session" | "calendar";
  source_ref: string;
  // The EVIDENCE's date (session end day), not the interaction's —
  // confirmation asks "when" separately (docs/people-plan.md §10 M4).
  occurred_at: string;
  excerpt: string | null;
  matched_term: string | null;
  status: "new" | "confirmed" | "dismissed";
  reviewed_at: string | null;
  created_at: string;
};

// A roster entry: a persisted row, or an eligible vault note the after()
// sync hasn't backfilled yet. Unpersisted entries render read-only —
// no cadence control, no interaction log, both need an id (§5).
export type RosterEntry = {
  person: Person | null;
  vaultPath: string | null;
  name: string;
  intro: string | null;
  lastTalked: PersonInteraction | null;
  noteUpdated: string | null;
};
