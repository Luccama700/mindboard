-- People groups: optional CONTEXTS for the roster (family / school / work),
-- mirroring inventory_groups (0004).
--
-- A group is a CONTEXT, never a closeness tier. docs/people-plan.md §3.1 and
-- §3.6 forbid ranking people — no streaks, no counters, no product-imposed
-- tiers — and that rule does not stop at the person row. "close friends" /
-- "inner circle" / "acquaintances" are not valid groups; "family", "ubc",
-- "work", "brazil" are. Nothing in this schema enforces that (a text column
-- cannot), so the constraint lives in the UI copy and in the group-suggester's
-- prompt (app/lib/people/suggest-groups.ts).
--
-- Membership is optional and single-valued: people.group_id is nullable, and a
-- person that fits no context stays unassigned rather than being filed
-- somewhere for tidiness.

create table public.people_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  -- Same default as inventory_groups: the first swatch of the shared 12-colour
  -- palette (PALETTE in app/_components/color-picker.tsx).
  color       text not null default '#B5FF3C',
  created_at  timestamptz not null default now()
);

-- A UNIQUE INDEX, not a table constraint: the key is an expression
-- (lower(name)), and Postgres only accepts expressions in an index. Same shape
-- as people_user_name_key (0047), minus the `where not archived` predicate —
-- groups have no archive, so this one is total and usable as an ON CONFLICT
-- arbiter if a writer ever needs one.
create unique index people_groups_user_name_key
  on public.people_groups (user_id, lower(name));

-- No separate (user_id) index: the unique index above already leads with
-- user_id and serves the "list this user's groups" read, exactly as 0047
-- argues for `people`.

alter table public.people_groups enable row level security;

create policy "people_groups_select_own"
  on public.people_groups for select
  using (auth.uid() = user_id);

create policy "people_groups_insert_own"
  on public.people_groups for insert
  with check (auth.uid() = user_id);

create policy "people_groups_update_own"
  on public.people_groups for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "people_groups_delete_own"
  on public.people_groups for delete
  using (auth.uid() = user_id);

-- ON DELETE SET NULL, like inventory_items.inventory_group_id: deleting a
-- context must never delete the people in it. The members simply become
-- unassigned, which is the same state a never-grouped person is in.
alter table public.people
  add column group_id uuid references public.people_groups (id) on delete set null;

create index people_user_group_idx on public.people (user_id, group_id);
