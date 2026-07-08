<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Mindboard Project Context

Mindboard is a personal life dashboard for one primary user. It started as a task tracker (tasks across groups of responsibility, with what matters today and an embedded Google Calendar) and has grown into a broader life command center: it now also tracks **finance** (`/finance`) and **inventory** (`/inventory`), and the dashboard opens with an at-a-glance "vitals" strip that synthesizes every domain. The app is designed for fast capture on iPhone as an installed PWA, so the bottom task input staying quick, focused, and reachable is the most important UX constraint.

The longer-term direction is to evolve Mindboard into an AI "second brain" / life command center — an in-app assistant with access to all this data, a notes/knowledge layer, and MCP interoperability. That plan and its phased roadmap live in `docs/second-brain-plan.md`; the groundwork (a typed agent tool layer) has begun. See the "AI Second-Brain Direction" section below.

## Current Stack

- Next.js 16.2.6 App Router, React 19, TypeScript strict, Turbopack.
- Tailwind v4 via `app/globals.css`; there is no `tailwind.config.ts`.
- Supabase Postgres + Supabase Auth with Google OAuth.
- Supabase SSR clients via `@supabase/ssr`.
- Deployed on Vercel from `main`.
- No UI library and no state library. Use React built-ins and hand-rolled Tailwind.
- `@dnd-kit/core` is the one allowed behavior dependency, used for drag-to-reschedule in the week view. Do not pull in `@dnd-kit/sortable` or `@dnd-kit/modifiers` unless a new feature actually needs them.
- Tests run on Vitest (`npm run test`); pure logic (projections, snapshots, money/split math) is unit-tested under `__tests__/`.
- `app/lib/` holds non-UI logic: `app/lib/data/*` (reusable, `cache()`-deduped, RLS-scoped reads), `app/lib/snapshots/*` (pure cross-domain rollups), and `app/lib/agent/registry.ts` (the agent tool-layer seam — see the AI Second-Brain Direction section).

## Product State

Shipped routes:

- `/` dashboard: an at-a-glance **vitals strip** (command center) across the top, then today task sections on the left and embedded calendar on the right on desktop (full viewport width, ~50/50 split); tasks first and calendar below on mobile.
- `/login`: Google OAuth sign-in.
- `/auth/callback`: exchanges Supabase OAuth code and persists Google provider tokens.
- `/groups`: group list with inline create form, inbox card, and per-group edit panels for renaming, type, color, and Google Calendar link.
- `/groups/[id]`: tasks for one group, plus upcoming events from the linked Google Calendar (if any).
- `/inbox`: tasks with no group.
- `/finance`: accounts + ledger + recurring expenses + income sources + spending categories on the left, a cashflow-forecast calendar on the right. See the Finance section.
- `/inventory`: stock items grouped, with a per-item depletion-forecast calendar. See the Inventory section.
- `/learn`: courses + sources + audio overviews (NotebookLM-style study engine); `/learn/[id]/chat` (grounded chat with citations) and `/learn/[id]/study` (flashcards + study-document generators). See the Learn section and `docs/education-plan.md`.

PWA support is shipped:

- `public/manifest.webmanifest`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/apple-touch-icon.png`
- `app/layout.tsx` exports Next metadata and viewport config.

## Design System

The default aesthetic is "Terminal Calm". Themes are implemented with CSS variables on `<html>`: dark is the default, and cream/midnight/forest/slate/sand are activated with `theme-*` classes. User-data colors (group colors, calendar/event colors) come from inline `style={{...}}` and are not affected by the theme.

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

The active theme palette lives in `app/globals.css` via `@theme inline` tokens such as `bg-page`, `text-fg`, `bg-card`, `border-line`, and `bg-accent`. Add or adjust colors through `app/_components/themes.ts` and the matching CSS variable block in `globals.css`, not by hard-coding old hex-specific Tailwind selectors.

Palette customization is per theme. Overrides persist in `localStorage` under `palette-${theme}` and are applied by setting CSS variables at runtime.

`app/_components/get-started-screen.tsx` lets first-time users choose dark or cream before login. `app/_components/settings-panel.tsx` renders the appearance section inline on `/settings`: a theme dropdown plus a collapsed "customize colors" disclosure wrapping the shared `ColorPicker` palette editor. Legacy plaintext image-gen keys in `localStorage` migrate to encrypted provider columns via `app/_components/legacy-image-key-migration.tsx` on the next `/settings` visit. `app/_components/theme-initializer.tsx` applies the saved theme class and palette variables after hydration; do not reintroduce raw `<script>` or `next/script` theme bootstrapping in `app/layout.tsx`, because it can mutate `<html>` before React hydrates and trigger hydration warnings.

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

`0004_inventory.sql` creates `inventory_groups` and `inventory_items` (`id`, `user_id`, `inventory_group_id`, `name`, `quantity`, `unit`, `notes`, `created_at`).

`0005_inventory_icons.sql` adds `inventory_items.image_url` and a public `inventory-icons` Supabase Storage bucket; writes are scoped to the user's own `{user_id}/...` folder.

`0006_finance.sql` creates `spending_categories`, `accounts` (manual `balance`, `type`, `currency`, `archived`), and `balance_changes` (append-only ledger: `direction` in/out, `amount`, `balance_after`, `category_id`, `occurred_at`).

`0007_finance_recurring.sql` creates `recurring_expenses` (flat recurring outflows) and `income_sources` (wage jobs linked to a Google calendar).

`0008_recurring_intervals.sql` adds `daily` and `custom` frequencies plus `interval_days`/`start_date` to `recurring_expenses`.

`0009_income_pay_schedule.sql` adds `pay_frequency` (weekly/biweekly/monthly) + `anchor_payday`/`period_start`/`period_end` to `income_sources`.

`0010_inventory_usages.sql` creates `inventory_usages` (recurring consumption rules) and adds `inventory_items.reorder_threshold`.

`0019_inventory_archive.sql` adds `inventory_items.archived`/`archived_at` ("stop tracking" archives instead of deleting; archived items are hidden from the page shelf, vitals, and MCP reads) and `last_restocked_at` (stamped on any quantity increase; powers the "sitting at zero since…" archive suggestion).

`0022_finance_transactions.sql` is the transactions-first finance restructure (docs/finance-automation-plan.md): `balance_changes` gains `source` ('manual'/'import'/'assistant'), `is_transfer`, and a dedup `fingerprint` (`date|direction|cents`); `balance_after` becomes nullable/deprecated. New `account_reconciliations` table anchors each account's derived balance ("held X at end of day D"), seeded per account at migration time. `user_settings.daily_spend_estimate` is the manual everyday-spend fallback for the forecast.

`0023_spend_overrides.sql` creates `spend_overrides` (one row per user+future date): a pinned expected everyday spend for a specific day, set via the slider in the finance calendar's selected-day panel; it replaces the baseline estimate for that date (0 = no spend expected).

`0024_education.sql` creates `courses`, `course_sources`, `course_source_parts` (chunked-MCP-upload staging), adds encrypted `user_settings.google_ai_api_key`/`openai_api_key`, and the private `course-files` bucket. `0026_audio_episodes.sql` creates `audio_episodes` + the private `course-audio` bucket. `0027_worker_jobs.sql` creates `jobs`/`worker_status` + the `claim_next_job()` SKIP-LOCKED claim RPC (service-role only). `0028_course_cards.sql` creates `course_cards` (flashcards with got/miss progress). (`0025` belongs to the onboarding feature.)

Every table has RLS enabled and user-scoped policies. Never disable RLS as a debugging shortcut.

**Scope note.** Mindboard has grown well past the original task app, with the user's explicit approval. Finance and inventory are full features, and their recurring tables (`recurring_expenses`, `income_sources`, `inventory_usages`) are intentional — not violations of the rule below. The AI second-brain direction (see that section) further authorizes future tables for notes/wikilinks, goals, pgvector embeddings, and AI conversation/audit logs. Outside those approved expansions, still do not add tables for subtasks, tags, attachments, reminders, dependencies, or two-way sync unless the user reopens scope.

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
  - Drag uses `@dnd-kit/core` with a `MouseSensor` only (6px activation distance): drag-to-reschedule is a desktop affordance and is deliberately disabled on touch, where chips tap through to the selected-day list and its edit panels instead.
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
- `app/actions/finance.ts`: category/account/recurring-expense/income-source CRUD, `recordBalanceChange` (balance update → transaction rows + reconciliation anchor), `updateBalanceChange` (amount/date/category/note edits), and `deleteBalanceChange` — the latter two re-derive the cached account balance (see Finance).
- `app/actions/inventory.ts`: inventory group/item/usage CRUD and quantity adjustments; `app/actions/inventory-icon.ts`: item icon upload/generation.
- `app/actions/auth.ts`.

## Finance

`/finance` is a money tracker and cashflow forecast. No bank/Plaid sync — but statement screenshots import through the `update_finance` MCP/assistant tool (see below). Design + decisions: `docs/finance-automation-plan.md`.

- **Transactions-first model** (migration 0022): `balance_changes` is a true transaction ledger — rows are dated, editable, and deletable. An account's balance is **derived**: latest `account_reconciliations` anchor ("held X at end of day D") + signed sum of rows outside it (dated after `as_of`, or on `as_of` but created after the anchor row). `accounts.balance` is a cache recomputed on every write by `recomputeAccountBalance` (`app/lib/finance/recompute.ts`); the pure math + `changeFingerprint` (`date|direction|cents`, dedup) live in `app/lib/finance/derive.ts`. `balance_after` is deprecated (unwritten, unread; column dropped in a later cleanup). Writers must insert transaction rows BEFORE the anchor that accounts for them.
- The manual flow is unchanged in feel: "update balance" diffs against the stored balance, writes categorized rows, and stamps a reconciliation anchor at the new balance (the anchor absorbs drift). A single decrease can be **split across multiple spending categories**; splits must sum to the decrease (`recordBalanceChange` + `allocations[]`; cent-accurate `splitEvenly`/`sumMoney` in `app/_components/money.ts`). Ledger rows now support amount/date/category/note edits and deletion (history panel in `app/finance/accounts-section.tsx`), each followed by a balance re-derive.
- **Statement import**: `update_finance` is a batched propose → confirm write on both the MCP server and the in-app assistant — spend/income (dated, duplicate-skipping via fingerprints, per-op `force`), transfer (paired `is_transfer` rows, e.g. card payments — excluded from all spending analytics), reconcile (anchor at the statement's ending balance; resolver orders it last), create_category / create_recurring (referenced by later ops in the same batch), adjust/remove (corrections by ledger-row id; adjust's `markTransfer` reclassifies a mis-imported row as a transfer). Pure batch logic is unit-tested in `app/lib/mcp/finance-ops.ts`; the executor lives in `EXECUTORS` (`app/lib/mcp/writes.ts`). Claude reads the screenshot in the chat — Mindboard has no OCR. Credit accounts store owed as a **negative** balance; card purchases are spends, card payments transfers.
- `recurring_expenses` land `monthly` (day-of-month, clamped), `weekly` (weekday), `daily`, or `custom` (every `interval_days` from `start_date`). They are projection inputs only — they do not write ledger rows.
- `income_sources` are wage jobs: a linked Google Calendar's timed events are treated as worked shifts; net pay = hours × `hourly_wage` × (1 − `tax_rate`/100). An optional pay schedule (weekly/biweekly/monthly + anchor payday + period) pays a lump on each payday; with no schedule, pay lands on the day worked.
- The right-column finance calendar shows projected end-of-day **net worth** (sum of account balances): days ≤ today are recorded actuals, days > today forecast wage income − recurring bills − **estimated everyday spend**. The everyday layer is a FLAT daily rate: the **median weekly** discretionary total over the trailing ~12 full weeks ÷ 7 (`app/_components/spend-baseline.ts`, unit-tested). It is deliberately NOT weekday-shaped: statement imports carry *posted* dates, and banks park weekend purchases on Monday, so weekday buckets learn the bank's posting calendar. Bills are excluded by amount+category match against active recurring rules with NO date requirement (payments wander); transfers are excluded; zero weeks count. Per-day resolution: `spend_overrides` pin (slider in the selected-day panel, 0 allowed) → confident rate (≥4 full weeks) → manual `user_settings.daily_spend_estimate` → nothing. Estimates render muted with a `~` prefix (`estimatedOutflow` on `DayRow`), distinct from firm amounts. Projection math is pure and unit-tested in `app/_components/finance-projection.ts`.

Files: `app/finance/page.tsx`, `app/finance/finance-client.tsx`, `app/finance/accounts-section.tsx`, `app/_components/finance-calendar.tsx`, `app/_components/finance-projection.ts`, `app/_components/spend-baseline.ts`, `app/_components/finance-types.ts`, `app/_components/money.ts`, `app/actions/finance.ts`, `app/lib/finance/derive.ts`, `app/lib/finance/recompute.ts`, `app/lib/mcp/finance-ops.ts`.

## Inventory

`/inventory` is "the shelf": a calm picture of what the user HAS, with a per-item depletion forecast. The design rule is have-first — attention is opt-in (an item only shows a "low"/run-out hint when the user set a `reorder_threshold` or usage rule), and running out is an exit, not an alarm. Full design rationale in `docs/inventory-redesign-plan.md`.

- Active items with quantity > 0 render grouped by `inventory_groups` and alphabetical, with inline −/＋ steppers. Items at zero drop into a collapsed "ran out" footer whose only actions are `restock…` and `stop tracking`.
- **Lifecycle**: `stop tracking` archives (swipe-left on mobile, hover ⏏ on desktop, the detail panel, or select-mode bulk bar). Archived items live in a collapsed "not tracking" section with `restore` and `delete forever`; hard delete only exists there and behind a confirm in the detail panel. An item at zero for 14+ days gets at most one quiet "stop tracking?" suggestion row, never a modal.
- **Omnibox**: the single field on top is search + capture. Plain text filters; `12 eggs` (recount), `+2 milk` (add), `-1 rice` (remove) apply instantly on enter when every ref resolves to an existing item. Batches that create new items, and free-form text (parsed by one forced-tool Claude call using the user's stored API key), come back as a propose → confirm receipt in the universal `ProposalCard`. Grammar: `app/_components/stock-capture-parse.ts`; server actions: `app/actions/stock-capture.ts`. The Dock's three-mode capture grammar is untouched — stock capture is page-local by design.
- **Agent editing**: `update_stock` is a batched propose → confirm write (add/remove/set/create/archive/restore; items referenced by id or fuzzy name — exact → unique substring, ambiguity fails with candidates) exposed on both the MCP server and the in-app assistant, with `list_inventory` as the id-source read. Pure batch logic (validation, resolution, receipt rendering) is unit-tested in `app/lib/mcp/inventory-ops.ts`; the shared executor lives in `EXECUTORS` in `app/lib/mcp/writes.ts`, so MCP `confirm_action` and the in-app `confirmProposal` both apply it.
- Select mode (toggle next to list/grid) turns rows into checkboxes with a sticky bulk bar: stop tracking · move to group · delete.
- `inventory_usages` are recurring consumption rules (`day`/`week`/`custom`) spread to an effective daily rate (day = amount, week = amount/7, custom = amount/interval_days). All usages sum to one smooth declining projection — weekly usage does NOT land on a specific weekday.
- Each item's detail panel shows an `InventoryCalendar` with projected remaining quantity per day, the run-out day, and the reorder-by day when `reorder_threshold` is set. Projection math is pure and unit-tested in `app/_components/inventory-projection.ts`.
- Item icons are uploaded or generated and served from the public `inventory-icons` storage bucket (migration `0005`).

Files: `app/inventory/page.tsx`, `app/inventory/inventory-client.tsx`, `app/_components/inventory-calendar.tsx`, `app/_components/inventory-projection.ts`, `app/_components/inventory-types.ts`, `app/_components/inventory-units.ts`, `app/_components/unit-picker.tsx`, `app/_components/stock-capture-parse.ts`, `app/actions/inventory.ts`, `app/actions/inventory-icon.ts`, `app/actions/stock-capture.ts`, `app/lib/mcp/inventory-ops.ts`.

## Learn

`/learn` is the education section (design record: `docs/education-plan.md`): a **course** is a NotebookLM-style container whose files become vault knowledge, podcasts, and study material. The vault stays the knowledge layer — converted markdown and generated study documents land in the GitHub vault under `Courses/<course>/`; Postgres holds only operational metadata.

- **Ingestion, three paths, one contract** (markdown → vault via the create-only `Courses/` writer, a second fenced direct-write exception alongside `capture_to_brain`'s `Inbox/`): (1) chat-AI transcription over MCP — `begin_source_upload` → `append_source_markdown` (contiguous 1-based parts ≤20k chars) → `finalize_source`, on subscription tokens; (2) the home worker (MinerU, free); (3) Claude-API conversion on the stored key (`app/lib/learn/convert.ts`: `unpdf` probe → `pdf-lib` ~20-page slices with 1-page overlap → per-slice document-block calls → anchor-trimmed stitch). Original PDFs upload browser→storage directly (private `course-files`, `{user}/{source}/` folders).
- **Audio overviews** (`app/lib/learn/episodes.ts` + `podcast-script.ts`): Claude writes a typed script — two hosts (flavors deep-dive/brief/debate) or a single narrator (flavor solo) — from the sources' vault markdown; voices render via **Gemini Flash TTS** (one multi-speaker request; PCM→WAV in pure JS — no ffmpeg on Vercel) or **VibeVoice on the home worker** ($0, queued). Episodes live in `audio_episodes` + the private `course-audio` bucket, played via signed URLs. MCP `generate_audio_overview` is propose → confirm (it spends money); the in-app tap executes directly.
- **Home worker** (`worker/worker.py` + `worker/README.md`): pull-based, no inbound ports, no DB key on the PC — it polls `POST /api/worker` (bearer = `MCP_BEARER_TOKEN`) for claim/heartbeat/complete/fail; claims are atomic (`claim_next_job()`, stale-heartbeat reclaim, 3-attempt dead-letter); PDFs travel via signed download URLs and audio via signed upload URLs; all vault/Postgres finalization stays in the app. The settings connections card shows online/queue state from `worker_status`.
- **Grounded chat** (`/api/course-chat` + `/learn/[id]/chat`): selected sources attach as citation-enabled text documents; answers stream over SSE and end with numbered citation chips (quoted passage + `noteHref` deep link into `/brain`). Source-subset toggling is the context strategy — no pgvector, honoring the cancelled Phase 3.
- **Study** (`/learn/[id]/study` + `app/lib/learn/artifacts.ts`): study guide/FAQ/briefing/timeline generate as vault notes (`type: course-artifact`); flashcards persist in `course_cards` with got/miss progress (reveal → grade, retest-missed, weak-cards deck).
- **Connections** (settings): every provider key lives in one section, one `ConnectionCard` recipe (status dot, last-4 hint, plain-language "powers" line, verify-on-save), all encrypted server-side via `app/actions/connections.ts` + `app/lib/connections/keys.ts`. Icon-generation keys moved here from localStorage; only provider/model prefs stay client-side.

Files: `app/learn/*`, `app/actions/learn.ts`, `app/actions/connections.ts`, `app/lib/learn/*`, `app/lib/connections/*`, `app/lib/mcp/course-ops.ts`, `app/lib/mcp/courses.ts`, `app/api/course-chat/route.ts`, `app/api/worker/route.ts`, `app/_components/learn-types.ts`, `app/_components/connection-card.tsx`, `worker/*`.

## Command Center (dashboard vitals)

The dashboard (`/`) opens with a horizontally scrollable **vitals strip** that synthesizes every domain at a glance — net worth + today's delta, next bill, tasks due/overdue, next event + free hours today, inventory low/run-out. It is deterministic (no AI), anchored to *today* regardless of the calendar month, and composed from:

- `app/lib/data/*` — reusable, `cache()`-deduped, RLS-scoped reads (finance, inventory). It reuses the dashboard's cached read for tasks/events, so the common current-month view adds no extra Supabase/Google round-trips.
- `app/lib/snapshots/*` — pure, unit-tested rollups (`financeSnapshot`, `inventorySnapshot`, `tasksSnapshot`, `scheduleSnapshot`) that reuse the finance/inventory projections; the only net-new math is calendar free-gap computation.
- `app/_components/vitals-strip.tsx` plus `getVitalsData`/`VitalsSection` in `app/page.tsx`, rendered in its own Suspense boundary above the today/calendar grid.

**Timezone convention.** The process clock is UTC on Vercel. The dashboard stream is timezone-aware via `user_settings.timezone`: `app/page.tsx` computes the header clock (`formatClock12`), the date label, and the stream's `today` in the user's zone (`todayISO(timeZone)` / `safeTimeZone` in `app/_components/date-utils.ts`), passes `timeZone` into `streamSnapshot` for all wall-clock facts (daily-log invite gate, due-time checks, event day bucketing), and `saveDailyLog` stamps `log_date` in the same zone. Everything else — the week grid, free-hours math (`app/lib/snapshots/schedule.ts`), MCP `todayKey()` — still uses the process clock; that debt is tracked in `docs/second-brain-plan.md`. When adding user-facing wall-clock logic to the dashboard, take a `timeZone` input rather than calling `getHours()` on the server.

## AI Second-Brain Direction

Mindboard is being evolved into an AI "second brain" / life command center. The architectural spine is a single **agent tool layer** (`app/lib/agent/registry.ts`): a typed catalog of read/write tools intended to be exposed three ways without rewriting logic — an in-app assistant, a remote MCP server, and a proactive "what should I do next" planner. The registry is currently the catalog (the seam); live handlers, an `ai_audit_log`, and the confirmation step are wired in a later phase.

Decided constraints: assistant writes are **propose → confirm** (never silent), and finance is read-safe by default. The AI stack (raw Anthropic SDK vs Vercel AI SDK vs Claude Agent SDK) is intentionally not yet chosen — Phase 0/1 (the read/tool layer + the vitals command center) are stack-agnostic. The full vision, phased roadmap, and decisions are in `docs/second-brain-plan.md`. This direction is what authorizes the future notes/goals/pgvector tables noted in the Data Model scope note.

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
- `app/_components/calendar-types.ts`: shared `CalendarItem` discriminated union for tasks, events, and finance changes in the calendar widget.
- `app/_components/task-row.tsx`: shared task row with inline edit panel (title, date, group, Markdown notes, delete).
- `app/_components/event-row.tsx`: read-only virtual row for events from a linked Google Calendar.
- `app/_components/today-client.tsx`: dashboard task list, mixes tasks with virtual events from linked calendars.
- `app/_components/tasks-client.tsx`: inbox and single-group task list.
- `app/_components/types.ts`: shared task types.
- `app/_components/date-utils.ts`: date helpers.
- `app/groups/groups-client.tsx`: group list, create form, per-group edit panel, color picker, calendar linker.
- `app/finance/finance-client.tsx`: finance UI — accounts, ledger, recurring expenses, income sources, categories, and the balance-update panel with multi-category split.
- `app/_components/finance-projection.ts`: pure, unit-tested net-worth/cashflow projection.
- `app/_components/money.ts`: money formatting + `splitEvenly`/`sumMoney`.
- `app/inventory/inventory-client.tsx`: inventory UI — grouped items, steppers, item detail with depletion calendar.
- `app/_components/inventory-projection.ts`: pure, unit-tested depletion forecast.
- `app/_components/vitals-strip.tsx`: the dashboard command-center vitals strip.
- `app/lib/data/*`, `app/lib/snapshots/*`: reusable reads and pure cross-domain rollups feeding the vitals strip.
- `app/lib/agent/registry.ts`: the agent tool-layer seam (see AI Second-Brain Direction).
- `docs/second-brain-plan.md`: the second-brain vision, roadmap, and decisions.

## Engineering Rules

- Read actual files before explaining or changing behavior.
- Prefer Server Components. Use `"use client"` only for state, hooks, optimistic UI, or browser APIs.
- Keep changes narrow. Do not refactor unrelated code.
- Use existing patterns before inventing abstractions.
- Validate user input and external API responses; trust internal code where reasonable.
- Avoid comments unless they explain a non-obvious invariant or constraint.
- Use `rg` for search.
- Use `npm run lint`, `npm run test`, and `npm run build` before declaring code changes complete.
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
