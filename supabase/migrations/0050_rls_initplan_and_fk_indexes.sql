-- Performance advisor cleanup (docs/audit-2026-09-01.md par. 2.5). Two parts:
--
-- 1. auth_rls_initplan x 156: every RLS policy evaluated auth.uid() per ROW.
--    Wrapping it as (select auth.uid()) makes Postgres evaluate it once per
--    statement (an InitPlan). Every public policy is the simple
--    `auth.uid() = user_id` shape (verified read-only against pg_policies on
--    2026-09-01), so a generic textual rewrite is safe. The rewrite is
--    idempotent: an already-rewritten policy deparses with `SELECT auth.uid()`
--    and is skipped by the guard.
--
-- 2. unindexed_foreign_keys x 21: covering indexes for FK columns the app
--    actually filters on. The two hot ones are balance_changes.account_id
--    (recomputeAccountBalance runs on every finance write) and
--    person_interactions.person_id (dossier reads); the rest ride along so
--    the advisor list goes quiet. The advisor's unused-index INFOs are NOT
--    dropped here - several are young, verify before removing.

do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        (coalesce(qual, '') like '%auth.uid()%'
          and coalesce(qual, '') not like '%SELECT auth.uid()%')
        or
        (coalesce(with_check, '') like '%auth.uid()%'
          and coalesce(with_check, '') not like '%SELECT auth.uid()%')
      )
  loop
    execute format(
      'alter policy %I on %I.%I%s%s',
      p.policyname, p.schemaname, p.tablename,
      case when p.qual is not null
        then format(' using (%s)', replace(p.qual, 'auth.uid()', '(select auth.uid())'))
        else '' end,
      case when p.with_check is not null
        then format(' with check (%s)', replace(p.with_check, 'auth.uid()', '(select auth.uid())'))
        else '' end
    );
  end loop;
end $$;

-- FK covering indexes (advisor: unindexed_foreign_keys, 2026-09-01 run).
create index if not exists account_reconciliations_account_idx on public.account_reconciliations (account_id);
create index if not exists ai_messages_user_idx on public.ai_messages (user_id);
create index if not exists audio_episodes_user_idx on public.audio_episodes (user_id);
create index if not exists balance_changes_account_idx on public.balance_changes (account_id);
create index if not exists balance_changes_category_idx on public.balance_changes (category_id);
create index if not exists course_cards_user_idx on public.course_cards (user_id);
create index if not exists course_source_parts_user_idx on public.course_source_parts (user_id);
create index if not exists course_sources_user_idx on public.course_sources (user_id);
create index if not exists courses_user_idx on public.courses (user_id);
create index if not exists goals_group_idx on public.goals (group_id);
create index if not exists inventory_items_group_idx on public.inventory_items (inventory_group_id);
create index if not exists jobs_user_idx on public.jobs (user_id);
create index if not exists mindspace_labels_topic_idx on public.mindspace_labels (topic_id);
create index if not exists mindspace_observations_topic_idx on public.mindspace_observations (topic_id);
create index if not exists people_group_idx on public.people (group_id);
create index if not exists person_interactions_person_idx on public.person_interactions (person_id);
create index if not exists person_mention_candidates_person_idx on public.person_mention_candidates (person_id);
create index if not exists recurring_expenses_category_idx on public.recurring_expenses (category_id);
create index if not exists recurring_tasks_group_idx on public.recurring_tasks (group_id);
create index if not exists spend_limits_category_idx on public.spend_limits (category_id);
create index if not exists tasks_group_idx on public.tasks (group_id);
