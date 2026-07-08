# Mindboard landing page + Football-Manager-style onboarding

Kickoff plan, drafted 2026-07-08. Two tracks that ship independently: a
from-scratch **landing page** (the logged-out `/`) and an in-app **onboarding
system** (first-run overview + per-section tours, saved forever, replayable
via a `?` icon). Implementation logs append below as milestones ship, in the
`docs/second-brain-plan.md` convention.

## Vision

Mindboard has become a second brain — tasks, calendar, money, shelf, copilot,
notes vault, courses — but it still greets strangers with a theme picker and
greets its owner with nothing at all. Two fixes, one voice:

1. **The landing page is the pitch.** Not a SaaS grid of feature cards — a
   page that *behaves like the product*: a terminal that boots, a demo board
   that runs itself, sections that demonstrate instead of describe.
2. **The onboarding is the product introducing itself, in place.** Football
   Manager model: one general overview up front that maps the app and returns
   you home, then an in-depth tour of each section the first time you actually
   walk into it. Finish a tour once, never see it again — unless you tap the
   small `?` in the corner.

**The voice (both tracks):** casual, lowercase, first person — the board talks
as *the part of your mind that doesn't forget*. Never corporate, never
"unlock productivity". Sample register: *"hey. i'm your board. you drop it,
i hold it."* All onboarding/landing copy is written in this voice; copy blocks
below are the actual draft copy, not placeholders.

## Locked decisions

1. **No new dependencies.** Everything is hand-rolled Tailwind + React
   built-ins + CSS keyframes + `IntersectionObserver`. No framer-motion, no
   tour library (react-joyride etc. are exactly what the project rules
   prohibit, and the fixed bottom Dock breaks every off-the-shelf positioner
   anyway).
2. **Tour completion is server-persisted** (new migration `0025_onboarding.sql`)
   so the PWA on the phone and the desktop browser agree. localStorage is only
   a render-guard mirror, never the source of truth.
3. **Tours anchor to chrome, never to data rows.** A brand-new account has
   zero tasks/accounts/items; every step must land on something that exists on
   an empty account (the capture bar, the vitals strip, a section header, an
   empty-state card). Anchors are `data-tour="…"` attributes; a missing anchor
   degrades to a centered card, never a crash or a mis-pointed arrow.
4. **`prefers-reduced-motion` is a first-class code path** on both tracks:
   landing animations collapse to their final frame; tour transitions become
   instant swaps.
5. **The existing dark/cream "pick a side" moment survives** — it was the one
   charming thing about the old get-started screen. It becomes a section *of*
   the new landing page (live theme flip), and still sets the pre-login theme
   via `setActiveTheme`.
6. **Existing user included:** the migration leaves `completed_tours` empty,
   so the owner sees the intro + tours exactly once, like any new user (and is
   the de-facto QA pass). No grandfathering flag.

---

# Track L — the landing page

Replaces `GetStartedScreen` as the logged-out `/`. One long, scroll-driven,
self-contained page. Concept name: **"the board wakes up."**

## L-concept, top to bottom

### 1. Boot (hero)

Black screen (`bg-page`), one blinking block cursor. It types, terminal-style
(~24 chars/sec, staggered lines, each line settles muted):

```
> where did i put my life?

searching…
  4 tasks due · 1 overdue
  rent hits friday · balance survives: yes
  milk: 2 days left
  free today: 14:00–17:30
  that idea you had in the shower: saved

found it.
```

Then the headline resolves in `text-fg` with the accent underline sweep:

**mindboard** — *a board for your mind.*

CTA: `get started →` (accent block button, same as today) + a quiet
`continue with google` secondary right below — both go to `/login`. A slow
pulsing `▼ scroll` hint at the bottom edge.

The boot sequence is the emotional pitch: the problem (*where did i put my
life*) and the answer (a mind that already knows) in five seconds. Reduced
motion: all lines pre-rendered, cursor static.

### 2. The self-driving board

A miniature fake dashboard (a stylized card, phone-proportioned on mobile,
wider on desktop) that **runs itself on a loop**, driven by a `setInterval`
script over hardcoded demo state — no Supabase, no network:

- a fake capture bar types `buy milk today`, chips light up (`today`), the
  task pops into the list above
- the task `call the landlord` gets checked; strikethrough, slides down
- the bar types `$4.50 coffee` → the mode hint flips to *log spend*, a tiny
  balance in the corner ticks down with a rolling-digit animation
- the bar types `gym mon/wed/fri 17:00` → `↻ mon/wed/fri` and `⌚ 17:00`
  chips assemble themselves out of the text
- a calendar chip drags itself one column right; the milk bar in a tiny
  inventory strip shortens; loop resets with a soft fade

Caption under it, in-voice: *"you type like you think. i sort out what you
meant."* This section demos the capture grammar — the app's single best
interaction — without a word of explanation. Reduced motion: a static
composed frame of the same scene.

### 3. Section scrollytelling — "what i hold"

One full-viewport-ish panel per domain, revealed by `IntersectionObserver`
(fade + 12px rise; instant when reduced motion). Each panel: the section's
Dock glyph rendered huge and ghosted in the background (`◆ ▦ ◇ $ ▤ ✦ ⌘`),
a two-line in-voice caption, and a small looping CSS vignette:

| panel | copy (draft) | vignette |
|---|---|---|
| ◆ now | *"one scroll of today. what's due, what's on the calendar, whether the money's fine. you'll start most days here."* | three stream rows cascade in, one ticks itself done |
| ▦ week | *"seven days on one screen. drag things around until the week looks survivable."* | a chip slides between two columns on repeat |
| ◇ plan | *"we talk here. i've read the whole board, so ask me about your own life."* | a chat bubble types, a proposal card stamps `✓ confirmed` |
| $ money | *"no bank hookup, no jump-scares. you tell me what happened; i keep the ledger and forecast where the balance lands."* | a sparkline draws itself left-to-right, dips at `rent`, recovers at `payday` |
| ▤ stock | *"the shelf. what you have and when it runs out — milk becomes a plan, not a crisis."* | item bars deplete at different rates; one flashes `buy by thu` |
| ✦ brain | *"notes that link to each other like thoughts do. drop an idea from anywhere; it's there forever."* | dots connect into a tiny constellation graph |
| ⌘ learn | *"feed me your lecture pdfs. get back study notes — and a two-host podcast about them."* | an audio waveform pulses between two speaker glyphs |

### 4. Pick a side (theme flip)

The dark/cream moment, upgraded: a full-width panel split in half exactly
like the old screen, but tapping a side **re-themes the entire landing page
live** (swap the `theme-*` class on `<html>` — infrastructure already
exists). Copy: *"your mind, your light. (you can repaint every pixel later.)"*
Persists the choice for `/login` and beyond, same as today.

### 5. Close

Full-viewport, near-empty, centered:

> *"this is your mind. give it a board."*
>
> `continue with google →`

Plus a one-line footer: *built for one person at a time · installs to your
home screen* — the honest positioning (personal tool, PWA), and quietly
different from every multi-tenant landing page.

## L-implementation

- `app/_components/landing/landing.tsx` — the page shell (client), imported by
  `app/page.tsx` in place of `GetStartedScreen` (which gets deleted).
- `app/_components/landing/boot-hero.tsx`, `demo-board.tsx`,
  `section-panels.tsx`, `theme-split.tsx`, `close-cta.tsx`.
- `app/_components/landing/use-typewriter.ts` + `use-in-view.ts` — the only
  two hooks; both ~30 lines, both respect `prefers-reduced-motion` via
  `matchMedia`.
- Demo-board loop state is a pure script array (`demo-script.ts`) consumed by
  a `useEffect` interval — testable-by-inspection, no timing logic in JSX.
- Keyframes go in `app/globals.css` under a `/* landing */` block using theme
  tokens (`var(--accent)` etc.) so the live theme flip recolors animations.
- No images, no fonts beyond Geist Mono, zero network calls while logged out.
- Lighthouse guard: everything below the hero lazy-mounts via `use-in-view`,
  so first paint is the boot sequence and nothing else.

---

# Track O — onboarding (the Football Manager model)

## O-flow

1. **First login ever** → dashboard mounts → the **intro** auto-opens: a
   full-screen card carousel (not anchored coach-marks — it describes sections
   that aren't on screen). One card per section, swipe/arrow through, skippable
   at every step. Finishing (or skipping) marks `intro` complete and returns
   you to the dashboard, per the FM model.
2. The intro's last card offers a choice: *"want the tour of this screen, or
   just poke around?"* — `show me` starts the `now` tour immediately;
   `i'll wander` closes. Either way the intro never auto-opens again.
3. **First visit to any section** (`now`, `week`, `plan`, `money`, `stock`,
   `tasks`, `brain`, `learn`) with that tour incomplete → its in-depth tour
   auto-starts after a ~600ms settle delay (let the page paint first).
4. A tour is marked complete when the user reaches the last step **or skips**
   — a skip is a completion (FM behavior: dismissed = never again). Replay is
   always available from `?`.
5. **The `?` icon**: a fixed 44px circled `?` in the **top-right** corner
   (bottom corners belong to the Dock), `text-muted`, opacity ~60%, visible on
   every tour-having page when its tour is complete. Tap → on most pages,
   restarts that page's tour; on the dashboard, a two-item mini-popover:
   *"tour this screen"* / *"replay the full intro"*.

## O-data

`supabase/migrations/0025_onboarding.sql`:

```sql
alter table public.user_settings
  add column completed_tours jsonb not null default '{}'::jsonb;
```

A map of tour key → completed-at ISO timestamp (timestamps make "reset tours"
debugging and any future "what's new since" logic free). One row per user
already exists and is already read app-wide; no new table, no new RLS.

Server actions (`app/actions/onboarding.ts`):

- `completeTour(key)` — validates the key against the catalog, merges
  `{ [key]: now }` into the jsonb. Fire-and-forget from the client (optimistic
  local state means a lost write costs one re-shown tour, nothing worse).
- `resetTours()` — wipes the map; wired to a small "replay all tours" row in
  `/settings` (nice-to-have, M3).

## O-architecture

The dock-mount pattern, mirrored:

- `app/_components/onboarding/tour-mount.tsx` — server shell in
  `app/layout.tsx` next to `DockMount`: resolves the user, reads
  `completed_tours`, renders nothing when logged out.
- `app/_components/onboarding/tour-provider.tsx` — client context holding
  `{ completed, markComplete, activeTour, startTour }`. On `usePathname()`
  change, maps route → tour key (`/` → `now`, `/finance` → `money`,
  `/finance/setup` → `money`, `/brain/*` → `brain`, …), auto-starts if
  incomplete. Also renders the `?` button and the overlay.
- `app/_components/onboarding/tours.ts` — the **catalog**: typed
  `Record<TourKey, TourStep[]>`, where a step is
  `{ anchor?: string; title: string; body: string; placement?: "top"|"bottom"; interactive?: boolean }`.
  Pure data, no components — copy edits never touch logic.
- `app/_components/onboarding/tour-overlay.tsx` — the coach-mark renderer:
  - Spotlight via the **box-shadow cutout** trick: one absolutely-positioned
    div matched to the anchor's `getBoundingClientRect()` (+8px padding, 4px
    radius) with `box-shadow: 0 0 0 100vmax rgba(0,0,0,.72)` — one element,
    no SVG mask, animates between steps with a CSS transition on
    top/left/width/height (instant under reduced motion).
  - The copy card: on **mobile, a bottom-anchored sheet** sitting *above* the
    Dock (the Dock stays visible — several steps point at it); on desktop, a
    popover placed by simple above/below-midpoint logic. Card = step counter
    (`2/6`), title, body, `back · next · skip tour`, all ≥44px targets.
  - Anchored steps `scrollIntoView({ block: "center" })` before spotlighting;
    anchor missing → centered un-anchored card (decision 3).
  - `interactive: true` steps leave the anchor's pointer-events live (for
    "try typing in the bar" moments); all other steps block the page.
- `app/_components/onboarding/intro-carousel.tsx` — the first-run overview:
  full-screen `bg-page` takeover, one card per section (glyph huge and
  ghosted, in-voice copy, dot progress), swipe via touch + arrow keys.
- `app/_components/onboarding/tour-geometry.ts` — pure helpers (spotlight
  rect math, placement pick, step-advance reducer) — **unit-tested** under
  `__tests__/`, keeping the repo's pure-logic-gets-tests convention.
- Anchor stamps: `data-tour="capture-input"`, `"capture-chips"`,
  `"dock-rail"`, `"dock-more"`, `"vitals"`, `"stream"`, `"calendar-pane"`,
  `"week-grid"`, `"plan-input"`, `"accounts"`, `"finance-calendar"`,
  `"omnibox"`, `"shelf"`, `"brain-graph"`, `"courses"` — one-line, inert
  additions to existing components; the full list is finalized per-tour
  during implementation.

## O-catalog (tours + draft copy)

Copy samples are the register to hold, not final-final wording. Everything
lowercase, the board speaking as your mind.

### `intro` — the overview carousel (~9 cards)

1. *"hey. i'm your board."* — *"i'm the part of your mind that doesn't
   forget. tasks, money, the stuff on your shelves, half-formed ideas — you
   drop it, i hold it. quick map, then you're free."*
2. ◆ **now** — *"one scroll of today. due tasks, calendar, whether the money's
   fine. you'll start most days here."*
3. ▦ **week** — *"seven days at a glance. drag things around until the week
   looks survivable."*
4. ◇ **plan** — *"where we talk. i've read this whole board, so you can ask me
   about your own life. i never change anything without showing you first."*
5. $ **money** — *"your ledger and a forecast of where the balance is headed.
   no bank hookup — you tell me what happened, i do the math."*
6. ▤ **stock** — *"the shelf. what you have, and when you'll run out of it.
   milk becomes a plan, not a crisis."*
7. ≡ **more** — *"under 'more': every task list, a notes vault that links like
   thoughts do (brain), and a study corner that turns lecture pdfs into
   podcasts (learn)."*
8. **the bar** — *"the most important thing on every screen is the bar at the
   bottom. tasks, spends, questions — it speaks all three. i'll show you on
   the next screen."*
9. *"that's the map."* — *"everything else i'll show you in place, the first
   time you walk in. want the tour of this screen, or just poke around?"* →
   `show me` / `i'll wander`

### `now` (~6 steps)

vitals strip (*"your vitals. money, tasks, next event, the shelf — if
something needs you today, it's lit up here"*) → the stream (*"today, in
order. tasks mix with calendar events so you see the actual day, not two
lists"*) → calendar pane / month-week (*"the wide view lives on the right;
on your phone it's below"*) → capture bar **interactive** (*"try it. type
`buy milk today` and hit enter — watch the chips"*) → capture grammar
(*"i also read `$4.50 coffee` as a spend and `? what should i do` as a
question. one bar, three doors"*) → the rail (*"and this rail is the whole
map from anywhere. that's the important stuff — `?` up top replays any of
this"*).

### `money` (~6 steps)

accounts (*"balances live here. update them whenever — i'll work out what
happened in between"*) → ledger (*"every change becomes a row you can edit.
i skip duplicates when you import statements"*) → recurring + income
(*"rent, subscriptions, your shifts — i use these to see the future"*) →
forecast calendar (*"each day = projected end-of-day worth. firm numbers are
real; `~` numbers are me estimating your everyday spend"*) → the day panel
(*"tap a day to see why. the slider pins what you expect to spend"*) →
capture reminder (*"fastest way to log: `$12 lunch` in the bar, from any
screen"*).

### `stock`, `week`, `plan`, `tasks`, `brain`, `learn`

Same shape, 4–6 steps each, one interactive step where natural (stock: the
omnibox `+2 milk`; plan: ask a first question; brain: capture a thought).
Step-by-step specs written at implementation time against the live DOM;
each tour's final step always names the `?` escape hatch.

## O-edge cases

- **Empty accounts:** all anchors are chrome/empty-states (decision 3); tours
  read naturally with zero data because copy never says "this task", it says
  "tasks land here".
- **Mid-tour navigation:** navigating away cancels the active tour *without*
  completing it — it re-offers on next visit. Only `skip tour` / finishing
  completes.
- **The Dock:** mobile tour card renders above it; steps that spotlight Dock
  elements (`capture-input`, `dock-rail`) place the card at the top instead.
- **Keyboard-up on iPhone:** interactive capture step listens to
  `visualViewport` the way the Dock already does, and hides the card while
  typing.
- **MCP/assistant surface:** nothing to do — tours are pure UI; no new agent
  tools.

---

# Milestones

Tracks are independent; O-milestones are sequential, L can land any time.

| # | What | Gate |
|---|---|---|
| **O0** | Migration 0025 + tour engine (provider, overlay, geometry + tests) + `?` button + `now` tour + anchor stamps on dashboard/Dock | fresh account: dashboard tour runs, completes, never re-shows; `?` replays it; works on the phone PWA |
| **O1** | Intro carousel + route→tour auto-start wiring + `money` and `stock` tours | first login: intro → returns home → `show me` chains into the now tour; first visit to `/finance` starts its tour |
| **O2** | Remaining tours (`week`, `plan`, `tasks`, `brain`, `learn`) + copy pass on everything in one sitting (voice consistency) | every rail + more section self-introduces exactly once |
| **O3** | `/settings` "replay all tours" (resetTours) + polish (spotlight transition timing, reduced-motion audit) | |
| **L0** | Landing shell + boot hero + close CTA (replaces GetStartedScreen; theme split ported as-is) | logged-out `/` boots, reads, converts to `/login`; old screen deleted |
| **L1** | Self-driving demo board + section scrollytelling panels | the loop runs clean on an iPhone; reduced-motion shows static frames |
| **L2** | Live theme-flip panel + performance pass (lazy mounts, no CLS) | flipping cream re-colors the whole page including running animations |

Each milestone gates on `npm run lint` / `test` / `build` per the engineering
rules.

# Out of scope

Product tours for individual *features* shipped later (those get one-off
"what's new" treatments, not tours); video or Lottie assets; sound; analytics
on tour completion (single-user app — the owner *is* the funnel); onboarding
checklists/gamification ("complete your profile!"); localizing the copy;
touring `/settings` and `/finance/setup` (self-explanatory forms); demo-data
seeding for new accounts (worth its own conversation if empty-start ever
feels cold).

# Open choices (proceeding with the stated defaults unless redirected)

1. **Intro → now-tour chaining** defaults to *ask* (`show me` / `i'll
   wander`) rather than auto-chaining — two overlays back-to-back with no
   consent feels like a timeshare pitch.
2. **Skip = complete** (FM behavior). The alternative — skip re-offers next
   visit — reads as nagging; `?` already covers regret.
3. The landing page keeps **google login as the only CTA** (no email capture,
   no waitlist theater) — it's a personal tool and the page says so.
