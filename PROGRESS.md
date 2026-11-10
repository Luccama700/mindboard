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

### Gate results

| When | Lint | Tests | Build |
|---|---|---|---|
| Baseline, `bd91c3e` | 0 errors, 2 warnings | 1902 of 1902 (94 files) | ok, placeholder env |

### Known traps

- This PC's Node (tzdata 2025c) and the database both compute `America/Vancouver` as UTC-8 in winter. Windows and the hosting runtime use UTC-7 all year, which is correct since British Columbia stopped changing clocks. Never assert that offset in a test, never compute local time in SQL.
- `utils/google/calendar.ts` throws a generic error when a token refresh fails and discards Google's error code. Task 6 fixes that.
- `next build` needs placeholder env values (see `PLAN.md`). It does not need real ones.
