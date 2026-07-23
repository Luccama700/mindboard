-- Recurring-task slots: one row = per-occurrence committed time for a recurring
-- task (approved from a gap proposal). Delete = revert to a soft proposal. A
-- slot overrides the rule's due_time for that day and counts as busy time
-- everywhere a timed recurring occurrence does (never double-counted).

create table public.recurring_task_slots (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  rule_id      uuid not null references public.recurring_tasks (id) on delete cascade,
  occurred_on  date not null,
  start_time   time not null,
  duration_min integer check (duration_min > 0),
  created_at   timestamptz not null default now(),
  unique (rule_id, occurred_on)
);

create index recurring_task_slots_user_day_idx
  on public.recurring_task_slots (user_id, occurred_on);

alter table public.recurring_task_slots enable row level security;

create policy "recurring_task_slots_select_own" on public.recurring_task_slots
  for select using (auth.uid() = user_id);
create policy "recurring_task_slots_insert_own" on public.recurring_task_slots
  for insert with check (auth.uid() = user_id);
create policy "recurring_task_slots_update_own" on public.recurring_task_slots
  for update using (auth.uid() = user_id);
create policy "recurring_task_slots_delete_own" on public.recurring_task_slots
  for delete using (auth.uid() = user_id);
