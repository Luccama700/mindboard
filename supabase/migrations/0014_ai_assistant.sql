-- ============================================================================
-- mindboard AI assistant tables (second-brain Phase 2)
-- ai_conversations / ai_messages persist the in-app assistant chat.
-- ai_audit_log records every write the assistant proposes: rows are created
-- as 'proposed' when Claude calls a write tool, and resolve to 'executed',
-- 'rejected', or 'error' when the user confirms or dismisses. Nothing the
-- assistant proposes runs without a row here (write-with-confirmation).
-- RLS scoped by auth.uid().
-- ============================================================================

create table public.ai_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ai_conversations_user_idx
  on public.ai_conversations (user_id, updated_at desc);

create table public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  created_at      timestamptz not null default now()
);

create index ai_messages_conversation_idx
  on public.ai_messages (conversation_id, created_at);

create table public.ai_audit_log (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.ai_conversations (id) on delete set null,
  tool_name       text not null,
  input           jsonb not null,
  summary         text not null,
  status          text not null default 'proposed'
                  check (status in ('proposed', 'executed', 'rejected', 'error')),
  result          jsonb,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index ai_audit_log_user_idx on public.ai_audit_log (user_id, created_at desc);
create index ai_audit_log_conversation_idx on public.ai_audit_log (conversation_id);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_audit_log enable row level security;

create policy "ai_conversations_select_own" on public.ai_conversations for select using (auth.uid() = user_id);
create policy "ai_conversations_insert_own" on public.ai_conversations for insert with check (auth.uid() = user_id);
create policy "ai_conversations_update_own" on public.ai_conversations for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "ai_conversations_delete_own" on public.ai_conversations for delete using (auth.uid() = user_id);

create policy "ai_messages_select_own" on public.ai_messages for select using (auth.uid() = user_id);
create policy "ai_messages_insert_own" on public.ai_messages for insert with check (auth.uid() = user_id);
create policy "ai_messages_delete_own" on public.ai_messages for delete using (auth.uid() = user_id);

create policy "ai_audit_log_select_own" on public.ai_audit_log for select using (auth.uid() = user_id);
create policy "ai_audit_log_insert_own" on public.ai_audit_log for insert with check (auth.uid() = user_id);
create policy "ai_audit_log_update_own" on public.ai_audit_log for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "ai_audit_log_delete_own" on public.ai_audit_log for delete using (auth.uid() = user_id);
