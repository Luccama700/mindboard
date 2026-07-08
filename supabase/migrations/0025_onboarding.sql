-- ============================================================================
-- mindboard onboarding — per-user tour completion (docs/onboarding-landing-plan.md)
-- A map of tour key -> completed-at ISO timestamp. Server-persisted so the
-- phone PWA and desktop agree; localStorage is only a render guard.
-- ============================================================================

alter table public.user_settings
  add column completed_tours jsonb not null default '{}'::jsonb;
