# Mindboard

Mindboard is a personal life dashboard: tasks across responsibility groups, a daily stream of what matters now, finance and inventory forecasts, people, a vault-backed second brain, and an MCP server that lets Claude read and (with confirmation) write all of it. Any Google account can sign in to its own fully isolated workspace.

The primary use case is an installed iOS PWA: open it, capture something in a few seconds through the Dock, and get back to the day.

## Features

- **Dashboard stream.** A daily pulse (clock, tasks to clear, free hours, mood), then NOW / NEXT / LATER task sections. On desktop a week calendar sits beside it; on mobile it is `/week`.
- **The Dock**, a global capture field with three modes:
  - tasks, with due date / time / group / recurrence;
  - spends;
  - notes, which land in the vault.
- **Tasks** (`/tasks`): every task, filterable by group, with an inline edit panel, the group manager and the history. Agent hand-off is available from the edit panel: `✦ follow up` and `✦ do it`.
- **Google Calendar.** Events from every readable calendar, with drag-to-reschedule and inline time editing on writable calendars, plus per-group calendar links.
- **Finance** (`/finance`): a transactions-first ledger, statement imports through the assistant, recurring bills and income, and a net-worth cashflow forecast.
- **Inventory** (`/inventory`): the shelf, depletion forecasts, a shopping list with AI price estimates, and propose → confirm capture.
- **People** (`/people`), **Brain** (`/brain`, the GitHub vault reader and graph), **Mindspace**, and **Learn** (`/learn`; hidden from the nav).
- **Assistant and approvals.** The in-app assistant (`/plan`) and an approvals inbox (`/approvals`) for every pending proposal.
- **Settings** (`/settings`):
  - provider keys, which are encrypted;
  - MCP personal access token;
  - connected OAuth apps with revoke;
  - data export, account deletion, and a list of where your data goes.
- **PWA and themes.** Installable on iOS, with six themes (dark, cream, midnight, forest, slate, sand) and per-theme palette overrides.

## Tech Stack

- Next.js 16 App Router with React 19 and TypeScript.
- Tailwind CSS v4.
- Supabase Postgres, Row Level Security, and Google Auth.
- `@supabase/ssr` for server/browser auth clients.
- Vercel deployment from `main`.

Important: this project uses Next.js 16. Before changing framework conventions, read the relevant docs in `node_modules/next/dist/docs/`.

## Getting Started

Install dependencies:

```bash
npm install
```

Create `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
```

Run the development server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Scripts

```bash
npm run dev
npm run lint
npm run build
npm run test
npm run start
```

`npm run build` may need network access because `next/font` fetches Geist Mono from Google Fonts.

## Database Setup

Apply every migration in `supabase/migrations` in numeric order (there is no `0053`). `AGENTS.md` → "Data Model" describes them. Migrations `0056`–`0065` (the 2026-10-26 security audit) must be applied **after** the matching code is deployed; each file's header says why.

Every table has Row Level Security enabled. User tables are scoped to `auth.uid() = user_id`. A handful of tables have no client policy at all and are written only by the server's service role: `jobs` and `ai_audit_log` writes, `urc_*`, and `oauth_*`.

Do not disable RLS for debugging. If a query fails because of RLS, fix the policy or the query context.

## Google Calendar Setup

Enable the Google Calendar API in Google Cloud.

Add these OAuth consent scopes:

```text
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
```

`calendar.events` is read+write on events (no calendar management) and is required for drag-to-reschedule and inline event editing.

Make sure Supabase Google Auth and Vercel use the same OAuth client:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

After changing scopes, sign out and sign back in. Google provider tokens are captured in `app/auth/callback/route.ts` and stored in `google_tokens`. Supabase does not refresh provider tokens automatically, so `utils/google/calendar.ts` handles refresh with Google’s token endpoint.

No Google API key is used.

## MCP Server (remote)

Mindboard exposes its data to external Claude clients (claude.ai web, mobile, Cowork) as a remote [Model Context Protocol](https://modelcontextprotocol.io) server, built on the Phase 0 tool registry. Reads are safe; writes go through an explicit propose → confirm step, and every executed write is recorded in `ai_audit_log`.

The server is **multi-tenant**: every request resolves to a specific Supabase user and every tool call is scoped to that user's rows. See `docs/mcp-provisioning.md` for the new-user setup flow.

- Endpoint: `POST /api/mcp/mcp` — App Router route at `app/api/mcp/[transport]/route.ts`, via Vercel's `mcp-handler` (stateless streamable HTTP, no Redis). One URL for all users; identity comes from the Authorization layer.
- Auth, three ways (each resolves to a user id in `authInfo.extra.userId`):
  1. **OAuth 2.1** for claude.ai:
     - discovery (`/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server`);
     - dynamic client registration, limited to allowlisted redirect hosts;
     - authorization code + PKCE (S256);
     - the `/authorize` step reuses the app's Google/Supabase login, so whoever signs in authorizes access to their own data.

     Tokens are HMAC-signed (`MCP_OAUTH_SECRET`):
     - codes are single-use;
     - refresh tokens rotate within a grant, and reuse revokes the grant;
     - access tokens are audience-checked.

     Grants live in `oauth_grants` and can be revoked from `/settings`.
  2. **Per-user personal access token** (`mbp_…`) for non-OAuth clients (Claude Desktop, MCP inspector, curl). It is generated on `/settings`, shown once, and stored only as a SHA-256 hash. PATs are refused by the URC tools.
  3. **Legacy static `MCP_BEARER_TOKEN`**: off unless `MCP_STATIC_BEARER_ENABLED=true`, in which case it maps to the deployment owner (`MINDBOARD_OWNER_USER_ID`). The home worker authenticates separately, with `WORKER_BEARER_TOKEN` on `/api/worker`.
- Risky writes need a human. A model can call `confirm_action` on its own proposal, so these proposals can only be confirmed from `/approvals`, the in-app assistant, or the watch:
  - deletes;
  - finance edits and reconciles;
  - settings;
  - paid generation;
  - approving an overnight build.
- Data access: a service-role Supabase client (`SUPABASE_SERVICE_ROLE_KEY`) with every query filtered by the authenticated user id explicitly (the service role bypasses RLS; the app's own pages use session clients where RLS is the boundary).
- Home worker: shared infrastructure, gated by an allowlist — only jobs from the owner plus `WORKER_ALLOWED_USER_IDS` (comma-separated user ids) are claimed.

Additional server env vars:

```bash
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_secret   # Dashboard > Settings > API
MCP_BEARER_TOKEN=a_long_random_secret        # legacy static token (only with MCP_STATIC_BEARER_ENABLED=true)
MCP_STATIC_BEARER_ENABLED=false              # leave unset/false unless you need the legacy path
WORKER_BEARER_TOKEN=a_long_random_secret     # the home worker's own secret for /api/worker
MINDBOARD_OWNER_USER_ID=your_supabase_auth_user_id   # owner mapping + worker heartbeat
MCP_OAUTH_SECRET=a_long_random_secret        # signs the OAuth codes/tokens
MCP_OAUTH_ALLOWED_REDIRECT_HOSTS=claude.ai,claude.com,localhost,127.0.0.1   # optional override
ASSISTANT_KEY_SECRET=a_long_random_secret    # encrypts stored provider keys and Google/GitHub tokens (32+ random bytes)
WORKER_ALLOWED_USER_IDS=uuid1,uuid2          # optional: extra users allowed on the home worker
WATCH_TOKEN=a_long_random_secret             # Apple Watch API bearer (see below)
```

Tools: about 70 reads, proposes and direct tools across tasks, recurring tasks, groups, calendar, finance, inventory, people, goals, daily logs, courses, the vault and URC. The authoritative list is `tools/list` against the server, or the `registerTool` calls in `app/api/mcp/[transport]/route.ts`. Every write tool proposes. `confirm_action` executes a proposal and `cancel_action` discards it. The two exceptions are the create-only vault writers (`capture_to_brain`, course uploads), which run directly.

In production, add it to claude.ai as a custom connector (Settings → Connectors → Add custom connector) pointing at `https://<your-domain>/api/mcp/mcp` — claude.ai runs the OAuth flow and each user approves once via their own Google login. Test locally with the MCP inspector (`npx @modelcontextprotocol/inspector`) using OAuth or a per-user `mbp_` token from `/settings`.

## Apple Watch API

The watchOS client (`mindboard-watch`, a separate repo) talks to a small JSON API under `/api/watch/*`, authenticated with a bearer token from the `WATCH_TOKEN` env var:

- Plain string: `WATCH_TOKEN=a_long_random_secret` — maps to the deployment owner (`MINDBOARD_OWNER_USER_ID`), like the legacy static MCP token.
- JSON map, one token per tenant: `WATCH_TOKEN={"secret_for_lucca":"<lucca_user_id>","secret_for_friend":"<friend_user_id>"}`.

Generate a token with `openssl rand -base64 48`, set it in Vercel (Production) and in `.env.local`, then paste the same value into the watch app's `Secrets.xcconfig`. Rotating the token is just changing the env var and redeploying; a missing or malformed `WATCH_TOKEN` makes every watch request 401.

Endpoints (all `Authorization: Bearer <token>`; writes are JSON `POST`s and accept an `Idempotency-Key` header so a retried request from a flaky watch connection never double-logs — the key derives the `ai_audit_log` row id, and a repeat replays the first attempt's result):

- `GET /api/watch/today` — overdue + due-today tasks (with group name + color, priority, and notes for the detail screen), today's remaining calendar events (with calendar, color — linked group's, else the Google calendar's — location, and description for the event screen), today's routines with done state, upcoming events and tasks for the next 7 days, next timed event, free hours left, plus `meta` (server time, user timezone).
- `POST /api/watch/complete` `{ "type": "task" | "recurring", "id" }` — same executors as the MCP `complete_task` / `complete_recurring_task` tools (recurring: today's occurrence only).
- `POST /api/watch/miss` `{ "id" }` — mark a task missed (the MCP `miss_task` executor).
- `POST /api/watch/followup` `{ "id", "text" }` — queue a dictated follow-up on a task as a `followup` job for the home worker (`worker/worker.py`), where a web-research-only Claude run (no shell, no credentials) researches it and the server creates one new task in the same group with the same due date from its result; the original stays open. Follow-ups are served for the deployment owner only. `meta.followups` in `/today` reports pending and recently failed jobs. The app's task edit panel queues the same job via its `✦ follow up` button (payload `source: "mindboard app"`).
- `POST /api/watch/defer` `{ "id" }` — push a task's due date by one day, keeping its time (the MCP `update_task` executor). Send an `Idempotency-Key`: a retried request would otherwise push it twice.
- `POST /api/watch/task` `{ "title" }` — inbox task, no group, priority med.
- `POST /api/watch/spend` `{ "amount", "note"? }` — logs a spend today against the default account (the oldest active one, as the dock's `$` capture does).
- `POST /api/watch/capture` `{ "text" }` — `capture_to_brain` with source `"apple watch"`.

## Project Structure

```text
app/
  _components/              shared UI (Dock, stream, calendar, task rows, onboarding)
  actions/                  server actions
  api/                      route handlers: mcp (+ oauth), worker, watch, capture, urc, account, assistant, course-chat
  lib/                      non-UI logic: mcp tool layer, data reads, snapshots, finance, vault, urc, ...
  <route>/                  pages: tasks, week, plan, approvals, finance, inventory, people, brain, mindspace, learn, settings
  page.tsx                  dashboard (or the landing page when signed out)

utils/                      Supabase and Google clients
supabase/migrations/        SQL schema, RLS policies, RPCs
worker/                     the home PC: worker.py (jobs) and urc-agent.mjs (remote-control sessions)
overnight/                  the nightly / on-demand agent harness (run.mjs) and its hardening runbook
test/isolation/             the live two-tenant isolation probe (npm run test:isolation)
__tests__/                  Vitest unit tests, including the static tenant-scope invariant
```

## Design Notes

The visual direction is “Terminal Calm”:

```text
background    #0d0d0d
foreground    #f5f0e8
accent        #b5ff3c
muted text    #6b6b6b
borders       #1f1f1f / #2a2a2a
danger        #ff6b6b
font          Geist Mono
```

Keep the app mobile-first, dense, and quiet. The Dock is the most important interaction and must stay usable while scrolling.

Theme colors are centralized in `app/globals.css` and `app/_components/themes.ts`. The dashboard settings panel stores per-theme palette overrides in `localStorage` as `palette-${theme}`.

## Agent Context

For AI agents and Claude Code, read `AGENTS.md` first. It contains the current architecture, product constraints, security rules, and implementation notes. `CLAUDE.md` points to that file.

Historical planning docs live in `docs/archive/` and are not current ground truth.

## Deployment

Pushes to `main` deploy through Vercel.

Before pushing code changes, run:

```bash
npm run lint
npm run test
npm run build
```

Browser-only setup, such as Supabase dashboard settings, Google Cloud OAuth consent, and Vercel environment variables, must be done manually in those dashboards.
