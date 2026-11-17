-- ============================================================================
-- course_sources.storage_path must sit in the owner's own folder
-- (security audit 2026-10-26, M7).
--
-- attachSourceFile (app/actions/learn.ts) checks the `{user_id}/{source_id}/`
-- prefix the browser uploaded to, but `course_sources_update_own` (0024) lets
-- the same user PATCH the column afterwards to anything at all — and
-- /api/worker then signs that path with the service role. An allowlisted user
-- who knew another user's exact object path could get that user's PDF
-- converted into their own vault. The route re-asserts the prefix in code now
-- (app/lib/worker/claims.ts: storagePathBelongsTo); this is the same rule as a
-- database fact, so nothing else has to remember it.
--
-- The pattern is the literal prefix attachSourceFile writes, with `like`'s
-- single trailing wildcard:   <user_id>/<id>/%
-- ============================================================================

alter table public.course_sources
  add constraint course_sources_storage_path_own_folder
  check (
    storage_path is null
    or storage_path like user_id::text || '/' || id::text || '/%'
  )
  not valid;

-- NOT VALID so adding it cannot fail on, or lock out, a pre-existing row.
-- LUCCA: after applying, check the existing rows and then validate:
--
--   select id, user_id, storage_path from public.course_sources
--    where storage_path is not null
--      and storage_path not like user_id::text || '/' || id::text || '/%';
--
--   -- expect zero rows; then:
--   alter table public.course_sources
--     validate constraint course_sources_storage_path_own_folder;
--
-- Any row the select returns is either legacy or the exact abuse this closes —
-- look at it before deciding whether to null the column or leave the
-- constraint unvalidated (it still applies to every new write either way).
