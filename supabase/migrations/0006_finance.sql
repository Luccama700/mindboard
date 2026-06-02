-- ============================================================================
-- mindboard finance
-- three tables: spending_categories, accounts, balance_changes.
-- accounts hold a manually-maintained balance; every change to that balance is
-- recorded as an append-only row in balance_changes. deductions ('out') carry a
-- spending category; deposits ('in') are recorded silently. RLS scoped by auth.uid().
-- ============================================================================

-- ---------- spending_categories ----------
create table public.spending_categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  color       text not null default '#B5FF3C',
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index spending_categories_user_id_idx on public.spending_categories (user_id);

alter table public.spending_categories enable row level security;

create policy "spending_categories_select_own"
  on public.spending_categories for select
  using (auth.uid() = user_id);

create policy "spending_categories_insert_own"
  on public.spending_categories for insert
  with check (auth.uid() = user_id);

create policy "spending_categories_update_own"
  on public.spending_categories for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "spending_categories_delete_own"
  on public.spending_categories for delete
  using (auth.uid() = user_id);


-- ---------- accounts ----------
create table public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  type        text not null default 'checking'
                check (type in ('checking', 'savings', 'cash', 'credit', 'investment', 'other')),
  color       text not null default '#B5FF3C',
  balance     numeric not null default 0,
  currency    text not null default 'USD',
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index accounts_user_id_idx on public.accounts (user_id);
create index accounts_user_active_idx on public.accounts (user_id) where archived = false;

alter table public.accounts enable row level security;

create policy "accounts_select_own"
  on public.accounts for select
  using (auth.uid() = user_id);

create policy "accounts_insert_own"
  on public.accounts for insert
  with check (auth.uid() = user_id);

create policy "accounts_update_own"
  on public.accounts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "accounts_delete_own"
  on public.accounts for delete
  using (auth.uid() = user_id);


-- ---------- balance_changes ----------
create table public.balance_changes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  account_id     uuid not null references public.accounts (id) on delete cascade,
  category_id    uuid references public.spending_categories (id) on delete set null,
  direction      text not null check (direction in ('in', 'out')),
  amount         numeric not null check (amount > 0),
  balance_after  numeric not null,
  note           text,
  occurred_at    date not null default current_date,
  created_at     timestamptz not null default now()
);

create index balance_changes_user_id_idx on public.balance_changes (user_id);
create index balance_changes_user_account_idx on public.balance_changes (user_id, account_id);
create index balance_changes_user_occurred_idx on public.balance_changes (user_id, occurred_at);

alter table public.balance_changes enable row level security;

create policy "balance_changes_select_own"
  on public.balance_changes for select
  using (auth.uid() = user_id);

create policy "balance_changes_insert_own"
  on public.balance_changes for insert
  with check (auth.uid() = user_id);

create policy "balance_changes_update_own"
  on public.balance_changes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "balance_changes_delete_own"
  on public.balance_changes for delete
  using (auth.uid() = user_id);
