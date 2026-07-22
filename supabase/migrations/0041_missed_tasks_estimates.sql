-- Task effort estimates + a 'missed' status. `estimated_minutes` is the user's
-- rough effort guess (positive minutes); `missed_at` stamps the manual "mark
-- incomplete" action on an overdue task, moving it into the done-vs-missed
-- history rather than deleting it. 'missed' joins the status set, and the open
-- partial index drops both terminal states so only live work is indexed.
--
-- DEPLOY ORDERING: apply this migration BEFORE the code that writes 'missed' or
-- reads the new columns, or the status CHECK will reject those writes.

alter table public.tasks
  add column estimated_minutes integer check (estimated_minutes > 0),
  add column missed_at          timestamptz;

-- Postgres can't alter a CHECK in place — drop and re-add. Verify the current
-- constraint name first with:
--   select conname from pg_constraint
--   where conrelid = 'public.tasks'::regclass and contype = 'c';
alter table public.tasks
  drop constraint if exists tasks_status_check;

alter table public.tasks
  add constraint tasks_status_check
  check (status in ('todo', 'doing', 'done', 'missed'));

-- Recreate the open-task partial index (see 0001_init.sql) so neither terminal
-- state (done, missed) sits in the live due-date lookup.
drop index if exists public.tasks_user_due_idx;
create index tasks_user_due_idx on public.tasks (user_id, due_date)
  where status not in ('done', 'missed');

alter table public.user_settings
  add column stream_max_tasks integer not null default 5
  check (stream_max_tasks between 3 and 15);
