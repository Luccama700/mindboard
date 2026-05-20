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
- `@dnd-kit/core` is the one allowed behavior dependency, used for drag-to-reschedule in the week view. Do not pull in `@dnd-kit/sortable` or `@dnd-kit/modifiers` unless a new feature actually needs them.

## Product State

Shipped routes:

- `/` dashboard: today task sections on the left and embedded calendar on the right on desktop, full viewport width with a ~50/50 split; tasks first and calendar below on mobile.
- `/login`: Google OAuth sign-in.
- `/auth/callback`: exchanges Supabase OAuth code and persists Google provider tokens.
- `/groups`: group list with inline create form, inbox card, and per-group edit panels for renaming, type, color, and Google Calendar link.
- `/groups/[id]`: tasks for one group, plus upcoming events from the linked Google Calendar (if any).
- `/inbox`: tasks with no group.

PWA support is shipped:

- `public/manifest.webmanifest`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/apple-touch-icon.png`
- `app/layout.tsx` exports Next metadata and viewport config.

## Design System

The default aesthetic is "Terminal Calm". A soft "cream" light mode is also shipped, activated by adding the class `theme-cream` to `<html>`. Both themes share the same lime accent and red danger color.

```text
font          Geist Mono throughout

dark (default)
background    #0d0d0d
foreground    #f5f0e8
accent        #b5ff3c
muted text    #6b6b6b
borders       #1f1f1f and #2a2a2a
danger        #ff6b6b

cream
background    #f5f0e8
foreground    #2a2620
accent bg     #c9a572 (cream caramel; for filled buttons/chips)
accent fg     #8b6332 (rich brown; for accent text, borders, outlines)
muted text    #897e62
borders       #d4c9b1 and #beb18f
danger        #ff6b6b (unchanged)
```

The cream theme is implemented as CSS overrides in `app/globals.css`, keyed by attribute selectors on Tailwind's arbitrary-value class names (e.g. `html.theme-cream .bg-\[\#0d0d0d\]`). User-data colors (group colors, calendar/event colors) come from inline `style={{...}}` and are not affected by the theme.

The accent color is driven by the CSS variable `--accent`, set per theme in `:root` and `html.theme-cream`. Every Tailwind utility keyed on the lime hex (`bg-[#b5ff3c]`, `text-[#b5ff3c]`, etc.) is rerouted to that variable in `globals.css`, so the user can override the accent at runtime.

`app/_components/theme-toggle.tsx` is the simple toggle used on the get-started screen. `app/_components/settings-panel.tsx` is the dashboard popover that combines a theme switcher with the shared `ColorPicker` for per-theme accent customization. Accent overrides persist in `localStorage` under `accent-dark` and `accent-cream`. `app/_components/theme-initializer.tsx` applies the saved theme class and `--accent` variable after hydration; do not reintroduce raw `<script>` or `next/script` theme bootstrapping in `app/layout.tsx`, because it can mutate `<html>` before React hydrates and trigger hydration warnings.

`app/_components/color-picker.tsx` is the shared 12-swatch palette + custom RGB picker, used by both the group edit panel and the settings panel.

Touch targets should be at least 44px. Mobile-first. Keep layouts quiet, dense, and utilitarian.

## Data Model

Migrations live in `supabase/migrations`.

`0001_init.sql` creates:

- `groups`: `id`, `user_id`, `name`, `type`, `color`, `archived`, `created_at`
- `tasks`: `id`, `user_id`, `group_id`, `title`, `due_date`, `status`, `priority`, `notes`, `created_at`, `completed_at`

`tasks.notes` stores plain Markdown text for task details. It is intentionally kept on the task row, not split into a separate notes table, so future AI-assisted expansion can work from the task's captured context without widening the product scope.

`0002_google_tokens.sql` creates:

- `google_tokens`: `id`, `user_id`, `access_token`, `refresh_token`, `expires_at`, `scopes`, `updated_at`

`0003_group_calendars.sql` adds:

- `groups.google_calendar_id` (TEXT, nullable): the Google Calendar id linked to this group, used to surface that calendar's events as virtual task rows.

Every table has RLS enabled and user-scoped policies. Never disable RLS as a debugging shortcut.

Do not add tables for subtasks, recurring tasks, tags, attachments, reminders, dependencies, or two-way sync unless the user explicitly changes the product scope.

## Google Calendar Integration

The calendar is embedded in the dashboard, not a separate `/calendar` page.

Key files:

- `utils/google/scopes.ts`: OAuth scopes requested during Google sign-in.
- `utils/google/calendar.ts`: server-only token refresh, calendar list fetch, all-calendar event fetch (`listEvents`), single-calendar event fetch (`listEventsForCalendar`), and `listCalendars` for the group linker UI.
- `app/auth/callback/route.ts`: stores `session.provider_token` and `session.provider_refresh_token` into `google_tokens`.
- `app/login/page.tsx`: requests Google OAuth scopes with `access_type=offline` and `prompt=consent`.
- `app/_components/dashboard-calendar.tsx`: month/week UI.
- `app/_components/event-row.tsx`: read-only virtual row for events from a linked calendar, rendered in the today list and on group pages.
- `app/page.tsx`: dashboard server component that fetches tasks, groups, calendar events, and builds the calendar-id → group link map.

Current Google scopes:

```text
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
```

`calendar.events` is read+write on events (no calendar management) and powers the drag-to-reschedule and inline edit features.

The app reads all Google calendars the user can access, skips free/busy-only calendars, fetches events from each readable calendar, and falls back to the primary calendar if the calendar-list request is not authorized yet.

Groups can be linked to a specific Google Calendar via `groups.google_calendar_id`. Events from a linked calendar render as read-only virtual rows in the today list (mixed into "today" and "due soon" by start time) and on the linked group's page (an "upcoming events" section). Past events (started before today, or timed and already ended) are filtered out client-side. The linking is one-way: Mindboard reads from Google and does not write back.

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

- Month view shows a compact 7-column grid with task/event chips and overflow counts. Month view is read-only.
- Week view shows a larger week grid with a due/all-day row plus timed Google events in an hourly grid. Week view supports drag-to-reschedule on tasks, all-day events, and timed events:
  - Tasks drag horizontally between days; the new column becomes the task's `due_date`.
  - All-day events drag horizontally between days.
  - Timed events drag in two dimensions; the new x position picks the day, the new y position picks the start time snapped to 15-minute increments. Duration is preserved.
  - Drag uses `@dnd-kit/core` with a `PointerSensor` (6px activation distance) and a `TouchSensor` (150ms hold delay) so the chips stay tappable on mobile.
  - Events from non-writable calendars (`reader` accessRole) appear dimmed and are not draggable.
- Below the grid is a "selected day" list. Tapping an editable Google Calendar event in that list opens an inline edit panel with date and time inputs (or just date inputs for all-day events). Saving PATCHes Google via `rescheduleEvent`.
- Mindboard tasks currently only have `due_date`, not due times, so they render in the due/all-day row.
- Google Calendar events can render as timed blocks or all-day items.
- Calendar events show their Google calendar name/color where available. Events from a calendar linked to a Mindboard group instead show the group's name and color, so a linked group's tasks and events render in the same color across the dashboard calendar widget and the task list.

Event rescheduling (write-back of `start`/`end`) is shipped. Event creation, deletion, title editing, attendee changes, and calendar/calendar-list management are out of scope unless the user explicitly opens a new checkpoint for them.

## Task UX

The task capture bar is the highest-priority interaction.

- File: `app/_components/task-capture-bar.tsx`
- It is a fixed bottom island.
- It should stay usable while scrolling.
- The input should stay focused after submit.
- Due-date chips stick across submits for quick batch entry.
- The group selector chip also sticks across submits. It opens a compact bottom-adjacent picker with "inbox" plus every active group, and new tasks should be inserted into the selected group.
- The `+ notes` chip opens a compact textarea for Markdown notes. Notes are trimmed, stored in `tasks.notes`, and cleared after submit. Keep the stored value as raw Markdown text; do not render HTML from it unless a future feature adds a sanitizer.

Tapping the title of any task row expands an inline edit panel with four fields, all auto-saving where applicable:

- Rename (saves on Enter or blur).
- Due date via the same today/+date/clear chips as the capture bar.
- Group selector (a dropdown of every active group plus "inbox"), used to sort inbox tasks into the right group from any list. When the task's new group no longer matches the current page (inbox or a single group), the row drops off the list optimistically.
- Markdown notes textarea (saves on blur into `tasks.notes`).
- Delete is in the same panel.

Group edit lives in `app/groups/groups-client.tsx`. Tapping the `···` on a group row opens an inline panel with rename, type, color, Google Calendar link, and archive. The shared `ColorPicker` and `TypePicker` components are reused by the create form and the edit panel. `CalendarLinkPicker` lists every readable Google Calendar from `listCalendars`.

Color picker:

- 12 preset swatches.
- A custom swatch with a rainbow conic gradient and a `+` glyph that opens the native `<input type="color">` for any RGB value.
- When the picked color is not in the preset palette, the custom swatch displays the chosen color and the hex is shown below.

Task optimistic UI patterns are in:

- `app/_components/today-client.tsx`: dashboard list, merges tasks with virtual events from linked calendars. Optimistic capture should map the selected group id to `group_name`/`group_color` immediately.
- `app/_components/tasks-client.tsx`: inbox and single-group list, removes a task from the visible list when its group is changed off the current page. Optimistic capture should only show a new task if its selected group belongs on the current page.

Mutations live in:

- `app/actions/tasks.ts`: `createTask`, `toggleTaskStatus`, `updateTask` (title, due date, group, notes), `deleteTask`.
- `app/actions/groups.ts`: `createGroup`, `updateGroup` (name, type, color, Google Calendar link), `archiveGroup`.
- `app/actions/calendar.ts`: `rescheduleEvent` (Google Calendar PATCH on `start`/`end`).
- `app/actions/auth.ts`.

## Important Files

- `proxy.ts`: Next 16 proxy/middleware equivalent for Supabase session refresh.
- `utils/supabase/server.ts`: server component/action Supabase client.
- `utils/supabase/client.ts`: browser Supabase client.
- `utils/supabase/middleware.ts`: proxy helper.
- `utils/google/calendar.ts`: server-only Google Calendar client (token refresh, `listEvents`, `listEventsForCalendar`, `listCalendars`, `updateEvent`).
- `app/layout.tsx`: metadata, viewport, root layout.
- `app/page.tsx`: dashboard server component.
- `app/_components/theme-initializer.tsx`: client-side theme/accent restoration from `localStorage` after hydration.
- `app/_components/dashboard-calendar.tsx`: embedded calendar shell + month grid + selected-day list with inline event edit.
- `app/_components/week-view.tsx`: week grid with `@dnd-kit/core` drag-to-reschedule for tasks, all-day events, and timed events.
- `app/_components/event-edit-panel.tsx`: inline form for editing an event's start/end date/time.
- `app/_components/calendar-types.ts`: shared `CalendarItem` discriminated union for tasks vs. events in the calendar widget.
- `app/_components/task-row.tsx`: shared task row with inline edit panel (title, date, group, Markdown notes, delete).
- `app/_components/event-row.tsx`: read-only virtual row for events from a linked Google Calendar.
- `app/_components/today-client.tsx`: dashboard task list, mixes tasks with virtual events from linked calendars.
- `app/_components/tasks-client.tsx`: inbox and single-group task list.
- `app/_components/types.ts`: shared task types.
- `app/_components/date-utils.ts`: date helpers.
- `app/groups/groups-client.tsx`: group list, create form, per-group edit panel, color picker, calendar linker.

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
