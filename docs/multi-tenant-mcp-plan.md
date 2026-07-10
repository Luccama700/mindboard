# Multi-tenant conversion: audit + migration plan

Status: **implemented 2026-07-10** (owner approved; decisions: login stays
open, worker shared behind `WORKER_ALLOWED_USER_IDS`, static token kept and
mapped to the owner). Migration `0035_multi_tenant_mcp` applied. New-user flow:
`docs/mcp-provisioning.md`.
Date: 2026-07-10. Prod project: `kdsunzpcjfzkidejtnyp` (verified read-only).

## Part 1 — Audit

### 1.1 Where the owner check lives

One env var is the root of all single-tenancy: `MINDBOARD_OWNER_USER_ID`
(= `8fd62772-a371-4d26-8a93-678b88c2b879`, verified in prod `auth.users` as
luccama700@gmail.com), read by `ownerUserId()` in `app/lib/mcp/config.ts:6`.
It is enforced in three places:

1. **OAuth authorize gate** — `app/api/mcp/oauth/authorize/route.ts:60`:
   after Supabase Google login, any session whose `user.id` differs from the
   env value gets `403 "this Mindboard account is not the MCP owner"`. This is
   the exact error non-owner accounts see today.
2. **MCP tool data layer (the real binding)** — every MCP read/write runs on
   the **service-role client** (bypasses RLS, `utils/supabase/service.ts`) and
   filters by `ownerUserId()` from env, ignoring who authenticated:
   - `app/lib/mcp/reads.ts:79` — `scoped()` binds `{ createServiceClient(), ownerUserId() }` for all ~25 read tools.
   - `app/lib/mcp/writes.ts` — ~25 `propose*` wrappers + `confirmAction`/`cancelAction` (lines 2683, 2722) bind the same pair.
   - `app/lib/mcp/courses.ts:373-385`, `app/lib/mcp/brain.ts:27`, `app/lib/learn/episodes.ts:410` — same pattern.
   Crucially, the auth wrapper *does* extract the token's user id
   (`extra.ownerId`, `app/api/mcp/[transport]/route.ts:1236`) — the tools just
   never read it.
3. **Worker heartbeat** — `app/api/worker/route.ts:59` upserts
   `worker_status` under `ownerUserId()`.

A fourth, identity-less path: the static **`MCP_BEARER_TOKEN`** env (shared
secret) authenticates MCP requests with no user attached (route.ts:1225-1228)
and is also the home worker's auth for `/api/worker`. Because data scoping
comes from env anyway, holding this token today = being the owner.

### 1.2 Tables

**Every one of the 30 public tables is a user-data table** with
`user_id uuid not null references auth.users(id) on delete cascade`,
RLS enabled, and per-operation `auth.uid() = user_id` policies. Verified
against prod (not just migration files): zero tables with RLS off, zero
tables without `user_id`.

| Category | Tables |
|---|---|
| Tasks/groups | groups, tasks, recurring_tasks, recurring_task_completions |
| Finance | spending_categories, accounts, balance_changes, account_reconciliations, recurring_expenses, income_sources, spend_overrides, spend_limits |
| Inventory | inventory_groups, inventory_items, inventory_usages |
| Learn | courses, course_sources, course_source_parts, course_cards, audio_episodes |
| AI/assistant | ai_conversations, ai_messages, ai_audit_log (also stores MCP proposals) |
| Infra/settings | user_settings, vault_settings, google_tokens, daily_logs, goals, jobs, worker_status |

Two intentional policy quirks, not gaps: `ai_messages` has no update policy;
`worker_status` is select-own only (writes go through the service role).

Storage buckets are already per-user too: `inventory-icons` (public read,
writes locked to `{user_id}/` folder), `course-files` and `course-audio`
(private, all four ops locked to `{user_id}/` folder).

**App config / shared tables: none.** The only shared state is env vars.

Dormant asset: migration `0016_mcp_server.sql` added
`user_settings.mcp_token_hash` + a partial unique index — a per-user MCP
token column that was designed but never wired to any code. We will use it.

### 1.3 Prod data reality (read-only checks, 2026-07-10)

- `auth.users` holds **5 users**: the owner + 4 other Google accounts
  (isabellagmartins01 since 2026-05-20; william.connell13, jpbomfim0201,
  emmaxsmith08 signed up 2026-07-10). Login is open Google OAuth.
- Row ownership: all domain data belongs to the owner. Other users own only
  their own `google_tokens` (4), `user_settings` (3), and `tasks` (2) rows —
  correctly isolated by RLS. **No cross-contamination found.**
- Consequence: **no backfill is needed and no schema migration is needed for
  isolation.** `user_id NOT NULL` + FK makes ownerless rows impossible.

### 1.4 How the MCP route authenticates today

`withMcpAuth(mcpHandler, verifyToken, { required: true })` (route.ts:1243):

- **OAuth 2.1, implemented in-app and stateless**: dynamic client registration
  (`/api/mcp/oauth/register`), authorize (owner-gated, auto-approve),
  token endpoint (code + refresh grants), PKCE S256 required, discovery at
  `/.well-known/oauth-authorization-server` + `/oauth-protected-resource`.
  Tokens are HMAC-SHA256-signed JSON (`MCP_OAUTH_SECRET`), access 1 h,
  refresh 30 d, `sub` = Supabase user id. No OAuth DB tables.
- **Static bearer** `MCP_BEARER_TOKEN`, constant-time compared.

The web app is already fully multi-tenant: every page/server action uses the
cookie-session client (`utils/supabase/server.ts`) so RLS applies, and the
in-app assistant threads the session `user.id` into
`runAssistantTool(supabase, userId, …)`. Onboarding (intro carousel, tours,
empty states) already exists for new users.

### 1.5 Bottom line

Steps 2 (schema) and 3 (RLS) of the original request are **already done** —
the app was built multi-tenant at the DB layer from day one. The entire
conversion is: (a) resolve a per-request user identity in the MCP layer,
(b) thread it into the tool functions instead of `ownerUserId()`,
(c) drop the authorize gate, (d) build token provisioning UI, (e) prove
isolation with tests.

## Part 2 — Migration plan

### Recommended MCP auth mechanism

**Single MCP URL for everyone (`/api/mcp/mcp`); identity from the
Authorization layer, never the URL path.**

1. **Primary: the existing OAuth flow, minus the owner gate.** Any signed-in
   Supabase user who hits authorize gets a token with `sub = their user id`.
   claude.ai / ChatGPT connectors already speak this flow. Zero secrets to
   copy; revocation via `MCP_OAUTH_SECRET` rotation (global) today, per-user
   revocation later if wanted.
2. **Secondary: per-user personal access token (PAT)** for non-OAuth clients
   (Claude Desktop config, curl, MCP inspector): `mbp_<32-byte-random>`,
   generated in Settings, shown once, stored as SHA-256 hex in the existing
   `user_settings.mcp_token_hash`, verified by hash lookup → `user_id`.
3. **Transitional: `MCP_BEARER_TOKEN` maps explicitly to
   `MINDBOARD_OWNER_USER_ID`** so the owner's static-token clients and the
   home worker keep working unchanged. Retire later at leisure.

Token-in-URL-path was considered and rejected: URLs leak into request logs,
browser history, and client configs; claude.ai already prefers OAuth here.

### Phases

**Phase 1 — parameterize the MCP tool layer (no behavior change).**
`reads.ts` `scoped(userId)`; `writes.ts`/`courses.ts`/`brain.ts`/
`episodes.ts` wrappers take `userId` (most already have `*For(client,
userId, …)` inner functions — this is mostly deleting env-binding shims).

**Phase 2 — per-request identity in the route.**
`verifyToken` resolves, in order: static token → owner id (env, transitional);
OAuth access token → `sub`; PAT → hash lookup. Each tool handler reads
`extra.authInfo` (mcp-handler ≥1.1 passes it through) and hands `userId`
down. Unresolvable identity → 401. Remove the owner gate in
`oauth/authorize/route.ts` (auto-approve stays, now per-user).
`/api/worker` keeps the static token and keeps heartbeating the owner row.

**Phase 3 — one idempotent migration** (`0035_mcp_user_tokens.sql`):
`alter table user_settings add column if not exists mcp_token_hint text;`
`… add column if not exists mcp_token_created_at timestamptz;`
(`mcp_token_hash` + index already exist from 0016). Nothing else. No
backfill. Applied via `supabase migration` tooling, not ad-hoc SQL.

**Phase 4 — provisioning UI + doc.**
Settings "MCP connection" card: shows the MCP URL, generate/regenerate/revoke
PAT (value shown once; hint = last 4), and short instructions for claude.ai
(add connector → sign in with Google) vs Desktop (paste PAT). Server actions
run on the session client. New-user path: Google sign-in → empty workspace
(already works) → Settings → connect. Plus `docs/mcp-provisioning.md`.

**Phase 5 — isolation tests.**
- Unit (Vitest, no network): PAT generate/hash/verify round-trip; token
  resolution precedence; a representative read and write asserting the
  queried `user_id` equals the authenticated user.
- Integration (needs approval — creates two throwaway users in prod via the
  admin API, cleans up after): (a) RLS proof — user A's anon-key session
  selects user B's tasks → 0 rows; inserts a row with `user_id = B` → RLS
  error. (b) MCP proof — two PATs; `list_tasks` returns disjoint sets;
  A calling `confirm_action` on B's proposalId → "not found". Alternative if
  prod test users are unwanted: run the same suite against a local
  `supabase start` stack.

### Preserving the owner (requirement 7)

- Data: untouched — no schema change to data tables, no backfill, no rewrite.
- claude.ai OAuth connection: tokens already carry your `sub`; the secret and
  format don't change → existing refresh tokens keep working, no re-auth.
- Static-token clients + home worker: unchanged via the transitional mapping.

### Decisions needed from the owner

1. **The 4 existing foreign accounts** — after this ships they get working
   MCP over their own (empty) data. Two signed up today; if they're not
   people you know, consider Supabase Auth restrictions (or leave it — they
   see nothing of yours either way).
2. **Shared home worker**: `claim_next_job()` takes any user's OCR/TTS jobs,
   so strangers' jobs would run on your PC (their own API keys/vault, your
   compute). Options: leave as-is, or filter claims to your user id.
3. **Static `MCP_BEARER_TOKEN`**: keep mapped to you indefinitely, or retire
   once you've switched personal clients to a PAT (worker would get its own
   `WORKER_TOKEN`).
4. Approval to create/delete two throwaway test users in prod for the
   isolation proof (or prefer a local stack).
