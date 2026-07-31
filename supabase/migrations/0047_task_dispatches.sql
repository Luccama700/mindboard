-- One-shot "do this now" dispatches (spec: docs/superpowers/specs/2026-07-31-task-dispatch-design.md).
-- A dispatch is the queue row AND the future chat-thread root. status flow:
-- requested -> claimed -> running -> done | failed. Stale claimed/running rows
-- (>60 min) are re-claimable.
create table public.task_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  note text not null,
  status text not null default 'requested'
    check (status in ('requested','claimed','running','done','failed')),
  result_summary text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);

alter table public.task_dispatches enable row level security;

create policy "task_dispatches_select_own" on public.task_dispatches
  for select using (auth.uid() = user_id);
create policy "task_dispatches_insert_own" on public.task_dispatches
  for insert with check (auth.uid() = user_id);
create policy "task_dispatches_update_own" on public.task_dispatches
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index task_dispatches_pending_idx
  on public.task_dispatches (user_id, status, created_at);
