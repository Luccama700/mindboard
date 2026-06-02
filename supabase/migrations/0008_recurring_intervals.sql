-- ============================================================================
-- mindboard finance: add 'daily' and 'custom' recurrence to recurring_expenses.
--   daily  -> lands every day (no extra params).
--   custom -> lands every `interval_days` days starting from `start_date`.
-- ============================================================================

alter table public.recurring_expenses
  drop constraint if exists recurring_expenses_frequency_check;

alter table public.recurring_expenses
  add constraint recurring_expenses_frequency_check
  check (frequency in ('monthly', 'weekly', 'daily', 'custom'));

alter table public.recurring_expenses
  add column if not exists interval_days int check (interval_days >= 1);

alter table public.recurring_expenses
  add column if not exists start_date date;
