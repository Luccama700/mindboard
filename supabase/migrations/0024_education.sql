-- ============================================================================
-- mindboard education section (/learn) — courses + sources (L0 of
-- docs/education-plan.md). Converted markdown lives in the vault; these
-- tables hold operational metadata only.
-- ============================================================================

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  code text,
  term text,
  color text not null default '#b5ff3c',
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.courses enable row level security;

create policy courses_select_own on public.courses
  for select using (auth.uid() = user_id);
create policy courses_insert_own on public.courses
  for insert with check (auth.uid() = user_id);
create policy courses_update_own on public.courses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy courses_delete_own on public.courses
  for delete using (auth.uid() = user_id);

create table public.course_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  kind text not null default 'pdf' check (kind in ('pdf', 'markdown', 'text', 'url')),
  status text not null default 'registered' check (
    status in ('registered', 'uploaded', 'queued', 'converting', 'converted', 'failed')
  ),
  storage_path text,
  vault_path text,
  page_count integer,
  error text,
  created_at timestamptz not null default now()
);

create index course_sources_course_idx on public.course_sources (course_id);

alter table public.course_sources enable row level security;

create policy course_sources_select_own on public.course_sources
  for select using (auth.uid() = user_id);
create policy course_sources_insert_own on public.course_sources
  for insert with check (auth.uid() = user_id);
create policy course_sources_update_own on public.course_sources
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy course_sources_delete_own on public.course_sources
  for delete using (auth.uid() = user_id);

-- Staging area for the chunked MCP upload (begin/append/finalize).
-- Rows are deleted after finalize assembles the markdown.
create table public.course_source_parts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.course_sources(id) on delete cascade,
  part_index integer not null,
  markdown text not null,
  created_at timestamptz not null default now(),
  unique (source_id, part_index)
);

alter table public.course_source_parts enable row level security;

create policy course_source_parts_select_own on public.course_source_parts
  for select using (auth.uid() = user_id);
create policy course_source_parts_insert_own on public.course_source_parts
  for insert with check (auth.uid() = user_id);
create policy course_source_parts_update_own on public.course_source_parts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy course_source_parts_delete_own on public.course_source_parts
  for delete using (auth.uid() = user_id);

-- Encrypted (AES-256-GCM, app-side — the 0015 anthropic_api_key pattern)
-- provider keys for server-side use: Gemini TTS + icon generation.
alter table public.user_settings
  add column google_ai_api_key text,
  add column openai_api_key text;

-- Private bucket for original course files (PDFs). No public read; clients
-- upload directly to their own {user_id}/... folder and read via signed URLs
-- or their own authenticated select.
insert into storage.buckets (id, name, public)
values ('course-files', 'course-files', false)
on conflict (id) do nothing;

create policy "course_files_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'course-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "course_files_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'course-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "course_files_update_own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'course-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "course_files_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'course-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
