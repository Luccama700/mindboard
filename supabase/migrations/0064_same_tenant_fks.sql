-- Audit 2026-10-26 L1: same-tenant foreign keys.
--
-- RLS checks only that a row's own user_id is the caller's. Every foreign key
-- below was single-column (child.x_id -> parent.id), so over PostgREST a
-- signed-in user could insert a row of their own that points at ANOTHER
-- tenant's group / account / category / person (v4 UUIDs only, but no policy
-- stopped it). MCP reads run on the RLS-bypassing service client and embed the
-- parent, so list_tasks / list_recent_ledger / get_snapshot would then show
-- the other tenant's names, colours and currencies.
--
-- Each FK becomes composite: (user_id, x_id) -> parent (user_id, id), so the
-- parent must belong to the same user. MATCH SIMPLE (the default) skips the
-- check when x_id is null, which keeps every optional link optional.
-- ON DELETE SET NULL keeps its old meaning via the column-list form
-- (Postgres 15+), so deleting a parent nulls only x_id, never user_id.
-- The child-side (user_id, x_id) indexes also cover the unindexed-FK
-- performance advisories for these relations.
--
-- Verified on the live data 2026-10-27: zero existing cross-tenant references
-- across all 25 relations, so the constraints validate immediately.
-- URC tables are service-role only and are left alone.

begin;

-- Parents: (user_id, id) must be unique to be a composite FK target.
alter table public.accounts add constraint accounts_user_id_id_key unique (user_id, id);
alter table public.ai_conversations add constraint ai_conversations_user_id_id_key unique (user_id, id);
alter table public.course_sources add constraint course_sources_user_id_id_key unique (user_id, id);
alter table public.courses add constraint courses_user_id_id_key unique (user_id, id);
alter table public.groups add constraint groups_user_id_id_key unique (user_id, id);
alter table public.inventory_groups add constraint inventory_groups_user_id_id_key unique (user_id, id);
alter table public.inventory_items add constraint inventory_items_user_id_id_key unique (user_id, id);
alter table public.mindspace_items add constraint mindspace_items_user_id_id_key unique (user_id, id);
alter table public.mindspace_topics add constraint mindspace_topics_user_id_id_key unique (user_id, id);
alter table public.people add constraint people_user_id_id_key unique (user_id, id);
alter table public.people_groups add constraint people_groups_user_id_id_key unique (user_id, id);
alter table public.recurring_tasks add constraint recurring_tasks_user_id_id_key unique (user_id, id);
alter table public.spending_categories add constraint spending_categories_user_id_id_key unique (user_id, id);
alter table public.tasks add constraint tasks_user_id_id_key unique (user_id, id);

alter table public.account_reconciliations drop constraint account_reconciliations_account_id_fkey;
alter table public.account_reconciliations add constraint account_reconciliations_account_id_fkey
  foreign key (user_id, account_id) references public.accounts (user_id, id) on delete cascade;
create index if not exists account_reconciliations_user_id_account_id_idx on public.account_reconciliations (user_id, account_id);

alter table public.ai_audit_log drop constraint ai_audit_log_conversation_id_fkey;
alter table public.ai_audit_log add constraint ai_audit_log_conversation_id_fkey
  foreign key (user_id, conversation_id) references public.ai_conversations (user_id, id) on delete set null (conversation_id);
create index if not exists ai_audit_log_user_id_conversation_id_idx on public.ai_audit_log (user_id, conversation_id);

alter table public.ai_messages drop constraint ai_messages_conversation_id_fkey;
alter table public.ai_messages add constraint ai_messages_conversation_id_fkey
  foreign key (user_id, conversation_id) references public.ai_conversations (user_id, id) on delete cascade;
create index if not exists ai_messages_user_id_conversation_id_idx on public.ai_messages (user_id, conversation_id);

alter table public.audio_episodes drop constraint audio_episodes_course_id_fkey;
alter table public.audio_episodes add constraint audio_episodes_course_id_fkey
  foreign key (user_id, course_id) references public.courses (user_id, id) on delete cascade;
create index if not exists audio_episodes_user_id_course_id_idx on public.audio_episodes (user_id, course_id);

alter table public.balance_changes drop constraint balance_changes_category_id_fkey;
alter table public.balance_changes add constraint balance_changes_category_id_fkey
  foreign key (user_id, category_id) references public.spending_categories (user_id, id) on delete set null (category_id);
create index if not exists balance_changes_user_id_category_id_idx on public.balance_changes (user_id, category_id);

alter table public.balance_changes drop constraint balance_changes_account_id_fkey;
alter table public.balance_changes add constraint balance_changes_account_id_fkey
  foreign key (user_id, account_id) references public.accounts (user_id, id) on delete cascade;
create index if not exists balance_changes_user_id_account_id_idx on public.balance_changes (user_id, account_id);

alter table public.course_cards drop constraint course_cards_course_id_fkey;
alter table public.course_cards add constraint course_cards_course_id_fkey
  foreign key (user_id, course_id) references public.courses (user_id, id) on delete cascade;
create index if not exists course_cards_user_id_course_id_idx on public.course_cards (user_id, course_id);

alter table public.course_source_parts drop constraint course_source_parts_source_id_fkey;
alter table public.course_source_parts add constraint course_source_parts_source_id_fkey
  foreign key (user_id, source_id) references public.course_sources (user_id, id) on delete cascade;
create index if not exists course_source_parts_user_id_source_id_idx on public.course_source_parts (user_id, source_id);

alter table public.course_sources drop constraint course_sources_course_id_fkey;
alter table public.course_sources add constraint course_sources_course_id_fkey
  foreign key (user_id, course_id) references public.courses (user_id, id) on delete cascade;
create index if not exists course_sources_user_id_course_id_idx on public.course_sources (user_id, course_id);

alter table public.goals drop constraint goals_group_id_fkey;
alter table public.goals add constraint goals_group_id_fkey
  foreign key (user_id, group_id) references public.groups (user_id, id) on delete set null (group_id);
create index if not exists goals_user_id_group_id_idx on public.goals (user_id, group_id);

alter table public.inventory_items drop constraint inventory_items_inventory_group_id_fkey;
alter table public.inventory_items add constraint inventory_items_inventory_group_id_fkey
  foreign key (user_id, inventory_group_id) references public.inventory_groups (user_id, id) on delete set null (inventory_group_id);
create index if not exists inventory_items_user_id_inventory_group_id_idx on public.inventory_items (user_id, inventory_group_id);

alter table public.inventory_usages drop constraint inventory_usages_inventory_item_id_fkey;
alter table public.inventory_usages add constraint inventory_usages_inventory_item_id_fkey
  foreign key (user_id, inventory_item_id) references public.inventory_items (user_id, id) on delete cascade;
create index if not exists inventory_usages_user_id_inventory_item_id_idx on public.inventory_usages (user_id, inventory_item_id);

alter table public.mindspace_labels drop constraint mindspace_labels_item_id_fkey;
alter table public.mindspace_labels add constraint mindspace_labels_item_id_fkey
  foreign key (user_id, item_id) references public.mindspace_items (user_id, id) on delete cascade;
create index if not exists mindspace_labels_user_id_item_id_idx on public.mindspace_labels (user_id, item_id);

alter table public.mindspace_labels drop constraint mindspace_labels_topic_id_fkey;
alter table public.mindspace_labels add constraint mindspace_labels_topic_id_fkey
  foreign key (user_id, topic_id) references public.mindspace_topics (user_id, id) on delete cascade;
create index if not exists mindspace_labels_user_id_topic_id_idx on public.mindspace_labels (user_id, topic_id);

alter table public.mindspace_observations drop constraint mindspace_observations_topic_id_fkey;
alter table public.mindspace_observations add constraint mindspace_observations_topic_id_fkey
  foreign key (user_id, topic_id) references public.mindspace_topics (user_id, id) on delete cascade;
create index if not exists mindspace_observations_user_id_topic_id_idx on public.mindspace_observations (user_id, topic_id);

alter table public.people drop constraint people_group_id_fkey;
alter table public.people add constraint people_group_id_fkey
  foreign key (user_id, group_id) references public.people_groups (user_id, id) on delete set null (group_id);
create index if not exists people_user_id_group_id_idx on public.people (user_id, group_id);

alter table public.person_interactions drop constraint person_interactions_person_id_fkey;
alter table public.person_interactions add constraint person_interactions_person_id_fkey
  foreign key (user_id, person_id) references public.people (user_id, id) on delete cascade;
create index if not exists person_interactions_user_id_person_id_idx on public.person_interactions (user_id, person_id);

alter table public.person_mention_candidates drop constraint person_mention_candidates_person_id_fkey;
alter table public.person_mention_candidates add constraint person_mention_candidates_person_id_fkey
  foreign key (user_id, person_id) references public.people (user_id, id) on delete cascade;
create index if not exists person_mention_candidates_user_id_person_id_idx on public.person_mention_candidates (user_id, person_id);

alter table public.recurring_expenses drop constraint recurring_expenses_category_id_fkey;
alter table public.recurring_expenses add constraint recurring_expenses_category_id_fkey
  foreign key (user_id, category_id) references public.spending_categories (user_id, id) on delete set null (category_id);
create index if not exists recurring_expenses_user_id_category_id_idx on public.recurring_expenses (user_id, category_id);

alter table public.recurring_task_completions drop constraint recurring_task_completions_rule_id_fkey;
alter table public.recurring_task_completions add constraint recurring_task_completions_rule_id_fkey
  foreign key (user_id, rule_id) references public.recurring_tasks (user_id, id) on delete cascade;
create index if not exists recurring_task_completions_user_id_rule_id_idx on public.recurring_task_completions (user_id, rule_id);

alter table public.recurring_task_slots drop constraint recurring_task_slots_rule_id_fkey;
alter table public.recurring_task_slots add constraint recurring_task_slots_rule_id_fkey
  foreign key (user_id, rule_id) references public.recurring_tasks (user_id, id) on delete cascade;
create index if not exists recurring_task_slots_user_id_rule_id_idx on public.recurring_task_slots (user_id, rule_id);

alter table public.recurring_tasks drop constraint recurring_tasks_group_id_fkey;
alter table public.recurring_tasks add constraint recurring_tasks_group_id_fkey
  foreign key (user_id, group_id) references public.groups (user_id, id) on delete set null (group_id);
create index if not exists recurring_tasks_user_id_group_id_idx on public.recurring_tasks (user_id, group_id);

alter table public.spend_limits drop constraint spend_limits_category_id_fkey;
alter table public.spend_limits add constraint spend_limits_category_id_fkey
  foreign key (user_id, category_id) references public.spending_categories (user_id, id) on delete cascade;
create index if not exists spend_limits_user_id_category_id_idx on public.spend_limits (user_id, category_id);

alter table public.task_dispatches drop constraint task_dispatches_task_id_fkey;
alter table public.task_dispatches add constraint task_dispatches_task_id_fkey
  foreign key (user_id, task_id) references public.tasks (user_id, id) on delete cascade;
create index if not exists task_dispatches_user_id_task_id_idx on public.task_dispatches (user_id, task_id);

alter table public.tasks drop constraint tasks_group_id_fkey;
alter table public.tasks add constraint tasks_group_id_fkey
  foreign key (user_id, group_id) references public.groups (user_id, id) on delete set null (group_id);
create index if not exists tasks_user_id_group_id_idx on public.tasks (user_id, group_id);

commit;
