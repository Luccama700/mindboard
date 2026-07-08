-- ============================================================================
-- mindboard audio overviews (L2 of docs/education-plan.md): generated two-host
-- podcast episodes per course, plus the private bucket the audio lands in.
-- (0025 is reserved by the concurrent onboarding migration.)
-- ============================================================================

create table public.audio_episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  title text not null,
  source_ids uuid[] not null default '{}',
  engine text not null default 'gemini' check (engine in ('gemini', 'vibevoice')),
  flavor text not null default 'deep-dive' check (flavor in ('deep-dive', 'brief', 'debate')),
  status text not null default 'scripting' check (
    status in ('scripting', 'rendering', 'queued', 'done', 'failed')
  ),
  script jsonb,
  duration_sec integer,
  storage_path text,
  error text,
  created_at timestamptz not null default now()
);

create index audio_episodes_course_idx on public.audio_episodes (course_id);

alter table public.audio_episodes enable row level security;

create policy audio_episodes_select_own on public.audio_episodes
  for select using (auth.uid() = user_id);
create policy audio_episodes_insert_own on public.audio_episodes
  for insert with check (auth.uid() = user_id);
create policy audio_episodes_update_own on public.audio_episodes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy audio_episodes_delete_own on public.audio_episodes
  for delete using (auth.uid() = user_id);

-- Private bucket; episodes are served via short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('course-audio', 'course-audio', false)
on conflict (id) do nothing;

create policy "course_audio_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'course-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "course_audio_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'course-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "course_audio_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'course-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
