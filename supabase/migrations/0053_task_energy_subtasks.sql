-- Energy cost + decomposition (additive only; RLS policies from 0001 already
-- scope every column by user_id, so nothing here touches them).
--
--   energy_cost     1..5, a second axis beside estimated_minutes: how much a
--                   task takes out of you, not how long it takes. A planning
--                   input, never a score.
--   energy_source   who set it: 'ai' (assigned at creation, shown outlined) or
--                   'user' (one tap, shown filled). An AI assignment only ever
--                   lands where this is still null, so a user value is never
--                   overwritten.
--   parent_task_id  a subtask's parent (depth one — enforced in the app). The
--                   parent stays the thing owed; children are what the daily
--                   stream shows. Deleting the parent deletes its children.
--   not_before      the earliest day a subtask may be planned. Together with
--                   due_date (its "must be done by") it is the child's window;
--                   the planner picks the day inside it at read time and never
--                   writes it back. A skipped child slides this forward.

alter table public.tasks
  add column energy_cost    smallint check (energy_cost between 1 and 5),
  add column energy_source  text check (energy_source in ('ai', 'user')),
  add column parent_task_id uuid references public.tasks (id) on delete cascade,
  add column not_before     date;

alter table public.tasks
  add constraint tasks_not_before_within_window
  check (not_before is null or due_date is null or not_before <= due_date);

create index tasks_parent_idx
  on public.tasks (parent_task_id)
  where parent_task_id is not null;
