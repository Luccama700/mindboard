-- People: the relationship layer.
-- The vault's People/*.md note is the WHO (identity, narrative, maintained by AI chats).
-- Mindboard owns the WHEN: recency, cadence, and an explicit interaction log.
-- Derived values (days since contact, overdue-ness) are computed at read time, never stored.
-- RLS scoped by auth.uid().

create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- Nullable: a person can exist without a vault note (e.g. someone named only in
  -- another person's prose). Unique per user when present, so the lazy upsert from
  -- the vault is idempotent.
  vault_path text,
  -- Name variants for mention matching ("Lucca" for "Lucca Martins de Andrade").
  -- Seeded from the matching mindspace_topics row's aliases, else from the note
  -- basename's tokens; user-editable. DORMANT until M4.
  aliases text[] not null default '{}',
  -- Opt-in cadence. NULL means this person never generates attention.
  -- No defaults are ever shipped by relationship type. (A CHECK already passes on
  -- NULL, so no `is null or` branch is needed.)
  checkin_days int check (checkin_days > 0),
  -- Persisted "not now". A suggestion for this person stays suppressed until this
  -- date. Dismissal has to be state: a suggestion that reappears on reload or on
  -- another device is exactly the nagging principle 8 forbids. M3.
  attention_snoozed_until date,
  archived boolean not null default false,
  -- Stamped on archive so the collapsed "not tracking" section can order by it,
  -- per inventory_items.archived_at (0019).
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  -- No triggers exist in this codebase; every writer sets this explicitly.
  updated_at timestamptz not null default now()
);

-- DELIBERATELY NOT PARTIAL, unlike the name index below, and unlike the design
-- doc's DDL. Postgres will only infer a PARTIAL unique index as an ON CONFLICT
-- arbiter when the statement repeats the index predicate in its conflict target,
-- and PostgREST/supabase-js `.upsert(rows, { onConflict: "user_id,vault_path" })`
-- has no way to send one -- the vault sync would fail at runtime with "no unique
-- or exclusion constraint matching the ON CONFLICT specification", inside after(),
-- where nothing surfaces it. Under default NULLS DISTINCT semantics a plain unique
-- on (user_id, vault_path) allows unlimited NULL-path rows anyway, so this is
-- identical in behaviour and valid as an arbiter.
create unique index people_user_vault_path_key
  on public.people (user_id, vault_path);

-- Partial on `not archived`, per 0031_spend_limits.sql:31-38. A non-partial unique
-- would let an archived person block their name forever -- breaking both the search
-- field's `add "davi"` and the vault sync's adoption step, with a raw unique
-- violation and no UI branch to catch it.
create unique index people_user_name_key
  on public.people (user_id, lower(name))
  where not archived;

-- No separate (user_id) index: people_user_name_key already leads with user_id and
-- serves the roster read, so a second one would be write cost for no read benefit
-- at 20-100 rows. 0031 ships a single plain index for the same reason.

alter table public.people enable row level security;

create policy "people_select_own"
  on public.people for select
  using (auth.uid() = user_id);

create policy "people_insert_own"
  on public.people for insert
  with check (auth.uid() = user_id);

create policy "people_update_own"
  on public.people for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "people_delete_own"
  on public.people for delete
  using (auth.uid() = user_id);

create table public.person_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- No composite FK tying person_id back to this row's user_id. That is the house
  -- pattern (spend_limits.category_id -> spending_categories has the same gap in
  -- 0031), and RLS still hides cross-tenant rows on read, so the exposure is orphan
  -- integrity rather than disclosure. Accepted explicitly, not by omission.
  person_id uuid not null references public.people (id) on delete cascade,
  -- What happened, in the user's terms. Records what the USER did or said,
  -- never an inference about the other person's state. See the privacy section.
  -- NULLABLE on purpose: the one-tap "talked" control (M1) writes no prose
  -- (summary null, source 'logged') and renders as a plain "talked". A not-null
  -- column would force a text field, and one tap that opens a textarea is not
  -- one tap.
  summary text,
  -- Date only: this is a day-grain fact, and storing an instant would invite
  -- UTC-slicing bugs downstream. Always written from a resolved user-zone day.
  occurred_at date not null,
  -- How much to trust that date. 'approx' is written by any path that cannot know
  -- the real day -- the backfill chips, and M4's candidate confirmation, where a
  -- session dated Aug 11 may say "I talked to Davi last month". An 'approx' row
  -- NEVER renders a fabricated exact date; the UI says "about a month ago".
  occurred_precision text not null default 'exact'
    check (occurred_precision in ('exact', 'approx')),
  -- Provenance. 'logged' = stated outright by the user (or the assistant on their
  -- behalf); 'confirmed' = promoted from a mindspace mention by an explicit tap
  -- (M4 only). The page shows this; it is not decoration.
  source text not null default 'logged'
    check (source in ('logged', 'confirmed')),
  created_at timestamptz not null default now()
);

create index person_interactions_user_person_idx
  on public.person_interactions (user_id, person_id, occurred_at desc);

-- A double-tapped mention confirm, or a retried action, must not insert twice.
-- Promoted mentions are one-per-person-per-day by construction. 'logged' rows are
-- deliberately NOT deduped: two real conversations on one day are a real thing.
create unique index person_interactions_confirmed_key
  on public.person_interactions (user_id, person_id, occurred_at)
  where source = 'confirmed';

alter table public.person_interactions enable row level security;

create policy "person_interactions_select_own"
  on public.person_interactions for select
  using (auth.uid() = user_id);

create policy "person_interactions_insert_own"
  on public.person_interactions for insert
  with check (auth.uid() = user_id);

create policy "person_interactions_update_own"
  on public.person_interactions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "person_interactions_delete_own"
  on public.person_interactions for delete
  using (auth.uid() = user_id);
