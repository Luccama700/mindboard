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

-- (user_id, id) is unique by construction (id is the PK); naming it lets the
-- parent link be a COMPOSITE foreign key, so a child can only ever point at a
-- task of the same user — RLS scopes rows, not the ids a row may reference.
alter table public.tasks
  add constraint tasks_user_id_id_key unique (user_id, id);

alter table public.tasks
  add column energy_cost    smallint check (energy_cost between 1 and 5),
  add column energy_source  text check (energy_source in ('ai', 'user')),
  add column parent_task_id uuid,
  add column not_before     date;

alter table public.tasks
  add constraint tasks_parent_same_user_fkey
  foreign key (user_id, parent_task_id)
  references public.tasks (user_id, id)
  on delete cascade;

-- A window needs its end: not_before without a due_date is meaningless.
alter table public.tasks
  add constraint tasks_not_before_within_window
  check (not_before is null or (due_date is not null and not_before <= due_date));

create index tasks_parent_idx
  on public.tasks (parent_task_id)
  where parent_task_id is not null;
