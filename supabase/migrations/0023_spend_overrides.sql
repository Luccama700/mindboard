-- ============================================================================
-- mindboard finance: per-day everyday-spend overrides
-- One row per (user, future date): the expected discretionary spend for that
-- specific day, set via the slider in the finance calendar's selected-day
-- panel. Replaces the baseline estimate for that date (0 = "no spend
-- expected"). Rows for past dates are ignored by readers and can be pruned.
-- ============================================================================

create table public.spend_overrides (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  date        date not null,
  amount      numeric not null check (amount >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, date)
);

create index spend_overrides_user_date_idx on public.spend_overrides (user_id, date);

alter table public.spend_overrides enable row level security;

create policy "spend_overrides_select_own"
  on public.spend_overrides for select
  using (auth.uid() = user_id);

create policy "spend_overrides_insert_own"
  on public.spend_overrides for insert
  with check (auth.uid() = user_id);

create policy "spend_overrides_update_own"
  on public.spend_overrides for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "spend_overrides_delete_own"
  on public.spend_overrides for delete
  using (auth.uid() = user_id);
