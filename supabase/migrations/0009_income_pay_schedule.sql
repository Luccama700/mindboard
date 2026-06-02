-- ============================================================================
-- mindboard finance: income pay schedules.
-- An income source can be paid on a schedule (weekly/biweekly/monthly) rather
-- than per shift. anchor_payday is one known payday; period_start/period_end
-- describe the shift window that payday covers. Subsequent paydays and their
-- periods step by the same interval. When pay_frequency is null, pay lands on
-- the day worked (the original behaviour).
-- ============================================================================

alter table public.income_sources
  add column if not exists pay_frequency text
    check (pay_frequency in ('weekly', 'biweekly', 'monthly'));

alter table public.income_sources
  add column if not exists anchor_payday date;

alter table public.income_sources
  add column if not exists period_start date;

alter table public.income_sources
  add column if not exists period_end date;
