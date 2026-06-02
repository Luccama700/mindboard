-- ============================================================================
-- mindboard inventory usages
-- Recurring consumption rules per item, used to forecast depletion, plus a
-- reorder threshold for "running low" flagging. Usage is spread to an effective
-- daily rate (day = amount, week = amount/7, custom = amount/interval_days).
-- RLS scoped by auth.uid().
-- ============================================================================

-- ---------- reorder threshold ----------
alter table public.inventory_items
  add column reorder_threshold numeric;

-- ---------- inventory_usages ----------
create table public.inventory_usages (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  inventory_item_id  uuid not null references public.inventory_items (id) on delete cascade,
  amount             numeric not null check (amount > 0),
  period             text not null check (period in ('day', 'week', 'custom')),
  interval_days      integer check (interval_days >= 1),
  created_at         timestamptz not null default now()
);

create index inventory_usages_user_id_idx on public.inventory_usages (user_id);
create index inventory_usages_item_idx on public.inventory_usages (inventory_item_id);

alter table public.inventory_usages enable row level security;

create policy "inventory_usages_select_own"
  on public.inventory_usages for select
  using (auth.uid() = user_id);

create policy "inventory_usages_insert_own"
  on public.inventory_usages for insert
  with check (auth.uid() = user_id);

create policy "inventory_usages_update_own"
  on public.inventory_usages for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "inventory_usages_delete_own"
  on public.inventory_usages for delete
  using (auth.uid() = user_id);
