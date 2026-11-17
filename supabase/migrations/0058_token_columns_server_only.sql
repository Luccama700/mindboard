-- Secret columns become server-only. Audit 2026-10-26, finding H4, second
-- half: the two preceding commits encrypt google_tokens.access_token /
-- refresh_token and vault_settings.github_token at rest; this stops the
-- browser's own database role from reading those columns at all.
--
-- NOT YET APPLIED. Apply only AFTER the deploy that carries those commits —
-- see the last note at the bottom.
--
-- WHY GRANTS AND NOT POLICIES. RLS decides which ROWS a role sees; it cannot
-- hide a COLUMN. "google_tokens_select_own" faithfully returns the caller's
-- own row, and the caller's own row is exactly what a stolen session or an XSS
-- wants: one supabase.from('google_tokens').select('*') in devtools is a live
-- Google refresh token, and the same for the vault PAT. Dropping or rewriting
-- the policies could not express "every column but this one". Column
-- privileges can, so they are the mechanism here and the policies stay as they
-- are.
--
-- WHY REVOKE-THEN-GRANT RATHER THAN A COLUMN-LEVEL REVOKE. In Postgres a
-- table-level privilege covers every column and column grants are purely
-- additive, so `revoke select (github_token)` is a silent no-op while the
-- table grant stands. The table grant has to go first; SELECT is then granted
-- back on the non-secret columns only.
--
-- WHY THE NON-SECRET COLUMNS COME BACK (and only to `authenticated`). UPDATE
-- and DELETE evaluate their RLS USING clause against user_id, which requires
-- SELECT on that column — without it a signed-in user could no longer
-- disconnect their vault. The app's own client-side-role reads need theirs
-- too: getVaultSettings selects repo/branch/updated_at on the cookie client to
-- render the /settings connection card. `anon` gets nothing back: no policy
-- ever admitted it to a row, so the grant was dead weight (audit L9).
--
-- WHY INSERT/UPDATE/DELETE ARE LEFT ALONE. A write cannot exfiltrate: PostgREST
-- echoes a row back only with Prefer: return=representation, which itself
-- needs SELECT, and supabase-js sends return=minimal unless .select() is
-- chained. Column-level write grants would also silently omit any column a
-- later migration adds, turning an unrelated feature into an outage.
--
-- CONSEQUENCE FOR LATER MIGRATIONS: after this, these two tables carry no
-- table-wide SELECT grant for `authenticated`. Any column added to them needs
-- its own `grant select (<column>) ... to authenticated`, or the client simply
-- will not see it.
--
-- APPLY AFTER DEPLOY, NOT BEFORE. Every server read and write of these columns
-- moved to the service client (which bypasses grants, with an explicit
-- user_id filter) in the two commits before this one: app/auth/callback,
-- utils/google/calendar.ts, app/lib/brain/vault.ts, app/actions/brain.ts.
-- That code works both before and after this migration. The old code does not:
-- applying this against a deployment that predates it breaks the calendar and
-- /brain until the deploy lands.

revoke select on table public.google_tokens from anon, authenticated;

grant select (id, user_id, expires_at, scopes, updated_at)
  on table public.google_tokens to authenticated;

revoke select on table public.vault_settings from anon, authenticated;

grant select (user_id, repo, branch, created_at, updated_at)
  on table public.vault_settings to authenticated;
