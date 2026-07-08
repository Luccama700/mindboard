# Finance Automation Plan — Statement Import + Forecast Revamp

Status: **implemented** (decisions locked 2026-07-06; Phases 1–3 shipped
2026-07-07 — migration `0022_finance_transactions.sql` applied to the live
project). Phase 4 (drop `balance_after`, vitals integration) remains optional
future work. Implementation notes where reality refined the design:

- Fingerprints are plain composite strings (`YYYY-MM-DD|direction|cents`), not
  sha1 — debuggable, computable in SQL for the backfill, and the account is
  already scoped by the `account_id` column (§3.5).
- The anchor rule gained a same-day tiebreak: a row dated ON `as_of` counts
  against the anchor only if it was *created after* the anchor row. This makes
  a same-day spend logged after a morning balance update move the balance,
  while statement rows imported alongside their reconcile stay inside it.
  Writers therefore insert transactions before their anchor (§3.3).
- The batch tool ended up with a `MAX_FINANCE_OPS` of 60 and the resolver
  enforces op ordering itself: category creates first, reconciles last.
- **The weekday-shaped baseline (decision #2) was revised on 2026-07-07**
  after real statement data exposed a posted-date artifact: banks post
  weekend purchases on Monday (observed live: 120 Monday rows vs 5 Saturday
  rows), so per-weekday medians learned "nothing on weekends, a fortune on
  Monday". The baseline is now a FLAT rate — median *weekly* discretionary
  total over trailing full weeks ÷ 7 — which is immune to which day the bank
  posted and steps over outlier weeks (tuition, rent). The bill filter also
  dropped its ±3-day landing-day requirement (real rent payments posted
  May 19 / May 28 / Jun 29 and slipped past it); amount+category match now
  suffices. In exchange, per-day agency moved to the user: migration 0023's
  `spend_overrides` lets a slider on any future day pin that day's expected
  spend (including $0). `adjust` also gained `markTransfer` for reclassifying
  mis-imported internal transfers.
- **The flat baseline was calibrated down on 2026-07-08**: the everyday layer
  now projects a predicted *minimum* — half the median weekly total
  (`MIN_SPEND_FACTOR = 0.5` in `spend-baseline.ts`). The raw median is a
  typical week (half of real weeks come in under it), and its error profile
  is one-sided — bill payments drifting past the 2% amount tolerance and
  one-off purchases inside otherwise-normal weeks can only inflate it — so it
  read consistently high against lived spending. The factor applies only to
  the history-derived rate; `spend_overrides` pins and the manual
  `daily_spend_estimate` stay face-value.

Two goals, decided with the user:

1. **Automated tracking**: send a screenshot of a bank statement (or account
   screen) to a Claude chat, and Claude uses the Mindboard MCP server to
   register every change — dated transactions, income, transfers, and a
   reconciled ending balance — behind one confirmable receipt.
2. **Forecast revamp**: future days in the cashflow calendar get a *projected
   daily spend* derived from spending history (weekday-aware), falling back to
   a user-set estimate when history is thin — layered on top of the existing
   "certain" recurring bills and wage income.

---

## 1. Research: where the current system fights these goals

### 1.1 The balance-anchored ledger

The finance model today is **balance-first**: the user types a new balance,
`recordBalanceChange` (app/actions/finance.ts) diffs it against the stored
`accounts.balance`, and the delta becomes one or more append-only
`balance_changes` rows, each carrying a running `balance_after`. Because
`balance_after` forms an insertion-ordered chain, amount edits and row deletes
are deliberately forbidden (`updateBalanceChange` only touches
category/date/note).

That design was right for manual entry — one source of truth (the balance the
user just read off their banking app), no drift. But it fights statement
import three ways:

- A statement is a list of **dated** transactions. Backdated inserts make the
  insertion-ordered `balance_after` chain meaningless (re-dating rows via
  `updateBalanceChange` already quietly breaks it today).
- AI-extracted data **will contain mistakes** (OCR misreads, duplicate rows,
  wrong sign). With edits/deletes forbidden, the only correction is an
  offsetting counter-entry — unacceptable noise once imports are the primary
  input path.
- A statement's ending balance is a natural **reconciliation point**; the
  current model has no way to say "as of June 30 this account held $2,410.22"
  independent of replaying every row.

### 1.2 The MCP write surface

The MCP server (app/api/mcp/[transport]/route.ts) already has the finance
reads Claude needs for context — `list_accounts`, `list_categories`,
`list_recent_ledger`, `finance_snapshot` — but only one finance write:
`log_spend` (single spend, today-only, no date, no income, no batch).

The template for the import tool already exists in inventory:
**`update_stock`** (app/lib/mcp/inventory-ops.ts + writes.ts) is a batched
propose → confirm write with:

- pure, unit-tested validation / name-resolution / receipt rendering,
- fuzzy references (id, exact name, unique substring; ambiguity fails with
  candidates),
- resolved ops (ids, not names) stored on the proposal so confirm re-executes
  deterministically,
- a shared executor in `EXECUTORS` used by both MCP `confirm_action` and the
  in-app assistant's `confirmProposal`.

The finance import tool copies this shape wholesale.

### 1.3 The forecast

`buildDayRows` (app/_components/finance-projection.ts) projects future days as
**wage income − recurring bills** and nothing else. Variable spending —
groceries, gas, coffee — is invisible until it's recorded, so the projected
net-worth line always slopes up more optimistically than reality.

One trap discovered during research: **double-counting bills**. The ledger
history *includes* bill payments (the user records them as balance
decreases), and future days *also* project those bills via
`recurring_expenses` rules. Any "average of past daily spend" that includes
bill rows would count each bill twice — once inside the historical average
smeared over every day, once as the projected recurring expense on its
landing day. The baseline must exclude bill-shaped history (§4.2).

A second trap: **transfers**. A credit-card payment shows up on a statement
as an outflow from checking and an inflow to the card. Neither is spending.
Without a first-class marker, imported transfers would inflate the spend
history and poison the daily-spend baseline (§3.4).

---

## 2. Decisions (user-confirmed 2026-07-06)

| # | Question | Decision |
|---|----------|----------|
| 1 | How far does the data-model restructure go? | **Transactions-first.** `balance_changes` becomes a true transaction ledger (dated, editable, deletable). Account balance derives from a reconciliation anchor + later transactions. Existing rows migrate as-is; manual balance updates still work. |
| 2 | Shape of the projected daily spend? | **Weekday-aware.** Per-weekday central value over the last ~8–12 weeks of discretionary spend (bills and transfers excluded). Manual flat fallback when history is thin. |
| 3 | Statement lines with no matching category? | **Claude may propose new categories** inside the same receipt; created on confirm. |
| 4 | Should import detect recurring patterns? | **Yes.** Import may propose new `recurring_expenses` (and flag price changes on existing ones) as separate confirmable lines. |

Standing constraints that still apply (docs/second-brain-plan.md):
assistant/MCP writes are **propose → confirm, never silent**; every write is
audit-logged; finance stays read-safe by default — this plan adds exactly one
new write tool.

---

## 3. Data model restructure (transactions-first)

### 3.1 Principles

- **Keep the table.** `balance_changes` keeps its name and existing rows;
  renaming to `transactions` would churn every reader for zero behavior. Its
  *semantics* change: a row is now a dated transaction, not a link in a
  balance chain.
- **`accounts.balance` becomes a derived cache.** Every reader (finance page,
  vitals, snapshots, MCP reads, net-worth projection) keeps working untouched.
  Every mutation recomputes it.
- **`balance_after` is deprecated**, not dropped: made nullable, no longer
  written, no longer read. A later cleanup migration drops it once nothing
  references it.

### 3.2 Migration `0022_finance_transactions.sql`

```sql
-- balance_changes: from chain link to transaction
alter table balance_changes alter column balance_after drop not null;
alter table balance_changes add column source text not null default 'manual'
  check (source in ('manual', 'import', 'assistant'));
alter table balance_changes add column is_transfer boolean not null default false;
alter table balance_changes add column fingerprint text;
create index balance_changes_fingerprint_idx
  on balance_changes (user_id, account_id, fingerprint);

-- reconciliation anchors: "this account held X at end of day D"
create table account_reconciliations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  balance numeric(12,2) not null,
  as_of date not null,
  source text not null default 'manual'
    check (source in ('manual', 'import', 'assistant')),
  note text,
  created_at timestamptz not null default now()
);
-- + RLS enable and the standard user-scoped policies (never skipped)

-- seed: one anchor per account at today's stored balance, so derivation
-- starts exactly coherent with the pre-migration state
insert into account_reconciliations (user_id, account_id, balance, as_of, source, note)
select user_id, id, balance, current_date, 'manual', 'migration seed'
from accounts;
```

### 3.3 Balance derivation

```
anchor  = latest reconciliation for the account
          (max as_of, ties broken by created_at)
balance = anchor.balance
        + Σ signed(amount) of balance_changes
            where occurred_at > anchor.as_of
```

Rows on the anchor date itself are considered *inside* the anchor (a
statement's ending balance is end-of-day). A pure, unit-tested helper —
`deriveBalance(anchor, changes)` in a new `app/lib/finance/derive.ts` — is
the single place this math lives. A server helper `recomputeAccountBalance`
wraps it (load anchor + later rows → write `accounts.balance`) and is called
by **every** mutation: create/edit/delete of a transaction, and any new
reconciliation.

Consequences:

- **Edits and deletes become legal.** `updateBalanceChange` gains
  amount/direction/account; a new `deleteBalanceChange` action appears. Both
  end with a recompute of the affected account(s). The finance-client ledger
  panel gains amount/delete controls.
- **The manual flow is unchanged in feel.** "Set new balance" in
  `BalanceUpdatePanel` still diffs and writes categorized split rows exactly
  as today — and now *also* stamps a reconciliation anchor at that balance.
  Any unexplained residual drift is absorbed by the anchor instead of
  silently corrupting the chain.
- A backdated import **before** the latest anchor changes history but not the
  current balance — correct, because the anchor already accounted for it (the
  money was already gone when the user last reconciled).

### 3.4 Transfers

No first-class transfer table (scope discipline). Instead: `is_transfer =
true` rows, always uncategorized, written in pairs by the import tool's
`transfer` op (out-row on the source, in-row on the destination, same
date/amount, mirrored notes). Everything that measures *spending* — the
daily-spend baseline (§4), category rollups, `financeSnapshot`'s spend
figures — excludes `is_transfer` rows. Net-worth math keeps them (they cancel
across accounts, and a card payment correctly moves value between a positive
checking balance and a negative credit balance).

**Credit accounts convention** (documented, not enforced): `credit` accounts
store the owed amount as a **negative balance**, so net worth = plain sum
stays honest. On a card statement: purchases are `spend` ops (categorized
`out`, balance goes more negative), payments received are the `transfer` op's
`in` side. The import tool's description teaches Claude this convention.

### 3.5 Dedup fingerprints

`fingerprint = sha1(account_id | occurred_at | direction | cents(amount))` —
deliberately excluding the note, since merchant strings vary between a manual
"coffee" log and a statement's `CARD PURCHASE 7-ELEVEN #2231`. Written on
every new row (manual, import, or assistant) so past manual logs are visible
to future imports. Collisions are *flagged, not blocked* (§5.4): two real
$6.40 coffees on the same day are legitimate.

---

## 4. Forecast revamp: projected daily spend

### 4.1 The layered forecast

Future days become three layers, visually distinct:

| Layer | Source | Certainty | Rendering |
|-------|--------|-----------|-----------|
| wage income | income_sources × calendar shifts | firm | `+$X` accent (as today) |
| recurring bills | recurring_expenses rules | firm | `−$X` danger (as today) |
| everyday spend | weekday baseline (new) | estimate | `~−$X` muted |

All three feed `runningTotal` — an estimate that's known to be an estimate
still beats a forecast that pretends groceries don't exist. The `~` prefix
and muted color keep the epistemic difference readable at a glance.

### 4.2 Baseline math (pure, unit-tested)

New module `app/_components/spend-baseline.ts`:

```
computeWeekdayBaseline(input: {
  changes: HistoryRow[];      // out-rows, last 90 days, is_transfer=false
  recurring: RecurringRule[]; // active rules with category_id
  today: string;
  weeks?: number;             // default 12
}): { byWeekday: number[7]; sampledWeeks: number; confident: boolean }
```

1. **Exclude bill-shaped rows** to prevent double counting: drop any out-row
   that matches an active recurring expense — same category (or the row is
   uncategorized) *and* amount within 2% of `rule.amount` *and* dated within
   ±3 days of a landing day of that rule (`ruleLandsOn` is reused). Everything
   surviving is "discretionary".
2. **Bucket by calendar day** (sum per date), then group dates by weekday.
   Days with *zero* discretionary spend count as explicit `$0` samples —
   omitting them would bias every weekday upward.
3. **Take the median** per weekday over its samples (~12 samples per weekday
   at 12 weeks). The median is what makes the one-off $210 TV purchase not
   replay every Friday forever; it also mops up any bill that slipped past
   the exclusion filter.
4. `confident = sampledWeeks >= 4`. Below that, the baseline reports
   not-confident and the manual fallback takes over.

### 4.3 Manual fallback

A single flat number, stored in the existing `user_settings` table (migration
0011) under key `daily_spend_estimate`. Resolution order per future day:

```
history confident  → byWeekday[weekday(day)]
manual value set   → flat manual value
neither            → $0 + a one-line hint on /finance:
                     "set an expected daily spend to sharpen the forecast"
```

UI: a small inline row in the finance page's left column (near recurring
expenses): `everyday spend · auto (mon $12 … sun $34)` with an `edit`
affordance that switches to a manual dollar input; `auto` reappears once
history is confident. No new page, no modal.

### 4.4 Wiring

- New cached read `getSpendHistory(userId, days = 90)` in
  `app/lib/data/finance.ts` — out-rows only, non-transfer, three columns
  (occurred_at, amount, category_id). Cheap and `cache()`-deduped like its
  siblings.
- `/finance` page computes the baseline server-side and passes a
  `spendEstimate` prop into `FinanceCalendar`.
- `buildDayRows` gains an `estimatedSpendByDate` input and a separate
  `estimatedOutflow` field on `DayRow` (kept apart from `outflow` so the UI
  can render firm vs estimated differently). `runningTotal` for future days
  subtracts it. Today and past days are untouched (actuals only).
- `SelectedDay` shows one extra row on future days:
  `everyday spending · estimated  ~−$X`.
- Existing tests in `__tests__/` extend to cover: exclusion filter, zero-day
  sampling, median behavior, fallback resolution, and `buildDayRows` with the
  new layer.

---

## 5. The MCP import tool: `update_finance`

One batched, propose → confirm write, mirroring `update_stock`'s architecture
exactly. Exposed on both the MCP server and the in-app assistant.

### 5.1 Intended flow (what a session looks like)

1. User drops a statement screenshot into a Claude chat with the Mindboard
   connector; Claude reads the image natively — **no OCR code in Mindboard**.
   The app's job is a great write tool, not vision.
2. Claude calls `list_accounts`, `list_categories`, and `list_recent_ledger`
   (recent window ≥ the statement period) for ids and dedup context.
3. Claude builds **one** `update_finance` batch: spends, incomes, transfers,
   a closing `reconcile`, plus any `create_category` / `create_recurring`
   proposals it derived from the lines.
4. The propose step resolves references, flags duplicates, and returns a
   receipt. Claude shows it; the user approves; `confirm_action` applies the
   whole batch and the app revalidates.

### 5.2 Operations

```
op: "spend"            { account, amount, date, category?, note? }
op: "income"           { account, amount, date, note? }
op: "transfer"         { from, to, amount, date, note? }
op: "reconcile"        { account, balance, asOf }
op: "create_category"  { name, color? }
op: "create_recurring" { name, amount, frequency, dayOfMonth? | weekday?
                         | intervalDays? + startDate?, category? }
op: "adjust"           { changeId, amount? | category? | date? | note? }
op: "remove"           { changeId }
```

- `account` / `category` accept **id or fuzzy name** (exact → unique
  substring, case-insensitive; ambiguity fails listing candidates) — same
  resolver contract as inventory. A `category` naming a `create_category` op
  earlier in the same batch resolves to it (statement import in one shot).
- `adjust` / `remove` are the correction path for earlier import mistakes
  ("that $210 on the 12th was actually $21.00") — they exist because the
  transactions-first restructure makes them legal.
- Batch cap ~50 ops (a monthly statement fits comfortably; `MAX_STOCK_OPS`
  precedent is the pattern, sized up for statements).
- `log_spend` **stays** as the cheap single-spend tool for "I spent $8 on
  lunch" moments; its executor is updated to write `source`/`fingerprint` and
  recompute the derived balance. Its description points statement-sized jobs
  at `update_finance`.

### 5.3 Architecture (mirrors inventory-ops)

- `app/lib/mcp/finance-ops.ts` — **pure and unit-tested**: op validation,
  reference resolution against fetched accounts/categories/recurring rules,
  duplicate detection against fetched recent rows, receipt rendering.
- `proposeUpdateFinanceFor(supabase, userId, raw, options)` in
  `writes.ts` — fetches live rows, resolves, stores **resolved ops** (ids,
  not names) on the proposal, returns the receipt. Shared by MCP (service
  client + owner scoping) and the in-app assistant (session client + RLS).
- `executeUpdateFinance` added to `EXECUTORS` — applies ops sequentially,
  first failure aborts the rest with "applied i of n", then recomputes each
  touched account's balance **once** at the end. `confirm_action` and the
  assistant's `confirmProposal` both route through it, unchanged.
- Everything lands in `ai_audit_log` via the existing `recordProposal` /
  `resolveProposal` path — no new audit machinery.

### 5.4 Duplicate handling

At propose time, each `spend`/`income` op's fingerprint is checked against
existing rows (and earlier ops in the same batch). Matches are **downgraded
to skipped**, kept visible in the receipt:

```
chase checking · import 2026-06-28 → 07-04
  + jun 29  coffee shop          −$6.40   dining
  + jul 01  rent                 −$1,200  housing
  + jul 03  payroll              +$1,834
  ~ jun 30  walmart −$54.10      SKIPPED — matches a logged spend that day
  ⇄ jul 02  → visa card          $250 transfer
  ★ new category "pharmacy"
  ↻ new recurring: netflix $15.49 monthly on the 14th
  ✓ reconcile: ending balance $2,410.22 as of jul 04
```

A per-op `force: true` imports despite the match (two identical coffees are
real). The tool description tells Claude to compare merchants via
`list_recent_ledger` notes before forcing. Ambiguity always errs toward
skipping — a missed duplicate corrupts totals silently; a skipped real
transaction is visible in the receipt and recoverable with one follow-up.

### 5.5 Recurring detection (decision #4)

Detection heuristics live in **Claude's judgment**, not in app code — the
tool just gives it `create_recurring` (and the existing recurring list via a
small read extension: `list_recurring_expenses`, added alongside the task
variant). The tool description instructs Claude to:

- check `list_recurring_expenses` before proposing (no duplicates),
- propose only on real evidence (same merchant + similar amount + regular
  cadence, or an unmistakable subscription line),
- when an existing rule's amount drifts (Netflix price hike), surface it in
  chat as a suggested `adjust`-style follow-up rather than auto-changing it.

Imported bill payments that match an existing rule are still recorded as
normal categorized spends — the §4.2 exclusion filter is what keeps them out
of the daily-spend baseline. Rules remain projection inputs only; they never
write ledger rows. That invariant is untouched.

---

## 6. Alternatives considered (and why not)

- **Additive import on the balance-anchored model** (no restructure): fewer
  moving parts, but `balance_after` becomes wrong for every backdated row and
  AI mistakes can only be countered with offsetting entries. Rejected by
  decision #1 — corrections are a hard requirement once import is primary.
- **A separate `transactions` table beside `balance_changes`**: clean slate,
  but every reader (vitals, snapshots, projections, MCP reads, two calendars)
  would need dual-source merging or a migration anyway. Altering in place is
  strictly less churn.
- **Same-date mirror / flat average for daily spend**: mirror replays
  one-offs and leaves gaps; flat average loses weekly rhythm. Weekday median
  keeps the shape without the ghosts (decision #2).
- **In-app OCR / file-upload import pipeline**: duplicates what the Claude
  client already does better (vision + judgment), and would drag parsing,
  storage, and format-drift maintenance into the app. The MCP boundary keeps
  Mindboard's surface small: *reads for context, one batched confirmable
  write*.
- **First-class transfer entity**: real modeling appeal, but a boolean +
  paired rows covers every current consumer (net worth, spend analytics,
  baseline). Revisit only if transfer-specific UX ever materializes.

## 7. Risks and edge cases

- **Overlapping statements** (June 1–30 then June 15–July 15): fingerprints
  make the overlap skip cleanly; the receipt shows the skips so nothing is
  invisible.
- **Legit same-day same-amount duplicates**: flagged-not-blocked + `force`,
  with note comparison guidance (§5.4).
- **Anchor vs backdated rows**: rows dated ≤ latest anchor deliberately do
  not move the current balance (§3.3). The receipt states this when it
  happens ("recorded as history; balance already reconciled past this date").
- **Baseline poisoning**: transfers excluded by flag; bills excluded by the
  rule-match filter; residual spikes absorbed by the median. Worst case the
  estimate is visibly labeled `~` and user-overridable.
- **Currency**: per-account `currency` already exists; v1 assumes one
  practical currency (as the UI does today). Mixed-currency statements are
  out of scope.
- **balance_after during transition**: nulled going forward, ignored by
  readers after Phase 1, column dropped in a later cleanup migration.

## 8. Phased implementation

Each phase ships independently and leaves the app fully working; `npm run
lint` / `test` / `build` gate every phase.

**Phase 1 — transactions-first foundation.** Migration 0022 (columns,
`account_reconciliations`, RLS, anchor seeding), `deriveBalance` +
`recomputeAccountBalance` (unit-tested), rewire `recordBalanceChange` /
`log_spend` to stamp source/fingerprint + anchor + recompute, extend
`updateBalanceChange` to amounts, add `deleteBalanceChange`, ledger-row
edit/delete UI in finance-client. Deprecate `balance_after` reads.

**Phase 2 — `update_finance` MCP tool.** `finance-ops.ts` (pure:
validate/resolve/dedup/receipt + tests), propose/execute in `writes.ts` +
`EXECUTORS`, register on MCP route and in-app assistant, add
`list_recurring_expenses` read, update `log_spend`/read descriptions to teach
the statement-import flow. End-to-end test with a real statement screenshot.

**Phase 3 — forecast revamp.** `spend-baseline.ts` (+tests),
`getSpendHistory` read, `daily_spend_estimate` setting + inline editor,
`buildDayRows` estimated layer, calendar + selected-day rendering.

**Phase 4 — polish (optional, separate approval).** Drop `balance_after`;
vitals strip "projected spend this week"; recurring price-drift surfacing;
import-history view over `ai_audit_log`.

## 9. Registry / docs follow-through

When implementing: mirror `update_finance` and `list_recurring_expenses` in
`app/lib/agent/registry.ts`, and update AGENTS.md's Finance section (the
balance-anchored description, the "amount edits/deletes are out of scope"
sentence, and the migrations list) — all three go stale the moment Phase 1
lands.
