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
- A read-only export tool was written and rehearsed. It is kept outside git, with its notes.
- `docs/rebuild/05-cutover-runbook.md` written (outside git): the order for the sitting that makes the security release live.
- Task 2 (planner) built and reviewed by a stronger reviewer. Four fix rounds, each on a case the reviewer reproduced: the guaranteed floor block losing its slot, a block leaving the plan at midnight, a floor fix that moved blocks it should have left alone, and a newly demanded block taking the top task's reserved slot. Clean at `a3e98d4`. 96 tests, including a two-day sweep that replans every ten minutes.
- Task 6 (tables and stores) built and reviewed. `0066` creates nine tables and one server-only function and touches nothing that exists. `0067` schedules the tick through Vault. Two fix rounds (replacing a day's plan is now one locked statement; the in-memory store mirrors the database's rules). Clean at `69f7fe4`. Neither migration has been applied anywhere real.
- Task 9 (migration rehearsal) built and reviewed. Every migration runs in an in-memory Postgres as part of `npm run test`. It found no fault in `0056` to `0067`. The rehearsal on a local copy of real data and the comparison of constraint and policy names with the live database are written up outside git.
- Task 8 (Today on sample data) built, rendered at phone width and reviewed. Fixture mode only (`V2_FIXTURES=1`, never in production). The first render caught a stylesheet that did not parse, which no test could see.
- Task 7 (the tick, incoming answers, routes) built and reviewed by a stronger reviewer. Its review found two serious defects before anything ran: a block whose answer had been recorded but whose effect had not landed was dropped as slipped twice, and the weekly paid-hours cap did not count shifts on the week's other days. Both fixed, with the cap failing closed. Clean after two fix rounds.
- Whole-branch review, then one fix pass, then one re-check. It found what no per-task review could: a query on a column that does not exist (the tests had stubbed the same wrong name), a day cut at midnight when lights out is later, invalid offsets for instants with milliseconds east of UTC (a defect in an existing helper, also fixed), and overdue items treated as deadlines every day. All fixed. `__tests__/v2-schema-contract.test.ts` now checks every column name the engine sends against the migrated schema.
- Verdict of the last re-check: fit to show as built and reviewed, not yet live. What is still open is listed in `PLAN.md` under "Known open edges" and "Next after this plan".
- **Not built, and required before the engine can be switched on for anyone:** the live Today screen, a go-live script (nothing yet writes an account's rules, expectations or pairing code, or enables an account), and a first run of the storage code against a real database.

### 2026-11-10

- The owner tried the sample screen and asked for a desktop version, his own data on it, and a colour scheme he can change. All three built, reviewed by rendering, and committed (`a144aea`).
- **Local mode.** `V2_LOCAL_SNAPSHOT` names a folder of local JSON files (an export, a rules document, a manifest, calendar events). The page builds the same planner input the live engine will and never connects to a database. It is refused in production and never writes. This is how the screen is tried on real data until the security release is live.
- **Desktop layout** from 1024 px: a rail, the day, and a side column (energy, lanes, items past their date, what did not fit). Phone layout unchanged below that.
- **Colour schemes.** Every token derives from two colours. Black and purple is the default and is what the server renders. The choice is stored per browser under `mb-v2-appearance`.
- **Planner, from real data:** an overdue item now ranks after live work (`0c171aa`). On a real account the oldest overdue task had been taking the guaranteed block every day.
- The screen input has one shape whatever built it: `app/lib/v2/view/screen-data.ts`.

### How the build runs

One implementer agent per task, then a separate reviewer agent, then fixes until the review is clean. The orchestrating session makes every commit. The working ledger with every ruling is `.superpowers/sdd/PLAN/progress.md` (git-ignored, so it can be lost; the rulings that matter are copied into the final report and into `docs/rebuild/04-decisions.md`).

To resume: read this file, then `PLAN.md`, then `git log --oneline bd91c3e..HEAD`. A task is done when its commit exists and the ledger has a `complete` line for it. Tasks without one start again from their brief (`bash <skill>/scripts/task-brief PLAN.md <n>`).

### Gate results

| When | Lint | Tests | Build |
|---|---|---|---|
| Baseline, `bd91c3e` | 0 errors, 2 warnings | 1902 of 1902 (94 files) | ok, placeholder env |
| All nine tasks, before the whole-branch review, `4827115` | 0 errors, 2 warnings | 2646 of 2646 (118 files) | ok, placeholder env |
| After the whole-branch fix pass, `2159f52` | 0 errors, 2 warnings | 2742 of 2742 (119 files) | ok, placeholder env |
| Final, one test added after `2159f52` | 0 errors, 2 warnings | 2743 of 2743 (119 files) | not re-run: no code changed since the build above |
| Real-data mode, desktop layout, colour schemes, `a144aea` | 0 errors, 2 warnings | 2902 of 2902 (121 files) | ok, placeholder env |

### Known traps

- Runtimes carry different versions of the time-zone database and can disagree about a zone whose rules changed recently. Never assert a particular zone's offset for a recent date in a test, and never compute local time in SQL. Tests use `UTC`, `America/Phoenix`, `Asia/Tokyo` and `America/New_York`.
- `utils/google/calendar.ts` throws a generic error when a token refresh fails and discards Google's error code. Task 6 fixes that.
- `next build` needs placeholder env values (see `PLAN.md`). It does not need real ones.
- The code reads `GOOGLE_CLIENT_SECRET`. A local env file that names that value differently can never refresh a Google token.
- Do not assume Docker, the Supabase CLI or `pg_dump` exist where this runs. Migrations are rehearsed in an in-memory Postgres (Task 9).
- Several agents share this folder during a wave. They do not commit and they run only their own tests. Commit by explicit path, never `git add -A`.
