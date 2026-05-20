<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Mindboard Project Context

Mindboard is a personal life dashboard for one primary user. It tracks tasks across groups of responsibility, shows what matters today, and embeds a Google Calendar view directly on the dashboard. The app is designed for fast capture on iPhone as an installed PWA, so the bottom task input staying quick, focused, and reachable is the most important UX constraint.

## Current Stack

- Next.js 16.2.6 App Router, React 19, TypeScript strict, Turbopack.
- Tailwind v4 via `app/globals.css`; there is no `tailwind.config.ts`.
- Supabase Postgres + Supabase Auth with Google OAuth.
- Supabase SSR clients via `@supabase/ssr`.
- Deployed on Vercel from `main`.
- No UI library and no state library. Use React built-ins and hand-rolled Tailwind.

## Product State

Shipped routes:

- `/` dashboard: today task sections on the left and embedded calendar on the right for desktop; tasks first and calendar below on mobile.
- `/login`: Google OAuth sign-in.
- `/auth/callback`: exchanges Supabase OAuth code and persists Google provider tokens.
- `/groups`: group list, create form, inbox card.
- `/groups/[id]`: tasks for one group.
- `/inbox`: tasks with no group.

PWA support is shipped:

- `public/manifest.webmanifest`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/apple-touch-icon.png`
- `app/layout.tsx` exports Next metadata and viewport config.

## Design System

The aesthetic is "Terminal Calm". Do not add alternate themes.

```text
font          Geist Mono throughout
background    #0d0d0d
foreground    #f5f0e8
accent        #b5ff3c
muted text    #6b6b6b
borders       #1f1f1f and #2a2a2a
danger        #ff6b6b
```

Touch targets should be at least 44px. Mobile-first. Keep layouts quiet, dense, and utilitarian.

## Data Model

Migrations live in `supabase/migrations`.

`0001_init.sql` creates:

- `groups`: `id`, `user_id`, `name`, `type`, `color`, `archived`, `created_at`
- `tasks`: `id`, `user_id`, `group_id`, `title`, `due_date`, `status`, `priority`, `notes`, `created_at`, `completed_at`

`0002_google_tokens.sql` creates:

- `google_tokens`: `id`, `user_id`, `access_token`, `refresh_token`, `expires_at`, `scopes`, `updated_at`

Every table has RLS enabled and user-scoped policies. Never disable RLS as a debugging shortcut.

Do not add tables for subtasks, recurring tasks, tags, attachments, reminders, dependencies, or two-way sync unless the user explicitly changes the product scope.

## Google Calendar Integration

The calendar is embedded in the dashboard, not a separate `/calendar` page.

Key files:

- `utils/google/scopes.ts`: OAuth scopes requested during Google sign-in.
- `utils/google/calendar.ts`: server-only token refresh, calendar list fetch, and event fetch.
- `app/auth/callback/route.ts`: stores `session.provider_token` and `session.provider_refresh_token` into `google_tokens`.
- `app/login/page.tsx`: requests Google OAuth scopes with `access_type=offline` and `prompt=consent`.
- `app/_components/dashboard-calendar.tsx`: month/week UI.
- `app/page.tsx`: dashboard server component that fetches tasks and calendar events.

Current Google scopes:

```text
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/calendar.calendarlist.readonly
```

The app reads all Google calendars the user can access, skips free/busy-only calendars, fetches events from each readable calendar, and falls back to the primary calendar if the calendar-list request is not authorized yet.

Required Vercel env vars:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
```

No Google API key is used. Do not commit API keys, access tokens, refresh tokens, session objects, or service-role keys. Do not log provider tokens.

After changing Google scopes, the user must:

1. Add the scope in Google Cloud OAuth consent.
2. Redeploy.
3. Sign out and sign back in so Supabase returns a provider token with the new scope.

## Calendar UX

Dashboard calendar supports month and week views.

- Month view shows a compact 7-column grid with task/event chips and overflow counts.
- Week view shows a larger week grid with a due/all-day row plus timed Google events in an hourly grid.
- Mindboard tasks currently only have `due_date`, not due times, so they render in the due/all-day row.
- Google Calendar events can render as timed blocks or all-day items.
- Calendar events show their Google calendar name/color where available.

Do not build Google event editing, event creation, or two-way sync unless the user explicitly starts a new checkpoint for it.

## Task UX

The task capture bar is the highest-priority interaction.

- File: `app/_components/task-capture-bar.tsx`
- It is a fixed bottom island.
- It should stay usable while scrolling.
- The input should stay focused after submit.
- Due-date chips stick across submits for quick batch entry.

Task optimistic UI patterns are in:

- `app/_components/today-client.tsx`
- `app/_components/tasks-client.tsx`

Mutations live in:

- `app/actions/tasks.ts`
- `app/actions/groups.ts`
- `app/actions/auth.ts`

## Important Files

- `proxy.ts`: Next 16 proxy/middleware equivalent for Supabase session refresh.
- `utils/supabase/server.ts`: server component/action Supabase client.
- `utils/supabase/client.ts`: browser Supabase client.
- `utils/supabase/middleware.ts`: proxy helper.
- `app/layout.tsx`: metadata, viewport, root layout.
- `app/page.tsx`: dashboard server component.
- `app/_components/dashboard-calendar.tsx`: embedded calendar UI.
- `app/_components/task-row.tsx`: shared task row.
- `app/_components/types.ts`: shared task types.
- `app/_components/date-utils.ts`: date helpers.

## Engineering Rules

- Read actual files before explaining or changing behavior.
- Prefer Server Components. Use `"use client"` only for state, hooks, optimistic UI, or browser APIs.
- Keep changes narrow. Do not refactor unrelated code.
- Use existing patterns before inventing abstractions.
- Validate user input and external API responses; trust internal code where reasonable.
- Avoid comments unless they explain a non-obvious invariant or constraint.
- Use `rg` for search.
- Use `npm run lint` and `npm run build` before declaring code changes complete.
- Next build may need network access to fetch Google Fonts.
- Do not touch or commit unrelated local changes. In particular, `.claude/settings.local.json` has been locally dirty before and should be ignored unless the user asks.

## Browser-Only Work

Do not try to automate Supabase dashboard, Google Cloud Console, Vercel dashboard, or GitHub website settings. Give explicit browser steps instead.

Common browser steps:

- Google Cloud: enable Google Calendar API.
- Google Cloud OAuth consent: add required Calendar scopes.
- Vercel: add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Supabase: confirm Google Auth provider uses the same OAuth client.
- App: sign out and sign back in after scope changes.

## Git And Deployment

Routine commits and normal pushes to `main` are okay when the user asks for changes to appear on Vercel. Never force-push, reset hard, delete unknown files, or rewrite history without explicit confirmation.

Vercel deploys automatically from GitHub `main`.
