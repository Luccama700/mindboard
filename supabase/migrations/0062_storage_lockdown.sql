-- Audit 2026-10-26 M6: storage exposure.
--
-- 1. inventory-icons is a PUBLIC bucket, and 0005 also gave it a SELECT policy
--    for every role with no folder check. A public bucket already serves
--    /object/public/... without any select policy, so that policy granted one
--    thing only: anyone holding the anon key could storage.list() the bucket
--    and walk every user's {user_id}/{item_id}/ folder (user ids, item ids,
--    uploaded photos). Replace it with an owner-only select, which uploads
--    and removals from the app still need.
--
-- 2. No bucket had a size or MIME limit; type/size checks were client-side
--    only, so any signed-up account could host arbitrary files (HTML, SVG,
--    binaries) under the project's supabase.co domain. Limits per bucket:
--    - inventory-icons: raster images only (no SVG), 5 MB.
--    - course-files: PDF only. Size is left to the project-wide limit so a
--      bucket limit can never be set above it.
--    - course-audio: WAV/MP3 only (written by the server and the home worker).
--    - reel-media: images only (reel thumbnails written by the server).

drop policy if exists inventory_icons_read_public on storage.objects;

drop policy if exists inventory_icons_select_own on storage.objects;
create policy inventory_icons_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'inventory-icons'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array[
         'image/png', 'image/jpeg', 'image/webp', 'image/gif',
         'image/heic', 'image/heif', 'image/avif'
       ]
 where id = 'inventory-icons';

update storage.buckets
   set allowed_mime_types = array['application/pdf']
 where id = 'course-files';

update storage.buckets
   set allowed_mime_types = array['audio/wav', 'audio/x-wav', 'audio/mpeg']
 where id = 'course-audio';

update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'reel-media';
