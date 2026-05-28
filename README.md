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
