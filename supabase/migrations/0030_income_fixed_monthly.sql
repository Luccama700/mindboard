-- ============================================================================
-- mindboard finance: fixed-monthly income sources.
-- fixed_amount + fixed_day (always set together) switch a source to a fixed
-- monthly income: the amount lands on that day each month (clamped to short
-- months) instead of hours × wage from a linked calendar. The hourly fields
-- (hourly_wage, tax_rate, calendar_id, pay schedule) are left untouched so
-- unchecking the mode restores the previous wage setup; projections ignore
-- them while the fixed fields are set.
-- ============================================================================

alter table public.income_sources
  add column if not exists fixed_amount numeric
    check (fixed_amount is null or fixed_amount >= 0);

alter table public.income_sources
  add column if not exists fixed_day integer
    check (fixed_day is null or (fixed_day >= 1 and fixed_day <= 31));

alter table public.income_sources
  add constraint income_sources_fixed_pair
    check ((fixed_amount is null) = (fixed_day is null));
