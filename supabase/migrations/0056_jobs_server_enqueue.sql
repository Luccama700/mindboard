-- ============================================================================
-- jobs are enqueued by the SERVER only (security audit 2026-10-26, C1 + M7).
--
-- 0027 gave `jobs` the usual own-row policies, so any signed-in session could
-- insert or update its own row over PostgREST with any payload it liked —
-- while the home worker on the PC treats that payload as something the server
-- wrote. A `reel` row's url reached a command line; a `followup` row's text
-- reached a Claude Code run. `urc_jobs` (0054) already models the right shape:
-- service-role writes only, client reads of its own rows.
--
-- Every app-side enqueue now goes through the service client with an explicit
-- user_id (queueSourceConversion, generateEpisodeFor, queueReel,
-- queueFollowupFromWatch, /api/capture), so nothing in the app needs these.
-- select-own stays: /settings counts the user's pending jobs and the watch's
-- follow-up receipt reads its own rows.
--
-- delete-own goes too: no client code deletes a job, and leaving it would let
-- a session drop the queued row the worker is about to claim.
-- ============================================================================

drop policy if exists jobs_insert_own on public.jobs;
drop policy if exists jobs_update_own on public.jobs;
drop policy if exists jobs_delete_own on public.jobs;
