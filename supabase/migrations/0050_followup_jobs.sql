-- ============================================================================
-- Follow-ups from the Apple Watch: the home worker gains a fourth job kind,
-- 'followup' — a dictated instruction about an open task that Claude Code on
-- the PC turns into a new follow-up task (same group, same due date), doing
-- whatever research the instruction needs first. Reuses the jobs/worker
-- chassis (0027); this only widens the kind check.
-- ============================================================================

alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (kind in ('ocr', 'tts', 'reel', 'followup'));
