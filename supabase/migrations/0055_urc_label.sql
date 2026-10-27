-- URC: an optional chat-chosen session name. Applied to production 2026-10-27.
--
-- The name ends up on the PC's command line (--remote-control / --name), so the
-- database holds it to the same strict allowlist as app/lib/urc/preview.ts
-- URC_LABEL_PATTERN and worker/urc-guards.mjs LABEL_PATTERN: lowercase letters,
-- digits and inner hyphens, 1-24 chars. Null means the default urc-<id> name.
-- claim_urc_job returns setof urc_jobs, so the column reaches the PC without a
-- function change; the PC re-checks it and falls back to the default if it
-- doesn't match.

alter table public.urc_jobs
  add column label text
  constraint urc_jobs_label_check
  check (label is null or label ~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$');
