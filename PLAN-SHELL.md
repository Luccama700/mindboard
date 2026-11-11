# The windowed screen, stage 2: the desk (tiled panes with tabs)

> **Status: written for the owner's yes. Nothing in this plan is built, and none of it starts before he says so.**
>
> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

## For the owner, in one screen

**What you get.** A new page, the desk, where the parts of Today and the week's calendar are panes that always fill the window. You drag the gap between two panes to resize them, drag a pane onto another to put it beside, above or below it, or drop it in the middle to make it a tab. Three named arrangements (Today, Plan the week, Clear the backlog), each of which you can change and save over. Your layout comes back exactly as you left it when you reload, separately for a laptop-sized window and a big one. It opens already arranged: on your big screen, Today on the left and the calendar on the right, with about 930 px for the week.

**What does not change.** The Today page and the Week page stay exactly as they are, at their own addresses, as the fallback. The phone has no panes and is untouched. The calendar is still read only. Nothing is pushed, deployed or connected to the live app, and it runs on the same copy of your data.

**What your yes authorizes.** Building the five tasks below on the `rebuild` branch, at the new address `/v2/desk`. It does not authorize replacing Today with the desk: that is a separate, one line decision after you have used it.

**Calls I made, each cheap to change.**

| Call | Why | To change it |
|---|---|---|
| The desk is its own page beside Today, not a replacement. | You can compare the two, and nothing you have now can regress. | One redirect, later. |
| It keeps the rail you already have. No sentence across the top and no bottom bar yet. | "The look" is still one of your open calls. The rail exists and is quiet. | A later stage. |
| The energy buttons move into the Today pane. | It is the one pane that cannot be closed, and energy changes the line right under it. | One line. |
| No keyboard chords in this stage. Everything is reachable with Tab, arrow keys on a divider, and a menu on each pane. | The sketch used Alt with the arrow keys, which is Back and Forward in your browser. Chords need choosing with care. | A later stage. |
| Saved per browser for now, on your account after the security release. | Saving to the account needs a table, and no migration is applied from this branch. | Stage 4. |

**Not in this stage:** the sentence across the top, dragging a task onto a calendar day, editing the calendar, panes for Money or Quests, the desk arranging itself, touch dragging.

---

**Goal:** A desktop page where the Today screen's existing parts and the calendar pane are tiled panes the owner can resize, dock, stack as tabs, close, reopen and maximize, with named arrangements and a saved layout per screen class that is correct on the first paint.

**Architecture:** The committed tile engine (`app/lib/v2/tiles`) is the only owner of the arrangement. Geometry has one source, the engine's own formula, in two forms tied together by a test: `layoutTree` (numbers, for hit testing) and a new pure module that writes the same formula as CSS lengths, so the server can draw a saved layout without knowing the window size and the browser reflows it without script. Today's state is lifted into a provider so the existing leaf components render inside panes unchanged. The page is a new route behind the same gate as Today.

**Tech stack:** Next.js 16 App Router, React 19, TypeScript strict, CSS container queries and `clamp()` / `round()`, Vitest. No new dependency.

**Spec:** `docs/rebuild/06-brain-os-direction.md`, `docs/rebuild/os/12-architecture-plan.md` (written for floating windows: its sections on state, accessibility and motion still apply), `docs/rebuild/os/11-motion-language.md`, and the prototype the owner chose, `docs/rebuild/mockups/os-b-tiled.html` with its notes. All outside git. Where they differ from this plan, this plan wins.

## Global Constraints

Everything in `PLAN.md` "Global Constraints" and `PLAN-OS.md` "Added constraints" binds every task here. In addition:

- **Read only.** No control on the desk changes a calendar event or writes anywhere but the browser's own storage.
- **Never run this app against the production database**, and bind any local server to `127.0.0.1`.
- **One gate.** `app/v2/desk/page.tsx` has exactly the shape of `app/v2/today/page.tsx`. `__tests__/v2-source.test.ts` walks it; change the page to satisfy the test, never the test.
- **The engine owns the arrangement.** No component computes, clamps or stores a ratio, a tab order or a focus of its own. Every change is one engine call on the working arrangement.
- **One source of geometry.** No component measures a pane to decide where another goes. A length on screen comes from `cssLayout`; a number used for hit testing comes from `layoutTree` on the measured workspace.
- **No remounts.** A pane's body is mounted once and stays mounted through every rearrangement, tab change, maximize and close.
- **Existing screens are untouched in behaviour.** Every existing test of Today, Week and the phone layout passes without being edited, except where a task names the test.
- **No route file names** (`page`, `layout`, `route`, `loading`, `error`, `template`, `default`, `not-found`, the metadata names) for any file that is not a route, anywhere under `app/`, private folders included.
- **Motion** uses only `--v2-quick`, `--v2-std`, `--v2-slow`, `--v2-ease` and `--v2-ease-in`, moves only `transform` and `opacity`, and stops entirely under `prefers-reduced-motion`.
- **Every drag has another way.** Anything a pointer drag does can be done from a menu or the keyboard (WCAG 2.5.7).
- **A task is not done until** a production build has run with placeholder settings, the controller has captured the page at 2000 by 985, 1366 by 768 and 1024 by 768, and (tasks 4 and 5) has dragged a real divider and a real pane header with a real pointer in a browser.
- All user facing words live in copy constants that the no-dash walk reads. Fixtures and test names are invented.

## Review Focus

The failure modes the spec implies that markup tests cannot see, most likely first. Each has a test or a gate in the task that owns it.

1. **The first paint with a saved layout is wrong or jumps.** The server HTML for a request carrying a non-default saved layout already holds that layout's lengths, for both screen classes (Task 3), and the controller reloads a rearranged desk and compares captures.
2. **A pane body remounts on a move** and loses its scroll, its focus or a running press. A test moves, tabs, maximizes and closes every pane and asserts each body's mount count stays 1 (Task 3 onward).
3. **A leaf drawn inside a narrow or very wide pane breaks**, because its styles were written for the page's columns. Each body is captured at 230, 464 and 1300 px wide (Task 3).
4. **Focus lands on something hidden**: a background tab, a pane behind a maximized one, a closed pane. Hidden bodies are `inert`; a test tabs through the whole desk in three states (Task 4).
5. **A second move during a transition** leaves a pane in the wrong place or content jumping. A test starts a move, starts another before the first ends, and asserts the final rects equal the engine's (Task 5); the controller does it by hand.

## File Structure

```
app/lib/v2/tiles/css.ts            new   the engine's formula as CSS lengths
app/lib/v2/tiles/cookie.ts         new   the saved form the server reads, compact and tolerant
app/lib/v2/view/desk.ts            new   DESK_COPY: every word the desk says
app/v2/_components/day-provider.tsx new  Today's state, lifted out unchanged
app/v2/today/today-client.tsx      edit  uses the provider; renders what it renders now
app/v2/desk/page.tsx               new   the route, through the gate
app/v2/_desk/desk-client.tsx       new   provider + workspace + rail
app/v2/_desk/use-tiles.ts          new   the one reducer over the engine
app/v2/_desk/workspace.tsx         new   the box, the panes in catalog order, the dividers
app/v2/_desk/pane-frame.tsx        new   header, tab strip, menu button, body slot
app/v2/_desk/pane-bodies.tsx       new   five thin adapters over the existing leaves
app/v2/_desk/divider.tsx           new   task 4: a separator you can drag or arrow
app/v2/_desk/pane-menu.tsx         new   task 5: every move, as a menu
app/v2/_desk/use-dock-drag.ts      new   task 5: drag a header onto a zone
app/v2/_desk/flip.ts               new   task 5: move everything from where it was
app/v2/_desk/desk-rail.tsx         new   the pane list and the arrangements
app/v2/_desk/announcer.tsx         new   the desk's one live region
app/v2/desk.css                    new   everything that draws the desk
app/v2/v2.css                      edit  leaf rules that assumed the page's columns
app/v2/_components/nav-bar.tsx     edit  a Desk link, from 1024 px
```

---

### Task 1: Today's state, lifted into a provider

Nothing on any screen changes. This is the seam the panes need.

**Files:**
- Create: `app/v2/_components/day-provider.tsx`
- Modify: `app/v2/today/today-client.tsx`
- Test: create `__tests__/v2-day-provider.test.ts`. Every existing test file passes unedited.

**Interfaces**

```ts
// app/v2/_components/day-provider.tsx
export interface DayValue {
  view: TodayView;
  clock: string;
  energy: Energy | null;            // what was answered, null when assumed
  said: string | null;              // the sentence for the live region
  revision: number;
  focusToken: number;
  movedIds: ReadonlySet<string>;
  planned: readonly PlannedBlock[]; // for the calendar, as today-client computes it now
  onStart(blockId: string): void;
  onDone(blockId: string): void;
  onSkip(blockId: string): void;
  onEnergy(energy: Energy): void;
}
export function DayProvider(props: { data: TodayScreenData; children: React.ReactNode }): JSX.Element;
export function useDay(): DayValue;   // throws outside a provider, with a sentence that says so
```

**Behaviour the tests pin**

1. `TodayClient` renders the same markup as before for the sample day, before and after a Start, a Done, a Not today and an energy answer (compare against the existing render tests' own assertions: they pass unedited).
2. The provider's state is seeded once. New `data` props re-render without resetting presses (the week link case).
3. `useDay()` outside a provider throws.
4. `planned` equals what `today-client.tsx` computed before the move, for the same sequence of presses.

**Steps**

- [ ] Write `v2-day-provider.test.ts` (the four behaviours). Run, fail.
- [ ] Move the state, `replan`, `viewFor`, `setBlockState`, the four handlers, `movedIds`, `view`, `planned` and `clock` out of `today-client.tsx` into the provider, unchanged. `TodayClient` becomes the provider around the same JSX.
- [ ] Run the new test and every test that imports `today-client`, the fixtures, the pane and the pages. `npx eslint`, `npx tsc --noEmit`.

---

### Task 2: the engine's geometry as CSS, and the saved form the server reads

Pure code, no screen. Wait for the whole-branch review of stage 1 before starting: it was asked what in the engine will hurt a shell, and its answer may change these signatures.

**Files:**
- Create: `app/lib/v2/tiles/css.ts`, `app/lib/v2/tiles/cookie.ts`
- Modify: `app/lib/v2/tiles/index.ts` (exports only)
- Test: create `__tests__/v2-tiles-css.test.ts`, `__tests__/v2-tiles-cookie.test.ts`

**Interfaces**

```ts
// css.ts
export interface CssBox { left: string; top: string; width: string; height: string }
export interface CssLayout {
  /** One per leaf, in the order leavesOf gives. Lengths are relative to the workspace box. */
  leaves: Array<CssBox & { leafId: string }>;
  /** One per split: the divider's box. */
  dividers: Array<CssBox & { splitId: string; dir: SplitDir }>;
  /** Custom properties for the workspace element: one ratio per split, and the shared sub-expressions. */
  vars: Record<string, string>;
  /** The smallest workspace this tree can be drawn in. The workspace takes it as min-width and min-height. */
  min: { w: number; h: number };
}
/** `scope` is the screen class. It is part of every custom property's name, because the
    server writes both classes' layouts into one document and both trees have an `s1`. */
export function ratioVar(scope: ScreenClass, splitId: string): string;   // "--v2-r-wide-s3"
export function cssLayout(arr: Arrangement, specs: readonly PaneSpec[], scope: ScreenClass): CssLayout;
```

```ts
// cookie.ts : what the first paint needs, and nothing else
export const TILE_COOKIE = "mb-v2-tiles";
export const TILE_COOKIE_MAX_BYTES = 3800;
/** `current` and `working` for each class. Saved named trees are not in it. */
export function encodeTileCookie(set: TileSet): string | null;   // null when it would not fit
export function decodeTileCookie(value: string | undefined): TileSet;
```

**Behaviour the tests pin**

1. **The same formula.** For a split given an extent `S`, the first child is `round(nearest, clamp(<min first>px, (S - 6px) * var(<ratio var>), S - 6px - <min second>px), 1px)`, then the 6 px gap, then the rest. That is `layoutTree`'s own arithmetic for every workspace at least as large as `min`.
2. **Proven, not asserted.** The test holds a small evaluator for exactly the CSS it needs (`+`, `-`, `*`, `clamp`, `round(nearest, x, 1px)`, `px`, `%`, `var`) and checks, for all six defaults and for 200 seeded random trees, at 40 workspace sizes from `min` up to 3840 by 2160, that every leaf and divider box equals `layoutTree`'s rect to the pixel.
3. **A maximized pane** gets the whole box (`0`, `0`, `100%`, `100%`); the others keep their own boxes, as `layoutTree` returns them.
4. **Linear, not exponential.** Shared sub-expressions go into `vars`, so the total length of a layout's strings grows linearly with the number of splits. A 12 deep chain stays under 8 KB.
5. **Only what the engine wrote.** Every string is built from numbers the module formatted and ids matching `^[ls][0-9]+$`. A tree carrying any other id throws. Nothing from a title or a pane id reaches a CSS string.
6. **The cookie holds `current` and `working` per class**, in a compact form, and round trips: `decodeTileCookie(encodeTileCookie(set))` equals `set` with every `saved` emptied. The worst arrangement the five panes allow, for both classes, encodes under `TILE_COOKIE_MAX_BYTES`. Measured before this plan was written: the full saved form is 3108 bytes as JSON and 5800 once URI encoded, which is why the named trees stay out of the cookie.
7. **Decoding is the engine's parser.** Anything malformed, oversized, or carrying an unknown pane gives exactly what `parseTileSet` would give for it: `EMPTY_TILE_SET` or a repaired class. The test feeds it CSS and markup injection strings, `__proto__` keys and a value of 100 KB.

**Steps**

- [ ] Write the evaluator and the failing equality test. Run, fail.
- [ ] Implement `css.ts`. Run, pass.
- [ ] Write the failing cookie tests. Implement `cookie.ts`. Run, pass.
- [ ] `npx eslint` on your files, `npx tsc --noEmit`.

---

### Task 3: the desk, standing still

The page exists, opens in the default arrangement for the window's size or in the saved one, and every part of Today and the calendar is readable inside its pane. Nothing can be moved yet.

**Files:**
- Create: `app/v2/desk/page.tsx`, `app/v2/_desk/{desk-client,use-tiles,workspace,pane-frame,pane-bodies,desk-rail,announcer}.tsx` (`use-tiles` is `.ts`), `app/v2/desk.css`, `app/lib/v2/view/desk.ts`
- Modify: `app/v2/layout.tsx` (import the stylesheet), `app/v2/v2.css` (only the leaf rules listed under behaviour 7), `app/v2/_components/nav-bar.tsx` and `app/lib/v2/view/today.ts` (a fifth destination, Desk, LAST in the list so the phone bar's marker positions do not move, and not displayed under 1024 px)
- Test: create `__tests__/v2-desk-page.test.ts`, `__tests__/v2-desk-workspace.test.ts`; extend `__tests__/v2-reserved-filenames.test.ts` to walk `app/v2/_components` and `app/v2/_desk`; add the new files to the locale guard and `desk.css` to the stylesheet checks. The two existing pins of the nav's words (`__tests__/v2-view-today.test.ts` and the nav tests in `__tests__/v2-calendar-pane.test.ts`) are updated to five destinations: these are the only existing tests this task may edit.

**Interfaces**

```ts
// app/lib/v2/view/desk.ts
export const DESK_COPY: {
  heading: "Desk";
  tooNarrow: "The desk needs a wider window. Today and Week work at any size.";
  paneList: "Panes";
  arrangements: "Arrangements";
  // menu, tab, divider and announcement words are added by tasks 4 and 5
};

// app/v2/_desk/use-tiles.ts
export type TilesAction =
  | { type: "class"; cls: ScreenClass }
  | { type: "replace"; set: TileSet };          // tasks 4 and 5 add the rest
export function useTiles(initial: TileSet): {
  set: TileSet; cls: ScreenClass | null; working: Arrangement | null; dispatch(action: TilesAction): void;
};

// app/v2/_desk/pane-bodies.tsx
export const PANE_BODIES: Record<PaneId, () => JSX.Element>;   // keys are exactly the catalog's ids
```

**Behaviour the tests pin**

1. **The gate.** `/v2/desk` is not found with the flags off and in production, awaits the loopback check before any read, and reads the tile cookie inside the guarded child. The gate walk passes with the page in it.
2. **The server draws the saved layout, for both classes at once.** The server cannot know the window's size, so it writes each frame's box twice, as custom properties per class (`--v2-x-regular`, `--v2-x-wide`, and the same for `y`, `w`, `h`), and whether the frame is shown in each class (`data-shown="regular wide"`, one, or neither). `desk.css` uses the regular set from 1024 px and the wide set from `@media (min-width: 1600px)`, and does not display a frame that is not shown in the class that applies. With no cookie the HTML holds the default arrangements. With a cookie holding a rearranged `working` for one class, it holds that arrangement for that class and the default for the other. No script is needed for either. Under 1024 px the workspace is not drawn and `DESK_COPY.tooNarrow` is shown with links to Today and Week.
3. **Flat and stable.** The workspace's children are the five pane frames in catalog order, then the dividers of each class. A frame is a `section` labelled by its title. A leaf holding several panes shows a tab strip (`role="tablist"`); only the active tab's body is shown. A background tab's body, a closed pane's body and every body behind a maximized pane stay in the document and are not displayed, which takes them out of the tab order and the accessibility tree on the server's HTML alone; once the browser knows its class they are also `inert`.
4. **Mount once.** A test replaces the arrangement with each of the six defaults in turn and asserts no body was unmounted (a ref counter in the test's own body stand-ins).
5. **The parts, unchanged.** Today's pane is the day header, the energy row and the line. Status is the said sentence as plain text, the all day row, the feed strip and the lanes. The two lists and the calendar are their own components. Each adapter is a few lines over `useDay()`; no leaf component is edited.
6. **One live region.** The desk's `Announcer` is the only `role="status"` on the page, outside every pane, and speaks `useDay().said`. The Status pane's sentence has no role.
7. **A leaf sizes by its pane.** `.v2-pane` is `container-type: inline-size` named `v2-pane`. The rules in `v2.css` that restyle a leaf because it sits in the page's side column (`.v2-side .v2-feeds`, `.v2-allday-label`, `.v2-energy`, `.v2-said`, `.v2-allday`, `.v2-sub`, `.v2-row`, `.v2-row b`, `.v2-more`) also apply inside a pane, written as `:where(.v2-side, .v2-pane)`, with no change in specificity for the existing page. The two font sizes that use `vw` take `cqw` inside a pane. The lists take two and three columns from the pane's width, as they do from the window's now. Nothing else in `v2.css` changes, and the tier tests pass unedited.
8. **The rail** lists the five panes with an open or closed mark, and the three arrangement names with the current one marked. In this task they are not controls yet.
9. **The window is filled.** The workspace is the height of the window beside the rail, with `min-width` and `min-height` from `cssLayout`. A window too short for the tree scrolls the page; no pane overflows its box.

**Steps**

- [ ] Write the failing tests (gate, server HTML for both cookies, structure, mount once, the live region, the stylesheet checks). Run, fail.
- [ ] Build the page, the client, the reducer, the workspace, the frames, the bodies, the rail, the announcer and `desk.css`. Make the listed leaf rules pane aware.
- [ ] Run this task's tests and every test that reads `app/v2`. `npx eslint`, `npx tsc --noEmit`.
- [ ] Report what cannot be checked without a browser. The controller builds, captures the three sizes with and without a saved cookie, and captures each body at 230, 464 and 1300 px wide.

---

### Task 4: resize, tabs, close and reopen, maximize, arrangements, saving

Everything that changes the layout without dragging a pane.

**Files:**
- Create: `app/v2/_desk/divider.tsx`
- Modify: `app/v2/_desk/{use-tiles.ts,workspace.tsx,pane-frame.tsx,desk-rail.tsx,announcer.tsx}`, `app/v2/desk.css`, `app/lib/v2/view/desk.ts`
- Test: create `__tests__/v2-desk-controls.test.ts`

**Interfaces**

```ts
// use-tiles.ts gains
| { type: "ratio"; splitId: string; ratio: number; size: number }
| { type: "equalize"; splitId: string }
| { type: "tab"; pane: PaneId }
| { type: "close"; pane: PaneId }
| { type: "open"; pane: PaneId; rects: TileRects | null }
| { type: "maximize"; pane: PaneId }
| { type: "arrangement"; name: string }
| { type: "saveOver"; name: string }
| { type: "reset" }
```

**Behaviour the tests pin**

1. **A divider** is a `role="separator"` with `aria-orientation`, `aria-valuenow`, `aria-valuemin` and `aria-valuemax` from `shareLimits`, focusable. Left and right (or up and down) move it by 2 percent of the split, with Shift by 10; Home and End go to the limits; Enter makes both sides equal, as a double click does.
2. **Dragging it** writes the ratio's custom property straight onto the workspace element on each pointer move, clamped to `shareLimits`, with no React render; on release one `ratio` action commits it through `setRatio`. Pointer capture is taken, and Escape during a drag restores the ratio the drag started from.
3. **Tabs.** A click or Enter on a tab is `activateTab`. Arrow keys move along the strip. The close button on a tab is `closePane`, absent on a pane that is not closable.
4. **Close and reopen.** A closed pane's mark in the rail goes hollow; pressing it there is `openPane` with the current rects, and the pane returns where it was. The rail's entry for an open pane focuses it.
5. **Maximize** is a button in the frame's header and a double click on the header. While a pane is maximized every other body is `inert` and one press restores.
6. **Arrangements.** Pressing a name applies it. When the working tree differs from the saved or default one, the name shows a quiet "changed", and "Save this layout over" offers the three names. Reset returns the class to its defaults after one confirmation in the rail, not a browser dialog.
7. **Saving.** After any committed change the cookie is rewritten (debounced, and never with a value over the limit: then the previous cookie is kept and the announcer says the layout could not be saved). Named trees are kept in `localStorage` under `mb-v2-tiles-saved`, parsed through `parseTileSet`. Switching screen class (the window crossing 1600 px) loads that class's own state and never copies one class into the other.
8. **Focus follows.** After a change the element focused is the active tab of the engine's `focus` pane, or the control that was pressed when it still exists. The announcer says what happened in one short sentence from `DESK_COPY`.
9. **Tab order** in three states (default, one pane maximized, one pane closed) never reaches a hidden body.

**Steps**

- [ ] Write the failing tests. Run, fail.
- [ ] Build the divider, the reducer's actions, the tab strip's controls, the rail's controls, saving.
- [ ] Run this task's tests and Task 3's. `npx eslint`, `npx tsc --noEmit`.
- [ ] The controller drags a real divider with a real pointer, reloads, and compares.

---

### Task 5: drag to dock, the pane menu, and motion

**Files:**
- Create: `app/v2/_desk/{pane-menu.tsx,use-dock-drag.ts,flip.ts}`
- Modify: `app/v2/_desk/{use-tiles.ts,workspace.tsx,pane-frame.tsx}`, `app/v2/desk.css`, `app/lib/v2/view/desk.ts`
- Test: create `__tests__/v2-desk-dock.test.ts`

**Interfaces**

```ts
// use-tiles.ts gains
| { type: "move"; pane: PaneId; targetLeafId: string; zone: Zone }

// flip.ts
/** Read every pane's box, run `change`, read them again, and animate each from the old box to the new. */
export function flip(panes: ReadonlyMap<PaneId, HTMLElement>, change: () => void, reduced: boolean): void;
```

**Behaviour the tests pin**

1. **Drag.** A pointer drag that starts on a frame's header or on a tab, after 6 px of travel, picks the pane up. The zone under the pointer comes from `zoneAt` on `layoutTree`'s rects for the measured workspace; a tinted overlay at `zoneRect` and a label from `TILE_COPY.zone` and the target's title say what will happen. Releasing is one `move` action. Escape, or releasing outside every pane, cancels. Nothing drags on a coarse pointer.
2. **The menu.** Each frame has a menu button. Its items are every change a drag can make, built from the engine: move left, right, up and down (`neighbourOf`, then `movePane` on that side of the neighbour), make a tab of each other open pane, split this tab off, maximize or restore, close. An item that would change nothing is not offered. The menu is a `role="menu"` with arrow keys, Home, End, Escape and type ahead on the first letter.
3. **Motion.** Every change of arrangement runs through `flip`: frames move from their old boxes with `transform` over `--v2-std`; an arrangement switch uses `--v2-slow` with a stagger of at most 40 ms a pane and 200 ms in all; the dock overlay fades over `--v2-quick`. Content inside a frame is never scaled. Under reduced motion nothing animates and the final state is immediate.
4. **Interrupted.** A second change that starts while the first is animating begins from where each frame is drawn at that moment, and ends at the engine's rects. The test starts one move, advances fake timers half way, starts another, runs to the end, and compares every frame's final box with `layoutTree`.
5. **No remounts**, again, across 100 seeded moves through the menu actions.

**Steps**

- [ ] Write the failing tests. Run, fail.
- [ ] Build the menu first (it is the accessible path, and it exercises every move), then the drag, then `flip`.
- [ ] Run this task's tests and tasks 3 and 4. `npx eslint`, `npx tsc --noEmit`.
- [ ] The controller drags a real header onto each of the five zones, starts a second move during a transition, turns reduced motion on, reloads, and captures.

---

## After this stage

- **The owner uses it.** If it is right, `/v2/today` on a wide window becomes the desk (one decision, one redirect) and the 1760 px tier of stage 1 is retired.
- **Stage 3, editing the calendar**, against the engine's fake, after the calendar engine's open defects are fixed.
- **Stage 4, after the security release:** layouts saved to the account (a table, written and reviewed, not applied from this branch), the Google adapter, live data.
- **Later, each its own decision:** the sentence across the top, a task dragged onto a calendar day, docking against the edge of the whole workspace, panes for Money and Quests, keyboard chords, touch.
