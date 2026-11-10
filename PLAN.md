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
- **New paths only:** `app/lib/v2/**`, `app/api/v2/**`, `app/v2/**`, `__tests__/v2-*.test.ts(x)`, `supabase/migrations/0066_*.sql` and up. Existing files change only where a task names them.
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
   1. An item that closes today gets one `session` block. Length is `deadlineDay.sessionMinutes`, or the candidate's `minutes` when that is smaller. It is placed as late as it can be while ending before the earlier of the closing instant minus the buffer and `latestEnd`, and not starting before `earliestStart`. If that does not fit, it takes the latest free interval before closing that holds at least the floor block.
   2. Any other hard-window item (closing within `hardWindowHours` of `now`) gets one block: a `touch` of `earlyTouch.minutes` while `earlyTouchDone` is false, otherwise a `focus` block of standard length (or `minutes` when smaller). Earliest closing first. These ignore `maxBlocksPerLanePerDay`.
   3. A hard item outside the hard window, closing within `earlyTouch.daysBefore` days, with `earlyTouchDone` false, gets a `touch` block. It counts as a normal block for capacity.
   4. Income: with an `incomeTarget`, mode `normal` or `travel`, weekly hours not yet reached, one `income` block of `incomeTarget.blockMinutes` (shorter when less remains, never under standard length). It is skipped when `capRoomHours` is smaller than the block.
   5. One `focus` block per lane for `step` candidates outside the hard window, earliest closing first, then lowest `energyCost` when energy is low.
   6. `side` candidates by `expiresAt`, soonest first, pinned last. A candidate of 10 minutes or less is a `small` block and uses the `small` capacity.
   7. Gym: when capacity allows, `rules.gym` is set and `gymSessionsDone` is under `perWeek`, one `gym` block, not before `gym.notBefore`.
5. Capacity: steps 1 and 2 are mandatory and are never dropped for capacity, but each uses one unit. Steps 3 to 6 share what is left of `capacity[energy].blocks`. `small` blocks use `capacity[energy].small`.
6. The floor: there is always one block of at least floor length on the top-ranked candidate. If nothing above produced one, add a `floor` block of `blockMinutes.floor`. With no candidates there is no floor block.
7. Modes: `short-night` and `rough-day` keep steps 1 and 6-floor only. `travel` skips the cap and the gym.
8. Placement is earliest fit, except `session` (latest fit) and `gym` (first fit after `notBefore`). A block needs one unbroken interval. No fit means an entry in `dropped` with reason `no-room`. Capacity exhausted means reason `capacity`. Cap means `cap`.
9. Stability: a `planned` block in `existing` whose id is still demanded and whose time is still free keeps its time. Changed starts go in `moved`. Planned blocks that are no longer in the plan go in `removed` with a reason.
10. Block id is `` `${date}:${kind}:${taskId ?? kind}` ``. Output blocks are sorted by start. The same input always gives the same output.

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
6. `slipAsk`: kind `slip`, topic `` `block:${block.id}` ``, dedupe key `` `slip:${block.id}` ``, time-critical, expires `rules.slipDefaultAfterMinutes` after `now`, no reminder. Options in this order: `did` "Did it" (`block.done`, fraction 1), `later` "Later today" (`block.reschedule`, `later-today`), `tomorrow` "Tomorrow" (`block.reschedule`, `tomorrow`), `drop` "Drop" (`block.drop`). Default `later`. Text: `` `Still doing ${block.title}?` ``.
7. `energyAsk`: kind `energy`, topic and dedupe key `` `energy:${date}` ``, time-critical, expires at 12:00 local on `date`, no reminder. Options `low` "Low", `ok` "OK", `good` "Good", each an `energy.set` effect. Default `ok`. Text: `Energy today?`.
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

## Wave 2 (detailed after Wave 1 is reviewed)

### Task 6: Tables, stores and the tick

Migration `0066_v2_engine.sql` (additive, unapplied): plan runs and blocks, asks, signals, feeds and feed runs, alerts, outbound notifications, per-user planner rules, Telegram links with pairing codes, `user_settings.ui_version`, and the new task columns. Store interfaces with in-memory fakes and Supabase implementations. `runTick(userId, now, deps)` composes Tasks 2 to 5. Route handlers: `app/api/v2/cron/tick`, `app/api/v2/telegram/webhook`, `app/api/v2/status`. A change to `utils/google/calendar.ts` so a failed token refresh records Google's error code instead of discarding it.

### Task 7: Today on fixtures, behind the account switch

`app/v2/today` in the new visual system (reference: `docs/rebuild/mockups/prototype.html`, sample data there must not be copied). A pure view-model builder with tests. Fixture mode only when `V2_FIXTURES=1` and not in production.

## Not in this plan

Calendar write-back, the mail sensor, money, quests, classes, the wake routine and the watch each get their own plan after slice 1 ships.
