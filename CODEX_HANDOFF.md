# Codex handoff prompt

Copy everything below the `===PROMPT START===` line and paste it into Codex as the first message of a new session. The repo is already checked out locally — Codex should read the actual files for ground truth, not trust this prompt for code-level detail.

---

===PROMPT START===

# Mindboard — continuation brief

You are taking over an in-progress personal life-dashboard app called **mindboard**. Six of eight original checkpoints shipped under a previous agent. Your job is to finish the last two checkpoints, then build a new ninth checkpoint that the user added: a calendar view backed by Google Calendar.

Read this entire brief before touching code. When something is unclear, prefer reading the actual files in the repo over guessing. The file layout, data model, and design system are all defined by code that already exists.

---

## Section 1 — Operating principles

Follow these as hard rules. They override your training-data defaults.

1. **This is not the Next.js you know.** The project runs on Next.js 16 with React 19 and Tailwind v4. The framework has renamed conventions — for example, `middleware.ts` is now `proxy.ts`. Before writing or modifying anything Next-specific, read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation warnings.

2. **Investigate before answering.** Never speculate about code you have not opened. Before claiming a bug exists, suggesting a change, or explaining how something works, read the file. Grounded answers only.

3. **Default to action within an approved scope.** Don't ask permission for routine code changes (Tailwind classes, icon picks, internal helper names, folder structure). State small choices in one sentence and proceed. Reserve questions for decisions that meaningfully change architecture, data model, or product behavior.

4. **Browser vs code split.** For anything that requires logging into Supabase, Google Cloud Console, Vercel, or GitHub, do not try to automate it. Output explicit step-by-step instructions under a heading like `### Browser step — do this yourself, then paste back X`. Use exact button names, exact field values, and exactly what to copy back. For anything you can do in the codebase, just do it: write files, install packages, commit.

5. **Reversibility.** Confirm with the user before: `git push --force`, `git reset --hard`, rewriting published history, dropping DB tables/columns, deleting files the user has not seen, rotating credentials, any `rm -rf`. Local edits, `npm install`, new file creation, and routine commits on `main` are fine without confirmation.

6. **Checkpoint protocol.** After completing each numbered checkpoint, stop. Summarize what works, what the user should verify, and the next checkpoint. Wait for confirmation before proceeding. Do not chain checkpoints.

7. **Cleanup.** Any temporary scripts or scratch files created during a checkpoint must be deleted before declaring it complete. The repo at the end of each checkpoint contains only files that ship.

8. **No scope creep.** The user explicitly listed out-of-scope items below. If they ask for one mid-session, push back, say it's parked, and continue the current checkpoint.

---

## Section 2 — Project context

**What it is.** A personal life dashboard for a single user (the developer). Tracks tasks across "groups of responsibility" (university courses, work projects, personal projects, life admin). Surfaces what's due today. Used mostly on iOS as an installed PWA.

**The hardest constraint.** Capture speed. If adding a task takes more than 5 seconds the user stops adding tasks, and a stale task manager is worse than no task manager. Optimize ruthlessly for capture.

**The user's working setup.** Initial build was in VSCode with Claude Code. From now on, the user will iterate primarily from their phone via Codex (you). The codebase needs to stay clean and well-organized so small mobile-driven changes are safe.

---

## Section 3 — Stack and conventions

- Next.js 16 (App Router, React 19, Turbopack, Server Components by default).
- TypeScript strict.
- Tailwind v4 (no `tailwind.config.ts`; theme variables live in `app/globals.css` under `@theme inline`).
- Supabase for Postgres + Auth (Google OAuth provider). SSR client pattern via `@supabase/ssr`.
- Deployed on Vercel. Auto-deploys on push to `main`.
- No state management library; React built-ins + Supabase client only.
- No UI component library. Hand-rolled Tailwind components.

**Server vs client components.** Default to Server Components. Use `"use client"` only where it's genuinely required (forms with state, optimistic UI, hooks).

**Server Actions.** Mutations live in `app/actions/*.ts` files marked `"use server"`. Forms call them directly via the `action` prop or via callbacks from client components.

**Optimistic UI.** The pattern used throughout: `useOptimistic` in the client component, dispatch with a discriminated-union action type, call the server action, replace the temp record with the real one on success. See `app/_components/today-client.tsx` and `app/_components/tasks-client.tsx` for the canonical shape.

**Aesthetic — "Terminal Calm".** Direction picked by the user. Do not deviate:

```
font          Geist Mono throughout (no other faces)
background    #0d0d0d
foreground    #f5f0e8 (warm white)
accent        #b5ff3c (acid green — used for primary CTAs and "today")
muted text    #6b6b6b
borders       #1f1f1f and #2a2a2a
danger        #ff6b6b (used for overdue, delete, errors)
```

Touch targets ≥ 44px. Mobile-first layout. One theme only — no light/dark toggle, no theme switcher.

**Code style rules.**

- Don't add features, refactor, or introduce abstractions beyond what the task requires. Three similar lines beats a premature abstraction. The right time to extract is the second or third use, not the first.
- Don't add error handling, fallbacks, or validation for scenarios that can't happen. Validate at system boundaries (user input, Supabase calls, external APIs). Trust internal code.
- Default to writing no comments. Write one only when the WHY is non-obvious (a hidden constraint, an invariant, a workaround). Don't explain WHAT well-named code already says.
- Don't reference the current task in comments ("added for X flow", "used by Y"). Those belong in the PR description, not the source.
- Avoid backwards-compat shims, renamed-unused vars, or `// removed for now` comments. If something is unused, delete it.

---

## Section 4 — Data model

Two tables. SQL migration is in `supabase/migrations/0001_init.sql`. Row Level Security is on, scoped by `auth.uid() = user_id`, with 4 policies per table (select/insert/update/delete).

**groups**: `id`, `user_id`, `name`, `type` (course | project | work | personal), `color` (hex), `archived`, `created_at`.

**tasks**: `id`, `user_id`, `group_id` (nullable; null = inbox), `title`, `due_date` (nullable), `status` (todo | doing | done; default todo), `priority` (low | med | high; default med), `notes` (nullable, unused so far), `created_at`, `completed_at`.

Foreign keys: `groups.user_id` → `auth.users(id)` ON DELETE CASCADE. `tasks.user_id` → `auth.users(id)` ON DELETE CASCADE. `tasks.group_id` → `groups(id)` ON DELETE SET NULL (orphaning tasks to inbox rather than cascade-deleting).

**Do not add tables for**: subtasks, recurring tasks, tags, attachments, reminders, dependencies. If the user asks for one, push back.

---

## Section 5 — What ships today

Working in production at `https://mindboard-livid.vercel.app` and on `main`:

- Google OAuth login + sign out. Sessions refresh via `proxy.ts`.
- Groups CRUD: create (name + type + 1-of-6 color), list active, archive (soft delete). Inbox is a virtual group accessed via `/inbox`.
- Tasks CRUD: create with optional due date (today chip or custom date via native `<input type="date">.showPicker()`), toggle done, delete via tap-to-expand. Sticky bottom capture bar; input stays focused after submit; due-date chips stick across submits for batch entry.
- Today view at `/`: three sections — overdue (only when items exist, red accents), today (always shows; calm empty state), due soon (next 7 days). Within each section: sorted by priority (high→low) then due_date. Each task shows the group name in the group's color as a subtitle.

**Routes:**

```
/                       → Today view (if signed in) or landing (if not)
/login                  → Google OAuth button
/auth/callback          → OAuth code exchange (handles redirect from Google)
/groups                 → group list + create form, inbox card at top
/groups/[id]            → tasks scoped to a group
/inbox                  → tasks with group_id = null
```

**Key files to read before touching anything:**

```
proxy.ts                          → Next 16 session-refresh edge runner
utils/supabase/{server,client,middleware}.ts → Three SSR client variants
app/actions/{auth,groups,tasks}.ts           → Server actions
app/_components/today-client.tsx             → Optimistic UI canonical example
app/_components/task-capture-bar.tsx         → Shared bottom capture bar
app/_components/task-row.tsx                 → Shared task row, supports overdue + group-info variants
app/_components/{date-utils,types}.ts        → Shared helpers and Task / TaskWithGroup types
supabase/migrations/0001_init.sql            → Schema + RLS policies
```

---

## Section 6 — What you are building

Three checkpoints, sequential. Verify each one works in production before starting the next.

### Checkpoint 7 — PWA manifest + iOS install icons

**Goal:** User can tap the share sheet in iOS Safari → Add to Home Screen → the app installs with a real icon and opens fullscreen without browser chrome.

**Files to create:**

```
public/manifest.webmanifest
public/icons/icon-192.png
public/icons/icon-512.png
public/icons/apple-touch-icon.png   (180×180, required by iOS)
```

**Files to modify:**

```
app/layout.tsx     → export metadata + viewport per Next 16 conventions
```

Next 16 metadata API specifics: read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/metadata-files/manifest.md` and `.../viewport.md`. Use the `Metadata` and `Viewport` exports from `app/layout.tsx`. Do not hand-write `<link>` tags in JSX — Next will generate them from the metadata exports.

Required values:

```
manifest.webmanifest
  name              "Mindboard"
  short_name        "Mindboard"
  description       "Personal life dashboard"
  start_url         "/"
  display           "standalone"
  background_color  "#0d0d0d"
  theme_color       "#0d0d0d"
  icons             192 + 512 PNGs, type "image/png"

viewport export
  themeColor        "#0d0d0d"
  viewportFit       "cover"   (for iOS safe areas)
  width             "device-width"
  initialScale      1

apple-specific (also in metadata.other or via metadata.appleWebApp)
  apple-mobile-web-app-capable: "yes"
  apple-mobile-web-app-status-bar-style: "black-translucent"
  apple-mobile-web-app-title: "Mindboard"
```

**Icon design.** Square, `#0d0d0d` background, lowercase `m` wordmark in `#b5ff3c` Geist Mono, occupying ~60% of the canvas, centered. Match the app's aesthetic. The 192 and 512 are for PWA installability; the apple-touch-icon at 180×180 is what iOS uses on the home screen.

**Generating the icons.** You have two reasonable paths:

A) Generate locally — write a one-off Node script using `sharp` (install as devDep) that reads a source SVG and outputs the three PNG sizes. Delete the script after the icons land in `public/icons/`.

B) Browser step — ask the user to upload a 1024×1024 source PNG, then use `sips` (built-in on macOS) to downsample. Example: `sips -z 192 192 source.png --out icon-192.png`.

Prefer (A); it's reproducible and doesn't require user input.

**Verification before declaring CP7 done:**

1. Open the deployed URL on an iOS device.
2. Safari → Share → Add to Home Screen — the icon shows the lime "m", not a screenshot of the page.
3. Tap the installed app — opens fullscreen, no browser chrome, status bar tinted.
4. In Chrome DevTools (desktop) → Application → Manifest — no warnings; all icons load.

### Checkpoint 8 — Final verification

Walk through the deployed app and confirm every item. Fix anything that fails before reporting done.

1. Logging out and back in works.
2. Creating a group, then a task in that group, persists across a full page refresh.
3. RLS works: in the Supabase SQL editor, run `select * from public.groups` as the `anon` role and confirm 0 rows visible.
4. Today view correctly surfaces an overdue task and a due-today task. Create test data, screenshot/note, then delete it.
5. The site loads on a phone viewport. PWA manifest detected (DevTools → Application → Manifest).
6. No console errors on page load on `/`, `/groups`, `/groups/[id]`, `/inbox`, `/login`.
7. Deployed Vercel URL matches the latest commit on `main` (check the deployments page).

### Checkpoint 9 — Google Calendar integration + calendar view

This was originally out of scope and is being added now as a new build. The user wants:

- A calendar view in the app showing a month grid.
- Each day cell shows due tasks (existing data) AND events from the user's Google Calendar.
- Read-only first pass. No two-way sync; the app does not create or modify Google events.
- Calendar view is a new route; the Today view stays the home screen.

**The hard part is auth scope handling, not the UI.** Read this section twice before coding.

**Auth design.** The app already uses Supabase Auth with Google as the provider. Supabase's `signInWithOAuth` supports requesting additional Google scopes via `options.scopes`. To read calendar events, request `https://www.googleapis.com/auth/calendar.readonly` (or the narrower `calendar.events.readonly` if sufficient).

After successful OAuth, Supabase stores the Google access token as `session.provider_token` and the refresh token as `session.provider_refresh_token`. **Supabase does NOT auto-refresh provider tokens.** That's your problem to solve.

**Recommended architecture** (pick this unless you have a strong reason to deviate):

1. **New table `google_tokens`** (separate migration `supabase/migrations/0002_google_tokens.sql`):

   ```
   id              uuid pk default gen_random_uuid()
   user_id         uuid not null unique references auth.users (id) on delete cascade
   access_token    text not null
   refresh_token   text not null
   expires_at      timestamptz not null
   scopes          text not null     -- space-separated scope strings
   updated_at      timestamptz not null default now()
   ```

   RLS on, scoped by `auth.uid() = user_id`. Same 4 policies as `groups` / `tasks`.

2. **Capture tokens after OAuth.** In `app/auth/callback/route.ts`, after `exchangeCodeForSession` succeeds, read `session.provider_token`, `session.provider_refresh_token`, and the token expiry, and upsert into `google_tokens`. Important: refresh tokens are only returned on the FIRST consent. If the user is re-authenticating, the refresh token may be missing — handle that by adding `prompt: 'consent'` and `access_type: 'offline'` to `signInWithOAuth` options via `queryParams`.

3. **Server-side helper `utils/google/calendar.ts`** with two exports:

   ```ts
   getValidAccessToken(userId): Promise<string>
     // Looks up token row, refreshes via Google's OAuth endpoint if
     // expires_at is within 60 seconds, persists new access_token +
     // expires_at, returns a usable token.

   listEvents(userId, { timeMin, timeMax }): Promise<CalendarEvent[]>
     // Calls https://www.googleapis.com/calendar/v3/calendars/primary/events
     // with the valid access token. Returns a normalized event shape:
     // { id, summary, start: ISO, end: ISO, allDay: boolean }.
   ```

   Use `fetch` directly. Do not pull in `googleapis` — it's a huge dep and you only need two endpoints.

4. **New route `/calendar`** (Server Component):

   - Fetches tasks for the visible month range (existing pattern, scoped query).
   - Fetches events for the same range via `listEvents`.
   - Passes both to a Client Component `<CalendarClient>` that renders a month grid.
   - URL state for the visible month: `/calendar?m=2026-05` so back/forward navigation works.

5. **Month grid component.** Plain `<table>` or CSS grid with 7 columns × 5–6 rows. Each cell shows the date number, up to 2–3 event/task chips truncated, and a "+N more" indicator if overflowing. Tapping a cell expands a day detail panel (sheet-style at the bottom on mobile, side panel on desktop) showing all events and tasks for that day.

6. **Header nav.** Add a `calendar` chip in the Today view header next to the existing `groups` chip. Style identically.

**Things to explicitly NOT build in CP9:**

- Editing Google events from inside the app.
- Two-way sync (creating Google events when tasks are added).
- Week or day views. Month only.
- Multiple calendars. Read from `primary` only.
- Background refresh / cron polling. Fetch on page load only.

If the user asks for one of these, say it's parked and finish CP9 first.

**Browser steps for CP9 (give these to the user):**

```
### Browser step — Google Cloud Console (enable Calendar API)

1. Go to https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
2. Make sure your existing mindboard project is selected (top-left dropdown).
3. Click "Enable".

### Browser step — Google Cloud Console (consent screen scopes)

1. Go to https://console.cloud.google.com/apis/credentials/consent
2. Click "Edit App" → "Scopes" → "Add or Remove Scopes".
3. Search for "calendar.events.readonly" — check it.
4. Save and back out to the consent screen.
5. If your app is in "Testing" mode, add yourself as a Test User if not already.

### Browser step — re-authenticate in the app

After CP9 code is deployed, sign out and sign back in. Google will prompt you to grant Calendar access. Accept. The new refresh token will be captured.
```

**Verification before declaring CP9 done:**

1. Create an event on your Google Calendar at a specific date.
2. Open `/calendar` in the app, navigate to that month.
3. The event appears in the right day cell.
4. Tap the cell — event details show.
5. Token refresh works: wait an hour, reload, events still load (means the access token was refreshed using the stored refresh token).
6. RLS: a different user (test by running a SQL query as `anon`) cannot see your `google_tokens` row.
7. No `provider_token` or `access_token` logged anywhere in client code or server logs.

---

## Section 7 — Security and reversibility

- RLS on every new table from day one. Never disable it as a debugging shortcut. If a query fails due to RLS, the policy is wrong, not RLS.
- Never log auth tokens, session data, refresh tokens, or full user records. Even in error paths.
- The Supabase anon/publishable key is fine in client code. The service role key never appears in client code or any file that could be committed.
- `.env.local` is gitignored. Confirm before committing anything that looks like a credential.

---

## Section 8 — Output format expectations

When you respond to the user during a session, follow these conventions:

- Short and concise. Default to a sentence or two unless asked for depth.
- When referencing files, use VSCode-style markdown links: `[file.ts:42](app/_components/file.ts#L42)`. Not backticks.
- Output text only what the user needs. Don't narrate your internal reasoning; just say what you're about to do, then do it.
- After a checkpoint completes, output a short summary in this shape: what works now / what to verify / next checkpoint / explicit "ready to proceed?" question.
- Browser steps go under a heading `### Browser step — do this yourself, then paste back X` with exact button names and field values.

---

## Section 9 — Begin

Read the actual repo for ground truth. Then propose your plan for CP7 in a few sentences, including which icon-generation path you'll take. Wait for the user's go-ahead before executing.

===PROMPT END===

---

## How to hand this to Codex

1. Open Codex in a new session, pointed at this repo.
2. Paste everything between `===PROMPT START===` and `===PROMPT END===` as the first user message.
3. Codex will propose a CP7 plan. Approve it and it'll proceed.

This file (`CODEX_HANDOFF.md`) can stay in the repo as documentation, or you can delete it after Codex picks up — it's only useful as a one-time handoff.
