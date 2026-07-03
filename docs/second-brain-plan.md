# Mindboard → AI second brain / life command center

Research + build plan. Started 2026-06-01. This document is the durable record of
the direction and of every change made along the way.

## Vision

Evolve Mindboard from a task/calendar app into a **glanceable life command center**
with an **in-app AI assistant** that has access to all life data, an **Obsidian-like
notes/knowledge layer**, and **MCP interoperability** with other assistants — so that
"whenever I don't know what to do, I can ask what the best next steps are."

Decomposed into four capabilities + one spine:

- **A. Glanceable command center** — deterministic synthesis over existing data.
- **B. Second-brain substrate** — notes, `[[wikilinks]]`, backlinks, daily notes, semantic search.
- **C. In-app assistant** — Claude with tools over all domains.
- **D. MCP interoperability** — Mindboard as an MCP server; assistant as an MCP client.
- **Spine: one agent tool layer** — typed read/write tools, **built once, exposed everywhere**
  (in-app assistant, MCP server, proactive planner).

## Locked decisions

- **Autonomy = write-with-confirmation.** Writes (create task, log spend, append note) go
  through an explicit propose → confirm step, with an `ai_audit_log` (Phase 2).
- **AI stack = undecided** — revisit at Phase 2. Candidates: Vercel AI SDK (fast, +dep),
  raw Anthropic SDK (minimal-dep ethos), Claude Agent SDK (heaviest, best for the planner).
  Phase 0/1 are intentionally **stack-agnostic** so this needn't be decided yet.
- **Scope expansion authorized** (notes, goals, pgvector, AI tables) — same explicit
  override as the finance/inventory recurring-table exceptions.
- RAG via Supabase **pgvector**; MCP server auth may start as a single-user bearer token.

## Phased roadmap

| Phase | What | Status |
|---|---|---|
| **0** | AI-readiness refactor: read layer + snapshots + tool-registry seam | **done (2026-06-01)** |
| **1** | Glanceable "vitals" command center on the dashboard | **done (2026-06-01)** |
| 2 | In-app assistant (read-first; writes behind confirm + audit) | planned |
| 3 | Notes / wikilinks / backlinks / daily notes + semantic search | planned |
| 4 | Goals + "next best step" planner + PWA morning brief | planned |
| 5 | MCP server + external MCP connector | planned |

---

## Implementation log — Phase 0 & 1 (2026-06-01)

Additive only. No existing finance/inventory behavior changed; the only edited file
is `app/page.tsx` (to mount the vitals strip). Verified: `npm run lint` clean,
`npm run test` 69 pass, `npm run build` succeeds.

### Phase 0 — the seam

**Read layer** (reusable, React `cache()`-wrapped, RLS- + explicit-`user_id`-scoped):
- `app/lib/data/finance.ts` — `getAccounts`, `getActiveRecurringExpenses`, `getBalanceChangesOn`.
- `app/lib/data/inventory.ts` — `getInventoryItems`, `getInventoryUsages`.

**Snapshots** (pure, unit-tested; compose reads + the existing tested projections):
- `app/lib/snapshots/finance.ts` — `financeSnapshot` → net worth, today delta, next bill
  (reuses `finance-projection.ruleLandsOn`).
- `app/lib/snapshots/inventory.ts` — `inventorySnapshot` → low/out counts, soonest run-out
  (reuses `inventory-projection`).
- `app/lib/snapshots/tasks.ts` — `tasksSnapshot` → overdue / due-today / due-soon counts.
- `app/lib/snapshots/schedule.ts` — `scheduleSnapshot` → next timed event + free waking hours
  today (the one piece of genuinely new logic: interval-merge free-gap math).

**Tool registry seam:**
- `app/lib/agent/registry.ts` — typed catalog of read tools (wired to snapshots) and write
  tools (cataloged, `confirm: true`, mapped to existing `app/actions/*`). No LLM wiring yet;
  this is the single source of truth Phase 2 + the MCP server will both consume.

**Tests:**
- `__tests__/vitals-snapshots.test.ts` — 17 tests across the four snapshots + registry validity.

### Phase 1 — the glanceable command center

- `app/_components/vitals-strip.tsx` — presentational server component; a horizontally
  scrollable strip of five tiles (net worth, next bill, tasks, next up, inventory) using
  Terminal Calm theme tokens. Net-worth/next-bill link to `/finance`, inventory to `/inventory`.
- `app/page.tsx` — added `getVitalsData` (reuses the cached `getDashboardData` for tasks/events,
  adds accounts/recurring/inventory/today-changes reads), a `VitalsSection`, a `VitalsSkeleton`,
  and mounted them in a `Suspense` boundary above the today/calendar grid.

### Adjacent finance work shipped (2026-06-01)

Not part of the second-brain phases, but landed in the same version: the finance
"where did it go?" flow now supports **splitting one balance decrease across
multiple spending categories** (each split is its own ledger row; amounts must sum
to the decrease). Helpers `splitEvenly`/`sumMoney` in `app/_components/money.ts`
(unit-tested); see the Finance section of `AGENTS.md`.

### Notes & follow-ups

- The vitals strip anchors to **today**; it reuses the dashboard's month-scoped events for
  the "next up" tile, so browsing the calendar to a non-current month can under-report today's
  free hours. Finance "today delta" is always correct (queried for today directly).
- Free-gap wake window is hard-coded 08:00–22:00 (local/server time, matching the app's
  existing date convention). Worth making user-configurable later.
- Defaults chosen: 5 tiles in the listed order; "next bill" instead of a runway figure
  (runway needs wage income, which requires per-source Google fetches — deferred).
- Deferred to Phase 2: wiring registry `handler`/`preview` functions, the `ai_audit_log`
  table, and the confirm UI.
- Optional cleanup (not done, to keep changes narrow): the duplicated `toDateKey` /
  `normalizeMonth` / `currentMonth` helpers across `app/page.tsx` and `app/finance/page.tsx`
  could move into `app/_components/date-utils.ts`.

---

## Strategic redirection (2026-07-02) — merge with the 2ndBrain vault

Recorded per `docs/MINDBOARD_KICKOFF.md`. Mindboard has merged, conceptually, with
**2ndBrain**, an Obsidian vault maintained by Claude in Cowork. The vault owns identity,
knowledge, goals, and narrative; Mindboard owns operations (tasks, calendar, money,
inventory). Claude clients span both. Consequences for the phased roadmap above:

- **Phase 3 (notes / wikilinks / pgvector in Postgres): CANCELLED.** The vault is the
  knowledge layer; a second Postgres knowledge store would split the brain.
- **Phase 2 (in-app chat assistant): DEPRIORITIZED indefinitely.** Claude-in-Cowork with
  vault + Supabase-MCP access already is the assistant with full data access.
- **Phase 4 (morning brief): moves out of this repo.** A Cowork scheduled task will consume
  the MCP tools.
- **Phase 5 (MCP server): PROMOTED to the next milestone** (Milestone 1) — the repo's real
  mission: make Mindboard's data reachable by every Claude surface via a remote MCP server
  built on the Phase 0 tool registry, preserving write-with-confirmation + audit log.

Net: Phase 3 cancelled; Phase 2 deprioritized; Phase 4 relocated to Cowork; Phase 5 promoted
(next). Phases 0 & 1 remain done.

---

## Implementation log — Milestone 0 (2026-07-02): bring it back to life

Session goal: app runs locally and in production again; fix only what rot broke. Plan mode
first, additive only, lint/test/build gated.

**Shipped (local, additive):**
- Fixed one env-name rot bug: `.env.local` defined `GOOGLE_SECRET_KEY`, but
  `utils/google/calendar.ts` reads `process.env.GOOGLE_CLIENT_SECRET` (matching the README).
  Renamed the key in the local, gitignored file (value unchanged). Google Calendar token
  refresh was silently broken until this.

**Verified green:** `npm install` clean; `npm run lint` clean; `npm run test` 76 pass;
`npm run build` succeeds. Dev server boots; `/`, `/login`, `/finance`, `/inventory`,
`/groups`, `/inbox` all return HTTP 200 with no server errors; `proxy.ts` Supabase middleware
runs.

**Database (via reconnected Supabase MCP, project `kdsunzpcjfzkidejtnyp`):**
- Migrations required by the committed code (0001–0010 equivalents) are all applied.
- **Data survived the pause:** 19 tasks, 8 groups, 3 accounts, 15 balance_changes,
  17 inventory_items, 2 google_tokens, 1 user_settings, 2 auth users.

**Finding — orphaned schema (repo↔DB divergence).** The live DB holds six migrations dated
2026-06-12 that exist in **no** git branch/history/reflog, in **no** working-tree code, and
**nowhere** on disk (checked git `-S`, Spotlight, the 2ndBrain vault, and prior agent-session
logs):
- `0011_user_settings` — timezone, wake window, hashed iOS-Shortcuts capture token.
- `0012_goals`, `0013_daily_logs` — Phase 4 intent + capacity layers.
- `0014_ai_assistant` — `ai_conversations`, `ai_messages`, `ai_audit_log` (Phase 2
  propose→confirm design).
- `0015_assistant_api_key` — `user_settings.anthropic_api_key`.
- `0016_mcp_server` — `user_settings.mcp_token_hash` + `ai_audit_log.source` in
  {`assistant`,`mcp`} (Phase 5 groundwork).

Repo's last commit is 2026-06-05; there are no commits 2026-06-08…06-16. Conclusion: on
2026-06-12 a session applied these migrations directly via the Supabase MCP `apply_migration`
tool, ahead of the roadmap, and the application code was never written / committed /
persisted. This is **orphaned schema, not lost code.** The SQL is clean and RLS-scoped and is
a usable foundation for Milestone 1 — its `mcp_token_hash` + audit-log `source` design already
matches the MCP milestone's intent.

**Decision (owner, this session):** document-only. Leave the orphaned schema in place,
untouched; do not back-fill migration files and do not drop tables in Milestone 0. Reconcile
deliberately at the start of Milestone 1.

**Owner-gated, not done this session** (browser/interactive, can't be automated):
- Smoke test locally: Google OAuth login → create a task → calendar renders → `/finance`
  loads → vitals strip shows (confirm the 19 tasks / balances appear).
- Production: confirm `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` on Vercel, redeploy if the
  last deploy is stale, verify prod end-to-end, confirm the iOS PWA still opens and captures.

**Next:** Milestone 1 — the MCP server (Phase 5). First step: decide back-fill-vs-adopt of the
orphaned 0011/0014/0016 schema so the server builds on existing tables rather than inventing
new ones.
