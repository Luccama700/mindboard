-- ============================================================================
-- mindboard finance: transactions-first restructure
-- balance_changes stops being a balance-diff chain and becomes a true
-- transaction ledger: rows are dated, editable, deletable. The account balance
-- is now DERIVED: latest account_reconciliations anchor + signed sum of later
-- transactions (see app/lib/finance/derive.ts); accounts.balance is a cache
-- recomputed on every write. balance_after is deprecated (nullable, no longer
-- written); a later cleanup migration drops it.
-- Design + decisions: docs/finance-automation-plan.md.
-- ============================================================================

-- ---------- balance_changes: chain link -> transaction ----------
alter table public.balance_changes
  alter column balance_after drop not null;

alter table public.balance_changes
  add column source text not null default 'manual'
    check (source in ('manual', 'import', 'assistant')),
  add column is_transfer boolean not null default false,
  add column fingerprint text;

-- dedup lookups during statement import: same account + same fingerprint
create index balance_changes_fingerprint_idx
  on public.balance_changes (user_id, account_id, fingerprint);

-- backfill fingerprints so past manual logs are visible to future imports.
-- format mirrors app/lib/finance/derive.ts changeFingerprint():
--   YYYY-MM-DD|direction|amount-in-cents
update public.balance_changes
set fingerprint =
  occurred_at::text || '|' || direction || '|' || round(amount * 100)::bigint::text
where fingerprint is null;

-- ---------- account_reconciliations ----------
-- "this account held <balance> at end of day <as_of>". The anchor absorbs any
-- unexplained drift; transactions dated after as_of (or dated as_of but
-- recorded after the anchor) move the derived balance.
create table public.account_reconciliations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  account_id  uuid not null references public.accounts (id) on delete cascade,
  balance     numeric not null,
  as_of       date not null,
  source      text not null default 'manual'
                check (source in ('manual', 'import', 'assistant')),
  note        text,
  created_at  timestamptz not null default now()
);

create index account_reconciliations_user_account_idx
  on public.account_reconciliations (user_id, account_id, as_of desc, created_at desc);

alter table public.account_reconciliations enable row level security;

create policy "account_reconciliations_select_own"
  on public.account_reconciliations for select
  using (auth.uid() = user_id);

create policy "account_reconciliations_insert_own"
  on public.account_reconciliations for insert
  with check (auth.uid() = user_id);

create policy "account_reconciliations_update_own"
  on public.account_reconciliations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "account_reconciliations_delete_own"
  on public.account_reconciliations for delete
  using (auth.uid() = user_id);

-- seed one anchor per account at its current stored balance, so derivation
-- starts exactly coherent with the pre-migration state.
insert into public.account_reconciliations (user_id, account_id, balance, as_of, source, note)
select user_id, id, balance, current_date, 'manual', 'migration seed'
from public.accounts;

-- ---------- user_settings: manual everyday-spend fallback ----------
-- flat per-day estimate used by the cashflow forecast when spending history is
-- too thin for the weekday baseline (app/_components/spend-baseline.ts).
alter table public.user_settings
  add column daily_spend_estimate numeric
    check (daily_spend_estimate is null or daily_spend_estimate >= 0);
