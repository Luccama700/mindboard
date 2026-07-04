-- ============================================================================
-- mindboard goals
-- The "intent" layer for the AI second brain: what the user is trying to
-- achieve, so "what should I do next" can rank against more than due dates.
-- Optionally linked to a group so goal progress can borrow that group's tasks.
-- RLS scoped by auth.uid().
-- ============================================================================

create table public.goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  title        text not null,
  why          text,
  horizon      text not null default 'quarter'
               check (horizon in ('week', 'month', 'quarter', 'year', 'life')),
  status       text not null default 'active'
               check (status in ('active', 'done', 'paused', 'archived')),
  target_date  date,
  group_id     uuid references public.groups (id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index goals_user_id_idx on public.goals (user_id);

alter table public.goals enable row level security;

create policy "goals_select_own"
  on public.goals for select
  using (auth.uid() = user_id);

create policy "goals_insert_own"
  on public.goals for insert
  with check (auth.uid() = user_id);

create policy "goals_update_own"
  on public.goals for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "goals_delete_own"
  on public.goals for delete
  using (auth.uid() = user_id);
