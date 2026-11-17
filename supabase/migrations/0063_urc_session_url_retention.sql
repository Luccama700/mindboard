-- Audit 2026-10-26 M8: a URC session link is a live handle to a Claude Code
-- session on the owner's PC. The server now clears urc_jobs.session_url when a
-- job reaches stopped/failed (app/lib/urc/device.ts), but rows that finished
-- before that change still carry their link. Clear them, and backstop the rule
-- in the database so no future write path can leave a link on a finished job.

update public.urc_jobs
   set session_url = null
 where session_url is not null
   and status not in ('running', 'stopping');

alter table public.urc_jobs
  add constraint urc_jobs_session_url_only_while_live
  check (session_url is null or status in ('claimed', 'running', 'stopping'));
