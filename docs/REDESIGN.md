# Mindboard Redesign — "THE STREAM" (Terminal Calm v2 · SIGNAL)

Full design specification and rationale. Commissioned 2026-07-05 by the owner:
"things are getting too cluttered and it stopped making as much sense as before…
it should feel easy to see what needs to be done, and if there isn't anything to
be done in that moment, then it should be easy to plan (with the AI model in the
app) or schedule what needs to be done."

Owner scope decisions (2026-07-05): full in-app planning copilot (reopens the
old Phase 2, whose schema shipped dormant in migrations 0011–0016); full IA
restructure; an evolved visual language (not just refinement); scheduling deep
enough to create real Google Calendar events (explicitly opening the checkpoint
AGENTS.md had fenced).

This document is the durable record. The per-milestone implementation log lives
in `docs/second-brain-plan.md`. If a binding decision changes mid-build, update
this file in the same commit.

---

## 1. Why — the clutter diagnosis

A six-agent survey of every surface (2026-07-05) found the clutter was not
density but **density without hierarchy of action**:

1. **The same information rendered 2–3× per screen, mostly without an action.**
   Task counts appeared in the vitals tile, the today-list section headers, and
   the calendar cells simultaneously. The vitals strip was entirely read-only —
   two of its five tiles weren't even links. Nothing on the dashboard said
   "do this next."
2. **Configure-once UI occupied prime daily space.** Inventory's AI icon
   generator sat above the daily quantity field; finance accounts always
   rendered five history rows; permanent view toggles topped the item list.
3. **Star navigation with dead-ends.** Every section linked only back to `/`;
   `/inbox` was reachable only through `/groups`; there was no tasks route and
   no calendar route; six look-alike pills crowded the header.
4. **The same pattern implemented N ways.** Four copies of `toDateKey`, three
   month-grid builders with different return types, two primary-button shapes,
   three input styles, different priority editors in capture vs edit.
5. **Mobile scroll burial.** On iPhone, the finance forecast calendar rendered
   below the entire config column; the dashboard calendar below the whole today
   list.
6. **Everything was 2-taps minimum.** The only 1-tap actions in the app were
   task-complete and the inventory steppers.

## 2. North star

Mindboard stops being dashboards you scan and becomes **one ranked queue you
clear**. Home is a single deterministic stream — NOW / NEXT / LATER / LOOSE
ENDS — synthesized from the four existing pure snapshots. Every card states one
fact and carries its one primary action inline; a fact never appears twice on a
screen and never appears before it's actionable. Clearing the stream deposits
you at planning: the empty state *is* the copilot and schedule affordances.
Human commands and AI proposals confirm through one identical ProposalCard into
the one existing audit machine (`ai_audit_log`). Capture never slows down.

Three concepts were generated independently (attention-triage feed / timeline-
as-spine / conversational command deck) and judged through philosophy, mobile-
ergonomics, and engineering-realism lenses. The triage feed won (9/8/8) and is
the chassis; the others contributed grafts listed below.

## 3. Binding decisions

1. **The Dock.** One fixed bottom island, two rows: nav rail on top
   (`◆ NOW · ▦ WEEK · ◇ PLAN · $ MONEY · ▤ STOCK · ≡`, 44px targets, active-tab
   accent tick), capture input on the bottom edge at its exact current pixel
   position. The rail collapses (200ms) when the input focuses or the keyboard
   is visible (`visualViewport`), so navigation never costs keyboard clearance.
   *(Graft from the command-deck concept — judged best-in-class mobile move.)*
2. **Timeline fragments only.** The timeline-as-home concept was killed on
   feasibility, but four fragments survive: free gaps rendered as first-class
   objects (duration label + `plan ◇` chip) in /week; `[schedule ▾]`
   next-3-free-gaps chips on any task; a now-line in /week's today column; the
   pulse line's linked fragments.
3. **Exactly three capture modes.** Bare text = task (unchanged cost; trailing
   date/time/priority parse into removable chips). `$ 12.50 groceries` = spend
   log (double-confirm; finance is never silently written). `? …` = copilot
   handoff to /plan. No other sigils, no search verbs, no nav verbs — parser
   trust is a budget and it's spent on exactly these three.
4. **MONEY and STOCK are rail citizens** (1 tap). The `≡` overflow sheet holds
   Tasks (with inbox badge), Brain, Settings, Audit.
5. **Ranking is objective time-facts only.** NOW membership: task overdue /
   due-time past / event in progress or starting ≤60min / bill landing today /
   run-out today. Priority (`!`) orders within sections, never promotes across
   them — you cannot disagree with "this is overdue." The rule table (§6) is
   published and is the unit-test spec. Snooze (a real due_date/due_time write)
   is the escape hatch on every card. NOW never caps; NEXT/LATER cap at 5 with
   overflow links.
6. **The accent keeps its identity** (`#b5ff3c` on dark) and narrows its meaning
   to exactly one thing: *the next action*. Money-up gets `--positive`. No
   glows, no phosphor effects.
7. **URLs.** `/finance` and `/inventory` keep their URLs (rail labels MONEY /
   STOCK). `/groups`, `/groups/[id]`, `/inbox` permanently redirect into the
   new `/tasks`.
8. **The copilot is a full-screen route (`/plan`) only.** No overlay panel (the
   riskiest `visualViewport` work, cut). A `?` capture navigates there with the
   message already sent.
9. **Task↔event lifecycle.** Completing a task never writes to Google. For
   tasks pushed to Google Calendar, Google's event times win at render (one-way
   truth; Google never writes task truth). Dangling event ids after external
   deletion fail soft.
10. **The settings popover retires** into `/settings`: themes + palette,
    timezone, wake window, Anthropic API key, vault PAT, capture token.

## 4. Information architecture

| Route | Contents |
|---|---|
| `/` | **The Stream** — pulse line + NOW/NEXT/LATER/LOOSE ENDS. The only dashboard. |
| `/week` | week grid (default) + month toggle, free-gap underlay, now-line, drag time-blocking |
| `/plan` | copilot conversation, thread history, read-only goals block, key setup |
| `/tasks` | one task list, group filter chip-rail, group CRUD sheet (absorbs groups + inbox) |
| `/finance` | money, daily loop first; config demoted to `/finance/setup` |
| `/inventory` | stock, attention-sorted by urgency |
| `/brain` | vault viewer + graph (internals untouched), per-note "send to copilot" |
| `/settings` | consolidated settings |

**Mobile navigation** is the Dock (decision 1). **Desktop**: a 200px left rail;
the capture island floats bottom-center (max 720px); at ≥1280px `/` renders the
Stream beside the week component — the two halves of the philosophy side by
side.

## 5. The pulse line

One line at the top of `/`:
`sat jul 05 · 14:32   ▲ +$142 · 3 to clear · 4.2h free · ●●○○○`
Each fragment links ($ → /finance, free hours → /week, dots → daily check-in
sheet). The delta uses `--text-display` — the one big number on the screen.

## 6. The Stream — ranking rules (this table is the test spec)

| Section | Membership (objective facts only) | Order within |
|---|---|---|
| **NOW** (never capped) | task overdue · task due today with due_time past · event in progress or starting ≤60min · bill (recurring expense) landing today · inventory run-out ≤ today | events by start → tasks by priority desc, days-late desc → bills → run-outs |
| **NEXT** (cap 5, `n more →`) | remaining due-today tasks · today's later timed events · items past reorder_threshold · tomorrow's first event | time-anchored by time; untimed tasks by priority desc |
| **LATER** (cap 5, `n more →`) | due ≤7d tasks · next bill ≤7d · run-outs ≤7d · daily-log invite (after wake_end − 2h if today's row empty) | by date asc |
| **LOOSE ENDS** (renders nothing when empty) | inbox count > 0 · stale tasks (created >14d, no due date) · stale active goals (>14d) · pending assistant proposals | fixed order: inbox, stale tasks, goals, proposals |

Data: a new pure `streamSnapshot()` (`app/lib/snapshots/stream.ts`) composing
the four existing snapshots — `scheduleSnapshot` finally reading
`user_settings.wake_start_hour/wake_end_hour/timezone` — plus thin reads for
stale goals, today's `daily_logs` row, and pending `ai_audit_log` proposals.

**Card grammar (strict):** left tick (accent = NOW, hairline elsewhere) ·
domain glyph (`○` task · `▸` event · `◆` money · `◇` stock · `★` goal · `●` log
· `◌` entropy) · one-line fact with `·`-joined meta · one 44px action row,
primary verb first. Tap the fact → the existing edit sheet for that entity.
Swipe right = complete; swipe left = snooze menu. Cards animate out on
resolution — the stream physically shrinks; that is the reward loop.

**Empty state:** `— clear — nothing needs you right now.` with
`[plan tomorrow ◇]` `[open week ▦]` and a dim `▸ next up: …` line.

## 7. The copilot (/plan)

- **Stack:** raw `@anthropic-ai/sdk`; SSE streaming from a route handler;
  manual agentic loop (`messages.stream` → `finalMessage()`, loop on
  `tool_use`, handle `pause_turn`/`refusal`); adaptive thinking; prompt caching
  on the frozen system block. Default model `claude-opus-4-8`, selectable in
  /settings. The key is the owner's own `user_settings.anthropic_api_key`,
  stored AES-256-GCM-encrypted with the server-only `ASSISTANT_KEY_SECRET`,
  decrypted only inside the route handler, never sent to a client, never
  logged.
- **Tools = the MCP catalog re-hosted** with the session (RLS) client and
  `source='assistant'`: reads verbatim (snapshots + list tools); writes are the
  existing `proposeCreateTask` / `proposeCompleteTask` / `proposeLogSpend` plus
  `proposeScheduleTask` and `proposeUpsertGoal`. Validation and audit paths
  unchanged. **Never a write without a tap.**
- **Propose → confirm UI:** every write renders as a **ProposalCard** (dashed
  hairline ghost, accent-wash tint, preview string, `[confirm] [edit] [skip]`)
  — deliberately the same component as capture's `$` confirm: one confirm
  grammar for human and AI. Multi-step plans stack with `[confirm all]`.
  Schedule proposals carry a `[+ gcal]` toggle. Finance proposals double-
  confirm; the copilot can propose `log_spend` only, never balance edits.
- **Fuel:** the system prompt is assembled server-side from live snapshots +
  active `goals` (title/why/horizon/target_date) + the last 7 `daily_logs`, so
  planning weighs a low-energy streak and quiet goals. Goals CRUD is
  conversational; the daily check-in is a human 3-control sheet (mood, energy,
  sleep) writing `daily_logs` directly.
- **First run:** no key → one setup panel (masked paste, test call, save). The
  deterministic app is never gated on a key.

## 8. Scheduling

- **Migration `0018_task_scheduling.sql`:** `tasks` gains `due_time time`,
  `duration_min integer`, `gcal_event_id text`, `gcal_calendar_id text`.
- Capture parses trailing times into a removable `⌚` chip; the date picker
  gains a time row. Untimed tasks behave exactly as before.
- **/week time-blocking:** drag a task chip from the all-day row into the hour
  grid → sets `due_time` (15-min snap, same path as timed-event drag; default
  30min; edge-drag resize sets `duration_min`); drag back clears. Task blocks
  are accent-outlined hollow; Google events solid — owned vs mirrored is
  legible at a glance. Free-gap underlay (accent-wash, interval-merge,
  wake-window-aware) with duration labels and `plan ◇` chips on gaps ≥45min;
  now-line in today's column.
- **`[schedule ▾]`** on any task: the next three free gaps today/tomorrow as
  one-tap chips + `pick on week →`. Scheduling without opening a calendar.
- **Task → real Google event:** `[→ calendar event]` on a time-blocked task
  creates the event (new `createEvent`; the existing `calendar.events` scope
  already permits insert) on the group-linked calendar else primary, stores the
  gcal ids, renders the block solid with `⇅`; subsequent drags PATCH Google via
  the existing `rescheduleEvent`. Human-initiated = direct write;
  copilot-initiated = proposal.

## 9. Capture

The contract is untouchable: fixed bottom island, same input position, focus
retained after submit, sticky date/group chips, optimistic insert, iOS
Shortcuts route. Evolutions: the three modes (decision 3), parse chips under
the input (tap to cycle/clear; Enter commits what the chips say), `$` flow
pinning into a ProposalCard with a second Enter to commit, time chips.
`parseCapture()` is pure and table-driven-tested. Category fuzzy-match only
ever *suggests* — never commits silently.

## 10. Visual language — Terminal Calm v2 "SIGNAL"

Still Geist Mono, dark-first, flat, square. The page stops being boxes-of-boxes
and becomes a **ruled ledger**: hairline-separated rows, caps-label section
rulers (`NOW ──── 3`), two elevations, one accent that means *next action*.

**Type scale** (Tailwind theme tokens; weights 400/500 only):

| token | spec | use |
|---|---|---|
| `text-display` | 28/32 · 500 · −0.02em · tabular | the ONE big number per screen |
| `text-title` | 17/24 · 500 | sheet + block titles |
| `text-body` | 15/22 · 400 | card facts, input, transcript |
| `text-action` | 13/20 · 500 · +0.02em | verbs, chips, buttons |
| `text-meta` | 11/16 · 400 · +0.06em | timestamps, deltas, tool traces |
| `text-label` | 10/14 · 500 · +0.14em · caps | section rulers, rail labels |

**Spacing:** 4px base; card padding 12×16; action rows ≥44px; rows hairline-
separated; 32px between modules with the ruler occupying it; gutters 16/24.
Density laws: one fact per line; meta joins with `·`, never a third line; verbs
are text, never icon buttons; **one button recipe and one input recipe**
(`app/_components/ui.tsx`) replacing the drifted 2-button/3-input landscape;
two elevations (`surface-0` page, `surface-1` island/sheets/proposals); 8px top
radius on the island and sheets exclusively.

**Color tokens added** (`globals.css` + `themes.ts`): `--surface-1`,
`--hairline`, `--accent-dim` (32%), `--accent-wash` (12%) — both derived via
`color-mix` so palette overrides propagate — and per-theme `--positive`.
Danger unchanged. All six themes remapped.

**Motion** (`--ease-signal: cubic-bezier(0.2,0,0,1)`; 120/200/280ms). The
exhaustive list of what animates: card resolution (strike 120 → collapse +
fade + 4px drift 280), section-count ticks, sheet rise 200, rail tick slide,
proposal confirm border-flash 300, optimistic-insert wash decay 400, the
copilot cursor `▮`. Nothing else moves. `prefers-reduced-motion` → opacity
only.

**Polish debt paid:** the theme class renders server-side from a cookie (kills
the light-theme FOUC), `theme-color` matches the active theme, every
interactive target ≥44px.

## 11. Section de-cluttering

- **/finance:** display-size net worth + today delta → compact per-account
  strip (history behind `history →`) → `[update balance]` bottom sheet (split
  logic and `money.ts` untouched) → the forecast calendar second, above all
  config → `configure ▸` → `/finance/setup` (recurring, income, categories).
  The 2,742-line client splits along this seam as a pure file-reorg commit
  before any visual change.
- **/inventory:** attention-sorted (out → run-out soonest → low → fine); groups
  become dim inline labels; steppers stay inline; the item sheet inverts
  (quantity + usage rules top, depletion calendar middle, icon/rename bottom
  under `appearance ▸`); add-item collapses to a `+` row.
- **/tasks:** one list + group chip-rail; group CRUD sheet reusing
  ColorPicker/TypePicker/CalendarLinkPicker; existing optimistic patterns.
- **/brain:** internals untouched; reskin; `send to copilot` per note; PAT
  setup moves to /settings.

## 12. Schema

`0018_task_scheduling.sql` is the only new table work. Everything else
activates dormant schema as built: `goals`, `daily_logs`, `ai_conversations`,
`ai_messages`, `user_settings` (timezone, wake window, anthropic_api_key,
capture_token_hash). RLS untouched everywhere. New env:
`ASSISTANT_KEY_SECRET`.

## 13. Milestones

| # | Ships | Done when |
|---|---|---|
| M0 | SIGNAL tokens, primitives, theme cookie SSR, theme-color, reduced motion, this document | zero-FOUC on all 6 themes; no behavior change; green |
| M1 | Dock (rail + capture, collapse-on-focus), /week, /tasks (+redirects), /settings (wake window + tz wired) | keyboard choreography verified on device; every route ≤1 tap away; capture contract intact |
| M2 | streamSnapshot + the Stream replaces `/` | rule table green under Vitest incl. boundary cases; act-from-home works |
| M3 | 0018, time chips, drag time-blocking, gap chips, task→gcal event | capture → block → Google event → drag, all on phone |
| M4 | parseCapture, parse chips, ProposalCard, `$` flow, `?` routing | `$14 lunch` ≤3 interactions, zero silent commits |
| M5 | /plan copilot end-to-end | proposals confirm into ai_audit_log `source='assistant'`; key never client-side |
| M6 | finance/inventory reorg + brain send-to-copilot + polish | daily loop above config on iPhone |

Sequencing note: the button/input recipes land in M0 and are adopted surface-
by-surface as each milestone rebuilds its screens (dock/settings in M1, stream
cards in M2, finance/inventory in M6) rather than as one big-bang restyle — the
end state is identical and each intermediate state stays coherent.

## 14. Not doing

Vault writes or editing UI (read-only stands); pgvector/notes tables (the
vault owns knowledge); Google event deletion/title/attendee sync; renaming live
MCP tools (external contract); framework upgrades; `cacheComponents`.
