-- One-shot "do this now" dispatches (spec: docs/superpowers/specs/2026-07-31-task-dispatch-design.md).
-- A dispatch is the queue row AND the future chat-thread root. status flow:
-- requested -> claimed -> running -> done | failed. Stale claimed/running rows
-- (>60 min) are re-claimable; attempts counts those claims so a dispatch that
-- kills the worker every time is retired instead of wedging the queue forever.
create table public.task_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  note text not null,
  status text not null default 'requested'
    check (status in ('requested','claimed','running','done','failed')),
  attempts int not null default 0,
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
-- Nothing deletes dispatches today; the policy exists so a future "cancel"
-- can, and so a session client can never reach past its own rows if it does.
create policy "task_dispatches_delete_own" on public.task_dispatches
  for delete using (auth.uid() = user_id);

create index task_dispatches_pending_idx
  on public.task_dispatches (user_id, status, created_at);

-- One live dispatch per task. The app checks first for a clean error; this is
-- what makes it true under a double-tap.
create unique index task_dispatches_one_open_per_task
  on public.task_dispatches (task_id)
  where status in ('requested', 'claimed', 'running');
