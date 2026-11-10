-- ============================================================================
-- Two invented tenants, written against the schema as it stands after 0055
-- (what production has today), so the security release 0056..0065 can be
-- applied on top of rows that already exist.
--
-- Invented data only: no real person, address, token or project. Token-like
-- values are obvious placeholders.
--
-- It covers every table the newest migrations constrain or rewrite:
--   0056 jobs, 0057 course_sources, 0058 google_tokens + vault_settings,
--   0060 ai_audit_log, 0061 (retention reads jobs, ai_audit_log, urc_jobs,
--   urc_log, google_tokens), 0063 urc_jobs, 0064 the foreign keys between
--   accounts, spending_categories, balance_changes, account_reconciliations,
--   groups, tasks, task_dispatches, recurring_tasks, inventory_groups,
--   inventory_items, people_groups, people, person_interactions, courses,
--   course_sources, ai_conversations, ai_audit_log.
--
-- Tenant A ends in ...aaaa, tenant B in ...bbbb. Every row of a tenant points
-- only at parents of the same tenant, which is what 0064 will start to demand.
-- Two rows are deliberately awkward for the release:
--   * a finished urc_jobs row still holding a session link (0063 must clear it
--     before its check constraint is added);
--   * a finished job older than the retention window (0061 must be able to
--     read it; it is only deleted when the prune function is called).
-- ============================================================================

insert into auth.users (id, email, created_at, last_sign_in_at, raw_app_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tenant-a@example.test', '2026-01-05T10:00:00Z', '2026-10-01T10:00:00Z', '{"provider":"google","providers":["google"]}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'tenant-b@example.test', '2026-02-05T10:00:00Z', '2026-09-20T10:00:00Z', '{"provider":"google","providers":["google"]}');

-- ---- tasks and groups -------------------------------------------------------
insert into public.groups (id, user_id, name, type, color) values
  ('aaaaaaaa-0000-4000-8000-000000000101', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Algebra', 'course', '#b5ff3c'),
  ('bbbbbbbb-0000-4000-8000-000000000101', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Garden', 'personal', '#ff6b6b');

insert into public.tasks (id, user_id, group_id, title, status) values
  ('aaaaaaaa-0000-4000-8000-000000000201', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000101', 'Finish problem set', 'todo'),
  ('aaaaaaaa-0000-4000-8000-000000000202', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, 'Book a haircut', 'todo'),
  ('bbbbbbbb-0000-4000-8000-000000000201', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000101', 'Water the tomatoes', 'doing'),
  ('bbbbbbbb-0000-4000-8000-000000000202', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, 'Renew library card', 'todo');

insert into public.task_dispatches (id, user_id, task_id, note) values
  ('aaaaaaaa-0000-4000-8000-000000000301', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000201', 'Outline the first three proofs'),
  ('bbbbbbbb-0000-4000-8000-000000000301', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000201', 'List what the beds need');

insert into public.recurring_tasks (id, user_id, group_id, title, frequency) values
  ('aaaaaaaa-0000-4000-8000-000000000401', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000101', 'Review notes', 'daily'),
  ('bbbbbbbb-0000-4000-8000-000000000401', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000101', 'Check the soil', 'daily');

-- ---- worker jobs ------------------------------------------------------------
insert into public.jobs (id, user_id, kind, status, created_at) values
  ('aaaaaaaa-0000-4000-8000-000000000501', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ocr', 'done', '2026-01-10T10:00:00Z'),
  ('aaaaaaaa-0000-4000-8000-000000000502', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tts', 'queued', '2026-11-01T10:00:00Z'),
  ('bbbbbbbb-0000-4000-8000-000000000501', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'followup', 'processing', '2026-11-02T10:00:00Z');

-- ---- assistant audit trail --------------------------------------------------
insert into public.ai_conversations (id, user_id, title) values
  ('aaaaaaaa-0000-4000-8000-000000000601', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Plan the week'),
  ('bbbbbbbb-0000-4000-8000-000000000601', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Seed order');

insert into public.ai_messages (id, conversation_id, user_id, role, content) values
  ('aaaaaaaa-0000-4000-8000-000000000611', 'aaaaaaaa-0000-4000-8000-000000000601', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user', 'What is due this week?'),
  ('bbbbbbbb-0000-4000-8000-000000000611', 'bbbbbbbb-0000-4000-8000-000000000601', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user', 'What should I plant?');

insert into public.ai_audit_log (id, user_id, conversation_id, tool_name, input, summary, status) values
  ('aaaaaaaa-0000-4000-8000-000000000621', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000601', 'create_task', '{"title":"Book a haircut"}', 'Create a task', 'executed'),
  ('aaaaaaaa-0000-4000-8000-000000000622', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, 'spawn_urc', '{"folder":"notes"}', 'Start a session', 'proposed'),
  ('bbbbbbbb-0000-4000-8000-000000000621', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000601', 'create_task', '{"title":"Renew library card"}', 'Create a task', 'rejected');

-- ---- courses ----------------------------------------------------------------
insert into public.courses (id, user_id, name) values
  ('aaaaaaaa-0000-4000-8000-000000000701', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Linear algebra'),
  ('bbbbbbbb-0000-4000-8000-000000000701', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Soil science');

-- storage_path sits in the owner's own folder: {user_id}/{source_id}/file
insert into public.course_sources (id, user_id, course_id, title, storage_path) values
  ('aaaaaaaa-0000-4000-8000-000000000711', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000701', 'Week 1 slides',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/aaaaaaaa-0000-4000-8000-000000000711/week1.pdf'),
  ('bbbbbbbb-0000-4000-8000-000000000711', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000701', 'Chapter 3',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/bbbbbbbb-0000-4000-8000-000000000711/ch3.pdf');

-- ---- remote-control sessions ------------------------------------------------
insert into public.urc_devices (id, user_id, name, token_hash) values
  ('aaaaaaaa-0000-4000-8000-000000000801', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'desk pc', 'hash-of-an-invented-device-token-a'),
  ('bbbbbbbb-0000-4000-8000-000000000801', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'laptop', 'hash-of-an-invented-device-token-b');

-- The first row is finished yet still carries its link: 0063 has to null it.
insert into public.urc_jobs (id, user_id, device_id, folder_key, status, session_url, confirmed_auth, audit_id) values
  ('aaaaaaaa-0000-4000-8000-000000000811', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000801', 'notes', 'stopped', 'https://example.test/session/finished', 'oauth:invented', 'aaaaaaaa-0000-4000-8000-000000000622'),
  ('aaaaaaaa-0000-4000-8000-000000000812', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000801', 'notes', 'running', 'https://example.test/session/live', 'oauth:invented', null),
  ('bbbbbbbb-0000-4000-8000-000000000811', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000801', 'garden', 'failed', null, 'oauth:invented', null);

insert into public.urc_log (id, user_id, job_id, event, folder_key) values
  ('aaaaaaaa-0000-4000-8000-000000000821', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000811', 'stopped', 'notes'),
  ('bbbbbbbb-0000-4000-8000-000000000821', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000811', 'failed', 'garden');

-- ---- credentials the release locks down --------------------------------------
insert into public.google_tokens (user_id, access_token, refresh_token, expires_at, scopes) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'invented-access-token-a', 'invented-refresh-token-a', '2026-12-01T00:00:00Z', 'calendar.readonly'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'invented-access-token-b', 'invented-refresh-token-b', '2026-12-01T00:00:00Z', 'calendar.readonly');

insert into public.vault_settings (user_id, github_token, repo) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'invented-vault-token-a', 'tenant-a/notes'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'invented-vault-token-b', 'tenant-b/notes');

-- ---- money ------------------------------------------------------------------
insert into public.accounts (id, user_id, name) values
  ('aaaaaaaa-0000-4000-8000-000000000901', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Everyday'),
  ('bbbbbbbb-0000-4000-8000-000000000901', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Savings pot');

insert into public.spending_categories (id, user_id, name) values
  ('aaaaaaaa-0000-4000-8000-000000000911', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Food'),
  ('bbbbbbbb-0000-4000-8000-000000000911', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Seeds');

insert into public.balance_changes (id, user_id, account_id, category_id, direction, amount) values
  ('aaaaaaaa-0000-4000-8000-000000000921', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000901', 'aaaaaaaa-0000-4000-8000-000000000911', 'out', 12.50),
  ('bbbbbbbb-0000-4000-8000-000000000921', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000901', 'bbbbbbbb-0000-4000-8000-000000000911', 'out', 4.00);

insert into public.account_reconciliations (id, user_id, account_id, balance, as_of) values
  ('aaaaaaaa-0000-4000-8000-000000000931', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000000901', 100.00, '2026-10-01'),
  ('bbbbbbbb-0000-4000-8000-000000000931', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000000901', 50.00, '2026-10-01');

-- ---- inventory --------------------------------------------------------------
insert into public.inventory_groups (id, user_id, name) values
  ('aaaaaaaa-0000-4000-8000-000000001001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Pantry'),
  ('bbbbbbbb-0000-4000-8000-000000001001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Shed');

insert into public.inventory_items (id, user_id, inventory_group_id, name) values
  ('aaaaaaaa-0000-4000-8000-000000001011', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000001001', 'Rice'),
  ('bbbbbbbb-0000-4000-8000-000000001011', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000001001', 'Twine');

-- ---- people -----------------------------------------------------------------
insert into public.people_groups (id, user_id, name) values
  ('aaaaaaaa-0000-4000-8000-000000001101', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Study group'),
  ('bbbbbbbb-0000-4000-8000-000000001101', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Neighbours');

insert into public.people (id, user_id, group_id, name) values
  ('aaaaaaaa-0000-4000-8000-000000001111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000001101', 'Sam Example'),
  ('bbbbbbbb-0000-4000-8000-000000001111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000001101', 'Robin Example');

insert into public.person_interactions (id, user_id, person_id, occurred_at) values
  ('aaaaaaaa-0000-4000-8000-000000001121', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-0000-4000-8000-000000001111', '2026-10-15'),
  ('bbbbbbbb-0000-4000-8000-000000001121', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-0000-4000-8000-000000001111', '2026-10-16');
