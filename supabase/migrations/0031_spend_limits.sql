-- ============================================================================
-- mindboard finance: spending limits
-- User-set budget caps the app tracks ACTUAL spend against (distinct from the
-- forecast's daily-spend estimate, which predicts future spend). One overall
-- limit plus optional per-category limits, each over a daily / weekly (Mon-Sun)
-- / monthly (calendar month) period. Actual spend is computed from
-- balance_changes with the same inclusion rules as the everyday-spend baseline
-- (out-flows only, transfers and recurring bills excluded). RLS scoped by
-- auth.uid().
-- ============================================================================

create table public.spend_limits (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  scope       text not null default 'overall'
                check (scope in ('overall', 'category')),
  category_id uuid references public.spending_categories (id) on delete cascade,
  period      text not null check (period in ('daily', 'weekly', 'monthly')),
  amount      numeric not null check (amount > 0),
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint spend_limits_scope_pair
    check ((scope = 'category') = (category_id is not null))
);

create index spend_limits_user_id_idx on public.spend_limits (user_id);

-- One active overall limit per user, and one active limit per category.
-- Partial (archived = false) so soft-archived limits never block a new one.
create unique index spend_limits_overall_uniq
  on public.spend_limits (user_id)
  where scope = 'overall' and archived = false;

create unique index spend_limits_category_uniq
  on public.spend_limits (user_id, category_id)
  where scope = 'category' and archived = false;

alter table public.spend_limits enable row level security;

create policy "spend_limits_select_own"
  on public.spend_limits for select
  using (auth.uid() = user_id);

create policy "spend_limits_insert_own"
  on public.spend_limits for insert
  with check (auth.uid() = user_id);

create policy "spend_limits_update_own"
  on public.spend_limits for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "spend_limits_delete_own"
  on public.spend_limits for delete
  using (auth.uid() = user_id);
