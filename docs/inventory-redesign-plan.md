# Inventory Redesign — "The Shelf"

> **Status (2026-07-06):** M1–M4 shipped (migration `0019_inventory_archive.sql`
> applied to the live project; page rebuilt; `list_inventory` + `update_stock`
> live on the MCP server and in-app assistant; omnibox capture on /inventory).
> One deviation from the plan as written: instead of a second fixed bottom bar
> (which would fight the global Dock and its deliberate three-mode capture
> grammar), the stock capture became the page **omnibox** — one field that is
> search + instant structured edits + NL-proposal entry. M5 (inventory_events
> ledger + learned usage) remains deferred.

## The reframe

The current `/inventory` page is a *warning system*: items are sorted by attention
(out → running-out-soonest → low → fine), so the top of the page is always the
stuff you **don't** have. The stated goal is the opposite:

> Keep track of what the user HAS. Don't bother them about what they don't have.

The redesign treats the page as a **shelf** — a calm, accurate picture of what you
own right now — with three deliberate consequences:

1. **Running out is an exit, not an alarm.** When an item hits zero it doesn't
   scream in red at the top of the list; it quietly slides into a small "ran out"
   footer where the only question is *"restock, or stop tracking?"*
2. **Stop-tracking is a first-class, one-tap action** (archive, not delete).
   Today, removing an item means: tap item → open detail → expand "appearance" →
   delete, and it destroys the row. Untracking should be as cheap as ticking off
   a task — and reversible.
3. **The agent is a peer editor.** You tell it what you got and what you used
   ("bought 12 eggs, used up the milk, got 3 rolls of paper towels") — in the
   app or from any MCP client — and it edits stock levels itself through one
   batched propose → confirm receipt.

## What exists today (findings)

- UI: `app/inventory/inventory-client.tsx` — two-pane (list/grid + detail aside),
  optimistic `useOptimistic` dispatchers, `rankedItems` sorts out/low first,
  delete is buried inside the detail panel's `appearance` disclosure. No search,
  no bulk actions, no archive.
- Actions: `app/actions/inventory.ts` — full CRUD, hard delete only.
- Schema: `inventory_items` has no `archived` column; migrations end at `0010`.
- MCP (`app/api/mcp/[transport]/route.ts` + `app/lib/mcp/*`): reads +
  propose → confirm writes with `ai_audit_log` rows exist and work
  (`create_task`, `complete_task`, `log_spend`), but inventory has **only the
  read snapshot** — no list tool (so no ids), no write tools.
- In-app assistant (`app/lib/assistant/tools.ts`, `app/actions/assistant.ts`):
  same propose-only pattern, `confirmProposal` already executes via the shared
  `EXECUTORS` map in `app/lib/mcp/writes.ts` — so one new executor serves both
  the MCP server and the in-app assistant for free.
- Projection math (`app/_components/inventory-projection.ts`) is pure, tested,
  and stays as-is.

## Design principles

- **Have-first ordering.** Default list = what you have, grouped, alphabetical.
  Attention is opt-in: an item only earns a "low" marker if the user set a
  `reorder_threshold` or a usage rule (they declared they care).
- **Zero is a fork in the road.** At 0, an inline strip appears on the row:
  `restock…` (type the new count) / `stop tracking` (archive). If an item sits
  at 0 untouched for 14+ days, a single quiet suggestion row offers to archive
  it — never a modal, never red.
- **Archive over delete.** `stop tracking` archives (hidden everywhere,
  restorable from a collapsed "not tracking · N" section). Hard delete survives
  only inside the archived section, for true mistakes.
- **One confirm per haul.** Agent edits are batched: a grocery run is one
  proposal with a receipt-style preview and one confirm, not five round-trips.

## Milestones

### M1 — Schema: the item lifecycle

`supabase/migrations/0011_inventory_archive.sql` (apply to live project
`kdsunzpcjfzkidejtnyp` via Supabase MCP, per standing preference):

- `inventory_items.archived boolean not null default false`
- `inventory_items.archived_at timestamptz` (null while active; also feeds the
  "long-zero" suggestion logic indirectly)
- `inventory_items.last_restocked_at timestamptz` (set whenever quantity
  increases; powers "sitting at zero since…" and future learned-usage work)
- Partial index `on inventory_items (user_id) where not archived`.

Filter `archived = false` in every reader: `app/inventory/page.tsx`,
`app/lib/data/inventory.ts` (vitals), `app/lib/mcp/reads.ts` (snapshot), and the
assistant's `get_snapshot`. Archived items vanish from vitals and projections —
that *is* the "don't bother me" guarantee.

Actions (`app/actions/inventory.ts`): add `setInventoryItemArchived(id, bool)`;
`updateInventoryItem` stamps `last_restocked_at` when quantity goes up.

### M2 — The page, rebuilt

Rework `app/inventory/inventory-client.tsx` (keep the optimistic-dispatch
architecture, projection imports, icon/appearance code — this is a re-layout,
not a rewrite of the data flow):

**List structure (top → bottom):**
1. **Search/filter field** — instant client-side name filter; doubles as the
   fast path to any item on a phone.
2. **On the shelf** — active items with quantity > 0, grouped by inventory
   group (colored section headers with per-unit totals), alphabetical inside.
   Row = icon · name · quiet `≈ runs out` hint *only when a usage rule or
   threshold exists* · the existing − / count / ＋ steppers (44px targets stay).
3. **Ran out** — collapsed-by-default footer (`ran out · N`): muted rows, each
   with `restock…` (inline number input, sets quantity + `last_restocked_at`)
   and `stop tracking` (archive, optimistic removal with a brief undo).
4. **Suggestion row** (max one): "milk has been at 0 for 3 weeks — stop
   tracking?" → `archive` / `keep`.
5. **Not tracking · N** — collapsed archived section: name + archived date,
   `restore` and `delete forever` per row. This is the only place hard delete
   lives.

**Management ergonomics:**
- **Swipe-to-untrack** on mobile (pointer-based translate on the row, no new
  dependency) revealing `stop tracking`; on desktop the same action appears on
  hover. Removal never requires opening the detail panel again.
- **Select mode** — a `select` toggle next to the existing list/grid toggle
  turns rows into checkboxes with a sticky action bar: `stop tracking` ·
  `move to group` · `delete`. This is the "prune 15 stale items in 20 seconds"
  path.
- Grid view keeps tiles but re-sorts have-first; out tiles fall into the
  "ran out" section rather than mixing in.
- Detail panel: unchanged (calendar, usage rules, notes, icon), except the
  buried delete becomes a visible `stop tracking` button plus
  `delete forever` behind it.

`inventorySnapshot` tweak (`app/lib/snapshots/inventory.ts`): `low` counts only
items with a threshold/usage rule; `out` counts only *non-archived* items — so
the dashboard vitals strip inherits the same calm-by-default stance.

### M3 — Agent stock editing (MCP + in-app, one executor)

New pure module `app/lib/mcp/inventory-ops.ts` (unit-tested): parse/validate a
batch of operations, resolve item names → ids, and render the receipt preview.

**Tool 1 — `list_inventory` (read).** Items with id, name, quantity, unit,
group, archived, thresholds. The agent's source of valid ids.

**Tool 2 — `update_stock` (propose).** One batch, many ops:

```jsonc
{ "operations": [
  { "op": "add",     "item": "eggs",  "amount": 12 },          // got more
  { "op": "remove",  "item": "milk",  "amount": 1 },           // used some
  { "op": "set",     "item": "rice",  "quantity": 0.5 },       // stock-take
  { "op": "create",  "name": "paper towels", "quantity": 3, "unit": "rolls", "group": "household" },
  { "op": "archive", "item": "water filter" },                  // stop tracking
  { "op": "restore", "item": "sunscreen" }                      // track again
]}
```

- `item` accepts an id or a name; resolution is case-insensitive exact → unique
  substring; ambiguity fails the *whole proposal* with the candidate list so
  the model retries precisely. Nothing partial is ever staged.
- Propose validates every op against current rows, records ONE
  `ai_audit_log` row, returns a receipt preview:

  ```
  eggs           6 → 18   (+12)
  milk           1 → 0    (ran out)
  rice           2 → 0.5 kg  (recount)
  paper towels   new · 3 rolls · household
  water filter   stop tracking
  sunscreen      tracking again
  ```
- Executor `executeUpdateStock` joins the shared `EXECUTORS` map in
  `app/lib/mcp/writes.ts`: re-validates against live quantities, applies ops
  sequentially, clamps at 0, stamps `last_restocked_at` on increases, reports
  per-op results. Registered in the MCP route next to the existing write tools;
  `confirm_action` / `cancel_action` work unchanged.

**In-app assistant:** add `list_inventory` + `propose_update_stock` to
`ASSISTANT_TOOLS` and `runAssistantTool` (session client, RLS-scoped).
`confirmProposal` in `app/actions/assistant.ts` already dispatches through
`EXECUTORS`, so the in-app confirm works the moment the executor exists. The
universal `ProposalCard` renders the receipt preview text as-is; a monospaced
multi-line preview is already its natural format.

After this milestone, "hey, I bought groceries — 12 eggs, 2 milks, and we're
out of coffee" works from claude.ai, Claude Desktop, or the in-app assistant,
ending in one tap on a receipt.

### M4 — Stock-check capture on the page itself

Bring the agent to the page: a capture field pinned at the bottom of
`/inventory` (visually the sibling of the task capture bar — same island
styling, same iPhone-PWA reachability):

- **Structured fast path (no AI, instant):** `12 eggs`, `+2 milk`, `-1 rice`,
  `0 coffee` parse locally into ops and apply optimistically through the
  existing dispatchers. Free-form quantity-first grammar, mirroring the task
  bar's chip philosophy.
- **Natural-language path:** anything that doesn't parse (`"back from costco:
  two dozen eggs, big bag of rice, we're out of dish soap"`) goes to a small
  server action that runs one Claude call with the M3 ops schema as forced tool
  output → returns a proposal → the receipt renders inline above the bar →
  confirm applies via the same executor. Propose → confirm is preserved even
  here; the structured path is exempt because the user typed the exact ops
  themselves.

This is also the natural seam for a later voice input (`webkitSpeechRecognition`
→ same NL path) — noted, not scheduled.

### M5 (later, optional) — Learned usage

Add an append-only `inventory_events` ledger (delta, source: user | agent |
capture-bar, occurred_at). Two payoffs, both deferred until wanted:
- **Learned depletion:** infer per-item daily consumption from the decrement
  history instead of hand-configured usage rules — the forecast calendar starts
  working for items the user never set rules on.
- **Provenance:** "what did the agent change last week" becomes a query, and
  per-event undo becomes possible.

## Explicitly out of scope

Barcode scanning, multi-user sharing, editing past events. Any of these reopens
scope with the user first.

**Scope reopened 2026-07-09: shopping list + price tracking.** The user asked
for both, so they shipped as a follow-up milestone: a derived shopping list
(out / low / running-out-soon items plus a stored `shopping_pinned` flag),
AI-looked-up prices (`est_price`/`price_source`/`price_checked_at` — the total for the planned `buy_amount`, added in 0033, since store packs don't map 1:1 to tracked units;
web-search Claude call against `user_settings.shopping_store`; manual edits
always win), `update_stock` ops pin_shopping/unpin_shopping/set_price, the
`shopping_list` + `lookup_prices` tools, and a projected-groceries layer on the
finance forecast (trips snapped to `user_settings.shopping_day`, deducted from
the everyday baseline). Pure logic: `app/_components/shopping-list.ts` and
`app/_components/grocery-forecast.ts`. The same milestone moved ran-out items
inline (quantity 0, greyed icon + ! badge) replacing the "ran out" footer, and
renamed the user-facing feature "stock" → "inventory".

## Verification per milestone

- Unit: `inventory-ops` parse/resolve/preview + snapshot changes under
  `__tests__/` (Vitest).
- `npm run lint && npm run test && npm run build` before each milestone lands.
- M3: exercise `update_stock` end-to-end through the MCP inspector or the
  connected Mindboard MCP server (propose → receipt → confirm → row check).
- M2/M4: drive the page in the browser — stepper to zero → fork strip appears;
  swipe-untrack; select-mode bulk archive; capture bar `12 eggs` round-trip.
