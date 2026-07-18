-- ============================================================================
-- Reel capture (docs/reel-capture-plan.md): the home worker gains a third job
-- kind, 'reel' — download an Instagram reel the user shared into the vault,
-- transcribe it, describe/OCR keyframes, and write the record back into the
-- note. Reuses the whole jobs/worker chassis (0027); this only widens the
-- kind check and adds the private bucket the thumbnail + keyframes land in.
-- ============================================================================

alter table public.jobs
  drop constraint jobs_kind_check,
  add constraint jobs_kind_check check (kind in ('ocr', 'tts', 'reel'));

-- Private bucket; keyframes + thumbnail served via short-lived signed URLs,
-- user-scoped to the {user_id}/... folder like course-audio.
insert into storage.buckets (id, name, public)
values ('reel-media', 'reel-media', false)
on conflict (id) do nothing;

create policy "reel_media_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'reel-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "reel_media_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'reel-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "reel_media_delete_own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'reel-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
