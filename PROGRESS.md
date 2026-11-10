# Rebuild progress

Read this first when resuming. Newest entry on top. `PLAN.md` is the current plan. The design and decisions are in `docs/rebuild/` (kept outside git, see its README).

## Standing rules

1. Never run this branch's app against the production database. From the security work on, the code encrypts stored tokens when it first reads them and `main` cannot read them back.
2. No merge, migration, deploy, push, worker restart or new cloud resource without the owner.
3. New migrations are 0066 and up: written, reviewed, never applied.
4. New code in new paths, so the security pull request can still merge by itself.
5. Nothing personal in tracked files.

## Log

### 2026-11-09

- Checkpoint answered: all recommended. Recorded in `docs/rebuild/04-decisions.md`.
- `rebuild` fast-forwarded onto the security branch head (`bd91c3e`). Nothing pushed.
- Baseline on this branch before any new code: see the gate results below.
- Task 1 (shared contracts) written: `app/lib/v2/types.ts`.
- Tasks 3 (asks), 4 (watchdog) and 5 (messages, Telegram adapter) built by implementer agents, each reviewed by a separate reviewer agent, all approved with no blocking finding. Commits `f45a585`, `187e1c0`, `714afd7`. Their small deferred findings are listed in the ledger and folded into Task 6 and Task 7 where they belong.
- Plan corrected where the build showed it was wrong (`f313ab6`): the morning message is three lines, the watchdog has a silent `update` action, expiring asks never throws.
- Wave 2 detailed in `PLAN.md` (`306865c`): Task 6 tables and stores, Task 7 tick and routes, Task 8 Today on sample data, Task 9 migration rehearsal. `motion` and `@electric-sql/pglite` (dev only) installed.
- A read-only JSON export of the database ran and matched an independent row count on all 44 tables. Tool and output are outside git (`docs/rebuild/tools/export-json.mjs`, `Documents\mindboard\backups\`). It is a copy of the data, not a restorable dump.
- `docs/rebuild/05-cutover-runbook.md` written (outside git): the order for the sitting that makes the security release live.

### How the build runs

One implementer agent per task, then a separate reviewer agent, then fixes until the review is clean. The orchestrating session makes every commit. The working ledger with every ruling is `.superpowers/sdd/PLAN/progress.md` (git-ignored, so it can be lost; the rulings that matter are copied into the final report and into `docs/rebuild/04-decisions.md`).

To resume: read this file, then `PLAN.md`, then `git log --oneline bd91c3e..HEAD`. A task is done when its commit exists and the ledger has a `complete` line for it. Tasks without one start again from their brief (`bash <skill>/scripts/task-brief PLAN.md <n>`).

### Gate results

| When | Lint | Tests | Build |
|---|---|---|---|
| Baseline, `bd91c3e` | 0 errors, 2 warnings | 1902 of 1902 (94 files) | ok, placeholder env |

### Known traps

- This PC's Node (tzdata 2025c) and the database both compute `America/Vancouver` as UTC-8 in winter. Windows and the hosting runtime use UTC-7 all year, which is correct since British Columbia stopped changing clocks. Never assert that offset in a test, never compute local time in SQL.
- `utils/google/calendar.ts` throws a generic error when a token refresh fails and discards Google's error code. Task 6 fixes that.
- `next build` needs placeholder env values (see `PLAN.md`). It does not need real ones.
- The code reads `GOOGLE_CLIENT_SECRET`. The local env file on the PC names that value differently, so a local run could never refresh a Google token. Whether the host has the right name is a check in the cutover runbook.
- No Docker, no Supabase CLI and no `pg_dump` on this PC. Migrations are rehearsed in an in-memory Postgres (Task 9). A real dump needs the PostgreSQL command-line tools installed first.
- Several agents share this folder during a wave. They do not commit and they run only their own tests. Commit by explicit path, never `git add -A`.
