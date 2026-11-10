# Mindboard v2: Engine and Today (slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The orchestrating session commits after each review. Implementers do not commit and do not push.

**Goal:** A deterministic engine that plans a day, asks one-tap questions and watches its own feeds, plus the first new screen (Today), all built beside the existing app without touching it.

**Architecture:** Pure, unit-tested modules under `app/lib/v2/` that code against the shared contracts in `app/lib/v2/types.ts`. Thin adapters (stores, Telegram, route handlers) sit around them and are tested with in-memory fakes. The core never calls a model and never needs the home PC.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4, Supabase Postgres, Vitest, zod. One new UI dependency is allowed in Task 7: `motion`.

**Spec:** `docs/rebuild/02-design.md`, with decisions in `docs/rebuild/04-decisions.md`. That folder is deliberately outside git (see its README). Read it locally. Never copy names, amounts or schedules from it into tracked files.

`PROGRESS.md` is the running log. Read it first when resuming.

## Global Constraints

- **Never run this app against the production database.** No `next dev`, `next start` or script with a production `.env.local`. Use placeholder env values for builds: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=placeholder-not-a-real-key`.
- Do not read any `.env*` file, `worker/*.env`, or `overnight/.env`. Do not use any MCP data tool. Do not push, merge, deploy or apply a migration.
- **New paths only:** `app/lib/v2/**`, `app/api/v2/**`, `app/v2/**`, `test/migrations/**`, `__tests__/v2-*.test.ts(x)`, `supabase/migrations/0066_*.sql` and up. Existing files change only where a task names them.
- Existing files this plan changes, each for one stated reason and nothing else: `utils/google/calendar.ts` (a failed token refresh reports Google's error code), `app/lib/snapshots/zoned-time.ts` (only if its ISO helper is wrong for an instant with milliseconds), `app/lib/account/export.ts` and its test (the account export must list or exclude every table, so the nine new ones are added), `__tests__/tenant-scope-invariant.test.ts` (it now scans `app/lib/v2`, with one allowlist entry per deliberate cross-account read), and `package.json` with its lockfile (`motion`, and `@electric-sql/pglite` for development only).
- New migrations are written and reviewed, never applied.
- No model call anywhere under `app/lib/v2/**`.
- **Time:** every local time comes from an IANA `timeZone` string through the helpers in `app/lib/snapshots/zoned-time.ts`. No `Date` getters, no `toISOString().slice`, no time-zone math in SQL. Tests must not assert the winter UTC offset of `America/Vancouver` (runtimes disagree about it). Use `UTC`, `America/Phoenix`, `Asia/Tokyo`, and `America/New_York` for daylight-saving edges.
- **Tenancy:** every service-client query filters by `user_id` (`__tests__/tenant-scope-invariant.test.ts` enforces it). Tables the server trusts get no client write policy.
- **Nothing personal in tracked files.** Lanes, wake times, caps and travel rules are data in a per-user `PlannerRules`. Fixtures are fictional.
- **Copy:** plain, direct, sentence case. No em dash and no en dash in any user-facing string. A test enforces it.
- **No streaks, points, XP, levels or penalties** in data or copy. Progress is a rate.
- Defaults that come from the spec: block minutes floor 25, standard 50, long 120. Hard window 72 hours. One block per lane per day, hard-window items exempt. No energy answer means "ok", reported as assumed. Slip default after 30 minutes. Three interrupting messages a day. Watchdog every 10 minutes, escalation after 2 hours and 12 hours.
- Next.js 16 differs from older versions. Read the relevant guide in `node_modules/next/dist/docs/` before writing a route handler or a page.
- A task is done when `npm run lint`, `npm run test` and `npm run build` (placeholder env) all pass.

## Review Focus

1. **A day with no room.** Fixed events fill the day. The plan must contain no overlap, keep the fixed events, and say why each candidate was dropped. (Task 2)
2. **Replanning a day already under way.** Started and done blocks never move. Planned blocks that still fit keep their times. (Task 2)
3. **A double tap or a retried webhook.** The second answer changes nothing and returns the recorded answer. (Task 3, Task 6)
4. **The weekly cap at its edges.** Monday starts the week in the user's zone. A block that would cross the cap is not placed. Exempt ranges lift it. (Task 2)
5. **A feed that ran and produced nothing.** Exit-ok with zero items is a failure once the grace period has passed. (Task 4)

---

### Task 1: Shared contracts

**Files:**
- Create: `app/lib/v2/types.ts` (done by the orchestrator, commit 1)

**Interfaces:**
- Produces: `PlannerRules`, `FixedEvent`, `Candidate`, `Block`, `PlanInput`, `PlanOutput`, `WeekStats`, `Ask`, `AskOption`, `AskEffect`, `Delivery`, `Expectation`, `FeedRun`, `FeedStatus`, `Alert`, `AlertAction`, `OutgoingMessage`, `Incoming`, and the aliases `DateKey`, `Instant`, `WallTime`, `LaneKey`, `Energy`, `PlanMode`.

- [x] **Step 1: Write the contracts.** Every later task imports from this file and does not redefine these names.

---

### Task 2: Planner core

**Files:**
- Create: `app/lib/v2/rules.ts`, `app/lib/v2/plan/day.ts`, `app/lib/v2/plan/rank.ts`, `app/lib/v2/plan/cap.ts`, `app/lib/v2/plan/planner.ts`
- Test: `__tests__/v2-rules.test.ts`, `__tests__/v2-plan-day.test.ts`, `__tests__/v2-plan-rank.test.ts`, `__tests__/v2-plan-cap.test.ts`, `__tests__/v2-planner.test.ts`
- Read first: `app/lib/snapshots/zoned-time.ts`, `app/lib/snapshots/schedule.ts`. For backward placement ideas: `git show origin/task-energy:app/lib/snapshots/gap-plan.ts`.

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `DEFAULT_RULES: PlannerRules` (generic: zone `UTC`, wake `08:00` every day, lights out `23:00`, no focus before `09:00`, buffer 10, capacity low `{blocks:0, small:1, gym:false, social:false}`, ok `{blocks:2, small:0, gym:false, social:false}`, good `{blocks:3, small:0, gym:true, social:true}`, no cap, no income target, no protected windows, no travel, deadline day `{sessionMinutes:180, earliestStart:"17:00", latestEnd:"23:00"}`, early touch `{daysBefore:3, minutes:25}`, no gym, plus the Global Constraints defaults)
  - `parseRules(input: unknown): PlannerRules` (zod, merges over `DEFAULT_RULES`, throws on a malformed `WallTime`, `DateKey` or zone)
  - `dayWindow(date: DateKey, rules: PlannerRules): { startMs: number; endMs: number }`
  - `freeIntervals(date: DateKey, fixed: FixedEvent[], rules: PlannerRules, opts: { fromMs: number; allowProtected: boolean }): Array<{ startMs: number; endMs: number }>`
  - `leaveByFor(fixed: FixedEvent[], rules: PlannerRules): PlanOutput["leaveBy"]`
  - `rankCandidates(candidates: Candidate[], now: Instant, rules: PlannerRules): Array<{ candidate: Candidate; tier: "due-today" | "hard-window" | "lane-step" | "side"; }>`
  - `weekStartKey(date: DateKey): DateKey` (the Monday of that week)
  - `capRoomHours(date: DateKey, fixed: FixedEvent[], week: WeekStats, rules: PlannerRules): number` (`Infinity` with no cap or inside an exempt range)
  - `planDay(input: PlanInput): PlanOutput`

**Behaviour the tests pin (decisions the code cannot guess):**

1. The window runs from the later of `now`, that weekday's wake target and `noFocusBefore`, to lights out. Lights out earlier than `06:00` means the next calendar day.
2. Busy time is every timed fixed event, widened by the first matching travel rule and by `bufferMinutes` on both sides. All-day events are ignored. A protected window is busy for everything except an item that closes today when `unlessDueToday` is true.
3. `existing` blocks in state `started` or `done` stay exactly where they are and count as busy. A task with a `skipped` block today is not planned again today.
4. Demand, in this order:
   1. A hard item that closes today gets one `session` block. Length is `deadlineDay.sessionMinutes`, or the candidate's `minutes` when that is smaller. It is placed as late as it can be while ending before the earlier of the closing instant minus the buffer and `latestEnd`, and not starting before `earliestStart`. If that does not fit, it takes the latest free interval before closing that holds at least the floor block.
   2. Any other hard item inside the hard window (closing within `hardWindowHours` of the reference instant) gets one block: a `touch` of `earlyTouch.minutes` while `earlyTouchDone` is false, otherwise a `focus` block of standard length (or `minutes` when smaller). Earliest closing first. These ignore `maxBlocksPerLanePerDay`.
   3. A hard item outside the hard window, closing within `earlyTouch.daysBefore` days, with `earlyTouchDone` false, gets a `touch` block. It counts as a normal block for capacity.
   4. Income: with an `incomeTarget`, mode `normal` or `travel`, weekly hours not yet reached, one `income` block of `incomeTarget.blockMinutes` (shorter when less remains, never under standard length). It is skipped when `capRoomHours` is smaller than the block.
   5. One `focus` block per lane for `step` candidates outside the hard window, earliest closing first, then lowest `energyCost` when energy is low.
   6. `side` candidates by `expiresAt`, soonest first, pinned last. A candidate of 10 minutes or less is a `small` block and uses the `small` capacity.
   7. Gym: when capacity allows, `rules.gym` is set and `gymSessionsDone` is under `perWeek`, one `gym` block, not before `gym.notBefore`.
5. Capacity: steps 1 and 2 are mandatory and are never dropped for capacity, but each uses one unit. Steps 3 to 6 share what is left of `capacity[energy].blocks`. `small` blocks use `capacity[energy].small`.
6. The floor: there is always one block of at least floor length on the top-ranked candidate, whenever a gap of floor length exists that no mandatory block needs. If nothing above produced one, add a `floor` block of `blockMinutes.floor`, and give it priority over every non-mandatory block: an optional block lower in the ranking never takes the gap the floor needed. A soft dated item (`hard` false) never enters the deadline tiers of step 4; it is ranked by its date inside the normal tiers. With no candidates there is no floor block. A top-ranked candidate whose own `minutes` is under the floor length is served by its own short block and gets no floor block beside it.
7. Modes: `short-night` and `rough-day` keep steps 1 and 6-floor only. `travel` skips the cap and the gym.
8. Placement is earliest fit, except `session` (latest fit) and `gym` (first fit after `notBefore`). A block needs one unbroken interval. No fit means an entry in `dropped` with reason `no-room`. Capacity exhausted means reason `capacity`. Cap means `cap`.
9. Stability. A `planned` block in `existing` whose start is at or before `now` is never moved, re-placed or removed by the planner: it stays exactly as it is, counts as busy until its end, and its task is not planned a second time. Resolving a block that has begun or been missed is the tick's job. A `planned` block that starts after `now`, whose id is still demanded and whose time is still free, keeps its time, even when an earlier slot is open. Changed starts go in `moved`. Planned blocks that are no longer in the plan go in `removed` with a reason.
10. Block id is `` `${date}:${kind}:${taskId ?? kind}` ``. Output blocks are sorted by start. The same input always gives the same output.
11. Ranking is relative to the day being planned. The reference instant is the later of `now` and the start of the planned day's window, on every day, so the answer does not change at midnight and an item that closes on the planned day gets its session. `rankCandidates` keeps its signature: its second argument is that reference instant. Ties are broken by comparing code points, never by a locale-aware compare, because the same input must give the same output in every runtime.

- [ ] **Step 1: Write the failing tests.** One test per numbered behaviour above, named for it, plus: `a day filled with fixed events has no overlap and explains every drop`, `lights out after midnight extends the window into the next day`, `a spring-forward day in America/New_York has a 23-hour clock and a correct window`, `works in UTC, America/Phoenix and Asia/Tokyo`.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run __tests__/v2-plan-day.test.ts __tests__/v2-plan-rank.test.ts __tests__/v2-plan-cap.test.ts __tests__/v2-planner.test.ts __tests__/v2-rules.test.ts`
- [ ] **Step 3: Implement the five modules.** Work in epoch milliseconds internally and convert at the edges with the zoned-time helpers.
- [ ] **Step 4: Run the tests, then the three gates.**

---

### Task 3: Asks

**Files:**
- Create: `app/lib/v2/asks/lifecycle.ts`, `app/lib/v2/asks/policy.ts`, `app/lib/v2/asks/builders.ts`
- Test: `__tests__/v2-asks-lifecycle.test.ts`, `__tests__/v2-asks-policy.test.ts`, `__tests__/v2-asks-builders.test.ts`

**Interfaces:**
- Consumes: Task 1 types. `dayWindow` is not needed: quiet hours are computed from `rules` with the zoned-time helpers.
- Produces:
  - `type AskDraft = Omit<Ask, "id" | "status" | "answeredOptionId" | "answeredAt" | "assumed" | "remindedAt">`
  - `openAsk(draft: AskDraft, open: Ask[], newId: () => string): { ask: Ask; created: boolean }` (an open ask with the same `dedupeKey` is returned unchanged with `created: false`)
  - `class UnknownOptionError extends Error`
  - `answerAsk(ask: Ask, optionId: string, at: Instant): { ask: Ask; changed: boolean; effect: AskEffect }` (an ask that is not `open` returns itself, `changed: false`, effect `{ type: "none" }`)
  - `dueReminders(asks: Ask[], now: Instant): Ask[]` and `markReminded(ask: Ask, at: Instant): Ask` (one reminder at most)
  - `expireDue(asks: Ask[], now: Instant): Array<{ ask: Ask; effect: AskEffect }>` (status `expired`, `assumed: true`, the default option's effect)
  - `interface DeliveryContext { now: Instant; rules: PlannerRules; interruptsSentToday: number; unansweredOnTopicThisWeek: number; weeklyAnswerRate: number | null; roughDay: boolean }`
  - `decideDelivery(ask: Ask, ctx: DeliveryContext): Delivery`
  - `slipAsk(block: Block, userId: string, rules: PlannerRules, now: Instant): AskDraft`
  - `energyAsk(date: DateKey, userId: string, rules: PlannerRules, now: Instant): AskDraft`

**Behaviour the tests pin:**

1. `decideDelivery` returns `hold` inside quiet hours (lights out to that day's wake target), unless `ask.kind` is `night-guard`.
2. Two or more unanswered asks on the same topic this week: `hold`.
3. `roughDay`: `digest` for everything.
4. Not time-critical: `digest`.
5. Time-critical: `interrupt` while `interruptsSentToday` is under the budget, else `digest`. The budget is `rules.interruptsPerDay`, halved and rounded up when `weeklyAnswerRate` is a number under 0.5.
6. `slipAsk`: kind `slip`, topic `` `task:${block.taskId}` `` (or `` `kind:${block.kind}` `` for a block with no task, so the backoff in rule 2 can count across days), dedupe key `` `slip:${block.id}` ``, time-critical, expires `rules.slipDefaultAfterMinutes` after `now`, no reminder. Options in this order: `did` "Did it" (`block.done`, fraction 1), `later` "Later today" (`block.reschedule`, `later-today`), `tomorrow` "Tomorrow" (`block.reschedule`, `tomorrow`), `drop` "Drop" (`block.drop`). Default `later`. Text: `` `Still doing ${block.title}?` ``.
7. `energyAsk`: kind `energy`, topic `energy`, dedupe key `` `energy:${date}` ``, time-critical, expires at 12:00 local on `date`, no reminder. Options `low` "Low", `ok` "OK", `good` "Good", each an `energy.set` effect. Default `ok`. Text: `Energy today?`.
8. `expireDue` never throws. An ask whose default option is missing from its options still expires, marked assumed, with effect `none`: one bad row must not stop an unattended sweep. `dueReminders` skips an ask that is already past `expiresAt`.

- [ ] **Step 1: Write the failing tests**, one per behaviour, plus `answering twice changes nothing the second time`, `an unknown option throws`, `an expired ask applies its default and is marked assumed`, `a reminder is due once and never again`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, then the three gates.**

---

### Task 4: Watchdog

**Files:**
- Create: `app/lib/v2/watch/expectations.ts`, `app/lib/v2/watch/alerts.ts`
- Test: `__tests__/v2-watch-expectations.test.ts`, `__tests__/v2-watch-alerts.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `evaluateFeeds(expectations: Expectation[], runs: FeedRun[], now: Instant, timeZone: string): FeedStatus[]`
  - `planAlerts(statuses: FeedStatus[], open: Alert[], now: Instant, newId: () => string): AlertAction[]`
  - `daysSince(since: Instant, now: Instant, timeZone: string): number` (calendar days in the zone, 0 on the same day)

**Behaviour the tests pin:**

1. A good run is finished, `ok`, with `count >= minCount`. `lastGoodAt` is the newest good run's `finishedAt`.
2. `alive`: a good run within `everyMinutes + graceMinutes` of `now`.
3. Otherwise, if the newest finished run is `error`: `failing`, cause its `errorClass` or `error`.
4. Otherwise, if the newest finished run is `ok` with too few items: `failing`, cause `empty-run`.
5. Otherwise: `late` up to twice the interval plus grace, then `blind`. Cause `no-run`.
6. Outside `activeHours` a feed is never downgraded for lateness. It reports `alive` unless rule 3 or 4 applies.
7. `planAlerts` keeps one open alert per cause. Feeds that are `failing` or `blind` raise alerts, `late` does not. A new cause opens one (step 0, `lastSentAt` null). When the feed list of an open alert changes and nothing else happens to that alert in the same plan, the action is `update` (silent: stored, never sent). The step follows the alert's age: 1 from 2 hours open, 2 from 12 hours, as a single `escalate` action that goes straight to the step the age calls for. A cause with no failing or blind feed left produces `close`.
8. `daysSince` never returns a negative number.

- [ ] **Step 1: Write the failing tests**, one per behaviour, plus `eight feeds with the same error class make one alert`, `a run that finished ok with zero items is a failure after the grace period`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, then the three gates.**

---

### Task 5: Messages and the Telegram adapter

**Files:**
- Create: `app/lib/v2/channel/messages.ts`, `app/lib/v2/channel/telegram.ts`, `app/lib/v2/channel/fake-telegram.ts`
- Test: `__tests__/v2-channel-messages.test.ts`, `__tests__/v2-channel-telegram.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `feedLine(statuses: FeedStatus[], labels: Record<string, string>, sinceLabel: (at: Instant | null) => string): string`
  - `morningMessage(a: { firstFixed: { title: string; time: string; leaveBy: string | null } | null; top: { title: string; time: string } | null; feedLine: string; energyAsk: Ask | null }): OutgoingMessage`
  - `planMessage(a: { energyLabel: string; assumed: boolean; lines: Array<{ time: string; title: string }>; startAsk: Ask | null }): OutgoingMessage`
  - `askMessage(ask: Ask): OutgoingMessage`
  - `replanMessage(a: { moved: number; removed: number; next: { title: string; time: string } | null }): OutgoingMessage`
  - `alertMessage(a: { causeLabel: string; affected: number; days: number; fix: string | null }): OutgoingMessage`
  - `answeredText(ask: Ask): string`
  - `interface TelegramClient { sendMessage(chatId: string, msg: OutgoingMessage): Promise<{ messageId: string }>; answerCallback(callbackId: string, text: string): Promise<void>; replaceButtons(chatId: string, messageId: string, text: string): Promise<void> }`
  - `toSendMessagePayload(chatId: string, msg: OutgoingMessage): Record<string, unknown>`
  - `parseUpdate(update: unknown): Incoming | null`
  - `verifySecret(headerValue: string | null, expected: string): boolean` (constant time, false for an empty expected value)
  - `createTelegramClient(token: string, fetchImpl?: typeof fetch): TelegramClient`
  - `class FakeTelegram implements TelegramClient` with a public `sent` array

**Behaviour the tests pin:**

1. Exact copy. `feedLine` with every feed alive: `All feeds alive.` With one not alive: `` `I can't see ${label} since ${sinceLabel(lastGoodAt)}.` `` With several: `` `${n} feeds are down. Worst: ${label}, since ${sinceLabel(lastGoodAt)}.` ``
2. `morningMessage`: at most three lines (the spec's limit). Line 1 `` `Morning. First thing: ${title} at ${time}, leave by ${leaveBy}.` `` (without the leave-by clause when null, and `Morning. Nothing fixed today.` when there is no fixed event). Line 2, only when there is a top block, `` `Then: ${title} at ${time}.` `` The last line is the feed line. With an `energyAsk`, ` Energy today?` is appended to that same last line and the buttons are that ask's options. In `feedLine`, "worst" is the feed that is not alive with the oldest last good run, and a feed that never had one counts as oldest.
3. `replanMessage`: `` `Moved ${moved}. Next is ${title} at ${time}.` `` With removals, `` ` Dropped ${removed}.` `` is appended. With no next: `Moved ${moved}. Nothing else today.`
4. `alertMessage`: `` `${causeLabel}. ${affected} things affected, day ${days + 1}.` `` followed by the fix on its own line when present. One affected thing reads `1 thing affected`.
5. `planMessage`: line 1 is `` `${energyLabel} day.` ``, or `` `${energyLabel} day, assumed.` `` when `assumed` is true. Then one line per entry, `` `${time} ${title}` ``. With a `startAsk` the buttons are that ask's options.
6. `askMessage`: the text is `ask.text` and the buttons are the ask's options in order. `answeredText`: `` `Got it: ${label}.` `` for an answered ask, `` `No answer, so I went with ${label}.` `` for an assumed one, where `label` is the label of `answeredOptionId` (or of the default option when assumed).
7. No output of any function in `messages.ts` contains U+2014 or U+2013, for every fixture in the test file.
8. Button `callback_data` is `` `a:${askId}:${optionId}` ``. `toSendMessagePayload` throws when one exceeds 64 bytes.
9. `parseUpdate`: a `callback_query` with matching data gives `answer`. A message `/start` or `/start <code>` gives `start`. Any other text message gives `text`. Everything else, including a callback with unknown data, gives `null`. `chatId` is always a string.

- [ ] **Step 1: Write the failing tests**, one per behaviour.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** `createTelegramClient` posts JSON to `https://api.telegram.org/bot${token}/<method>` and throws on a non-ok response without including the token in the message.
- [ ] **Step 4: Run the tests, then the three gates.**

---

## Wave 2

Tasks 6, 8 and 9 own disjoint files and can run side by side. Task 7 needs Task 6. Task 8 needs Task 2.

Environment names used from here on (values live in the host's settings, never in the repo): `V2_CRON_SECRET`, `V2_STATUS_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `V2_FIXTURES`.

### Task 6: Tables and stores

**Files:**
- Create: `supabase/migrations/0066_v2_engine.sql`, `supabase/migrations/0067_v2_tick_schedule.sql`
- Create: `app/lib/v2/store/types.ts`, `app/lib/v2/store/mappers.ts`, `app/lib/v2/store/memory.ts`, `app/lib/v2/store/supabase.ts`
- Test: `__tests__/v2-store-mappers.test.ts`, `__tests__/v2-store-memory.test.ts`, `__tests__/v2-migration-sql.test.ts`
- Modify: the allowlist in `__tests__/tenant-scope-invariant.test.ts`, only for behaviour 9
- Read first: `supabase/migrations/0054_urc.sql` (server-only tables), `0064_same_tenant_fks.sql`, `0065_rls_hardening.sql`, `utils/supabase/service.ts`, and `app/lib/urc/` for how this codebase writes a service-client store

**Interfaces:**
- Consumes: Task 1 types.
- Produces (in `store/types.ts`; you design the method lists, these names are fixed):
  - `interface RulesDocument { planner: Partial<PlannerRules>; lanes: Array<{ key: LaneKey; label: string; color: string; groupIds: string[]; hardDates: boolean }>; feedLabels: Record<string, string> }` (`hardDates` says whether a dated task in that lane is a real deadline; it defaults to false)
  - `interface EngineUser { userId: string; timeZone: string; rules: RulesDocument }`
  - `interface DayRecord { userId: string; date: DateKey; energy: Energy | null; energyAssumed: boolean; mode: PlanMode; plannedAt: Instant | null; morningSentAt: Instant | null; dropped: PlanOutput["dropped"]; leaveBy: PlanOutput["leaveBy"] }`
  - `interface OutboxItem { id: string; userId: string; kind: "morning" | "ask" | "alert" | "note"; dedupeKey: string; delivery: "interrupt" | "digest"; message: OutgoingMessage; askId: string | null; createdAt: Instant; claimedAt: Instant | null; sentAt: Instant | null; chatMessageId: string | null; error: string | null }`
  - `interface ChannelLink { userId: string; chatId: string | null; linkedAt: Instant | null }`
  - `interface Stores { users; days; blocks; asks; outbox; feeds; alerts; channels }`, one small interface per member, every method taking `userId` first except `users.listEnabled()` and `channels.userForChat(chatId)`
  - `createMemoryStores(): Stores` and `createSupabaseStores(client: SupabaseClient): Stores`

**Tables (names fixed, columns follow the Task 1 types):** `v2_rules` (one row per user: the rules document and `enabled boolean not null default false`, the per-account switch), `v2_days`, `v2_blocks`, `v2_asks`, `v2_outbox`, `v2_feed_expectations`, `v2_feed_runs`, `v2_alerts`, `v2_channels`.

**Behaviour the tests and the review pin:**

1. `0066` creates new tables only. It changes no existing table, column, policy or row.
2. Every table has `user_id uuid not null references auth.users (id) on delete cascade` and row level security enabled. `authenticated` may `select` its own rows, written as `(select auth.uid()) = user_id`, on every table except `v2_outbox` and `v2_channels`, which get no policy at all. There is no insert, update or delete policy anywhere: every write is the server's. Grants say the same thing as the policies, because new tables in `public` inherit every privilege for `anon` and `authenticated` by default: each table gets `revoke all ... from anon, authenticated`, then `grant select ... to authenticated` only where a select policy exists.
3. A foreign key to another user-owned table is composite, `(user_id, x_id)` to `(user_id, id)`, as `0064` does (`v2_blocks.task_id` to `tasks`, `v2_outbox.ask_id` to `v2_asks`).
4. Rules that must hold even when two requests race are database facts: `v2_blocks` primary key `(user_id, id)`; `v2_days` primary key `(user_id, date)`; `v2_asks` unique `(user_id, dedupe_key)`, so a key can be asked once, ever; `v2_outbox` unique `(user_id, dedupe_key)`; `v2_alerts` unique `(user_id, cause)` where status is `open`; `v2_channels` unique chat id; `v2_feed_expectations` primary key `(user_id, feed)`.
5. Every text column that mirrors a union in `types.ts` has a check constraint with exactly that union's values.
6. Instants are `timestamptz`. Local dates are `date` columns filled by the app. No time-zone function appears in the SQL.
7. `v2_channels` stores the chat id and, for pairing, a SHA-256 hash of a one-time code with an expiry. Never the code.
8. `0067` schedules the tick: a `pg_cron` job every 10 minutes that calls the tick route with `net.http_post`, reading the URL and the bearer from Supabase Vault (`v2_tick_url`, `v2_cron_secret`). No URL and no secret appear in the file. Both files open with a comment: what it does, that it has NOT been applied, what must exist first, and the statements that remove it.
9. Every Supabase query in `store/supabase.ts` filters on `user_id` or carries it in the payload, so the tenant-scope test passes. The two cross-user reads (`users.listEnabled`, `channels.userForChat`) return ids only and get one allowlist entry each that says why.
10. `mappers.ts` is pure: row to domain and back, validated with zod on read. A malformed row throws `RowShapeError` naming the table and the column. `parseRulesDocument(input: unknown): RulesDocument` lives here.
11. `asks.insert` returns the existing ask with `created: false` when the key exists. `asks.answer(userId, askId, optionId, at)` is one conditional update (`where status = 'open'`) and returns the updated ask, or `null` when it was not open. This is what makes a double tap or a retried webhook harmless.
12. `outbox.enqueue` does nothing when the key exists. `outbox.claim(userId, id, at)` is one conditional update (`where claimed_at is null`) and returns the item or `null`: a message is sent at most once, even with two ticks overlapping.
13. `blocks.replacePlanned(userId, date, blocks)` replaces only rows in state `planned`. Rows in `started`, `done` or `skipped` are never rewritten by a plan. The blocks store can also write a new start and end for one `planned` block, and list a user's blocks from earlier days that are still `planned` or `started`. The asks store counts, per topic, the asks opened since an instant that expired unanswered.
14. `feeds.prune(userId, before)` deletes that user's feed runs older than the instant. Nothing else in the stores deletes.
15. `memory.ts` has the same semantics as the Supabase stores, including 11 to 13, and `v2-store-memory.test.ts` pins them. Engine tests run on it.
16. `v2-migration-sql.test.ts` reads the two files as text and checks: every `create table` is followed by `enable row level security` for that table; no policy for insert, update, delete or all; every new table has its revoke from `anon` and `authenticated`, and the only grant to `authenticated` is `select`; no `at time zone` and no `timezone(`; ASCII only; no `http` literal in `0067`.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Write the migrations, then the mappers, the memory stores and the Supabase stores.**
- [ ] **Step 4: Run your tests, the tenant-scope test (`npx vitest run __tests__/tenant-scope-invariant.test.ts`), eslint on your paths and `npx tsc --noEmit`.**

---

### Task 7: The tick, incoming answers and the routes

**Files:**
- Create: `app/lib/v2/engine/sources.ts`, `app/lib/v2/engine/tick.ts`, `app/lib/v2/engine/incoming.ts`, `app/lib/v2/engine/pairing.ts`, `app/lib/v2/engine/probes.ts`
- Create: `app/api/v2/cron/tick/route.ts`, `app/api/v2/telegram/webhook/route.ts`, `app/api/v2/status/route.ts`
- Modify: `utils/google/calendar.ts` (behaviour 12 only), `app/lib/v2/channel/telegram.ts` (behaviour 13 only)
- Test: `__tests__/v2-engine-sources.test.ts`, `__tests__/v2-engine-tick.test.ts`, `__tests__/v2-engine-incoming.test.ts`, `__tests__/v2-engine-pairing.test.ts`, `__tests__/v2-api-routes.test.ts`
- Read first: `app/api/worker/route.ts` (bearer check, runtime), the route handler guide under `node_modules/next/dist/docs/`, `app/lib/v2/store/types.ts`, `utils/google/calendar.ts`

**Interfaces:**
- Consumes: `planDay`, `parseRules` (Task 2); asks lifecycle, policy and builders (Task 3); `evaluateFeeds`, `planAlerts`, `daysSince` (Task 4); messages, `TelegramClient`, `parseUpdate`, `verifySecret` (Task 5); `Stores` (Task 6).
- Produces:
  - `interface TickDeps { stores: Stores; telegram: TelegramClient | null; loadFixed(userId: string, date: DateKey, user: EngineUser): Promise<{ fixed: FixedEvent[]; calendar: FeedRun }>; loadCandidates(userId: string, user: EngineUser, now: Instant): Promise<Candidate[]>; newId(): string }`
  - `runTick(deps: TickDeps, userId: string, now: Instant): Promise<{ ok: boolean; steps: Record<string, "ok" | "error"> }>`
  - `handleIncoming(deps: TickDeps, incoming: Incoming, now: Instant): Promise<void>`
  - `createPairingCode(stores: Stores, userId: string, now: Instant, random: () => string): Promise<string>` and `redeemPairingCode(stores: Stores, code: string, chatId: string, now: Instant): Promise<string | null>`
  - `tasksToCandidates(rows, user: EngineUser, touchedTaskIds: Set<string>): Candidate[]` and `toFixedEvents(events, timedTasks, capCalendarIds: Set<string>): FixedEvent[]`
  - `SLIP_GRACE_MINUTES = 10`, `ALERT_REOPEN_QUIET_HOURS = 6`, `FEED_RUN_RETENTION_DAYS = 14`

**Behaviour the tests pin:**

1. The tick runs these steps in this order. A step that throws is recorded as `error` and the rest still run. The tick always writes its own feed run (`engine-tick`), `ok` only when every step was.
   1. Expire asks that are due and apply each default effect.
   2. A `started` block whose end has passed becomes `done`. Blocks from earlier days are closed out: still `planned` becomes `skipped` (reason `day ended`), still `started` becomes `done`.
   3. Slips. The planner never moves a `planned` block that has begun, so the tick resolves it. A `planned` block whose start is `SLIP_GRACE_MINUTES` or more in the past: when no ask exists for it, open a slip ask; while its ask is open, wait; when its ask is already resolved (it was moved later once and slipped again), the block becomes `skipped` with reason `slipped twice`.
   4. Plan today with `planDay` and store it with `blocks.replacePlanned`. The plan is recomputed every tick: the planner is deterministic and keeps times that still fit.
   5. Morning, once a day: at or after that weekday's wake target and before 12:00 local, when `morningSentAt` is empty. Open the energy ask unless energy is already set, enqueue the morning message (kind `morning`, key `` `morning:${date}` ``), set `morningSentAt`.
   6. Watchdog: feed runs of the last 48 hours plus the probes, through `evaluateFeeds` and `planAlerts`. Every action is stored. `open` is announced unless an alert for the same cause was announced in the last `ALERT_REOPEN_QUIET_HOURS` hours. `escalate` is announced. `close` is announced only when that alert had been announced. `update` is never announced. An expectation is judged only once it has been enabled for longer than its interval plus grace.
   7. Send: claim and send outbox items with delivery `interrupt`. Nothing is sent inside quiet hours except an ask of kind `night-guard`. A failed send stores a short error class on the item and writes a `telegram` feed run with that class (`bot-blocked` for HTTP 403).
   8. Prune this user's feed runs older than `FEED_RUN_RETENTION_DAYS` days.
2. Asks go through `decideDelivery`, with `unansweredOnTopicThisWeek` taken from the asks store (asks on that topic, opened since Monday in the user's zone, that expired unanswered). `interrupt` is enqueued for sending and counts toward the day's budget. `digest` and `hold` are stored and shown on Today, not pushed. The morning message and alerts do not count toward the budget.
3. With no Telegram link, or `telegram` null, every step still runs, nothing is sent, and the `telegram` feed reads cause `not-linked`.
4. A calendar failure does not stop the plan. `loadFixed` returns what it has plus a `calendar` feed run with the error class, and the tick plans with it. The tick has no cookie session: the production `loadFixed` reads the calendar the way the MCP snapshot does (see `app/lib/snapshots/planning-read.ts`), with the service client and the user id threaded through.
5. `handleIncoming` for an `answer`: find the user for the chat (unknown chat: do nothing). `asks.answer` decides. When it changed: apply the effect, replan, then `answerCallback` with `answeredText` and `replaceButtons` with the original text, a new line, and `answeredText`. When it did not change (second tap, retry): `answerCallback` with the recorded answer and nothing else.
6. Effects: `block.done` sets the block `done`. `block.reschedule later-today` gives the block a new time and leaves it `planned`: the first free interval that holds its length and starts after both `now` and its old end plus the buffer, found with `freeIntervals` and today's other blocks as busy. With no such interval the block becomes `skipped` with reason `no room later today`. The next plan keeps the new time (Task 2, behaviour 9). `block.reschedule tomorrow` and `block.drop` set it `skipped` (reasons `moved to tomorrow`, `dropped`). `energy.set` stores the day's energy as given, not assumed. No effect touches the task row.
7. `handleIncoming` for a `start`: a valid, unexpired code links the chat to that code's user, clears the code, and replies `Linked. I will message you here.` Anything else replies `That code is not valid any more. Make a new one in Mindboard.` Codes are 128 random bits, stored as a SHA-256 hash, valid 15 minutes, single use. A `text` from any chat is ignored in this slice.
8. `tasksToCandidates`: open tasks only. `lane` is the lane whose `groupIds` contains the task's group, else null. `kind` is `step` with a lane, `side` without. `due` is the due date at the due time, or at 23:59 local when there is no time. `hard` is true for a dated task in a lane whose `hardDates` is true. `minutes` is `estimated_minutes`. `earlyTouchDone` is true when the id is in `touchedTaskIds`.
9. `toFixedEvents`: timed calendar events (source `google`, `countsTowardCap` when the calendar id is in `capCalendarIds`), and tasks that have both a due time and a duration (source `task`). All-day events keep `allDay: true`.
10. `POST /api/v2/cron/tick`: bearer `V2_CRON_SECRET`, compared in constant time. 503 when the variable is unset, 401 on a mismatch. It runs the tick for every enabled user, one failing user never stopping the next, and answers `{ users, failed }` and nothing else. `runtime = "nodejs"`, `maxDuration = 60`.
11. `POST /api/v2/telegram/webhook`: the `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET` with `verifySecret`, 401 on a mismatch. After that it always answers 200, whatever the update was. `GET /api/v2/status`: bearer `V2_STATUS_SECRET`, answers `{ ok, lastTickAt, staleMinutes }` across all users, `ok` false when the newest tick is older than 30 minutes. No per-user data.
12. `utils/google/calendar.ts`: when a token refresh fails, the thrown `GoogleCalendarConnectionError` carries Google's error code (`invalid_grant`, `invalid_client` and so on, `unknown` when the body has none) and one line is logged with that code and no token. Existing callers keep working unchanged.
13. `channel/telegram.ts`: requests time out after 10 seconds, errors are a `TelegramError` with `method` and `status` (still never the token), and `toSendMessagePayload` throws on an option id that contains a colon.
14. Probes: `home-worker` reads the newest heartbeat in `worker_status` as a feed run. More probes arrive later.
15. (After review.) An answer or an expiry is committed before its effect is applied, so the slips step must tell two cases apart. A resolved slip ask means `slipped twice` only when the block's start is later than the instant the ask was resolved. Otherwise the effect never landed, and the step re-applies the recorded option's effect.
16. (After review.) The weekly cap fails closed. `TickDeps` has `loadWeekCapHours(userId, weekStart, date, user): Promise<{ hours: number; ok: boolean }>`, the cap-counting hours on the week's other six days. When it cannot be read, no capped block is planned and the `calendar` feed shows the failure.
17. (After review.) The send step never sends a stale item: an ask that is no longer open, a morning message that is not for today or is past 12:00 local, an alert message whose alert is no longer open, a close for an alert that was never announced. Such an item is marked failed with class `stale`. An alert's `lastSentAt` is stamped when its message is sent.
18. (After review.) In the cron route each account's tick has a 20 second deadline, and calendar reads have a 10 second limit, so one slow account cannot starve the next.
19. (After review.) A task that became one of today's fixed events is not a candidate today.

- [ ] **Step 1: Write the failing tests** on the memory stores and `FakeTelegram`, one per behaviour, plus: `two ticks at the same instant send one morning message`, `a retried webhook update changes nothing`, `an answer after the ask expired changes nothing`, `a tick with a failing calendar still plans`, `quiet hours hold an alert until the wake target`. Three of the tests run several ticks in a row on the memory stores with the real `planDay`: `a block in progress is not moved by a tick`, `an ignored slip question moves the block later once and then skips it`, `tapping later today moves the block to a later free slot and the next tick keeps it there`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run your tests, the tenant-scope test, eslint on your paths and `npx tsc --noEmit`.**

---

### Task 8: Today on sample data

**Files:**
- Create: `app/lib/v2/view/today.ts`, `app/lib/v2/view/format.ts`, `app/lib/v2/fixtures/sample-day.ts`
- Create: `app/v2/layout.tsx`, `app/v2/v2.css`, `app/v2/today/page.tsx`, `app/v2/today/today-client.tsx`, and components under `app/v2/_components/`
- Test: `__tests__/v2-view-today.test.ts`, `__tests__/v2-view-format.test.ts`, `__tests__/v2-fixtures.test.ts`
- Read first: `docs/rebuild/mockups/prototype.html` (the approved look and motion; a local file, not in git), the pages and fonts guides under `node_modules/next/dist/docs/`, `app/lib/v2/plan/planner.ts`

**Interfaces:**
- Consumes: Task 1 types, `planDay` and `DEFAULT_RULES` (Task 2), `feedLine` (Task 5).
- Produces:
  - `buildTodayView(input: TodayInput): TodayView` where `TodayInput = { date: DateKey; now: Instant; timeZone: string; plan: PlanOutput; fixed: FixedEvent[]; lanes: Array<{ key: LaneKey; label: string; color: string }>; feeds: FeedStatus[]; feedLabels: Record<string, string>; openAsks: Ask[]; energy: Energy | null }`
  - `TodayView = { dateLabel: string; allDay: string[]; stops: Stop[]; litStopId: string | null; energy: { label: string; assumed: boolean; ask: Ask | null }; notToday: Array<{ title: string; reason: string }>; feed: { line: string; dots: Array<{ label: string; state: FeedStatus["state"] }> }; empty: boolean }`
  - `Stop = { id: string; source: "fixed" | "block"; kind: BlockKind | "fixed"; title: string; start: string; end: string; lane: { label: string; color: string } | null; state: "done" | "skipped" | "past" | "now" | "next" | "later"; leaveBy: string | null; reason: string }`
  - `clockLabel(at: Instant, timeZone: string): string` (24-hour `HH:MM`) and `dayLabel(date: DateKey): string`
  - `sampleDay(): { input: PlanInput; lanes: TodayInput["lanes"]; feeds: FeedStatus[]; feedLabels: Record<string, string> }`

**Behaviour the tests pin:**

1. Stops are the timed fixed events and the blocks, in start order. All-day events go in `allDay`.
2. One stop is lit: the one in progress at `now`, else the next one that has not ended. A `done` or `skipped` block is never lit. Nothing is lit when the day is over.
3. A fixed event with a leave-by time shows it as `Leave by HH:MM`.
4. Energy reads `Low`, `OK` or `Good`, and `OK, assumed` when the plan assumed it. An open energy ask is passed through so the screen can show its three options.
5. `notToday` lists dropped candidates with plain reasons: `no-room` is `No room today`, `capacity` is `Past today's capacity`, `cap` is `Would go over your weekly hours`.
6. `empty` is true with no stops and no all-day events, and the screen then says `Nothing planned. Add a task and it lands here.`
7. No output string of `view/` contains U+2014 or U+2013, for every fixture. No streak, point, level or penalty appears in data or copy.
8. The sample day is fictional (invented titles, six lanes named Study, Work, Money, People, Craft, Body) and is a real `PlanInput`: the screen shows `planDay(sampleDay().input)`, not a hand-written plan.
9. `app/v2/today/page.tsx` renders the sample day when `process.env.V2_FIXTURES === "1"` and `process.env.VERCEL_ENV !== "production"`. In that mode it reads no database and needs no sign-in. In every other case it calls `notFound()`. The live branch is a later task of its own (see "Next after this plan"), because it also has to deal with the old app's chrome around the new screen.
10. On the sample screen the buttons work on local state: Start, Done and Not today change the block and re-run `planDay` in the browser, so a replan is the real planner. Blocks that move animate to their new place (shared layout animation). The energy options replan too.
11. The look follows the prototype: the day as one line of stops, one lit stop as a filled tinted card, no glow. Colour tokens live in `app/v2/v2.css` under `[data-v2-root]` and `app/globals.css` is not edited. Fonts are Chakra Petch for display and Atkinson Hyperlegible for text, loaded with `next/font/google` in `app/v2/layout.tsx`. Motion uses `motion`, with durations 140, 280 and 520 ms, and stops when the system asks for reduced motion.
12. It works at 375 px wide with no sideways scroll, every control is at least 44 px tall, and keyboard focus is visible.

- [ ] **Step 1: Write the failing tests** for the view model, the formatters and the fixtures.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the view model, then the screen.**
- [ ] **Step 4: Run your tests, eslint on your paths and `npx tsc --noEmit`.**

---

### Task 9: Migration rehearsal

**Files:**
- Create: `test/migrations/harness.mjs`, `test/migrations/supabase-stubs.sql`, `test/migrations/seed-two-tenants.sql`, `test/migrations/README.md`
- Test: `__tests__/v2-migrations-apply.test.ts`
- Read first: `supabase/migrations/` (all of it, quickly), `test/isolation/README.md`

**Interfaces:**
- Consumes: `@electric-sql/pglite` (already installed as a dev dependency).
- Produces:
  - `createDatabase(): Promise<PGlite>` (in memory, with the stubs loaded)
  - `listMigrations(dir?: string): string[]` (file names in order)
  - `applyMigrations(db, opts: { from?: string; upTo?: string; skip?: string[] }): Promise<string[]>` (each file in its own transaction; on failure it throws an error naming the file and Postgres's message)
  - a command line: `node test/migrations/harness.mjs --data <export folder> [--from-applied 0055] [--skip 0061]`

**Behaviour the tests pin:**

1. The stubs give the migrations what Supabase gives them and nothing more: the roles `anon`, `authenticated` and `service_role`, an `auth` schema with `users` and `uid()`, a `storage` schema with `buckets`, `objects` and `foldername()`, and `cron`, `net` and `vault` stand-ins that record what they were asked to do. The migration files run unmodified.
2. Every migration from `0001` to `0065` applies in order on an empty database.
3. With `0001` to `0055` applied and a small invented two-tenant data set loaded, `0056` to `0065` apply. This is what catches a new constraint that existing rows would break.
4. The stubs reproduce Supabase's default privileges (new tables in `public` grant everything to `anon`, `authenticated` and `service_role`), so before `0065` `anon` does hold table privileges. After `0065`, and also after the sequence production will really run (`0056` to `0065` without `0061`): every table in `public` has row level security on; `jobs`, `ai_audit_log`, `urc_devices`, `urc_jobs`, `oauth_grants` and `oauth_used_codes` have no policy that lets a client write; `anon` holds no table privilege in `public`.
5. A migration that fails reports its file name. The test for this uses a deliberately broken file in a temporary folder.
6. The command line loads a JSON export (one `<table>.json` per table and `auth-users.json`, as the export tool writes them) after the already-applied migrations, fills columns the export leaves out with a placeholder, applies the rest, and prints one line per migration and the row count of every table before and after. It never prints a row. This mode is for local use on real data and has no test that needs real data. A second mode, `--catalog [--upto 0055] [--names <table>]`, prints per-table fingerprints of constraint and policy names so they can be compared with production's, because the newest migrations address those objects by name.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Write the stubs and the harness.** If something in a migration cannot be made to run in this engine, stop and report which statement and why.
- [ ] **Step 4: Run your test file, eslint on your paths and `npx tsc --noEmit`.**

---

## Next after this plan

- **Live Today.** `app/v2/today/page.tsx` gets its live branch: a signed-in account whose `v2_rules.enabled` is true reads its day through the stores (session client, select-own policies) and the same `buildTodayView`. Start, Done, Not today and the energy options become server actions that go through the same effect code as a Telegram answer. The old app's capture dock and tour buttons must not show on the new screen.
- **More probes.** The morning brief, the diary and the collector each leave a note in the vault. A probe that looks for today's note turns each into a feed the watchdog can judge.
- **The outside check.** A small script in the owner's Google account that reads `/api/v2/status` every 15 minutes and sends an email when it is stale or unreachable.
- **A run against a real database.** `store/supabase.ts` has only ever been type-checked and reviewed. Its first run must be against a staging project or a watched first tick.

## Not in this plan

Calendar write-back, the mail sensor, money, quests, classes, the wake routine and the watch each get their own plan after slice 1 ships.
