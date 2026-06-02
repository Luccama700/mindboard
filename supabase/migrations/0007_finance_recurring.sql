-- ============================================================================
-- mindboard finance: recurring cashflow
-- recurring_expenses: flat outflows landing monthly (day-of-month) or weekly.
-- income_sources: wage jobs whose linked Google Calendar events are worked
--   shifts; net pay = hours * hourly_wage * (1 - tax_rate/100). These are
--   projection inputs for the finance calendar; they do not write balance rows.
-- RLS scoped by auth.uid().
-- ============================================================================

-- ---------- recurring_expenses ----------
create table public.recurring_expenses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  amount        numeric not null check (amount > 0),
  category_id   uuid references public.spending_categories (id) on delete set null,
  frequency     text not null check (frequency in ('monthly', 'weekly')),
  day_of_month  int check (day_of_month between 1 and 31),
  weekday       int check (weekday between 0 and 6),
  archived      boolean not null default false,
  created_at    timestamptz not null default now()
);

create index recurring_expenses_user_id_idx on public.recurring_expenses (user_id);

alter table public.recurring_expenses enable row level security;

create policy "recurring_expenses_select_own"
  on public.recurring_expenses for select
  using (auth.uid() = user_id);

create policy "recurring_expenses_insert_own"
  on public.recurring_expenses for insert
  with check (auth.uid() = user_id);

create policy "recurring_expenses_update_own"
  on public.recurring_expenses for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "recurring_expenses_delete_own"
  on public.recurring_expenses for delete
  using (auth.uid() = user_id);


-- ---------- income_sources ----------
create table public.income_sources (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  hourly_wage  numeric not null default 0 check (hourly_wage >= 0),
  tax_rate     numeric not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  calendar_id  text,
  color        text not null default '#7CFF6B',
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);

create index income_sources_user_id_idx on public.income_sources (user_id);

alter table public.income_sources enable row level security;

create policy "income_sources_select_own"
  on public.income_sources for select
  using (auth.uid() = user_id);

create policy "income_sources_insert_own"
  on public.income_sources for insert
  with check (auth.uid() = user_id);

create policy "income_sources_update_own"
  on public.income_sources for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "income_sources_delete_own"
  on public.income_sources for delete
  using (auth.uid() = user_id);
