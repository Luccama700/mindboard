-- ============================================================================
-- mindboard inventory
-- two tables: inventory_groups, inventory_items. RLS scoped by auth.uid().
-- ============================================================================

-- ---------- inventory_groups ----------
create table public.inventory_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  color       text not null default '#B5FF3C',
  created_at  timestamptz not null default now()
);

create index inventory_groups_user_id_idx on public.inventory_groups (user_id);

alter table public.inventory_groups enable row level security;

create policy "inventory_groups_select_own"
  on public.inventory_groups for select
  using (auth.uid() = user_id);

create policy "inventory_groups_insert_own"
  on public.inventory_groups for insert
  with check (auth.uid() = user_id);

create policy "inventory_groups_update_own"
  on public.inventory_groups for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "inventory_groups_delete_own"
  on public.inventory_groups for delete
  using (auth.uid() = user_id);


-- ---------- inventory_items ----------
create table public.inventory_items (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  inventory_group_id  uuid references public.inventory_groups (id) on delete set null,
  name                text not null,
  quantity            numeric not null default 0,
  unit                text not null default '',
  notes               text,
  created_at          timestamptz not null default now()
);

create index inventory_items_user_id_idx on public.inventory_items (user_id);
create index inventory_items_user_group_idx on public.inventory_items (user_id, inventory_group_id);

alter table public.inventory_items enable row level security;

create policy "inventory_items_select_own"
  on public.inventory_items for select
  using (auth.uid() = user_id);

create policy "inventory_items_insert_own"
  on public.inventory_items for insert
  with check (auth.uid() = user_id);

create policy "inventory_items_update_own"
  on public.inventory_items for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "inventory_items_delete_own"
  on public.inventory_items for delete
  using (auth.uid() = user_id);
