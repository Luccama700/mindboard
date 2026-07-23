-- Mindspace (docs/mindspace-plan.md): cross-domain "what's been on my mind"
-- topics. A topic is a current concern — a person, project, job, course, or
-- life area — seeded from vault entity pages and task groups, freely editable.
-- M1 persists only the taxonomy: per-item classifications are deterministic
-- (frontmatter topics, wikilinks, task groups, name matches) and recomputed at
-- read time. The LLM classifier (M2) adds item/label/observation tables when
-- results stop being derivable.

create table public.mindspace_topics (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  kind        text not null check (kind in ('person', 'project', 'work', 'course', 'area', 'emergent')),
  description text,
  aliases     text[] not null default '{}',
  -- Seeding provenance: {"vaultPath": "People/Emma.md"} and/or {"groupId": "<uuid>"}.
  seed_ref    jsonb not null default '{}'::jsonb,
  status      text not null default 'active' check (status in ('active', 'muted', 'archived')),
  pinned      boolean not null default false,
  color       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index mindspace_topics_user_idx on public.mindspace_topics (user_id);
create unique index mindspace_topics_user_name_idx
  on public.mindspace_topics (user_id, lower(name));

alter table public.mindspace_topics enable row level security;

create policy "mindspace_topics_select_own" on public.mindspace_topics
  for select using (auth.uid() = user_id);
create policy "mindspace_topics_insert_own" on public.mindspace_topics
  for insert with check (auth.uid() = user_id);
create policy "mindspace_topics_update_own" on public.mindspace_topics
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "mindspace_topics_delete_own" on public.mindspace_topics
  for delete using (auth.uid() = user_id);
