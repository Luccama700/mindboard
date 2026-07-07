-- Recurring tasks: rule templates whose occurrences are computed, never
-- materialized as task rows. Weekly rules can land on several weekdays
-- (gym mon/wed/fri = one rule). due_time null = untimed (list-only; timed
-- rules also render as week-view blocks and count as busy time).

create table public.recurring_tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  group_id      uuid references public.groups (id) on delete set null,
  title         text not null,
  notes         text,
  priority      text not null default 'med' check (priority in ('low', 'med', 'high')),
  frequency     text not null check (frequency in ('daily', 'weekly', 'monthly', 'custom')),
  weekdays      int[] check (
                  weekdays is null
                  or (
                    array_length(weekdays, 1) between 1 and 7
                    and weekdays <@ array[0, 1, 2, 3, 4, 5, 6]
                  )
                ),
  day_of_month  int check (day_of_month between 1 and 31),
  interval_days int check (interval_days >= 1),
  start_date    date,
  due_time      time,
  duration_min  int check (duration_min > 0),
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  check (frequency <> 'weekly' or weekdays is not null),
  check (frequency <> 'monthly' or day_of_month is not null),
  check (frequency <> 'custom' or (interval_days is not null and start_date is not null))
);

create index recurring_tasks_user_id_idx on public.recurring_tasks (user_id);

alter table public.recurring_tasks enable row level security;

create policy "recurring_tasks_select_own" on public.recurring_tasks
  for select using (auth.uid() = user_id);
create policy "recurring_tasks_insert_own" on public.recurring_tasks
  for insert with check (auth.uid() = user_id);
create policy "recurring_tasks_update_own" on public.recurring_tasks
  for update using (auth.uid() = user_id);
create policy "recurring_tasks_delete_own" on public.recurring_tasks
  for delete using (auth.uid() = user_id);

-- Completion history: one row per (rule, day). Insert = done, delete = undo;
-- a missed day simply has no row (skip-silently, no overdue pile-up).

create table public.recurring_task_completions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  rule_id      uuid not null references public.recurring_tasks (id) on delete cascade,
  occurred_on  date not null,
  completed_at timestamptz not null default now(),
  unique (rule_id, occurred_on)
);

create index recurring_task_completions_user_day_idx
  on public.recurring_task_completions (user_id, occurred_on);

alter table public.recurring_task_completions enable row level security;

create policy "recurring_task_completions_select_own" on public.recurring_task_completions
  for select using (auth.uid() = user_id);
create policy "recurring_task_completions_insert_own" on public.recurring_task_completions
  for insert with check (auth.uid() = user_id);
create policy "recurring_task_completions_update_own" on public.recurring_task_completions
  for update using (auth.uid() = user_id);
create policy "recurring_task_completions_delete_own" on public.recurring_task_completions
  for delete using (auth.uid() = user_id);
