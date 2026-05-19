-- ============================================================================
-- mindboard initial schema
-- two tables: groups, tasks. RLS scoped by auth.uid().
-- ============================================================================

-- ---------- groups ----------
create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  type        text not null check (type in ('course', 'project', 'work', 'personal')),
  color       text not null,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index groups_user_id_idx on public.groups (user_id);
create index groups_user_active_idx on public.groups (user_id) where archived = false;

alter table public.groups enable row level security;

create policy "groups_select_own"
  on public.groups for select
  using (auth.uid() = user_id);

create policy "groups_insert_own"
  on public.groups for insert
  with check (auth.uid() = user_id);

create policy "groups_update_own"
  on public.groups for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "groups_delete_own"
  on public.groups for delete
  using (auth.uid() = user_id);


-- ---------- tasks ----------
create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  group_id      uuid references public.groups (id) on delete set null,
  title         text not null,
  due_date      date,
  status        text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  priority      text not null default 'med' check (priority in ('low', 'med', 'high')),
  notes         text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index tasks_user_id_idx on public.tasks (user_id);
create index tasks_user_group_idx on public.tasks (user_id, group_id);
create index tasks_user_due_idx on public.tasks (user_id, due_date) where status != 'done';

alter table public.tasks enable row level security;

create policy "tasks_select_own"
  on public.tasks for select
  using (auth.uid() = user_id);

create policy "tasks_insert_own"
  on public.tasks for insert
  with check (auth.uid() = user_id);

create policy "tasks_update_own"
  on public.tasks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "tasks_delete_own"
  on public.tasks for delete
  using (auth.uid() = user_id);
