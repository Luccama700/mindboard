# Mindboard

Mindboard is a personal life dashboard built for fast task capture and daily planning. It tracks tasks across responsibility groups, surfaces what is due today, and embeds a read-only Google Calendar view directly into the dashboard.

The primary use case is an installed iOS PWA: open it, jot a task in a few seconds, and get back to the day.

## Features

- Google OAuth sign-in through Supabase Auth.
- Today dashboard with overdue, today, and due-soon task sections, laid out full-width with the task list on the left and the calendar on the right on desktop.
- Groups for courses, work, projects, and personal areas, with inline edit panels for rename, type, color, archive, and Google Calendar linking.
- Inline task editing on every row: rename, change due date, edit Markdown notes, and move between groups or the inbox without leaving the list.
- Twelve preset color swatches plus a custom swatch backed by the native color picker for any RGB value.
- Inbox for tasks without a group.
- Fast fixed-bottom task capture bar with sticky due-date chips, sticky group selection, and a quick Markdown notes drawer.
- Embedded dashboard calendar with month and week views.
- Google Calendar events from every readable calendar on the signed-in Google account, with drag-to-reschedule and inline date/time editing for events on calendars you can write to.
- Per-group Google Calendar linking: events from a linked calendar appear as read-only rows in the today list and the group page, tagged with the group's color and name.
- PWA manifest and iOS home-screen icons.
- Six preset themes (dark, cream, midnight, forest, slate, sand) plus full per-theme palette customization (13 color slots) from the dashboard settings panel, persisted in `localStorage`.
- Split-screen get-started page that animates the chosen theme to 80% width on tap, and a first-run welcome tour that prompts for a theme and points to the settings panel.

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

Apply the migrations in `supabase/migrations`:

- `0001_init.sql`: creates `groups` and `tasks`, including `tasks.notes` for Markdown task details.
- `0002_google_tokens.sql`: creates `google_tokens` for Google provider tokens.
- `0003_group_calendars.sql`: adds `groups.google_calendar_id` for per-group Google Calendar linking.

Every table has Row Level Security enabled and policies scoped to `auth.uid() = user_id`.

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
  1. **OAuth 2.1** for claude.ai — discovery (`/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server`), dynamic client registration, authorization-code + PKCE. The `/authorize` step reuses the app's Google/Supabase login; whoever signs in authorizes access to their own data (the token's `sub` is their user id). All OAuth artifacts are stateless HMAC-signed tokens (`MCP_OAUTH_SECRET`), no DB tables.
  2. **Per-user personal access token** (`mbp_…`) for non-OAuth clients (Claude Desktop, MCP inspector, curl) — generated on `/settings`, shown once, stored only as a SHA-256 hash in `user_settings.mcp_token_hash`.
  3. **Legacy static `MCP_BEARER_TOKEN`** — still accepted and mapped to the deployment owner (`MINDBOARD_OWNER_USER_ID`); also the home worker's auth for `/api/worker`.
- Data access: a service-role Supabase client (`SUPABASE_SERVICE_ROLE_KEY`) with every query filtered by the authenticated user id explicitly (the service role bypasses RLS; the app's own pages use session clients where RLS is the boundary).
- Home worker: shared infrastructure, gated by an allowlist — only jobs from the owner plus `WORKER_ALLOWED_USER_IDS` (comma-separated user ids) are claimed.

Additional server env vars:

```bash
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_secret   # Dashboard > Settings > API
MCP_BEARER_TOKEN=a_long_random_secret        # legacy static token, maps to the owner
MINDBOARD_OWNER_USER_ID=your_supabase_auth_user_id   # owner mapping + worker heartbeat
MCP_OAUTH_SECRET=a_long_random_secret        # signs the stateless OAuth tokens
WORKER_ALLOWED_USER_IDS=uuid1,uuid2          # optional: extra users allowed on the home worker
WATCH_TOKEN=a_long_random_secret             # Apple Watch API bearer (see below)
```

Tools:

- Reads: `finance_snapshot`, `tasks_snapshot`, `inventory_snapshot`, `list_tasks`, `list_groups`, `list_accounts`, `list_categories`, `list_recent_ledger`.
- Writes (propose): `create_task`, `complete_task`, `log_spend` — each returns a preview + `proposalId` and writes nothing on its own.
- `confirm_action` executes a proposal (applies the write and flips its audit row to `executed`); `cancel_action` discards it.

In production, add it to claude.ai as a custom connector (Settings → Connectors → Add custom connector) pointing at `https://<your-domain>/api/mcp/mcp` — claude.ai runs the OAuth flow and each user approves once via their own Google login. Test locally with the MCP inspector (`npx @modelcontextprotocol/inspector`) using OAuth, a per-user `mbp_` token from `/settings`, or the legacy static bearer.

## Apple Watch API

The watchOS client (`mindboard-watch`, a separate repo) talks to a small JSON API under `/api/watch/*`, authenticated with a bearer token from the `WATCH_TOKEN` env var:

- Plain string: `WATCH_TOKEN=a_long_random_secret` — maps to the deployment owner (`MINDBOARD_OWNER_USER_ID`), like the legacy static MCP token.
- JSON map, one token per tenant: `WATCH_TOKEN={"secret_for_lucca":"<lucca_user_id>","secret_for_friend":"<friend_user_id>"}`.

Generate a token with `openssl rand -base64 48`, set it in Vercel (Production) and in `.env.local`, then paste the same value into the watch app's `Secrets.xcconfig`. Rotating the token is just changing the env var and redeploying; a missing or malformed `WATCH_TOKEN` makes every watch request 401.

Endpoints (all `Authorization: Bearer <token>`; writes are JSON `POST`s and accept an `Idempotency-Key` header so a retried request from a flaky watch connection never double-logs — the key derives the `ai_audit_log` row id, and a repeat replays the first attempt's result):

- `GET /api/watch/today` — overdue + due-today tasks, today's routines with done state, next timed event, free hours left, plus `meta` (server time, user timezone).
- `POST /api/watch/complete` `{ "type": "task" | "recurring", "id" }` — same executors as the MCP `complete_task` / `complete_recurring_task` tools (recurring: today's occurrence only).
- `POST /api/watch/task` `{ "title" }` — inbox task, no group, priority med.
- `POST /api/watch/spend` `{ "amount", "note"? }` — logs a spend today against the default account (the oldest active one, as the dock's `$` capture does).
- `POST /api/watch/capture` `{ "text" }` — `capture_to_brain` with source `"apple watch"`.

## Project Structure

```text
app/
  _components/              shared dashboard/task UI
  actions/                  server actions for auth, groups, tasks
  auth/callback/route.ts    Supabase OAuth callback and token capture
  groups/                   group list and group task pages
  inbox/                    inbox task page
  login/                    Google sign-in page
  layout.tsx                app metadata, viewport, font, PWA hooks
  page.tsx                  main dashboard

utils/
  google/                   Google Calendar scopes, token refresh, event fetch
  supabase/                 SSR browser/server/proxy clients

supabase/migrations/        SQL schema and RLS policies
public/                     PWA manifest and icons
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

Keep the app mobile-first, dense, and quiet. The fixed task capture island is the most important interaction and should remain usable while scrolling. Quick capture supports task title, group, due date, and Markdown notes without leaving the bar.

Theme colors are centralized in `app/globals.css` and `app/_components/themes.ts`. The dashboard settings panel stores per-theme palette overrides in `localStorage` as `palette-${theme}`.

## Agent Context

For AI agents and Claude Code, read `AGENTS.md` first. It contains the current architecture, product constraints, security rules, and implementation notes. `CLAUDE.md` points to that file.

`CODEX_HANDOFF.md` is historical checkpoint context and should not be treated as current ground truth.

## Deployment

Pushes to `main` deploy through Vercel.

Before pushing code changes, run:

```bash
npm run lint
npm run test
npm run build
```

Browser-only setup, such as Supabase dashboard settings, Google Cloud OAuth consent, and Vercel environment variables, must be done manually in those dashboards.
