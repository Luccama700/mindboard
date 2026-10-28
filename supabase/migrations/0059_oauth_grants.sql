-- ============================================================================
-- OAuth server state: single-use authorization codes (audit M1) and revocable,
-- rotating refresh-token families (audit M2).
--
-- The MCP authorization server is otherwise stateless — every artifact is an
-- HMAC-signed token that carries its own claims (app/lib/mcp/oauth.ts). That
-- is fine for things a signature can prove, and wrong for the two things it
-- cannot: "has this code been spent?" and "has this grant been revoked?".
-- Those are facts about the past, so they need a row.
--
-- RLS is enabled with NO policies at all on both tables, exactly like
-- urc_devices/urc_jobs (0054): they are reachable only by the service role (the
-- token endpoint and the settings revoke actions, which filter user_id
-- themselves). A session JWT must never be able to read another user's grant,
-- forge a used-code row to lock out a legitimate exchange, or clear its own
-- revoked_at.
--
-- CUTOVER: the app ships before this migration is applied. Until then both
-- stores fail OPEN (undefined_table only — any other database error fails
-- closed) so existing claude.ai connectors keep working, and the server logs
-- one warning per cold start. Applying this migration closes the window.
-- ============================================================================

-- Spent authorization codes. The row IS the "already used" fact; the primary
-- key is what makes the second exchange fail (23505 -> invalid_grant), so the
-- insert must stay a bare insert and never an upsert.
--
-- code_hash is sha256(code). Codes carry a random jti, so two codes issued in
-- the same second for the same user/client/redirect/challenge still hash
-- differently — without the jti a second, legitimate authorization could
-- collide with the first one's spent row.
create table public.oauth_used_codes (
  code_hash text primary key,
  -- The code's own exp. Rows are only useful until then; the token endpoint
  -- opportunistically sweeps everything past it.
  expires_at timestamptz not null
);

create index oauth_used_codes_expires_idx on public.oauth_used_codes (expires_at);

alter table public.oauth_used_codes enable row level security;
-- No policies by design — service role only. See the header.

-- One refresh-token family, created by one authorization-code exchange. The
-- refresh token names its family (gid) and its position in the chain (jti);
-- only the jti in current_refresh_jti is live, so presenting an older one is
-- proof the family leaked and revokes the whole thing.
--
-- Access tokens stay stateless and short-lived (1 hour), so revoking a grant
-- stops refreshes immediately but an already-issued access token keeps working
-- until it expires.
create table public.oauth_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The full signed client_id token the client presented, stored verbatim and
  -- compared exactly: a refresh must come from the same registered client.
  client_id text not null,
  -- Attacker-controllable (Dynamic Client Registration is unauthenticated), so
  -- the settings list shows it as "calls itself …", never as identity.
  client_name text,
  created_at timestamptz not null default now(),
  -- Bumped on every successful refresh — "last active", not "last tool call".
  last_used_at timestamptz,
  revoked_at timestamptz,
  current_refresh_jti text not null,
  -- The jti that current_refresh_jti replaced, and when. A client that lost the
  -- response to a refresh retries with the previous token; within a short grace
  -- window that is a retry, not a theft, and must not revoke the family.
  previous_refresh_jti text,
  rotated_at timestamptz
);

-- The settings list and the revoke actions both read by user.
create index oauth_grants_user_idx on public.oauth_grants (user_id, created_at desc);

alter table public.oauth_grants enable row level security;
-- No policies by design — service role only. See the header.
