-- Mindspace M3 (docs/mindspace-plan.md): external AI-conversation streams.
-- mindspace_sessions is the system of record for imported activity that has no
-- live source to re-read — claude.ai conversations (manual data-export import)
-- and Claude Code sessions (synced nightly by the overnight agent's local
-- scanner via the mindspace_ingest_sessions MCP tool). Rows store the user's
-- OWN words only (capped), never the assistant's, and re-imports upsert
-- idempotently on (user, provider, session_ref).

create table public.mindspace_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  provider     text not null check (provider in ('claude_ai', 'claude_code')),
  session_ref  text not null,
  title        text,
  project      text,
  started_at   timestamptz not null,
  ended_at     timestamptz not null,
  duration_min int not null check (duration_min >= 0),
  word_count   int not null default 0,
  user_text    text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, provider, session_ref)
);

create index mindspace_sessions_user_ended_idx
  on public.mindspace_sessions (user_id, ended_at desc);

alter table public.mindspace_sessions enable row level security;

create policy "mindspace_sessions_select_own" on public.mindspace_sessions
  for select using (auth.uid() = user_id);
create policy "mindspace_sessions_insert_own" on public.mindspace_sessions
  for insert with check (auth.uid() = user_id);
create policy "mindspace_sessions_update_own" on public.mindspace_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "mindspace_sessions_delete_own" on public.mindspace_sessions
  for delete using (auth.uid() = user_id);

-- The verdict cache learns the two new sources.
alter table public.mindspace_items
  drop constraint if exists mindspace_items_source_check;
alter table public.mindspace_items
  add constraint mindspace_items_source_check check (source in
    ('capture', 'journal', 'note', 'task', 'ai_chat', 'daily_log', 'spend',
     'event', 'claude_ai', 'claude_code'));
