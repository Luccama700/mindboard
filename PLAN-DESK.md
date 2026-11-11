# The desk: tiled panes on every screen, with Quests and Money

> **Status: approved by the owner on 2026-11-10** ("build quests and money with subagents, and implement the same desktop/tile feel that we brainstormed earlier, I want this on all screens, we are optimizing for maximum customization"). This plan replaces `PLAN-SHELL.md`.
>
> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One workspace at `/v2/desk` in which Today, Week, Quests and Money are layouts of the same panes, on a big screen, a laptop and a phone, with every pane, every layout and every view option the owner's to arrange and all of it saved.

**Architecture:** The tile engine (`app/lib/v2/tiles`) owns every arrangement: a split tree with tabs per layout and per screen class. Geometry has one formula in two forms tied by a test (numbers for hit testing, CSS lengths so the server can draw a saved layout without knowing the window's size). Every pane body is mounted once and reads its data from two providers: the day (the planner's state, lifted out of the Today client) and the desk's data (`DeskScreenData`: the day, the quests, the money). Quests is handed the very planner input Today plans from, and Money's hours come from it too, so one fact has one number.

**Tech stack:** Next.js 16 App Router, React 19, TypeScript strict, CSS container queries, `clamp()` and `round()`, Vitest. No new dependency.

**Spec:** `docs/rebuild/02-design.md` sections 4 (the quest model) and 6 (the finance pipeline, "What changes on the Money screen"), `docs/rebuild/os/10-brain-os-concept.md` (the window catalogue and the phone's one slot), `docs/rebuild/os/11-motion-language.md`, and the prototype the owner chose, `docs/rebuild/mockups/os-b-tiled.html` with its notes. All outside git. Where they differ from this plan, this plan wins.

## What the owner was told (the calls made for him)

| Call | To change it |
|---|---|
| "All screens" is read as every destination and every window size, the phone included. | Say so. |
| The desk replaces the separate pages. The old Today and Week pages stay at their addresses, untouched, as a fallback. | One redirect. |
| On a phone there is one slot: one pane at a time, switched from the bottom bar. Which panes and in what order is his. No side by side. | A later stage. |
| Quests and Money are read only. They show and sort. | Live data, after the security release. |
| Money shows old numbers and says so before anything else. | Nothing: it is the truth. |
| Quests reads exactly what Today reads. A lane nothing feeds stays quiet. Nothing is invented. | Nothing. |
| No keyboard chords. Every drag has a menu path. | A later stage. |
| Saved in the browser. On the account after the security release. | Stage 4. |

## Global Constraints

Everything in `PLAN.md` "Global Constraints" and `PLAN-OS.md` "Added constraints" binds every task here. In addition:

- **Read only.** Nothing on the desk changes a task, a calendar event or money. The only thing written anywhere is the layout, in the browser's own storage.
- **Never run this app against the production database**, and bind any local server to `127.0.0.1`.
- **One gate.** Every `page.tsx` under `app/v2` has exactly the shape of `app/v2/today/page.tsx`. `__tests__/v2-source.test.ts` walks them. Change the page to satisfy the test, never the test, except for the one pinned list of pages that a task which adds a page is told to update.
- **The engine owns the arrangement.** No component computes, clamps or stores a ratio, a tab order, a focus or a layout of its own. Every change is one engine call.
- **One source of geometry.** A length on screen comes from `cssLayout`. A number used for hit testing comes from `layoutTree` on the measured workspace. No component measures one pane to place another.
- **No remounts.** A pane's body is mounted once and stays mounted through every rearrangement, tab change, maximize, close and change of layout.
- **One fact, one number.** Quests ranks and counts from the planner input Today uses. Money's hours and cap come from that input. No pane recomputes what another pane or the planner already computed.
- **Nothing invented.** A lane with nothing in it shows nothing. A rate is shown only over days the source can see. A money number older than a week leads with how old it is.
- **Nothing personal in tracked files.** Fixtures, test names, comments and plan text are invented. No real account name, amount, task title, course, person or place. The local snapshot folder is outside git and no implementer opens it.
- **The existing screens are untouched in behaviour.** Every existing test of Today, Week and the phone layout passes without being edited, except where a task names the test.
- **No route file names** (`page`, `layout`, `route`, `loading`, `error`, `template`, `default`, `not-found`, the metadata names) for any file that is not a route, under `app/lib`.
- **Colour** comes from a token in `v2.css` or from `identityTokens`. No colour literal outside the defaults block of `v2.css`, no new font. Money uses tabular figures.
- **Motion** uses only `--v2-quick`, `--v2-std`, `--v2-slow`, `--v2-ease`, `--v2-ease-in`, moves only `transform` and `opacity`, and stops under `prefers-reduced-motion`.
- **Every drag has another way** (WCAG 2.5.7).
- **Words** live in copy constants that the no-dash walk reads. No em dash and no en dash anywhere, in strings or comments.
- **A task is not done until** a production build has run with placeholder settings and the controller has looked at what it draws, at the widths the task names.

## Shared files, one owner per wave

| File | Wave 1 | Wave 2 | Wave 3 |
|---|---|---|---|
| `app/v2/v2.css` | Task 5 | Task 9 | Task 10, then 11 |
| `__tests__/v2-source.test.ts` (the pinned set of pages only) | Task 5 | Task 9 | nobody |
| `app/lib/v2/view/today.ts` and the nav copy | nobody | Task 9 | Task 14 |
| `app/lib/v2/tiles/**` | Task 1 (Task 2 creates `css.ts` only) | Task 8 (`codec.ts`, `cookie.ts` only) | Task 13 if needed |
| `app/lib/v2/view/desk-data.ts` and the stubs' signatures | the controller only | the controller only | the controller only |

`__tests__/v2-fixtures.test.ts` and `__tests__/v2-appearance.test.ts` find screen files and stylesheets by walking folders. Nobody registers a file in them.

## The cut order

If the night runs short, cut from the bottom: Task 13 (pane options in the menu), then Task 12 (the heads-up line), then the drag half of Task 11 (the menu stays), then Task 10's layouts of his own (resize, tabs, close and saving stay). Waves 1 and 2 are not cut: a standing desk with four layouts and real panes is the floor.

## Review Focus

What markup tests cannot see, most likely first. Each has a test or a gate in the task that owns it.

1. **A seam between two tasks.** Last stage's real defects were all between tasks. Each wave ends with a seam render by the controller: every pane alone in the gallery at 230, 464 and 1300 px, then the desk at 2000 by 985, 1366 by 768 and 390 by 844.
2. **The first paint with a saved layout is wrong or jumps** (Tasks 8, 9, 10).
3. **A pane body remounts** on a move or a change of layout and loses its scroll or a press (Tasks 9, 10, 11).
4. **A pane drawn very narrow or very wide breaks**, because its styles assumed a column (Tasks 5, 6, 7).
5. **Money states something false with confidence**: a balance or a forecast shown as current when the ledger is months old (Tasks 4, 7).
6. **Focus lands on something hidden**: a background tab, a pane behind a maximized one, a pane of another layout (Tasks 9, 10).

## Already in place (written by the controller, do not change their signatures)

- `app/lib/v2/view/desk-data.ts`: `QuestsScreenData`, `QuestDone`, `MoneyScreenData`, `MoneyAccount`, `MoneyDay`, `MoneyBill`, `MoneyIncome`, `MoneyRow`, `DeskScreenData`.
- `app/lib/v2/fixtures/sample-quests.ts` `sampleQuests(today)`, `sample-money.ts` `sampleMoney(today)`: stubs for Tasks 3 and 4. `sample-desk.ts` `sampleDesk(weekParam)`: complete.
- `app/lib/v2/local/quests.ts` `loadLocalQuests(dir, today)`, `local/money.ts` `loadLocalMoney(dir, today)`: stubs for Tasks 3 and 4. `local/desk.ts` `loadLocalDesk(dir, now, dateParam, weekParam)`: complete. A part whose file cannot be read becomes a note, not an error.
- `app/v2/_desk/pane-body.ts`: `PaneBody`, `PaneBodyProps`.
- `app/v2/_components/quests/quest-panes.tsx` `QUEST_PANE_BODIES` and `app/v2/_components/money/money-panes.tsx` `MONEY_PANE_BODIES`: empty maps for Tasks 6 and 7.

## The panes

Fourteen. `id`, the title on a frame, the short label on a tab and on the phone's bar, the group in the pane list, and the smallest box its content still makes sense in.

| id | Title | Short | Group | Min w by h | What it is |
|---|---|---|---|---|---|
| `today` | The day | Day | day | 320 by 320 | The date, the notice, the energy answer and the line of the day |
| `status` | Status | Status | day | 230 by 150 | What the last press did, the all day row, the feeds, the lanes in one line each |
| `past-due` | Past their date | Past | day | 230 by 150 | Existing list |
| `not-today` | Did not fit today | Did not fit | day | 230 by 150 | Existing list |
| `calendar` | Calendar | Calendar | day | 320 by 300 | The week, read only (stage 1) |
| `lanes` | Lanes | Lanes | quests | 240 by 160 | Every lane with its next stop |
| `steps` | Steps | Steps | quests | 260 by 200 | The open steps of the lanes, in the planner's order |
| `side-quests` | Side quests | Side | quests | 240 by 160 | What belongs to no lane, with its clock |
| `done` | Done lately | Done | quests | 230 by 150 | What was finished, and the rate |
| `forecast` | Forecast | Forecast | money | 320 by 280 | The balance day by day |
| `accounts` | Accounts | Accounts | money | 230 by 150 | What each account holds, and how old that is |
| `coming-up` | Coming up | Coming up | money | 230 by 150 | Bills and pay with a date |
| `hours` | Hours | Hours | money | 230 by 150 | This week's paid hours against the target and the cap |
| `ledger` | Transactions | Recent | money | 260 by 180 | The newest lines of the ledger |

## The layouts

Four built in, in this order: `today` "Today", `week` "Week", `quests` "Quests", `money` "Money". The user can add up to eight of his own.

Default trees. `h r [A | B]` is side by side with A taking share r; `v r [A | B]` is A above B; `tabs(...)` is one leaf, first tab in front. Compact is always one leaf.

| Layout | wide (1600 and up) | regular (1024 to 1599) | compact (under 1024) |
|---|---|---|---|
| today | `h 0.5 [ h 0.5 [ v 0.67 [today \| status] \| v 0.5 [past-due \| not-today] ] \| calendar ]` | `h 0.5 [ tabs(today, status, past-due, not-today) \| calendar ]` | `tabs(today, status, past-due, not-today, calendar)` |
| week | `h 0.29 [ v 0.56 [ tabs(not-today, past-due) \| tabs(today, status) ] \| calendar ]` | `h 0.3 [ tabs(not-today, past-due, today, status) \| calendar ]` | `tabs(calendar, not-today, past-due)` |
| quests | `h 0.3 [ v 0.5 [lanes \| done] \| h 0.55 [ steps \| v 0.5 [side-quests \| past-due] ] ]` | `h 0.36 [ lanes \| h 0.5 [ steps \| tabs(side-quests, past-due, done) ] ]` | `tabs(lanes, steps, side-quests, past-due, done)` |
| money | `h 0.52 [ forecast \| h 0.5 [ v 0.5 [accounts \| hours] \| v 0.55 [coming-up \| ledger] ] ]` | `h 0.58 [ forecast \| v 0.5 [ tabs(accounts, hours) \| tabs(coming-up, ledger) ] ]` | `tabs(forecast, accounts, coming-up, hours, ledger)` |

---

# Wave 1: five tasks at once, no file in common

### Task 1: the engine learns layouts, the phone, options, and the four amendments

`app/lib/v2/tiles` is committed and unwired, so nothing has been saved by anyone: the saved form changes now, with no migration. `PLAN-OS.md` Task 3 is the engine's spec; this task changes exactly what is listed here and keeps every other behaviour there.

**Files:**
- Modify: `app/lib/v2/tiles/{types,tree,geometry,catalog,store,index}.ts`
- Test: amend `__tests__/v2-tiles-{tree,geometry,store}.test.ts`
- Do not create `css.ts` (Task 2 does, at the same time) and do not touch anything else.

**Interfaces (what changes)**

```ts
// types.ts
export type ScreenClass = "compact" | "regular" | "wide";   // compact: under 1024, always one leaf
export type LayoutId = string;                               // built in: today, week, quests, money. The user's: u1, u2, ...
export type PaneGroup = "day" | "quests" | "money";
export interface PaneOption {
  key: string;                                               // [a-z][a-z0-9-]*
  label: string;
  choices: ReadonlyArray<{ value: string; label: string }>;  // value: [a-z0-9-]+
  fallback: string;                                          // one of the values
}
export interface PaneSpec {
  id: PaneId; title: string; short: string; group: PaneGroup;
  minWidth: number; minHeight: number;
  options: readonly PaneOption[];
}                                                            // `closable` is gone: see behaviour 2
export interface Arrangement {
  tree: TileNode | null; maximized: PaneId | null; focus: PaneId | null;
  lastSpot: Record<PaneId, Spot>;
  options: Record<PaneId, Record<string, string>>;           // only values that differ from the fallback
}
export interface LayoutMeta { id: LayoutId; title: string; base: BuiltInLayoutId }
export type BuiltInLayoutId = "today" | "week" | "quests" | "money";
```

```ts
// catalog.ts
export const PANES: readonly PaneSpec[];                     // the fourteen of "The panes", in that order
export const BUILT_IN_LAYOUTS: readonly LayoutMeta[];        // the four, base === id
export const MAX_LAYOUTS = 12;
export const TILES_MIN_WIDTH = 1024; export const WIDE_MIN_WIDTH = 1600;
export function screenClassFor(width: number): ScreenClass;  // never null: under 1024, or not a finite number, is "compact"
export function defaultTree(cls: ScreenClass, base: BuiltInLayoutId): TileNode;
export function defaultArrangement(cls: ScreenClass, base: BuiltInLayoutId): Arrangement;   // the SAME frozen object every call
export const TILE_COPY: { zone: Record<Zone, string> };      // unchanged
```

```ts
// tree.ts (added; every `specs` parameter anywhere in the engine now defaults to PANES)
export function openPane(arr: Arrangement, pane: PaneId, workspace: Workspace | null, specs?: readonly PaneSpec[]): Arrangement;
export function moveTab(arr: Arrangement, pane: PaneId, toIndex: number): Arrangement;
export function setOption(arr: Arrangement, pane: PaneId, key: string, value: string, specs?: readonly PaneSpec[]): Arrangement;
export function optionsOf(arr: Arrangement, pane: PaneId, specs?: readonly PaneSpec[]): Record<string, string>;  // every key of the spec, stored value or fallback
export function flatten(arr: Arrangement): Arrangement;      // the same panes as ONE leaf, in leaf order, active = the focus or the first
```

```ts
// store.ts (replaces ClassState and the old TileSet)
export interface TileSet {
  version: 1;
  layouts: LayoutMeta[];                                     // the rail's order; always holds the four built in
  hidden: LayoutId[];
  current: LayoutId;
  /** layout -> class -> the arrangement, ONLY when it differs from that layout's default. */
  slots: Record<LayoutId, Partial<Record<ScreenClass, Arrangement>>>;
}
export const EMPTY_TILE_SET: TileSet;
export function arrangementOf(set: TileSet, layout: LayoutId, cls: ScreenClass): Arrangement;
export function withArrangement(set: TileSet, layout: LayoutId, cls: ScreenClass, arr: Arrangement): TileSet;
export function isChanged(set: TileSet, layout: LayoutId, cls: ScreenClass): boolean;
export function resetLayout(set: TileSet, layout: LayoutId, cls: ScreenClass | null): TileSet;   // null: every class
export function addLayout(set: TileSet, title: string, from: LayoutId, cls: ScreenClass): TileSet;
export function renameLayout(set: TileSet, id: LayoutId, title: string): TileSet;
export function removeLayout(set: TileSet, id: LayoutId): TileSet;
export function moveLayout(set: TileSet, id: LayoutId, toIndex: number): TileSet;
export function setHidden(set: TileSet, id: LayoutId, hidden: boolean): TileSet;
export function setCurrent(set: TileSet, id: LayoutId): TileSet;
export function cleanTitle(raw: string): string;
export function parseTileSet(value: unknown): TileSet;
export function serializeTileSet(set: TileSet): string;
```

**Behaviour the tests pin**

1. **Three classes.** `screenClassFor` answers `compact` under 1024 (and for NaN, a negative number or infinity), `regular` to 1599, `wide` from 1600.
2. **Every pane can be closed; a layout cannot be emptied.** `closePane` is refused only for the last pane open. The parser no longer puts a pane back. A tree that ends with nothing open is replaced by that layout's default for that class.
3. **Twelve defaults**, the table in "The layouts", written out as data. Each opens only catalog panes, each at most once. Every regular default fits 896 by 600 and every wide default 1472 by 700 at the catalog's minimum sizes, and a test names any split that draws at a clamped share at those sizes (it pins the list, as now). Every compact default is one leaf. `defaultArrangement` returns the same frozen object for the same arguments, with `focus` and no `maximized`.
4. **A user's layout** has an id `u<n>`, n one more than the largest in use, and a `base`: the built in layout it was made from (the base of `from`). Its default for a class with nothing stored is its base's default. `addLayout` copies `from`'s arrangement for `cls` into the new layout, makes it current, and is refused (same object) at `MAX_LAYOUTS`. `renameLayout` and `removeLayout` act on a user's layout only; removing the current one moves `current` to the layout before it in the rail's order.
5. **`cleanTitle`**: trims, collapses runs of whitespace to one space, drops control characters, keeps at most 24 code points (never half a surrogate pair), and gives `"Layout"` for what is left empty. `addLayout` and `renameLayout` store only cleaned titles.
6. **`setHidden`** never hides the last visible layout, and hiding the current one moves `current` to the next visible. `setCurrent` on an unknown or hidden id returns the same object. `moveLayout` clamps the index.
7. **Amendment A, a layout nobody changed is not stored.** `withArrangement` removes the slot when the arrangement equals the default: the same `signature`, no `maximized`, no `options`, an empty `lastSpot`. `arrangementOf` then answers the default object itself. `isChanged` is "a slot is stored". So a default that changes in a later release reaches everyone who never rearranged it.
8. **Amendment B, focus is not saved.** `serializeTileSet` leaves `focus` out. On parse it is the maximized pane, or the tab the first leaf is showing. A change of focus or of the front tab alone still changes the stored text only through the tree's `active`.
9. **Amendment C.** Every `specs` parameter defaults to `PANES`. A pane with no spec is not in the catalog and is dropped by the parser. `openPane` takes the workspace's size (or null) and works the rects out itself.
10. **Ratios are stored to four decimals.** `setRatio`, `normalize` and the parser round to 4 decimals after clamping, so a saved form in any encoding holds exactly what the engine holds.
11. **`moveTab`** moves a pane to an index inside its own leaf (clamped), keeps the active tab and the focus, and returns the same object when nothing moves.
12. **Options.** `setOption` stores a value only when the pane's spec has that key and that choice; a value equal to the fallback removes the entry (and the pane's entry when it is the last). `optionsOf` answers every key the spec declares. The catalog's options are exactly: `calendar` `days` (auto, 1, 3, 7; fallback auto); `steps` `group` (none, group; fallback none); `side-quests` `sort` (clock, added; fallback clock); `done` `span` (7, 14, 28; fallback 14); `forecast` `span` (14, 30, 60; fallback 30); `ledger` `rows` (10, 25, 50; fallback 25). Every other pane has none. Labels are short plain words ("Days", "Automatic", "Group by", "Sort by", "Show", and so on) and join the no-dash walk.
    A pane option's choices are fixed in the catalog, so `steps` cannot list the user's own lanes as choices: filtering by lane is done inside the pane (Task 6) and is not saved.
13. **Compact is one leaf.** `flatten` turns any arrangement into one leaf holding its open panes in leaf order. `withArrangement(set, layout, "compact", arr)` stores `flatten(arr)`, and the parser flattens a compact slot. In a compact arrangement `maximized` is always null.
14. **The parser cannot return a broken desk.** Anything malformed, another version, or not an object gives `EMPTY_TILE_SET`. Otherwise, in order: the four built in layouts are always present (missing ones are appended in catalog order, and their titles and bases are the catalog's whatever was stored); user layouts keep their order, with ids that are not `u<n>` or repeat dropped, titles cleaned, a base that is not built in replaced by `today`, and anything past `MAX_LAYOUTS` dropped; `hidden` keeps only known ids and never all of them; `current` falls back to the first visible layout; each slot goes through the tree repair of `PLAN-OS.md` behaviour 13 (unknown panes dropped, a pane twice keeps its first place, depth over 12 or nothing open gives the default, ids repaired), then behaviour 18's focus rule, then amendment A (a repaired slot equal to the default is dropped); options keep only keys and values the catalog declares. Keys named `__proto__`, `constructor` or `prototype` are ignored anywhere.
15. **Round trip.** `parseTileSet(serializeTileSet(x))` deeply equals `x` with every `focus` set as behaviour 8 sets it, for every set the engine can produce. `serializeTileSet` gives the same text for equal sets whatever order their keys were written in.
16. **Sequences.** The seeded run of `PLAN-OS.md` behaviour 16 now also draws: `moveTab`, `setOption`, `addLayout`, `renameLayout`, `removeLayout`, `moveLayout`, `setHidden`, `setCurrent`, `resetLayout`, a change of class, and a serialize and parse every 25 steps. After every step, for every layout and class: the invariants of behaviour 16 and both halves of behaviour 18; a compact arrangement is one leaf; at least one layout is visible and `current` is one of them; no slot equals its default.

**Steps**

- [ ] Read `PLAN-OS.md` Task 3 (the engine's spec) and the six engine files.
- [ ] Amend the tests for behaviours 1 to 16, run them, see them fail for the right reason.
- [ ] Change the engine. Run the engine's test files until green.
- [ ] `npx eslint` on your files, `npx tsc --noEmit`. In the same commit's working tree, update the text of `PLAN-OS.md` Task 3 behaviours 4, 5, 11, 12, 13, 14 and 15 with one line each saying what `PLAN-DESK.md` Task 1 changed, so the two plans do not disagree.

---

### Task 2: the engine's geometry as CSS

Pure code, one new file. It reads only what Task 1 does not change the shape of: `TileNode`, `Split`, `Leaf`, `PaneSpec` (`minWidth`, `minHeight`), `minSize`, `shareLimits`, `layoutTree`, `leavesOf`, `GAP`.

**Files:**
- Create: `app/lib/v2/tiles/css.ts`, `__tests__/v2-tiles-css.test.ts`
- Do not edit any other file, not even `index.ts`: Task 1 is rewriting the engine beside you. Import from `./types`, `./tree`, `./geometry` directly. If `tsc` reports errors in files you do not own while Task 1 is mid-change, name them and move on.

**Interfaces**

```ts
export interface CssBox { left: string; top: string; width: string; height: string }
export interface CssLayout {
  /** One per leaf, in the order leavesOf gives. Lengths are relative to the workspace box. */
  leaves: Array<CssBox & { leafId: string }>;
  /** One per split: the divider's box. */
  dividers: Array<CssBox & { splitId: string; dir: SplitDir }>;
  /** Custom properties for the workspace element: one ratio per split, and the shared sub-expressions. */
  vars: Record<string, string>;
  /** The smallest workspace this tree can be drawn in. */
  min: { w: number; h: number };
}
/** `scope` goes into every custom property's name: the server writes several classes' layouts into one document and each tree has an `s1`. It must match [a-z]+. */
export function ratioVar(scope: string, splitId: string): string;        // "--v2-r-wide-s3"
export function cssLayout(tree: TileNode | null, maximizedLeafId: string | null, specs: readonly PaneSpec[], scope: string): CssLayout;
```

`cssLayout` takes the tree and the id of the maximized leaf (or null) rather than an `Arrangement`, so it does not depend on the fields Task 1 is adding.

**Behaviour the tests pin**

1. **The same formula.** For a split given an extent `S`, the first child is `round(nearest, clamp(<min first>px, (S - 6px) * var(<ratio var>), S - 6px - <min second>px), 1px)`, then the 6 px gap, then the rest. When the two minimums cannot both fit, `shareLimits` answers `[0.5, 0.5]`: write that case as the engine computes it, so the two forms agree below the minimum as well, or state in the file's header exactly where they stop agreeing and make the test's sizes start there.
2. **Proven, not asserted.** The test holds a small evaluator for exactly the CSS it needs (`+`, `-`, `*`, `clamp`, `round(nearest, x, 1px)`, `min`, `max`, `px`, `%`, `var`) and checks, for 200 seeded random trees of up to 12 leaves with random minimum sizes, at 40 workspace sizes from `min` up to 3840 by 2160, that every leaf and divider box equals `layoutTree`'s rect to the pixel.
3. **A maximized leaf** gets the whole box (`0`, `0`, `100%`, `100%`); the others keep their own boxes, as `layoutTree` returns them. A null tree gives no leaves, no dividers and a `min` of zero.
4. **Linear, not exponential.** Shared sub-expressions go into `vars`, so the total length of a layout's strings grows linearly with the number of splits. A 12 deep chain stays under 8 KB.
5. **Only what the module wrote.** Every string is built from numbers the module formatted (finite, no exponent notation) and ids matching `^[ls][0-9]+$`. A tree carrying any other id, or a `scope` not matching `^[a-z]+$`, throws. No title and no pane id reaches a string.

**Steps**

- [ ] Write the evaluator and the failing equality test. Run, fail.
- [ ] Implement `css.ts`. Run, pass.
- [ ] `npx eslint` on your two files, `npx tsc --noEmit`.

---

### Task 3: Quests, the data and the view model

Pure code and one file reader. No component.

**Files:**
- Create: `app/lib/v2/view/quests.ts`, `__tests__/v2-view-quests.test.ts`, `__tests__/v2-local-quests.test.ts`
- Modify: `app/lib/v2/fixtures/sample-quests.ts` and `app/lib/v2/local/quests.ts` (replace the stub bodies; the signatures stay)
- Read, do not edit: `app/lib/v2/view/desk-data.ts`, `app/lib/v2/view/today.ts` (how a lane's line and a past due item are worded and counted), `app/lib/v2/plan/rank.ts` (`rankCandidates`), `app/lib/v2/local/files.ts` (how a file of the folder is read and how its errors are worded), `app/lib/v2/view/format.ts`.

**Interfaces**

```ts
// app/lib/v2/view/quests.ts
export interface QuestItem {
  id: string;
  title: string; detail: string | null;        // split exactly as Today splits a title (splitTitle)
  lane: LaneKey | null;
  identity: { label: string; color: string; source: "tag" | "lane" } | null;   // resolved exactly as a stop's is on Today
  /** "13 November", or null when it has no date. */
  due: string | null;
  /** Where its date stands against the planned day. */
  when: "past" | "today" | "soon" | "later" | "none";   // soon: inside the planner's hard window
  hard: boolean;
  /** Its place in the planner's own order, 1 first. */
  rank: number;
}
export interface QuestLane {
  key: LaneKey; label: string; color: string;
  open: number;                                 // EQUAL to Today's lane line for the same input
  /** The step the planner ranks first in this lane, or null when the lane is empty. */
  next: QuestItem | null;
  /** The nearest date still ahead, worded as Today words it, or null. */
  due: string | null;
  past: number;                                 // how many of its steps have a date that has gone by
  /** Finished in the lane inside the span, or null when the source has no history for the span. */
  done: number | null;
  /** True when nothing is open and nothing was finished: the lane says nothing at all. */
  quiet: boolean;
}
export interface QuestsView {
  lanes: QuestLane[];                           // every lane of the user, in their order, quiet ones included
  steps: QuestItem[];                           // every open step of every lane, by rank
  side: QuestItem[];                            // everything with no lane, by rank
  done: { span: number; days: Array<{ date: DateKey; label: string; items: Array<{ id: string; title: string; identity: QuestItem["identity"] }> }>; total: number; perWeek: number | null; known: boolean };
  empty: boolean;                               // nothing open anywhere and nothing done
}
export function buildQuestsView(data: QuestsScreenData, doneIds: ReadonlySet<string>, span: 7 | 14 | 28): QuestsView;
export const QUESTS_COPY: { ... };              // every word the Quests panes say
```

```ts
// app/lib/v2/local/quests.ts
export async function loadLocalQuests(dir: string, today: TodayScreenData): Promise<QuestsScreenData | null>;
```

**Behaviour the tests pin**

1. **The same input.** `buildQuestsView` counts and ranks from `data.input` and nothing else: `rankCandidates(input.candidates, input.now, input.rules, input.date)` gives every `rank`. A test builds the Today view and the Quests view from one `TodayScreenData` (the sample day) and asserts that every lane's `open` equals Today's lane line `open`, that the "no lane" count equals `side.length`, and that every candidate appears exactly once across `steps` and `side`.
2. **A press on Today is seen here.** `doneIds` are the tasks finished in this session (from the day's state). An id in it leaves `steps`, `side`, a lane's `open` and `next`, and joins today's day in `done`. The view does not replan anything.
3. **Lanes that nothing feeds stay quiet.** A lane with no open step and nothing done has `quiet: true`, `next: null`, `due: null`. Nothing is invented for it: no placeholder step, no rate of zero.
4. **`next`** is the lane's first step by rank. `due` on the lane is the nearest date still ahead among its open steps (the rule of Today's lane line). `past` counts its open steps whose date has gone by, judged from `planReference(input.now, input.date, input.rules).instant`, the instant Today judges from.
5. **`when`** for an item: `past` before that reference instant; `today` when its date is the planned day; `soon` inside `rules.hardWindowHours` of `now`; `later` beyond; `none` with no date.
6. **Done lately.** `done.days` are the days of the span that have something, newest first, each with its items newest first. `done.total` counts them. `known` is `data.historyDays >= span`; when it is false, `perWeek` is null and each lane's `done` is null, because a rate over days the source cannot see would be an invented number. When known, `perWeek` is `total / (span / 7)` rounded to one decimal.
7. **Titles** are split with Today's `splitTitle`, and an identity is resolved as a stop's is (the group's tag when there is one, else the lane, else null). Import or share that logic; do not write a second copy.
8. **Ordering never depends on the locale.** Ties break on the id. No `localeCompare`, no `Intl`, no `toLocale*`. Dates are worded with the helpers in `view/format.ts`.
9. **The sample.** `sampleQuests(today)` keeps `input`, `lanes` and `tags` from the sample day and adds an invented history: about twenty things finished over the last 21 days across the sample's lanes, some days empty, with `historyDays: 28`. Deterministic, no clock, no randomness. Its titles are invented and are not titles of the sample day's open candidates.
10. **The local folder.** `loadLocalQuests(dir, today)` returns `{ input: today.input, lanes: today.lanes, tags: today.tags, done, historyDays }`. `done` is read from the folder's task file: rows whose status is `done` with a finish time inside the last 28 days before the planned day, newest first, each with the lane its group belongs to (from the rules document, as `tasksToCandidates` does it) and its group's tag. `historyDays` is 28 when the task file holds any finished row at all, else 0. It reads with the helpers of `local/files.ts` and reports an unreadable file as that module does (`LocalSnapshotError`, a literal file name and a fixed phrase, never a path or a value). It returns null only when the folder has no task file. Tests use a folder written in a temporary directory with invented rows, as `__tests__/v2-local-snapshot.test.ts` does.
11. **No dash** in any string of `QUESTS_COPY`; the test walks it.

**Steps**

- [ ] Write the failing tests for behaviours 1 to 9, run, fail.
- [ ] Implement `view/quests.ts` and the sample. Run, pass.
- [ ] Write the failing tests for behaviour 10, implement the loader, run, pass.
- [ ] `npx eslint` on your files, `npx tsc --noEmit`.

---

### Task 4: Money, the data and the view model

Pure code and one file reader. No component.

**Files:**
- Create: `app/lib/v2/view/money.ts`, `__tests__/v2-view-money.test.ts`, `__tests__/v2-local-money.test.ts`
- Modify: `app/lib/v2/fixtures/sample-money.ts` and `app/lib/v2/local/money.ts` (replace the stub bodies; the signatures stay)
- Read, do not edit: `app/lib/v2/view/desk-data.ts`, `app/lib/v2/local/files.ts`, `app/lib/v2/view/format.ts`, `app/lib/v2/types.ts` (`PlanInput`, `PlannerRules`, `Block`, `FixedEvent`).

**The local file.** `money.json` in the snapshot folder, written by the controller outside git. Its shape (the reader validates it; anything else is a `LocalSnapshotError`):

```jsonc
{
  "version": 1,
  "takenAt": "<instant>", "today": "YYYY-MM-DD", "currency": "CAD", "netWorth": 0,
  "accounts": [{ "id": "", "name": "", "type": "checking", "balance": 0, "currency": "CAD" }],
  "recurring": [{ "id": "", "name": "", "amount": 0, "category": "", "schedule": "monthly on day 28" }],
  "income": [{ "id": "", "name": "", "hourlyWage": 0, "taxRatePct": 0, "calendarId": null,
               "paySchedule": { "frequency": "monthly", "anchorPayday": "YYYY-MM-DD" },
               "fixedMonthly": { "amount": 0, "dayOfMonth": 25 } }],
  "categories": [{ "name": "", "color": "#RRGGBB" }],
  "limits": [{ "label": "", "period": "monthly", "amount": 0, "spent": 0, "remaining": 0, "state": "under" }],
  "forecast": {
    "everydaySpend": { "dailyRate": 0, "sampledWeeks": 0, "confident": false, "manualFallback": 0 },
    "groceryTrips": [{ "date": "YYYY-MM-DD", "amount": 0, "items": 0 }],
    "days": [{ "date": "YYYY-MM-DD", "inflow": 0, "outflow": 0, "everyday": 0, "groceries": 0, "projected": 0 }]
  },
  "ledger": { "lastOn": "YYYY-MM-DD", "rows": [{ "id": "", "on": "YYYY-MM-DD", "direction": "out", "amount": 0, "account": "", "category": null, "note": "" }] }
}
```

`hourlyWage`, `fixedMonthly`, `calendarId`, `manualFallback`, `category` and `ledger.lastOn` may be null. Unknown keys are ignored.

**Interfaces**

```ts
// app/lib/v2/view/money.ts
export const STALE_AFTER_DAYS = 7;
export interface MoneyAge {
  /** Whole days from the newest ledger line to the desk's day, or null for an empty ledger. */
  days: number | null;
  stale: boolean;                               // days === null, or days > STALE_AFTER_DAYS
  /** The one sentence every Money pane leads with when stale, else null. */
  line: string | null;                          // "No transaction since 24 August, 78 days ago. Everything here is what was last known."
}
export interface MoneyCell {
  date: DateKey; dayOfMonth: number; isToday: boolean;
  /** False for a grid cell that pads the first or last week: nothing is drawn in it. */
  inRange: boolean;
  balance: string | null;                       // "1,894" (no cents, grouped), or null out of range
  /** What is firm on the day, worded: "Pay 2,725", "Bill 103". */
  marks: Array<{ kind: "in" | "out"; label: string }>;
  /** True on the lowest day of the span, and on any day under zero. */
  low: boolean; negative: boolean;
}
export interface MoneyForecastView {
  age: MoneyAge;
  span: 14 | 30 | 60;
  weekdays: string[];                           // Mon first, short
  weeks: MoneyCell[][];                         // rows of seven, padded
  list: MoneyCell[];                            // the in-range days in order, for a narrow pane
  lowest: { date: string; balance: string } | null;   // "Thursday 24 December", "424"
  /** The sentence about the estimate, always present: it is a guess and says so. */
  estimate: string;                             // "Everyday spending is a guess of 63 a day, typed in by hand."
  empty: boolean;                               // the source has no forecast rows
}
export interface MoneyAccountsView { age: MoneyAge; total: string; currency: string; accounts: Array<{ id: string; name: string; kind: string; balance: string; negative: boolean }>; takenLine: string; empty: boolean }
export interface MoneyComingView { age: MoneyAge; items: Array<{ id: string; date: string; inDays: number; kind: "in" | "out"; name: string; amount: string }>; empty: boolean }
export interface MoneyLedgerView { age: MoneyAge; rows: Array<{ id: string; date: string; kind: "in" | "out"; amount: string; note: string; account: string; category: string | null }>; more: number; empty: boolean }
export interface MoneyHoursView {
  /** Null when the rules set no weekly income target. */
  target: { hours: number; done: number; label: string } | null;    // "6 of 10 hours"
  /** Null when the rules set no weekly cap. */
  cap: { hours: number; used: number; label: string; over: boolean } | null;
  empty: boolean;                               // neither is set
}
export function moneyAge(data: MoneyScreenData): MoneyAge;
export function buildForecastView(data: MoneyScreenData, span: 14 | 30 | 60): MoneyForecastView;
export function buildAccountsView(data: MoneyScreenData, timeZone: string): MoneyAccountsView;
export function buildComingView(data: MoneyScreenData, span: 14 | 30 | 60): MoneyComingView;
export function buildLedgerView(data: MoneyScreenData, rows: 10 | 25 | 50): MoneyLedgerView;
export function buildHoursView(input: PlanInput, blocks: readonly Block[]): MoneyHoursView;
export function formatAmount(value: number): string;   // whole units, grouped by thousands with a comma, a leading minus sign for negatives
export const MONEY_COPY: { ... };               // every word the Money panes say
```

**Behaviour the tests pin**

1. **It says how old it is first.** `moneyAge`: `days` is the whole days from `ledgerLastOn` to `data.today`. Stale when the ledger is empty or older than `STALE_AFTER_DAYS`. `line` names the day of the last transaction as a day and a month and the count of days. Every view carries the same `age`. With an empty ledger the line says no transaction has been recorded at all.
2. **The forecast is the source's own.** `buildForecastView` reads `data.forecast` and computes nothing a forecast engine would: no schedule is expanded, no balance is summed. It takes the first `span` rows from `data.today` on (rows before it are dropped; if the source's first day is later than today, the grid starts there). Weeks are Monday first and padded with cells that are not in range.
3. **Marks are only what is firm.** A day's `inflow` above zero gives one "in" mark and its `outflow` one "out" mark. The label is the matching name when exactly one bill or one fixed monthly income has that amount (to the cent) and, for a bill, a schedule whose words contain that day of the month; otherwise the plain word for pay or for a bill. The everyday estimate and the grocery estimate never produce a mark: they are in the balance and in the `estimate` sentence.
4. **The lowest day** of the span is flagged once (the earliest on a tie), and every day under zero is `negative`. `lowest` is worded with the weekday, the day and the month.
5. **The estimate sentence** says a manual figure was typed in when `confident` is false and `manualFallback` is a number, says it comes from the ledger when `confident` is true, and says there is no estimate when neither holds.
6. **Accounts.** One line per account in the source's order, the total as the sum of the balances (computed here; it is the one sum this module makes), `negative` for a balance under zero, and `takenLine` saying when the source last read them, as a day, a month and a clock in the desk's zone.
7. **Coming up.** The firm marks of the span as a list in date order, each with the days from today, the name by rule 3 and the amount. Estimates are never in it.
8. **Ledger.** The newest `rows` lines as the source ordered them, `more` counting the rest. A note longer than 80 characters is cut at a word boundary with three dots; nothing else is changed in it.
9. **Hours come from the planner's own numbers.** `buildHoursView(input, blocks)`: the target is `input.rules.incomeTarget` (null when unset), `done` is `input.week.incomeHoursElsewhere` plus the hours of this day's blocks of kind `income` that are not skipped; the cap is `input.rules.weeklyHourCap` (null when unset, and when the planned day is inside a `capExemptRanges` range), `used` is `input.week.capHoursElsewhere` plus the hours of this day's fixed events that count toward the cap plus those same income blocks. Hours are rounded to a quarter. Nothing here reads a calendar or a wage.
10. **`formatAmount`** has no decimals, groups thousands with a comma, and puts a minus sign before a negative. No `Intl`, no `toLocale*`. Halves round away from zero.
11. **The sample.** `sampleMoney(today)`: invented accounts (an everyday account and a savings account), a 60 day forecast from the sample day with a pay day, two bills and an everyday estimate, fifteen invented ledger lines, the newest two days before the sample day (so the sample is NOT stale). Deterministic. A second export `sampleMoneyStale(today)` is the same with the newest line 80 days back, for tests and the gallery.
12. **The local folder.** `loadLocalMoney(dir, today)` returns null when the folder has no `money.json`, and otherwise a `MoneyScreenData` with `today: today.input.date`, `ledgerLastOn` from `ledger.lastOn`, `bills` from `recurring`, `income` from `income`, `rows` from `ledger.rows`, `forecast` from `forecast.days`. A file that is there and does not match is a `LocalSnapshotError` naming `money.json` and the field's path, never a value. Tests use a temporary folder with invented numbers.
13. **No dash** in any string of `MONEY_COPY`, and ordering never depends on the locale.

**Steps**

- [ ] Write the failing tests for behaviours 1 to 11, run, fail.
- [ ] Implement `view/money.ts` and the sample. Run, pass.
- [ ] Write the failing tests for behaviour 12, implement the reader, run, pass.
- [ ] `npx eslint` on your files, `npx tsc --noEmit`.

---

### Task 5: the day's state lifted out, the pane registry, and a gallery to look at one pane alone

Nothing on Today or Week changes. This is the seam every pane needs, and the page the controller uses to look at a pane at a fixed size before the desk exists.

**Files:**
- Create: `app/v2/_components/day-provider.tsx`, `app/v2/_desk/desk-data-provider.tsx`, `app/v2/_desk/pane-registry.tsx`, `app/v2/_desk/day-panes.tsx`, `app/v2/_desk/pane-box.tsx`, `app/v2/panes/page.tsx`, `app/v2/panes/gallery-client.tsx`, `app/lib/v2/view/desk.ts`, `app/v2/desk.css`, `__tests__/v2-day-provider.test.ts`, `__tests__/v2-pane-gallery.test.ts`
- Modify: `app/v2/today/today-client.tsx` (uses the provider; renders what it renders now), `app/v2/layout.tsx` (import `desk.css`), `app/v2/v2.css` (only the leaf rules named in behaviour 6), `__tests__/v2-source.test.ts` (ONLY the pinned set of pages, which gains `app/v2/panes/page`)
- Read, do not edit: `app/v2/_desk/pane-body.ts`, the two stub maps, `app/lib/v2/view/desk-data.ts`, `app/lib/v2/fixtures/sample-desk.ts`, `app/lib/v2/local/desk.ts`, `app/lib/v2/tiles/catalog.ts` (pane ids; Task 1 is rewriting it beside you, so read ids from the table in this plan and do not import the engine).

**Interfaces**

```ts
// app/v2/_components/day-provider.tsx
export interface DayValue {
  data: TodayScreenData;
  view: TodayView; clock: string;
  energy: Energy | null; said: string | null;
  revision: number; focusToken: number;
  movedIds: ReadonlySet<string>;
  planned: readonly PlannedBlock[];
  /** The plan on screen, for panes that read the planner's own numbers. */
  plan: PlanOutput;
  /** Tasks finished in this session: a block of the plan in state "done" that carries a task. */
  doneIds: ReadonlySet<string>;
  onStart(blockId: string): void; onDone(blockId: string): void; onSkip(blockId: string): void; onEnergy(energy: Energy): void;
}
export function DayProvider(props: { data: TodayScreenData; children: React.ReactNode }): JSX.Element;
export function useDay(): DayValue;                 // throws outside a provider, in a sentence that says so

// app/v2/_desk/desk-data-provider.tsx
export function DeskDataProvider(props: { data: DeskScreenData; keep?: Readonly<Record<string, string>>; children: React.ReactNode }): JSX.Element;
export function useDeskData(): DeskScreenData;      // throws outside a provider
export function useDeskKeep(): Readonly<Record<string, string>>;   // search params every link on the desk carries (layout, date)

// app/v2/_desk/pane-registry.tsx
export function paneBody(id: string): PaneBody;     // a day pane, a quests pane, a money pane, or NotBuilt
export const KNOWN_PANE_IDS: readonly string[];     // the fourteen ids of this plan's table, in order

// app/v2/_desk/pane-box.tsx
/** The box a body is drawn in: the `v2-pane` container, with the scroller every body shares. */
export function PaneBox(props: { paneId: string; children: React.ReactNode; style?: React.CSSProperties }): JSX.Element;

// app/lib/v2/view/desk.ts
export const DESK_COPY: { heading: "Desk"; notBuilt: "This pane is not built yet."; noQuests: string; noMoney: string; /* later tasks add theirs */ };
```

**Behaviour the tests pin**

1. **Lifted, not changed.** The state, `replan`, `viewFor`, the handlers, `movedIds`, `view`, `planned` and `clock` move from `today-client.tsx` into `DayProvider` unchanged. `TodayClient` becomes the provider around the same markup. Every existing test passes unedited.
2. **Seeded once per planned day.** New `data` for the same day re-renders without losing presses. The key on the planned day stays where the page puts it.
3. **`doneIds`** holds the task id of every block of the current plan whose state is `done` and whose `taskId` is not null. It changes in the render that carries the press.
4. **Five day panes** in `day-panes.tsx`, each a few lines over `useDay()` and the existing leaf components, with no leaf component edited: `today` (the day header, the energy row, the line or the empty sentence), `status` (the said sentence as plain text with no role, the all day row, the feed strip, the lane summary), `past-due`, `not-today`, `calendar` (the calendar pane with `planned` from the day, `basePath="/v2/desk"`, and `keep` from `useDeskKeep()`; when the day has no calendar, the sentence `CALENDAR_COPY.noCalendar`). Neither the day provider nor a pane holds a `role="status"`: the page that mounts them owns the one live region.
5. **The registry** answers the body for an id from the day panes, then `QUEST_PANE_BODIES`, then `MONEY_PANE_BODIES`, and `NotBuilt` (one sentence, `DESK_COPY.notBuilt`) for anything else, including an id that is not one of the fourteen. A test asserts the five day ids resolve to real bodies and that an unknown id does not throw.
6. **A leaf sizes by its pane.** `PaneBox` is `container-type: inline-size`, named `v2-pane`, fills its parent, and scrolls its content on the block axis with the inside focus ring the lists already have. The rules in `v2.css` that restyle a leaf because it sits in the page's side column (`.v2-side .v2-feeds`, `.v2-allday-label`, `.v2-energy`, `.v2-said`, `.v2-allday`, `.v2-sub`, `.v2-row`, `.v2-row b`, `.v2-more`) also apply inside a pane, written as `:where(.v2-side, .v2-pane)` so the existing page keeps its specificity. The two font sizes that use `vw` take `cqw` inside a pane. The lists take two and three columns from the pane's own width. The day's line never grows wider than 640 px inside a pane. Nothing else in `v2.css` changes and the tier tests pass unedited.
7. **The gallery.** `/v2/panes?pane=<id>&w=<px>&h=<px>` goes through the gate exactly as Today does, loads the whole desk (`sampleDesk(week)` or `loadLocalDesk`), and draws ONE pane: `DeskDataProvider`, `DayProvider` keyed on the planned day, and a `PaneBox` of exactly that width and height (defaults 464 by 600; each clamped to 160..2400) holding `paneBody(id)` with the options given as `?o.<key>=<value>`. An unknown id draws `NotBuilt`. `?stale=1` on the sample source swaps in `sampleMoneyStale` when that export exists (Task 4 adds it; until then the parameter does nothing). Above the box, one line names the pane and the size. The page holds the one `role="status"`, speaking `useDay().said`.
8. **The gate's pinned set** in `__tests__/v2-source.test.ts` (the test that says which modules of the real tree are data modules) gains the gallery page. Nothing else in that file changes.

**Steps**

- [ ] Write `v2-day-provider.test.ts` (behaviours 1 to 3). Run, fail.
- [ ] Move the state into the provider. Run that test and every test that imports `today-client`, the fixtures, the pane and the pages.
- [ ] Write `v2-pane-gallery.test.ts` (behaviours 4, 5, 7: the gate, the five panes in a box, an unknown id, the live region). Run, fail. Build the registry, the day panes, the box, the gallery and `desk.css`. Run, pass.
- [ ] Make the listed leaf rules pane aware (behaviour 6) and add the stylesheet checks for them.
- [ ] `npx eslint` on your files, `npx tsc --noEmit`. Report what cannot be checked without a browser: the controller captures each of the five panes at 230, 464 and 1300 px wide.

---

# Wave 2: the panes, the saved form and the standing desk

### Task 6: the Quests panes

**Files:**
- Create: `app/v2/_components/quests/{lanes-pane,steps-pane,side-quests-pane,done-pane,quest-row}.tsx`, `app/v2/quests.css`, `__tests__/v2-quests-panes.test.ts`
- Modify: `app/v2/_components/quests/quest-panes.tsx` (fill the map), `app/v2/layout.tsx` (import the stylesheet: one line, after `desk.css`)
- Read: `app/lib/v2/view/quests.ts` (Task 3), `app/v2/_desk/{pane-body,desk-data-provider}.tsx`, `app/v2/_components/day-provider.tsx`, `app/v2/_components/list-row.tsx` and `stop-card.tsx` (how a row takes an identity colour), `app/v2/v2.css` (tokens).

**Behaviour the tests pin**

1. **Four bodies** in `QUEST_PANE_BODIES`: `lanes`, `steps`, `side-quests`, `done`. Each reads `useDeskData().quests` and `useDay().doneIds`, builds its part with `buildQuestsView`, and draws nothing of its own invention. With `quests` null each says `DESK_COPY.noQuests`.
2. **Lanes.** One row per lane in the user's order with its colour through `identityTokens`, its open count, its next stop's title and date, and the count past their date when above zero. A quiet lane is drawn as its name alone, dimmed, with no numbers. Under 300 px of pane: name, count and the next date only. From 520 px: the next stop's title beside the name. Pressing a lane filters the `steps` pane? No: panes do not talk to each other in this stage. A lane row is not a control.
3. **Steps.** The open steps by rank, each a row: title, detail, its identity, its date and a mark for `past`, `today` and `soon`. A filter by lane at the top of the pane (a row of the lanes that have steps, plus All), held in the pane's own state and not saved. The `group` option set to `group` groups the rows under their identity label. One column under 560 px of pane, two from there, three from 900.
4. **Side quests.** The same rows for what has no lane. The `sort` option: `clock` is rank order; `added` is the order of `data.input.candidates`.
5. **Done lately.** The days of the span with what was finished, newest first, a total, and the rate per week only when `known`. When the source has no history: one sentence saying so, and no number. The `span` option picks 7, 14 or 28.
6. **Read only.** No button, no input, no link inside a row. The only controls are the steps pane's lane filter (buttons with `aria-pressed`).
7. **Structure.** Each body is a list (`role="list"`) or lists under headings, with the pane's frame supplying the region and its name. Rows clip their text (`min-width: 0`, `overflow-wrap: anywhere`), so a long unbroken word never widens a pane.
8. **Colour and type** follow the existing lists. `quests.css` holds no colour literal and no new font; the stylesheet checks cover it by walking the folder.

**Steps**

- [ ] Write the failing tests (bodies rendered with `sampleDesk(null)` inside the two providers; a press on Today's lit card removes that step; quiet lanes; no history; the filter; the options; read only; the stylesheet's container thresholds). Run, fail.
- [ ] Build the four bodies and `quests.css`. Run, pass.
- [ ] `npx eslint`, `npx tsc --noEmit`. The controller captures each body in the gallery at 240, 464 and 1300 px on the sample and on the local copy.

---

### Task 7: the Money panes

**Files:**
- Create: `app/v2/_components/money/{forecast-pane,accounts-pane,coming-up-pane,hours-pane,ledger-pane,money-age}.tsx`, `app/v2/money.css`, `__tests__/v2-money-panes.test.ts`
- Modify: `app/v2/_components/money/money-panes.tsx` (fill the map), `app/v2/layout.tsx` (import the stylesheet: one line, after `desk.css`)
- Read: `app/lib/v2/view/money.ts` (Task 4), the two providers, `app/v2/calendar.css` (how a grid of days is drawn by its own width), `app/v2/v2.css` (tokens).

**Behaviour the tests pin**

1. **Five bodies** in `MONEY_PANE_BODIES`: `forecast`, `accounts`, `coming-up`, `hours`, `ledger`. Each builds its view with the functions of `view/money.ts`. With `money` null the four that need it say `DESK_COPY.noMoney`; `hours` reads `useDay()` and works without money data.
2. **Stale first.** When `age.stale`, the pane's first element is the age line (`MoneyAgeLine`), set apart, before any number, and every number in the pane is drawn in the quieter ink with the word for "last known" beside the pane's main figure. The test renders each pane with `sampleMoneyStale` and asserts the age line comes before every figure in document order.
3. **Forecast.** From 480 px of pane: a month grid, weekday header, one cell per day with the day number, the balance in tabular figures and its marks; today marked as the calendar marks today; the lowest day and any day under zero marked with the danger token and a word, never by colour alone. Under 480 px: the days as a list, date and balance on a line, marks under it. The estimate sentence sits under the grid in the quiet ink, always. The `span` option picks 14, 30 or 60 days. Cells are not controls.
4. **Accounts.** The total first, then one line per account, then the line saying when the accounts were last read.
5. **Coming up.** A list in date order: the date, "in 3 days", the name, the amount with a sign word for in and out.
6. **Hours.** Two meters at most: the week's target and the cap, each a plain bar with its label ("6 of 10 hours"), the cap's bar in the danger token when over. No meter for what the rules do not set, and one sentence when neither is set. A bar has `role="meter"` with its three values.
7. **Ledger.** The newest lines: date, note, account, category, amount. One line each from 420 px of pane, two lines each under it. A count of the rest. The `rows` option picks 10, 25 or 50.
8. **Read only, structure, colour**: as Task 6's behaviours 6 to 8, for `money.css`.

**Steps**

- [ ] Write the failing tests (each body with `sampleDesk(null)`, with `sampleMoneyStale`, with money null; the forecast's two layouts in the stylesheet; hours from a planner input with and without a target and a cap). Run, fail.
- [ ] Build the five bodies and `money.css`. Run, pass.
- [ ] `npx eslint`, `npx tsc --noEmit`. The controller captures each body in the gallery at 240, 464 and 1300 px, fresh and stale, on the sample and on the local copy.

---

### Task 8: the saved form the server reads

**Files:**
- Create: `app/lib/v2/tiles/codec.ts`, `app/lib/v2/tiles/cookie.ts`, `__tests__/v2-tiles-codec.test.ts`
- Modify: `app/lib/v2/tiles/index.ts` (exports for `css`, `codec`, `cookie`)

**Interfaces**

```ts
// codec.ts : one arrangement as a short string of characters a cookie carries unescaped
export function encodeArrangement(arr: Arrangement): string;
export function decodeArrangement(text: string): Arrangement | null;   // never throws; null when it cannot be read

// cookie.ts : what the first paint needs, and nothing else
export const TILE_COOKIE = "mb-v2-desk";
export const TILE_COOKIE_MAX = 3800;
export function encodeTileCookie(set: TileSet): string | null;         // null when it would not fit
export function decodeTileCookie(value: string | undefined): TileSet;
```

**Behaviour the tests pin**

1. **The grammar.** A leaf is `(` its pane ids joined by `~`, the active one followed by `*`, `)`. A split is `h` or `v`, the ratio as four digits (the ratio times 10000, zero padded), then its two children with no separator. After the tree: `_m.` and a pane id when one is maximized; then `_o.<pane>.<key>.<value>` for each stored option, panes and keys in sorted order. An empty tree is `()`. Only the characters `a-z 0-9 ( ) ~ * . _ -` appear.
2. **Round trip.** `decodeArrangement(encodeArrangement(a))` has the same `signature`, `maximized`, options and front tabs as `a`, for every arrangement the engine can produce (the seeded generator of the engine's tests). Ids are minted again in pre-order; `lastSpot` and `focus` are not carried.
3. **Tolerant.** Any string (10,000 seeded random ones over the grammar's alphabet, and 1,000 over all of ASCII) returns null or an arrangement and never throws, never recurses deeper than 12 splits, and never returns a tree holding an id the catalog does not know (those panes are dropped as the parser drops them).
4. **The cookie holds** the rail (the order of layouts, the user's layouts with their titles and bases, the hidden ones), `current`, and the current layout's arrangement for each class that differs from its default. Titles are written with every character outside `A-Z a-z 0-9` as `'` and two hex digits per UTF-8 byte. Fields are joined by `!`. It starts with `1!` (the version).
5. **It fits.** The worst case the engine allows (twelve layouts with 24 character titles, the current layout rearranged in all three classes with every option set) encodes under `TILE_COOKIE_MAX`. The test builds that case and reports the byte count.
6. **Decoding is the engine's parser.** `decodeTileCookie` builds a plain object and hands it to `parseTileSet`, so every repair is the parser's. Anything malformed, oversized or of another version gives `EMPTY_TILE_SET`. The test feeds it markup and CSS injection strings, `__proto__`, and 100 KB of noise.

**Steps**

- [ ] Write the failing tests. Run, fail. Implement the two files. Run, pass.
- [ ] `npx eslint`, `npx tsc --noEmit`.

---

### Task 9: the desk, standing still

The page exists. It opens on the layout the address names, in the default arrangement for whatever size the window is, with every pane that is built drawn in its place. Nothing can be moved yet.

**Files:**
- Create: `app/v2/desk/page.tsx`, `app/v2/_desk/{desk-client,workspace,pane-frame,desk-rail,desk-bar,announcer}.tsx`, `app/v2/_desk/use-tiles.ts`, `__tests__/v2-desk-page.test.ts`, `__tests__/v2-desk-workspace.test.ts`
- Modify: `app/v2/desk.css`, `app/lib/v2/view/desk.ts`, `app/v2/v2.css` (only if a rail rule must be shared), `__tests__/v2-source.test.ts` (ONLY the pinned set of pages, which gains the desk page)

**Interfaces**

```ts
// app/v2/_desk/use-tiles.ts
export type TilesAction =
  | { type: "class"; cls: ScreenClass }
  | { type: "layout"; id: LayoutId }
  | { type: "replace"; set: TileSet };            // later tasks add the rest
export function useTiles(initial: TileSet): {
  set: TileSet;
  /** null until the browser has said how wide it is: the first render is the server's. */
  cls: ScreenClass | null;
  dispatch(action: TilesAction): void;
};
```

**Behaviour the tests pin**

1. **The gate.** `/v2/desk` is not found with the flags off and in production, awaits the loopback check before any read, and reads `?layout=`, `?date=` and `?week=` inside the guarded child. An unknown or hidden `layout` falls back to the set's current one. The gate walk passes with the page in it.
2. **One page, every layout.** The rail's layouts are anchors to `/v2/desk?layout=<id>` carrying `date` when the request had a usable one. A press changes the layout in the browser (the reducer, then `window.history.pushState`, which Next 16 keeps in step with `useSearchParams`; read the guide in `node_modules/next/dist/docs/` and name it in your report) with no request to the server, so the day's presses are kept. Back and Forward change the layout. Without script the anchor loads that layout from the server.
3. **The server draws every class.** It cannot know the window's size, so each frame's box is written three times as custom properties (`--v2-x-regular`, `--v2-x-wide`, and the same for `y`, `w`, `h`, from `cssLayout`), and each frame says in which classes it is shown (`data-shown="compact regular wide"`, some, or none). `desk.css` uses the regular set from 1024 px and the wide set from `@media (min-width: 1600px)`, shows in compact only the front tab of the one leaf, and does not display a frame that is not shown in the class that applies. No script is needed for the first paint.
4. **The first client render is the server's HTML.** The reducer's first state is built only from the server's props. The class is `null` on the first render, on the server and in the browser alike; it is read from `matchMedia` in an effect. A test renders the desk to a string as the server does, hydrates that markup with a different window width, and asserts React reports no mismatch and the markup is unchanged until the effects have run.
5. **Flat and stable.** The workspace's children are the fourteen frames in catalog order, then the dividers of the classes. A frame is a `section` labelled by its title. A leaf holding several panes shows a tab strip (`role="tablist"`, the short labels); only the front tab's body is displayed. Bodies of background tabs, of panes not in this layout and of panes behind a maximized one stay mounted and are not displayed, which takes them out of the tab order and the accessibility tree; once the class is known they are also `inert`.
6. **Mount once.** A test switches through the four layouts and back and asserts no body was unmounted (a counter in the test's stand-in bodies), and that a press on Today's lit card made before the switches is still there after them.
7. **The frame.** A header with the pane's title (or the tab strip), then the `PaneBox` with `paneBody(id)` and that pane's options from the arrangement. In this task the header has no controls.
8. **Regular and wide.** The existing rail on the left: the layouts (the current one marked with `aria-current="page"`), then the pane list by group with a mark for open in this layout, then Appearance. The workspace fills the rest of the window, with `min-width` and `min-height` from `cssLayout`. A window too short for the tree scrolls the page; no pane overflows its box.
9. **Compact.** One slot. The top bar holds the current layout's name as a button that opens the list of layouts (a sheet of anchors); the bottom bar is the current layout's tabs in order, the front one marked, scrolling sideways when there are more than fit. The slot fills the space between the bars and its body scrolls inside it.
10. **One live region.** The desk's `Announcer` is the only `role="status"` on the page, outside every pane, and speaks `useDay().said`. The notes of `DeskScreenData.notes` and the day's notice are shown once, in the rail on a big screen and under the top bar on a phone.
11. **The local source** uses `loadLocalDesk`; a folder whose day cannot be read gets the shared snapshot error screen.

**Steps**

- [ ] Write the failing tests. Run, fail.
- [ ] Build the page, the client, the reducer, the workspace, the frame, the rail, the bars, the announcer; extend `desk.css`.
- [ ] Run this task's tests and every test that reads `app/v2`. `npx eslint`, `npx tsc --noEmit`.
- [ ] The controller builds, captures the four layouts at 2000 by 985, 1366 by 768 and 390 by 844 on the sample and on the local copy, and presses through the layouts in a browser with a press on Today made first.

---

# Wave 3: moving things, saving, and the rest

### Task 10: resize, tabs, close and reopen, maximize, layouts, saving

**Files:**
- Create: `app/v2/_desk/{divider,layout-menu,pane-list}.tsx`, `app/v2/_desk/persist.ts`, `__tests__/v2-desk-controls.test.ts`
- Modify: `app/v2/_desk/{use-tiles.ts,workspace.tsx,pane-frame.tsx,desk-rail.tsx,desk-bar.tsx,announcer.tsx,desk-client.tsx}`, `app/v2/desk/page.tsx` (reads the cookie inside the guarded child), `app/v2/desk.css`, `app/lib/v2/view/desk.ts`

**Behaviour the tests pin**

1. **A divider** is a `role="separator"` with `aria-orientation` and the three values from `shareLimits`, focusable. Arrow keys move it by 2 percent of the split, with Shift by 10; Home and End go to the limits; Enter makes both sides equal, as a double click does. Dragging writes the ratio's custom property straight onto the workspace element on each pointer move, clamped, with no React render; on release one action commits it through `setRatio`. Pointer capture is taken, and Escape during a drag restores the ratio it started from.
2. **Tabs.** A click or Enter on a tab is `activateTab`. Arrow keys move along the strip. Each tab has a close control (`closePane`), absent when it is the last pane of the layout. Alt with the arrow keys is NOT bound.
3. **Close and reopen.** The pane list marks what is open in this layout. Pressing a closed pane opens it (`openPane` with the workspace's measured size) and it returns where it was; pressing an open one focuses it.
4. **Maximize** is a button in the frame's header and a double click on the header. While a pane is maximized every other body is `inert`, and one press restores.
5. **Layouts.** In the rail and in the phone's sheet: switch; "New layout from this one" (asks for a name in a small inline field, `addLayout`); rename and delete for the user's own; move up and move down; hide and show for the built in ones; "Reset this layout" when it is changed (`isChanged`), after one confirmation in place, not a browser dialog. The limit of twelve is said in words when it is reached.
6. **The phone.** The bottom bar's tabs can be reordered and hidden from a list with Move up, Move down, Show and Hide (`moveTab`, `closePane`, `openPane`). No drag on a coarse pointer.
7. **Saving.** After any committed change: the whole set goes to `localStorage` under `mb-v2-desk` (`serializeTileSet`), and the cookie is rewritten (`encodeTileCookie`); when it would not fit, the previous cookie is kept and the announcer says the layout is saved on this device but the first paint may show the default. On load the server paints from the cookie; an effect then reads `localStorage` and replaces every layout except the current one's arrangement for the class being shown, so nothing on screen jumps. A change of class (the window crossing 1024 or 1600 px) shows that class's own arrangement and never copies one class into another.
8. **Focus follows.** After a change the element focused is the front tab of the engine's `focus` pane, or the control that was pressed when it still exists. The announcer says what happened in one short sentence from `DESK_COPY`.
9. **Tab order** in four states (default, one pane maximized, one pane closed, another layout) never reaches a body that is not displayed.
10. **A reload** of a rearranged desk draws the rearranged desk in the server's HTML (the test renders the page with the cookie that the client wrote).

**Steps**

- [ ] Write the failing tests. Run, fail. Build. Run this task's tests and Task 9's. `npx eslint`, `npx tsc --noEmit`.
- [ ] The controller drags a real divider with a real pointer, closes and reopens a pane, makes a layout of his own, reloads, and compares captures.

---

### Task 11: the pane menu, drag to dock, and motion

**Files:**
- Create: `app/v2/_desk/{pane-menu.tsx,use-dock-drag.ts,flip.ts}`, `__tests__/v2-desk-dock.test.ts`
- Modify: `app/v2/_desk/{use-tiles.ts,workspace.tsx,pane-frame.tsx}`, `app/v2/desk.css`, `app/lib/v2/view/desk.ts`

**Behaviour the tests pin**

1. **The menu** on each frame holds every change a drag can make, built from the engine: move left, right, up and down (`neighbourOf`, then `movePane` on that side of the neighbour), make a tab of each other open pane, split this tab off, maximize or restore, close, and "Move to layout" for each other layout (close here, open there). An item that would change nothing is not offered. It is a `role="menu"` with arrow keys, Home, End, Escape and type ahead on the first letter. On the phone it holds only what one slot allows.
2. **Drag.** A pointer drag that starts on a frame's header or on a tab, after 6 px of travel, picks the pane up. The zone under the pointer comes from `zoneAt` on `layoutTree`'s rects for the measured workspace; a tinted overlay at `zoneRect` and a label from `TILE_COPY.zone` and the target's title say what will happen. Releasing is one `movePane`. Escape, or releasing outside every pane, cancels. Nothing drags on a coarse pointer.
3. **Motion.** Every change of arrangement and every change of layout runs through `flip`: frames move from their old boxes with `transform` over `--v2-std`; a change of layout uses `--v2-slow` with a stagger of at most 40 ms a pane and 200 ms in all; a pane that appears fades in over `--v2-quick`; the dock overlay fades over `--v2-quick`. Content inside a frame is never scaled. Under reduced motion nothing animates.
4. **Interrupted.** A second change that starts while the first is animating begins from where each frame is drawn at that moment and ends at the engine's rects.
5. **No remounts** across 100 seeded moves through the menu's actions.

**Steps**

- [ ] The menu first (the accessible path), then the drag, then `flip`, each tests first.
- [ ] The controller drags a real header onto each of the five zones, starts a second move during a transition, turns reduced motion on, reloads, and captures.

---

### Task 12: the heads-up line

One sentence across the top of the workspace (under the top bar on a phone): what is running, what is next and in how long, how many things past their date wait for a decision. Built from the day's view and nothing else: `buildHeadline(view, now, timeZone)` in `app/lib/v2/view/desk.ts`, pure and tested. The parts that name a pane are buttons that bring that pane to the front of the current layout, opening it if it is closed. It is not a live region and never moves anything on its own.

---

### Task 13: pane options in the menu

The pane menu gains a "View" group for a pane whose spec declares options: one radio group per option (`setOption`). The day's bodies read theirs (`calendar` `days` picks the layout the pane draws instead of its own width when it is not `auto`). Saved with the layout by the engine.

---

### Task 14: the way in, and the last review

- `/v2` answers with a redirect to `/v2/desk` behind the gate. The old Today and Week pages gain one more destination in their rail, "Desk", last, not displayed under 1024 px; their two nav tests are updated to five destinations.
- The launchers in `docs/rebuild/tools/` open the desk.
- `PROGRESS.md`, the ledger, a whole-branch review on the strongest model over this plan's range, one fix round, one scoped re-review.

## After this plan

- The owner uses it. If it is right, `/v2/today` and `/v2/week` become redirects into the desk and their client files are removed.
- Editing the calendar; a task dragged onto a calendar day; docking against the edge of the whole workspace; keyboard chords; touch dragging.
- After the security release: layouts on the account, live data, Quests and Money that write.
