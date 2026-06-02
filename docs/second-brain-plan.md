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
