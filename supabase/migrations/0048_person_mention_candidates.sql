-- People M4: mention candidates.
-- Evidence that a person was ON YOUR MIND — never that you were in contact.
-- The confirm tap is the boundary: only a human turns a candidate into a
-- person_interactions row (docs/people-plan.md §2). 0047's `source` column
-- distinguishes only 'logged' from 'confirmed', so there is nowhere in it to
-- record WHICH mention produced an interaction, which were reviewed, or which
-- were dismissed — without this table a rescan rediscovers the same mentions
-- forever and "unreviewed" is not computable.
-- RLS scoped by auth.uid().

create table public.person_mention_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  source_kind text not null check (source_kind in ('session', 'calendar')),
  source_ref text not null,        -- session_ref, or the calendar event id
  occurred_at date not null,       -- the EVIDENCE's date (session end / event day)
  excerpt text,                    -- matched passage, capped; null for calendar
  matched_term text,               -- which alias hit, so a noisy alias is diagnosable
  status text not null default 'new'
    check (status in ('new', 'confirmed', 'dismissed')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Makes rescans idempotent: one piece of evidence never yields a second
-- candidate. Deliberately NOT partial, unlike 0047's name index, so it is a
-- valid ON CONFLICT arbiter for the scan's ignoreDuplicates upsert — two
-- concurrent scans settle to one row instead of throwing inside after().
create unique index person_mention_candidates_evidence_key
  on public.person_mention_candidates (user_id, person_id, source_kind, source_ref);

create index person_mention_candidates_review_idx
  on public.person_mention_candidates (user_id, person_id, status, occurred_at desc);

alter table public.person_mention_candidates enable row level security;

create policy "person_mention_candidates_select_own"
  on public.person_mention_candidates for select
  using (auth.uid() = user_id);

create policy "person_mention_candidates_insert_own"
  on public.person_mention_candidates for insert
  with check (auth.uid() = user_id);

create policy "person_mention_candidates_update_own"
  on public.person_mention_candidates for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "person_mention_candidates_delete_own"
  on public.person_mention_candidates for delete
  using (auth.uid() = user_id);

-- The incremental scan's watermark: the newest mindspace_sessions.ended_at that
-- has already been scanned against the roster. It cannot be derived from the
-- candidate rows, because a session that matched nobody leaves no trace there —
-- without this column every scan would re-read the whole retained corpus, which
-- is exactly the unbounded read-path search §10 M4 forbids.
--
-- NULL means "never scanned": the first run initializes it to the newest
-- session and writes no candidates, because historical backfill is an explicit,
-- paginated one-off (scanAllSessions), not read-path behaviour.
alter table public.user_settings
  add column people_scan_watermark timestamptz;
