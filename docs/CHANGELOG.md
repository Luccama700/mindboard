# Changelog

Versioned record of shipped change sets. Newest first. Design rationale lives
in the linked plan docs; this file records exactly what changed and where.

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
