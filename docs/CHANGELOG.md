# Changelog

Versioned record of shipped change sets. Newest first. Design rationale lives
in the linked plan docs; this file records exactly what changed and where.

---

## Onboarding refresh: new-feature tours, global reset, ※ what's new (2026-07-10)

The tours catch up with everything shipped since v0.4.0, everyone's onboarding
re-offers, and the app gains an in-app patch-notes surface.

- **Tour + intro content** (`app/_components/onboarding/tours.ts`): intro cards
  for money/inventory/more updated (spend limits, the self-pricing shopping
  list, brain+learn now on the rail); `now` tour teaches the reworked rail and
  the `plan` chip; `money` tour gains a "the guardrails" step on the
  already-stamped `spend-limits` anchor plus grocery-`≈−` and fixed-monthly
  copy; `stock` tour gains "the shopping list" on a new `data-tour="shopping"`
  stamp (`app/inventory/inventory-client.tsx`); `tasks` tour gains a "✦ auto
  sort" step; `plan` tour mentions horizon planning and the model picker.
- **Global reset**: `supabase/migrations/0034_reset_tours.sql` wipes every
  user's `completed_tours`, and the localStorage render-guard mirror is
  version-bumped to `mb-completed-tours-v2` (shared `TOURS_MIRROR_KEY` in
  `tours.ts`, used by the controller and the settings replay button; the v1 key
  is cleaned up on read) so stale client mirrors can't suppress the re-offer.
- **※ what's new**: a second floating button beside the `?`
  (`onboarding-controller.tsx`) opens a patch-notes panel
  (`whats-new-panel.tsx`) fed by hand-written, board-voice entries in
  `whats-new.ts` (newest first). Quiet unread accent dot keyed on
  `localStorage["mb-news-seen"]` vs the latest entry id; marking seen happens on
  open; no auto-open. Per-device read-marker — no DB column.

Note: the shopping-list/grocery-forecast, spend-limits, fixed-monthly-income,
dock-rework, and inbox-auto-sort change sets (commits `2e58488`, `f706991`,
`4e9adba`, `6e183d6`/`59e9248`, `4ff9869`, 2026-07-08/09) predate this entry and
are recorded user-facing in `whats-new.ts`; design docs:
`docs/inventory-redesign-plan.md`, `docs/finance-automation-plan.md`.

---

## get_snapshot horizon planning read + zone-correct free-time math (2026-07-08)

`get_snapshot` gains a wide planning mode across `today…+horizonDays`, and the
wake-window/free-time math is now computed in the user's timezone instead of the
UTC process clock.

- **Zone-aware schedule math**: `app/lib/snapshots/schedule.ts`
  (`scheduleSnapshot`, `freeGaps`, `freeIntervalsForDay`) take an optional
  `timeZone` and resolve wake windows via new pure helpers in
  `app/lib/snapshots/zoned-time.ts` (`zonedWallTimeToUtcMs`, `zonedDateKey`,
  `zonedClock`, `zonedClockMinutes`, `zonedIso`). Omitting `timeZone` keeps the
  old process-clock behavior (correct in the browser). Tests: `zoned-time.test.ts`,
  new zone cases in `free-gaps.test.ts`.
- **Horizon planning snapshot**: `app/lib/snapshots/planning.ts`
  (`planningSnapshot`, pure + unit-tested in `planning-snapshot.test.ts`)
  composes, over the horizon: per-day schedule (timed events, Mindboard
  time-blocks, materialized recurring-task occurrences — source-tagged — plus
  free gaps, free-hours-before-5pm, and committed minutes), every open task with
  due time/duration + a scheduled flag, upcoming bills + projected net worth per
  day, inventory run-out estimates, and the recent check-in trend + active
  goals. Times carry explicit ISO offsets. Assembled session-less by
  `app/lib/snapshots/planning-read.ts` (`buildPlanningSnapshot`), which is
  client-agnostic so the MCP service client and the in-app session client share it.
- **Shared cashflow core**: `getFinanceForecast` (MCP `finance_forecast`) was
  extracted to `app/lib/finance/forecast.ts` (`buildFinanceForecast`) so the
  planning snapshot reuses the exact finance-calendar projection.
- **Surfaces**: the in-app assistant `get_snapshot` (`app/lib/assistant/tools.ts`)
  takes `horizonDays` (1–60) / `verbose:true` — the bare call keeps the lean
  default shape; the remote MCP server gains a `get_snapshot` tool
  (`app/api/mcp/[transport]/route.ts` → `getPlanningSnapshot`) that is always the
  wide read, alongside the existing lean `*_snapshot` tools.

---

## v0.4.0 — landing page + Football-Manager onboarding (2026-07-08)

The logged-out `/` and the first-run experience, rebuilt together. Plan and
rationale: [onboarding-landing-plan.md](onboarding-landing-plan.md). Shipped
in the same tree (and the same push) as v0.3.0 below — two concurrent
sessions, merged and verified as one set.

### Track L — the landing page

`GetStartedScreen` is deleted; `app/page.tsx` renders the new
`app/_components/landing/landing.tsx` when logged out. One long, scroll-driven,
self-contained page in the board's voice (casual, lowercase, first person):

- **Boot hero** (`boot-hero.tsx`): terminal-style typed boot sequence
  (*"where did i put my life?"* → the board answers) resolving into the
  headline and `get started →` / `continue with google` CTAs.
- **A day with the board** (`day-scene.tsx` + `day-script.ts`): a
  scroll-progress-driven scene that walks five chapters of one day through a
  stylized mini-dashboard. The chapter/segment math (`chapterAt`, `seg`,
  `lerp`, `typedCount`, chapter fades) is pure and unit-tested in
  `__tests__/landing-day.test.ts`.
- **Grammar doors** (`grammar-doors.tsx`): the capture bar's three modes
  (task / `$` spend / `?` question) demonstrated, not described.
- **MCP bridge panel** (`mcp-bridge.tsx`): the claude.ai connector pitch.
- **Theme split** (`theme-split.tsx`): the dark/cream "pick a side" moment
  survives — tapping a side re-themes the whole landing page live and
  persists the choice for `/login`.
- **Close CTA** (`close-cta.tsx`), hooks `use-in-view.ts` /
  `use-scroll-progress.ts` (both respect `prefers-reduced-motion`), and a
  `/* landing */` keyframe block in `app/globals.css` using theme tokens.
- No new dependencies, no images, no network calls while logged out.

### Track O — onboarding (the Football Manager model)

One overview up front, then an in-depth tour of each section the first time
you walk in. Finish or skip once → never again; a fixed `?` button replays.

- **Migration `0025_onboarding.sql`** (applied live):
  `user_settings.completed_tours jsonb` — tour key → completed-at timestamp.
  Server actions `completeTour`/`resetTours` in `app/actions/onboarding.ts`;
  the migration leaves the map empty so the owner sees everything once too.
- **Engine** (`app/_components/onboarding/`): `TourMount` server shell mounted
  in `app/layout.tsx` next to `DockMount`; `onboarding-controller.tsx` maps
  route → tour key and auto-starts incomplete tours; `tour-overlay.tsx`
  renders the spotlight via the box-shadow-cutout trick with a mobile
  bottom-sheet / desktop popover card; `intro-carousel.tsx` is the first-run
  full-screen overview; `tours.ts` is the pure copy catalog. Spotlight/
  placement math is pure and unit-tested (`tour-geometry.ts`,
  `__tests__/tour-geometry.test.ts`).
- **Anchors**: inert `data-tour="…"` stamps on the Dock, vitals, stream,
  calendar pane, week grid, plan input, finance sections, inventory omnibox,
  tasks page, and brain — all chrome or empty-states, so tours work on a
  zero-data account. A missing anchor degrades to a centered card.
- **Replay**: `replay-tours-button.tsx` (the `?`), plus a "replay all tours"
  row in `/settings`.

### Dashboard stream polish (same push)

- **Task cards lead the "next" section** (`app/lib/snapshots/stream.ts`):
  due-today tasks now sort before later-today events, so a full calendar day
  can't push actionable tasks past the section cap.
- **Inline group picker on stream task cards** (`stream-client.tsx` +
  `page.tsx` passing `groups`): re-group a task from the dashboard; group and
  reschedule edits apply optimistically in place (card re-labels instead of
  vanishing) until the next server snapshot confirms. Render behavior covered
  by the new `__tests__/stream-client-render.test.tsx`.
- **`/week` rail tab is mobile-only** (`dock.tsx`): desktop's dashboard
  already shows the week pane, so the tab was redundant there.

---

## v0.3.0 — `/learn`: courses, study engine, audio overviews (2026-07-08)

The education section, L0–L5 in one session. Plan, rationale, and the full
implementation log: [education-plan.md](education-plan.md). Migrations
0024/0026/0027/0028/0029 applied to the live DB.

- **Courses** (`/learn`, migration 0024): course CRUD, per-course sources,
  browser→storage direct PDF upload into the private `course-files` bucket.
  Converted markdown lands in the GitHub vault under `Courses/<course>/` (a
  second fenced create-only writer alongside `capture_to_brain`'s `Inbox/`);
  Postgres holds only operational metadata.
- **Ingestion, three paths, one contract**: chat-AI transcription over MCP
  (`begin_source_upload` → `append_source_markdown` → `finalize_source`),
  the home worker (MinerU/Marker, free), or Claude-API conversion on the
  stored key (`app/lib/learn/convert.ts`: `unpdf` probe → `pdf-lib` ~20-page
  slices with 1-page overlap → per-slice document-block calls →
  anchor-trimmed stitch). Pure logic unit-tested (`course-ops`,
  `convert-plan`).
- **Audio overviews** (migrations 0026 + 0029): Claude writes a typed
  two-host script (flavors deep-dive/brief/debate, plus **solo**
  single-narrator lectures); rendered via Gemini Flash TTS (one multi-speaker
  request, PCM→WAV in pure JS) or VibeVoice on the home worker ($0, queued,
  owner's cloned voice as default host). Episodes in `audio_episodes` +
  private `course-audio`, played via signed URLs. MCP
  `generate_audio_overview` is propose → confirm (it spends money).
- **Home worker** (migration 0027, `worker/`): pull-based Python worker with
  no inbound ports and no DB key — polls `POST /api/worker` (bearer =
  `MCP_BEARER_TOKEN`) for claim/heartbeat/complete/fail; atomic
  `claim_next_job()` (SKIP LOCKED, stale-heartbeat reclaim, 3-attempt
  dead-letter); files travel by signed URLs; all finalization stays in the
  app. Installed and verified end-to-end on the PC (Marker OCR + ComfyUI
  VibeVoice via `render_vibevoice.py`).
- **Grounded chat** (`/learn/[id]/chat` + `/api/course-chat`): selected
  sources attach as citation-enabled documents; SSE streaming answers end in
  numbered citation chips with quoted passages and `/brain` deep links.
- **Study** (`/learn/[id]/study`, migration 0028): study guide / FAQ /
  briefing / timeline generate as vault notes; flashcards persist in
  `course_cards` with got/miss progress, retest-missed, and a weak-cards
  deck.
- **Connections redesign** (`/settings`): every provider key in one section,
  one `ConnectionCard` recipe (status dot, last-4 hint, "powers" line,
  verify-on-save), all encrypted server-side (`app/actions/connections.ts` +
  `app/lib/connections/keys.ts`). Icon-generation keys moved out of
  localStorage (one-time re-paste; `legacy-image-key-migration.tsx` cleans
  up); only provider/model prefs stay client-side. The settings worker card
  shows online/queue state from `worker_status`.
- New MCP + assistant tools: `list_courses`, `begin_source_upload`,
  `append_source_markdown`, `finalize_source`, `generate_audio_overview`.
  The Dock's ≡ sheet gains `learn`.
- New deps: `pdf-lib`, `unpdf`.

### Verification (both versions, one tree)

- `npm run lint` clean, `npm run test` 435 passing (31 files), `npm run
  build` green with `/learn`, `/learn/[id]/chat`, `/learn/[id]/study`,
  `/api/course-chat`, and `/api/worker` registered.
- Migrations 0024–0029 applied to the live Supabase project.
- Owner-gated follow-ups: paste the Google AI key (and re-paste the OpenAI
  key if wanted) in settings → connections; toggle the claude.ai Mindboard
  connector off/on so it re-fetches the new tools.

---

## v0.2.1 — timezone-correct dashboard clock + daily-log invite (2026-07-08)

Two fixes on `/` with one root cause: the page renders on Vercel where the
process clock is UTC, and `user_settings.timezone` was stored but never
consulted by the dashboard. At 11:38pm in Vancouver the header clock read
`06:38`, and the evening energy/mood log row never appeared (its gate
`getHours() >= wakeEndHour - 2` saw UTC hour 6).

- **Header clock** is now 12-hour in the user's saved timezone (`11:38pm`) via
  new `formatClock12` in `app/_components/date-utils.ts`; the date label next
  to it no longer flips to tomorrow after 5pm local.
- **`streamSnapshot` takes `timeZone`** (`app/lib/snapshots/stream.ts`) and
  evaluates all wall-clock facts in it: the daily-log invite gate, due-time
  "time past" checks, event times on cards, and today/tomorrow event
  bucketing. Omitted/null falls back to the process clock, so the pure module
  stays deterministic and the existing tests unchanged.
- **The stream's `today`** (daily-log lookup, today's spend delta, recurring
  completions) is computed in the user's zone — `todayISO()` gained an
  optional `timeZone` argument.
- **`saveDailyLog`** stamps `log_date` in the user's zone, so logging at 11pm
  dismisses *today's* invite instead of writing tomorrow's row.
- **`safeTimeZone`** guards the free-text timezone setting — a typo'd zone
  falls back to the server clock instead of throwing in `Intl` and 500ing
  the page.
- Regression tests: 12-hour formatting, `safeTimeZone`, and the log-invite
  gate at 11:38pm Vancouver (`__tests__/date-utils.test.ts`,
  `__tests__/stream-snapshot.test.ts`).

Remaining timezone debt (unchanged, tracked in
[second-brain-plan.md](second-brain-plan.md)): the free-hours math
(`app/lib/snapshots/schedule.ts`), the week grid, and MCP `todayKey()` still
use the process clock.

---

## v0.2.0 — "The Shelf" (2026-07-06)

Full redesign of `/inventory` plus agent-editable stock levels via MCP and the
in-app assistant. Plan and rationale: [inventory-redesign-plan.md](inventory-redesign-plan.md).
Landed in commit `7073de3` (19 files, +2457 / −133). Deployed to production;
migration applied to the live Supabase project (`kdsunzpcjfzkidejtnyp`).

### The reframe

The old page was a warning system — attention-sorted (out → run-out → low →
fine), so the top of the list was always what you *didn't* have, and removing
an item took four taps ending in a hard delete. The page is now **the shelf**:
a calm picture of what you HAVE. Running out is an exit, not an alarm;
stop-tracking is a one-tap, reversible action; and an agent can edit stock
levels through the same propose → confirm rail as every other Mindboard write.

### Database (migration `0019_inventory_archive.sql` — applied live)

- `inventory_items.archived boolean not null default false` — "stop tracking"
  archives instead of deleting.
- `inventory_items.archived_at timestamptz` — shown in the "not tracking"
  section, cleared on restore.
- `inventory_items.last_restocked_at timestamptz` — stamped on any quantity
  increase (steppers, restock, agent ops); powers the "sitting at zero since…"
  archive suggestion.
- Partial index `inventory_items_active_idx on (user_id) where not archived`.

Archived items are excluded from every reader: the dashboard vitals
(`app/lib/data/inventory.ts`), the MCP snapshot (`app/lib/mcp/reads.ts`), the
assistant's `get_snapshot`, and the pure `inventorySnapshot` rollup
(`app/lib/snapshots/inventory.ts`) filters them defensively as well.

### `/inventory` page rebuild (`app/inventory/inventory-client.tsx`)

- **Have-first shelf.** Active items with quantity > 0 render grouped by
  inventory group (colored section headers with item counts or per-unit
  totals) and alphabetical within. The old attention ranking is gone.
- **Opt-in hints.** A row only shows a marker when the user asked for one:
  "low" (reorder threshold set) or `≈ jul 20` (usage rule set). No red badges
  on items with no threshold and no rule.
- **"Ran out" footer.** Items at zero drop into a collapsed `ran out · N`
  section. Each row offers exactly two actions: `restock…` (inline count
  input, Enter commits) and `stop tracking`.
- **Archive suggestion.** An item at zero for 14+ days gets at most one quiet
  dashed suggestion row ("X has been out for N weeks — stop tracking?") with
  `stop tracking` / `keep`. Never a modal, never more than one at a time.
- **"Not tracking" section.** Collapsed list of archived items with the
  archive date, `restore`, and `delete forever` (confirm-guarded). Hard delete
  only exists here and in the item detail panel behind a confirm.
- **Stop-tracking affordances.** Swipe-left on a row (touch, pointer-based,
  vertical-scroll-safe), hover ⏏ button (desktop), a visible `stop tracking`
  button in the item detail panel (replacing the delete buried under
  "appearance ▸"), and select mode.
- **Select mode.** A `select` toggle next to the list/grid switch turns rows
  into checkboxes with a sticky bulk bar: `stop tracking` · `move to…` (group
  select) · `delete` (confirm-guarded) · `done`.
- **Omnibox.** The single field on top is search + capture:
  - plain text filters the list live (commands filter by the item they name);
  - `12 eggs` (recount), `+2 milk` (add), `-1 rice` (remove) apply instantly
    on Enter when every ref resolves to an existing item — same trust level as
    tapping the steppers;
  - a batch that would create a new item, and any free-form text ("back from
    costco: two dozen eggs, out of dish soap"), returns a propose → confirm
    receipt rendered in the universal `ProposalCard`. Free text is parsed by
    one forced-tool Claude call (Haiku 4.5, the user's stored API key).
  - The Dock's global three-mode capture grammar (task / `$` / `?`) is
    untouched — stock capture is page-local by design.
- Grid view, count-mode toggle (items/totals), item detail panel (depletion
  calendar, usage rules, notes, icon generate/upload), and all optimistic
  update patterns are preserved.

### Agent stock editing (MCP server + in-app assistant)

- **New read — `list_inventory`** (`app/lib/mcp/reads.ts`, assistant
  dispatcher): items with id, name, quantity, unit, group, threshold, archived
  flag, plus the group list. `includeArchived` reveals untracked items (needed
  before a `restore`).
- **New write — `update_stock`**: ONE batched propose → confirm proposal for a
  whole haul. Ops: `add` (got more), `remove` (used some), `set` (recount),
  `create` (new item, optional unit/group), `archive` (stop tracking),
  `restore` (track again). `item` accepts an id or a name — case-insensitive
  exact match, then unique substring; ambiguity fails the whole batch with the
  candidate list. The proposal preview is a receipt
  (`eggs  6 → 18  (+12)` / `milk  1 → 0  (ran out)` / `paper towels  new · 3 rolls`).
- **Safety properties:** resolved ops are stored on the proposal **by id**, so
  a rename between propose and confirm cannot retarget a write. Execution
  re-reads live quantities (deltas re-apply, recounts overwrite, clamped at
  zero) and applies sequentially, reporting how far it got on failure. Every
  proposal lands in `ai_audit_log`; nothing applies without `confirm_action`
  (MCP) or the user's confirm tap (app).
- **One executor, three surfaces.** The pure batch logic (shape validation,
  name → id resolution, receipt rendering, stored-op re-validation) lives in
  `app/lib/mcp/inventory-ops.ts`. The executor joins the shared `EXECUTORS`
  map in `app/lib/mcp/writes.ts`, so the MCP server, the in-app assistant, and
  the omnibox proposals all execute identical code.

### New files

| File | Purpose |
| --- | --- |
| `supabase/migrations/0019_inventory_archive.sql` | archive lifecycle columns + partial index |
| `app/lib/mcp/inventory-ops.ts` | pure stock-batch logic (validate / resolve / receipt) |
| `app/_components/stock-capture-parse.ts` | pure omnibox grammar (`12 eggs`, `+2 milk`, `-1 rice`) |
| `app/actions/stock-capture.ts` | `proposeStockOps` (direct) + `proposeStockFromText` (one Claude call), both propose-only |
| `__tests__/inventory-ops.test.ts` | 15 tests: batch validation, fuzzy resolution, running quantities, receipt, audit-row round-trip |
| `__tests__/stock-capture-parse.test.ts` | 5 tests: grammar accepts/rejects, all-or-nothing multi-segment parse |
| `docs/inventory-redesign-plan.md` | the design plan, updated with shipped status |

### Modified files

| File | Change |
| --- | --- |
| `app/inventory/inventory-client.tsx` | full rebuild (see page section above) |
| `app/inventory/page.tsx` | select the new columns (client receives archived items for the "not tracking" section) |
| `app/actions/inventory.ts` | `setInventoryItemArchived`; `updateInventoryItem` stamps `last_restocked_at` on quantity increases; new columns in selects |
| `app/lib/mcp/writes.ts` | `proposeUpdateStockFor`/`proposeUpdateStock` + `executeUpdateStock` registered in `EXECUTORS` |
| `app/lib/mcp/reads.ts` | `listInventory`; snapshot read filters `archived = false` |
| `app/api/mcp/[transport]/route.ts` | registers `list_inventory` + `update_stock`; `confirm_action` description updated |
| `app/lib/assistant/tools.ts` | `list_inventory` + `propose_update_stock` tool defs and dispatcher cases |
| `app/lib/data/inventory.ts` | vitals read filters `archived = false` |
| `app/lib/snapshots/inventory.ts` | rollup ignores archived items |
| `app/_components/inventory-types.ts` | `InventoryItem` gains `archived` / `archived_at` / `last_restocked_at` |
| `__tests__/vitals-snapshots.test.ts` | item fixture gains the new fields |
| `AGENTS.md` | Inventory section rewritten; migration 0019 documented |

### Verification

- `npm run lint` clean, `npm run test` 250 passing (20 new), `npm run build`
  green.
- Live DB schema confirmed post-migration (columns + defaults present).
- Vercel production deploy from `main` (`7073de3`) verified building; local
  build of the same tree passed.

### Deferred (not in this version)

- **M5 — learned usage:** an append-only `inventory_events` ledger to infer
  per-item consumption from edit history (no hand-configured usage rules) and
  give agent-change provenance/undo.
- Voice input on the omnibox (would reuse the NL path unchanged).
- Note: claude.ai may cache an MCP connector's tool list — toggle the
  Mindboard connector off/on if `update_stock` doesn't appear after deploy.

---

## v0.1.0 — baseline (pre-2026-07-06)

Everything before this changelog existed: tasks + groups + Google Calendar
integration, finance, the original inventory tracker, PWA support, the
Terminal Calm design system and its redesign (Dock, Stream, planning copilot —
see [REDESIGN.md](REDESIGN.md)), the second-brain vault (`/brain`), and the
remote MCP server with OAuth (see [second-brain-plan.md](second-brain-plan.md)).
