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
- **Review of that work, and its fixes** (`79d6daf`). The loader passed. Two faults in the colour work: a custom background in the middle of the range left text under 4.5 to 1, and the appearance panel stopped answering Escape once focus left it. Now the painted page moves away from the ink by the smallest step that can carry text (the stored pick is unchanged, and the panel says so when the move is visible), every token is derived on the scheme's own side of each surface, and the lit card's tint is the largest its inks still read on. A sweep of 96 backgrounds, 5 accents and 6 identity colours pins the ratios; the reviewer's own probe of 143,360 combinations found no failure. The four built-in schemes are byte for byte as before.
- **The desktop page fills the window** (`434d355`). The owner opened it on a wide monitor and it used the left half: the frame was capped at 1140 px. The cap is gone. The day takes up to 640 px; everything after that goes to the day's context, which becomes more columns as the window allows: one from 1024 px, two from 1360 px (status, the lists), three from 1760 px (status, past their date, did not fit today), and rows two across inside a list once it is wide enough. Phone layout unchanged. Checked by capturing the real page at 1024, 1366, 1920, 2000 and 2560 px wide.
- **A trap found on the way:** the pane used for rendering is narrower than a desktop window, so a wide layout cannot be judged there. A headless browser on a throwaway profile gives a full-size capture of a local page.
- **Review of the full-width page, and its fixes** (`b1b8633`). The layout itself was found correct. One real gap: on a wide window a list is a column that scrolls on its own with nothing in it to focus, so a keyboard could not scroll it in a browser that does not make scrollers focusable by itself. Each list takes focus now. Also: the last column keeps off the window's edge, and a long group name gives way before it pushes the date out of a row. Exercised on the production build: a list scrolls while the page and the day stay still, at 2000 and 1366 px wide.
- **A stronger whole-range review, and its fixes** (`208fad3`, `f8f4e0d`, `9e3d15f`). No critical finding. It found the real-data page reachable from the local network (the server was listening on every interface; rebound to the loopback address at once, see Known traps), a title with two parentheticals cut at the first, one long word widening a stop, a paraphrase of a real task title in a test, and that the overdue rule only held inside a tier. All fixed. Left open by ruling: on the phone the document order no longer matches the visual order for a screen reader; it is resolved when the screen is restructured.
- **Second round on the same review** (`133d959`, `f536971`, `a422c9e`, `c00ec02`). The overdue rule now holds in every step of the plan, not only for the guaranteed block: live lane steps are asked for first, then live side quests, then whatever is past its date, and an early touch is only for a deadline still coming (PLAN.md behaviour 4 amended). Every text line of a stop can break. The loopback check guards real data only. The reviewer's last word: fit to show on real data, with the server bound to the loopback address. Checked on the rebuilt page: a 340 character link wraps inside its card, and a foreign Host header gets the not-found page with no data.
- **The calendar engine is committed** (`b2af919`): `app/lib/v2/calendar`, 166 tests, reviewed twice, imported by nothing. What it still owes before a screen uses it is in PLAN.md under Known open edges.
- **A new direction from the owner: the app as an OS of windows, with the Google calendar back as an editable window.** Nothing of it is wired into the product. What exists: research and audit notes, a concept, five clickable prototypes and an architecture plan (all outside git), and one pure engine in the tree, `app/lib/v2/calendar` (week grid layout, edits as data, a port with a fake behind it), which nothing imports yet. The direction waits for the owner's decisions.

- **The owner chose tiled panes with tabs.** `PLAN-OS.md` is the active plan, with its own ledger. Stage 1 is his literal first ask, a read only week calendar beside Today. The tiled shell is not in that plan and is not started without his yes.
- **Stage 1 is built, on sample data and on a local copy.** The calendar's data and view model, with one gate that every v2 page goes through (`76d1580`, `b46948f`); the pane, its place as a fourth track on the Today page from 1760 px, and `/v2/week` (`5aef278`, `b7027b5`). It sizes itself by its own width: an agenda under 480 px, three days from 480, seven from 760. It imports only the types and grid halves of the calendar engine and never fetches. What the app planned is drawn dashed, so it cannot be mistaken for what is on the calendar. A day the source does not cover says so and is never drawn as free.
- **The gate test reads the code's structure** (`bedf42c`, `ed96a88`, `c6422b1`). The first version matched text and a comment could satisfy it. After four review rounds it parses each route file with the TypeScript compiler: the entry is synchronous and starts no read, every read sits behind a plain awaited loopback check in the same function, a loader reached through a wrapper or rendered as an imported component counts, and `process` is refused outside the gate's own argument.
- **The tile engine is committed and unwired** (`a2fef4e`, `6e4d446`): `app/lib/v2/tiles`, a split tree with tabs, its geometry, six default arrangements over two screen classes, and a tolerant parser for the saved form. 161 tests, among them a seeded run of 400 operations from each default. One rule came out of its review: what is focused can always be seen.
- **Two defects that no test saw, found by building and by looking.** The plan named a file `layout.ts` under `app/lib`, which Next reads as a route layout: the build failed while the type check and every test passed. And the first render on real data drew every event from its own day to the right edge of the grid. Both are fixed and each now has a test that fails on it. See Known traps.

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
| Colour fixes and the full-width desktop page, `434d355` | 0 errors, 2 warnings | 2935 of 2935 (121 files) | ok, placeholder env |
| After the review of the full-width page, `b1b8633` | 0 errors, 2 warnings | 2941 of 2941 (121 files) | ok, placeholder env |
| After the whole-range review and its two fix rounds, with the calendar engine, `c00ec02` | 0 errors, 2 warnings | 3163 of 3163 (124 files) | ok, placeholder env |
| Stage 1 of the windowed screen and the tile engine, `b7027b5` | 0 errors, 2 warnings | 3636 of 3636 (134 files) | ok, placeholder env |

### Known traps

- Runtimes carry different versions of the time-zone database and can disagree about a zone whose rules changed recently. Never assert a particular zone's offset for a recent date in a test, and never compute local time in SQL. Tests use `UTC`, `America/Phoenix`, `Asia/Tokyo` and `America/New_York`.
- `utils/google/calendar.ts` throws a generic error when a token refresh fails and discards Google's error code. Task 6 fixes that.
- `next build` needs placeholder env values (see `PLAN.md`). It does not need real ones.
- The code reads `GOOGLE_CLIENT_SECRET`. A local env file that names that value differently can never refresh a Google token.
- Do not assume Docker, the Supabase CLI or `pg_dump` exist where this runs. Migrations are rehearsed in an in-memory Postgres (Task 9).
- Several agents share this folder during a wave. They do not commit and they run only their own tests. Commit by explicit path, never `git add -A`.
- `next dev` and `next start` listen on every network interface unless told otherwise. Local mode and sample mode show their data to whoever can reach the server, so always start them with `-H 127.0.0.1`. A review found the real-data page reachable from the local network for about three hours on 2026-11-10 because of this.
- A file under `app/` named like a route file (`layout.ts`, `page.ts`, `route.ts`, `icon.ts` and the rest) is a route to Next even inside `app/lib`. The type check reads generated route types that only a build or `npx next typegen` refreshes, so it stays green on a stale tree while the build fails. Run a real build before a task is called done. `__tests__/v2-reserved-filenames.test.ts` guards the names.
- An absolutely positioned child of a CSS grid, placed with a single `grid-column` line, runs to the container's edge: an end line left to `auto` is the grid's padding edge, not one track. Tests that read markup and stylesheet text cannot see layout. Render a screen at the owner's width before calling it done.
