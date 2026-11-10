# The windowed screen, stage 1: the calendar beside Today (read only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a wide screen the Today page shows what it shows now on the left and a week calendar on the right, read only. A `/v2/week` page shows the same calendar on any screen.

**Architecture:** The one shape the screen is handed gains a calendar. A pure view model turns a week of events into positioned chips, using only the grid half of the calendar engine. One pane component that sizes itself by its own width is mounted in two places. Every v2 page goes through one gate.

**Tech stack:** Next.js 16 App Router, React 19, TypeScript strict, the v2 stylesheet and colour tokens, Vitest. No new dependency.

**Spec:** the owner's direction and the architecture note are kept outside git (`docs/rebuild/06-brain-os-direction.md`, `docs/rebuild/os/12-architecture-plan.md`), because the repository is public and they describe his life. This plan stands alone: everything an implementer needs is in it. Where it and those notes differ, this plan wins.

**Where this sits:** the owner chose tiled panes with tabs as the window model (2026-11-10). This stage is his literal first ask and does not depend on the model: the calendar's data path, its view model, a pane that sizes itself, and a Week page all survive into the tiled shell. The shell itself (stage 2) is not planned here and is not started without his yes.

## Global constraints

Everything under "Global Constraints" in `PLAN.md` still holds. The ones that bite here, verbatim:

- New code in new paths. The existing files this plan changes are listed in each task, and nothing else outside `app/v2` and `app/lib/v2` changes.
- This branch never runs against the production database and never signs in to Google. Data comes from the sample day (`V2_FIXTURES=1`) or a local snapshot folder (`V2_LOCAL_SNAPSHOT`), and from nowhere else.
- A local server that can show the snapshot is always bound to `127.0.0.1`. The page code cannot enforce that; the gate's Host check is a speed bump and says so.
- Nothing personal in a tracked file: invented names, places and titles only.
- No em dash and no en dash in any string a user can read.
- Every colour comes from the scheme tokens or from `identityTokens`. No colour literal in a component or in `calendar.css`.
- Motion is transform and opacity only, the three durations, the two easings, nothing under reduced motion. This stage adds no motion at all.
- Zones in tests: `UTC`, `America/Phoenix`, `Asia/Tokyo`, `America/New_York`. Never assert a specific offset for a recent date in a zone whose rules changed lately.
- No `localeCompare`, no `Intl` used directly in a screen file, no `Date.now()` and no argument-less `new Date()` in pure modules.
- Implementers do not commit, stash, push, start servers, build, read `.env` files or use MCP data tools. The controller commits by explicit path.

Added for this stage:

- **Read only.** No control inside an event, no drag, no editing. `CalEvent.editable` is carried and ignored.
- **The grid half only.** Screen and view code may import from `@/app/lib/v2/calendar/types` and `@/app/lib/v2/calendar/grid`, and from nothing else in that folder: not `ops`, not `edit`, not `port`, not `fake-port`, and not the barrel `index`. The engine's write half has open defects (see `PLAN.md`, Known open edges) and must not be reachable from a screen yet. A test pins this.
- **The calendar never fetches.** Its data arrives as props from the server render.
- **One gate.** Every `app/v2/**/page.tsx` decides what it may show through `app/lib/v2/source.ts` and nothing else. A test pins this.

## Review focus

The five things most likely to bite a person using this, each pinned by a test in the task that owns the code:

1. A day the source has no calendar data for must read "Not in this copy". It must never look like a free day. (Task 1, view model; Task 2, pane.)
2. An event that crosses midnight, one that ends exactly at midnight, and a day the clocks change must each be drawn on the right day at the right height. (Task 1, view model, through the engine's `layoutDay`.)
3. A long unbroken title or location in an event must wrap or clip inside its chip and never widen its column. (Task 2.)
4. The pane must be usable at 320 px wide and at 1400 px wide, by its own width and not the window's. (Task 2.)
5. In local mode a request to `/v2/week` whose Host is not the loopback address gets no data. (Task 1, gate; Task 2, the page.)

---

### Task 1: the gate, the calendar's data, and its view model

**Files:**
- Create: `app/lib/v2/source.ts`, `app/lib/v2/view/calendar.ts`, `app/lib/v2/fixtures/sample-week.ts`, `app/lib/v2/local/calendar.ts`
- Modify: `app/lib/v2/view/screen-data.ts`, `app/lib/v2/view/format.ts`, `app/lib/v2/local/files.ts`, `app/lib/v2/local/snapshot.ts`, `app/lib/v2/fixtures/sample-day.ts`, `app/v2/today/page.tsx`
- Test: create `__tests__/v2-source.test.ts`, `__tests__/v2-view-calendar.test.ts`, `__tests__/v2-fixtures-week.test.ts`, `__tests__/v2-local-calendar.test.ts`; keep green, changing only what this task's interfaces force: `__tests__/v2-local-snapshot.test.ts`, `__tests__/v2-fixtures.test.ts`, `__tests__/v2-view-today.test.ts`
- Do not touch: `app/v2/_components/**`, `app/v2/v2.css`, `app/v2/today/today-client.tsx`, `app/lib/v2/calendar/**`, `app/lib/v2/plan/**`

**Interfaces**

Consumes (exists today): `CalEvent`, `fromEngineEvent` from `app/lib/v2/calendar/types.ts`; `weekOf`, `layoutDay`, `layoutAllDay` from `app/lib/v2/calendar/grid.ts`; `EngineCalendarEvent` from `app/lib/v2/engine/sources.ts`; `dayWindow` from `app/lib/v2/plan/day.ts`; `clockLabel`, `dayLabel` from `app/lib/v2/view/format.ts`; `isLoopbackHost`, `localSnapshotDir`, `loadLocalToday` from `app/lib/v2/local/snapshot.ts`; `fixturesEnabled`, `sampleDay` from `app/lib/v2/fixtures/sample-day.ts`.

Produces:

```ts
// app/lib/v2/source.ts
export type ScreenSource = { kind: "sample" } | { kind: "local"; dir: string };

/** What a v2 page may show, or null for nothing. Pure and synchronous, so a
 *  page can refuse with a real 404 before anything streams. Sample wins over
 *  local, as today. Never anything in production. */
export function screenSource(env: {
  V2_FIXTURES?: string;
  V2_LOCAL_SNAPSHOT?: string;
  VERCEL_ENV?: string;
}): ScreenSource | null;

/** The loopback speed bump, for a local source only (a no-op for the sample,
 *  which is invented data and has to show on a preview). Calls notFound(). */
export async function requireLoopback(source: ScreenSource): Promise<void>;

export { isLoopbackHost }; // moves here; snapshot.ts re-exports it
```

```ts
// app/lib/v2/view/screen-data.ts (added)
export interface ScreenCalendar {
  id: string;
  label: string;
  color: string | null;
  writable: boolean;
}

export interface CalendarScreenData {
  timeZone: string;
  now: Instant;
  /** The seven days shown, Monday first. */
  week: DateKey[];
  /** The days of `week` this source has calendar data for. */
  covered: DateKey[];
  calendars: ScreenCalendar[];
  /** Every event that overlaps the week. Read only in this stage. */
  events: CalEvent[];
  /** The hours a day normally spans: earliest wake to lights out, capped at 1440. */
  dayWindow: { fromMinute: number; toMinute: number };
  /** The Monday of the week before and after, when the source covers any day of it. */
  prevWeek: DateKey | null;
  nextWeek: DateKey | null;
  /** The Monday of the week that holds today, when it is not the week shown and is covered. */
  thisWeek: DateKey | null;
}

// TodayScreenData gains one required field:
//   calendar: CalendarScreenData | null;   // null: this source has no calendar at all
```

```ts
// app/lib/v2/view/format.ts (added)
/** "9 to 15 November", "30 November to 6 December", "28 December 2026 to 3 January 2027". */
export function weekLabel(week: readonly DateKey[]): string;
/** "13:00 to 14:00" in the zone given. */
export function timeRangeLabel(start: Instant, end: Instant, timeZone: string): string;
```

```ts
// app/lib/v2/view/calendar.ts
export interface PlannedBlock { id: string; title: string; start: Instant; end: Instant }

export interface CalendarChip {
  id: string;
  kind: "event" | "planned";
  title: string;
  /** "13:00 to 14:00". */
  time: string;
  calendar: string | null;      // the calendar's label; null for a planned block
  color: string | null;         // the calendar's colour; null takes the accent
  location: string | null;
  /** Fractions of the visible window: 0 is its top, 1 its bottom. */
  top: number;
  height: number;
  column: number;
  columnCount: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  recurring: boolean;
}

export interface CalendarDayView {
  date: DateKey;
  /** "Tuesday 10 November", the label of the day's list. */
  label: string;
  weekday: string;              // "Tue"
  dayNumber: string;            // "10"
  isToday: boolean;
  covered: boolean;
  /** Today and the two days after it (or the first three days when today is not in the week). */
  near: boolean;
  chips: CalendarChip[];        // timed, in start order
  allDay: string[];             // titles of the all day events on this day, for the agenda
}

export interface CalendarAllDaySpan {
  id: string;
  title: string;
  color: string | null;
  firstIndex: number;
  lastIndex: number;
  row: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface CalendarView {
  weekLabel: string;
  days: CalendarDayView[];
  allDay: CalendarAllDaySpan[];
  allDayRows: number;
  /** The visible window, whole hours. */
  fromMinute: number;
  toMinute: number;
  hours: Array<{ label: string; top: number }>;   // one per hour line, "09:00"
  /** Where the now line sits in today's column, or null when it is not on screen. */
  nowTop: number | null;
  nowLabel: string;
  /** Only the calendars with something on this week, in the data's order. */
  legend: Array<{ id: string; label: string; color: string | null }>;
  /** Covered days exist and none of them has anything on it. */
  empty: boolean;
  prevWeek: DateKey | null;
  nextWeek: DateKey | null;
  thisWeek: DateKey | null;
}

export function buildCalendarView(
  data: CalendarScreenData,
  planned: readonly PlannedBlock[],
): CalendarView;

export const CALENDAR_COPY: {
  heading: "Calendar";
  planned: "Planned";
  notCovered: "Not in this copy";
  nothing: "Nothing on the calendar";
  allDay: "All day";
  previous: "Previous week";
  next: "Next week";
  thisWeek: "This week";
  now: "Now";
  readOnly: "Read only for now. Change events in Google Calendar.";
};
```

```ts
// app/lib/v2/fixtures/sample-week.ts
/** The sample's calendar for the week that holds `weekParam`, or the sample day's week. */
export function sampleWeek(weekParam: string | null): CalendarScreenData;
```

```ts
// app/lib/v2/local/calendar.ts
/** The snapshot's calendar for a week, or null when the folder has no events file. */
export async function loadLocalCalendar(
  dir: string,
  now: Instant,
  weekParam: string | null,
): Promise<CalendarScreenData | null>;
```

**The snapshot folder, as this task reads it** (all additions are optional, so an older folder still loads):

| File | Addition |
|---|---|
| `snapshot.json` | `"calendarRange": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`, inclusive: the days the events file can speak for. Absent: every day from the earliest event's day to the latest event's day. |
| `calendars.json` | New, optional. An array of `{ "id", "label", "color": "#RRGGBB" or null, "writable": boolean }`. Absent: one calendar per distinct `calendarId` in the events, labelled "Calendar", except that a calendar whose id equals a group row's `google_calendar_id` (same account) takes that group's name and colour. |
| `calendar-events.json` | Each event may also carry `"recurring": boolean`. Absent means false. |

**Behaviour the tests pin**

1. `screenSource`: the sample when `V2_FIXTURES` is `"1"` and the environment is not production; else local when `V2_LOCAL_SNAPSHOT` is an absolute path and not production; else null. Exactly today's two checks, moved, not rewritten.
2. `app/v2/today/page.tsx` keeps a synchronous default export that calls `screenSource` and `notFound()` before anything is awaited (a real 404 for a route that is off), then renders an async child that awaits `requireLoopback(source)`. The page's own copy of the loopback helper is deleted.
3. A static test reads every `page.tsx` under `app/v2` and fails unless it calls both `screenSource(` and `requireLoopback(` and imports neither `localSnapshotDir` nor `fixturesEnabled` directly.
4. `loadLocalToday` fills `calendar` with `loadLocalCalendar(dir, now, null)` for the week of the planned day, and `sampleDay()` fills it with `sampleWeek(null)`. The day's fixed events shown on Today and that day's events in the calendar are the same events: same ids, same times.
5. The week: `weekOf` of the wanted day, Monday first. `weekParam` is used only when it is a real date key and the source covers at least one day of that week; anything else falls back to the default week. `prevWeek`, `nextWeek` and `thisWeek` are set only when the source covers a day of that week.
6. `covered` is exact: a day outside the source's range is not covered even when the week is shown.
7. `dayWindow`: `fromMinute` is the earliest wake across the week's seven days and `toMinute` the latest lights out, both from the rules through `dayWindow(date, rules)`, capped to 0..1440. `buildCalendarView` then widens that to whole hours and further to include every timed chip of the week, so nothing is ever drawn outside the grid.
8. `buildCalendarView` places chips with `layoutDay` and `layoutAllDay` and nothing of its own: `top` and `height` are the placed minutes mapped onto the visible window, clamped to 0..1, and a chip is never shorter than fifteen minutes' worth. Planned blocks go through the same layout as events of the same day, so a planned block and an event that overlap sit side by side.
9. A day that is not covered has no chips, `covered: false`, and the view never counts it toward `empty`.
10. `nowTop` is set only when today is in the week and now is inside the visible window.
11. `legend` lists only calendars with an event in this week. A calendar the data does not know (an event whose `calendarId` is in no calendar entry) is labelled "Calendar" with no colour, never dropped.
12. `weekLabel`: same month "9 to 15 November"; across months "30 November to 6 December"; across years with both years. No dash.
13. The sample week: every timed fixed event of `sampleDay()` appears with the same id and time; it also has invented events on at least four other days, one read only calendar, one repeating occurrence, one all day event spanning several days, and one pair that overlaps. It covers its own week and the one after, so Next works and Previous does not. Deterministic: two calls are deeply equal.
14. The local loader never writes, never reads outside the folder, never logs a row, and its errors (`LocalSnapshotError`) name the file and the field and never a value. An impossible date in `calendarRange` or a colour that is not `#RRGGBB` makes that file malformed.
15. No string in `CALENDAR_COPY` or produced by the view model contains an em dash or an en dash. Add them to the existing no-dash walk.

**Steps**

- [ ] Write the failing tests for `screenSource`, the static page test, `weekLabel` and `timeRangeLabel`, and `buildCalendarView` (an invented week in `America/Phoenix`: two overlapping events, an event crossing midnight, one ending exactly at midnight, a multi day all day event, a day not covered, a planned block overlapping an event, and a New York week containing a clock change asserting the chip sits at its wall clock time).
- [ ] Run them and see them fail.
- [ ] Implement `source.ts`, the shapes, the formatters and the view model.
- [ ] Write the failing tests for `sampleWeek` and `loadLocalCalendar` (an invented folder in a temporary directory, two accounts' groups, with and without `calendars.json` and `calendarRange`).
- [ ] Implement them, wire `sampleDay()` and `loadLocalToday`, switch `page.tsx` to the gate.
- [ ] Run this task's four test files plus the three kept green, `npx eslint` on every file touched, `npx tsc --noEmit`.

---

### Task 2: the calendar pane, its place beside Today, and the Week page

**Files:**
- Create: `app/v2/_components/calendar/calendar-pane.tsx` and whatever small files beside it the pane needs, `app/v2/calendar.css`, `app/v2/week/page.tsx`, `app/v2/week/week-client.tsx`
- Modify: `app/v2/layout.tsx` (import the stylesheet), `app/v2/today/today-client.tsx` (mount the pane), `app/v2/v2.css` (the wide tier only), `app/v2/_components/nav-bar.tsx` (Today and Week become links), `app/lib/v2/view/today.ts` (only if the nav copy needs a field)
- Test: create `__tests__/v2-calendar-pane.test.ts`, `__tests__/v2-week-page.test.ts`; update the tier tests in `__tests__/v2-fixtures.test.ts`; add `calendar.css` to the stylesheet checks in `__tests__/v2-appearance.test.ts`
- Do not touch: `app/lib/v2/calendar/**`, `app/lib/v2/plan/**`, `app/lib/v2/local/**`

**Interfaces**

Consumes (from Task 1): `CalendarScreenData`, `buildCalendarView`, `CalendarView`, `PlannedBlock`, `CALENDAR_COPY`, `screenSource`, `requireLoopback`, `sampleWeek`, `loadLocalCalendar`. Existing: `identityTokens` and `useAppearance` (how a stop or a list row takes its colour today: read `app/v2/_components/list-row.tsx`).

Produces:

```ts
// app/v2/_components/calendar/calendar-pane.tsx
export function CalendarPane(props: {
  data: CalendarScreenData;
  /** Today's planned blocks, from the plan the screen is showing right now. */
  planned: readonly PlannedBlock[];
  /** The path the week links point at: "/v2/today" or "/v2/week". */
  basePath: string;
}): JSX.Element;
```

**Behaviour the tests pin**

1. **Read only.** No `button`, `input` or link inside a chip. The only controls in the pane are the three week links.
2. **Structure a screen reader can use.** The pane is a `section` labelled by its heading, which reads "Calendar" and the week label. Each day is a list labelled with the day's full label. Today's column carries `aria-current="date"`. A chip's text reads, in order: title, time range, the calendar's label, the location; a planned chip reads "Planned" where the calendar's label would be.
3. **A day that is not covered** shows `CALENDAR_COPY.notCovered` in its column and in the agenda, and nothing else. A covered week with nothing on it shows `CALENDAR_COPY.nothing` once.
4. **Sized by its own width, not the window's.** The pane sets `container-type: inline-size`. Under 480 px it is an agenda: the seven days as lists, in order, today marked. From 480 px it is a grid of the three `near` days. From 760 px it is the seven day grid. The server renders both the agenda and the grid and the stylesheet shows one; the hidden one is `display: none`, so it is out of the tab order and the accessibility tree. No script measures anything.
5. **Height.** The grid fills the height its container gives it. An hour is never drawn shorter than 28 px; when the window does not fit, the grid scrolls inside the pane (its own scroller, focusable so a keyboard can scroll it, like the lists), never the page. The header (week label, links, weekday row, all day row) does not scroll.
6. **Colour.** A chip takes its identity from its calendar's colour through `identityTokens`, exactly as a list row does: the fill is the tinted card, the mark is the lane colour, the title is the ink. A chip with no colour takes the accent. A planned chip has no fill and a dashed outline in the accent, so what the app planned can never be mistaken for what is on the calendar. `calendar.css` holds no colour literal, and the existing stylesheet checks cover it.
7. **Nothing overflows.** A chip clips its text to its own box (`overflow: hidden`, `min-width: 0`, `overflow-wrap: anywhere` on the title), so a long unbroken title or location never widens a column. A chip too short for two lines shows the title only. Side by side chips share the column by `column` and `columnCount`.
8. **The now line** is drawn in today's column at `nowTop` with `CALENDAR_COPY.now` and the time, and not at all when `nowTop` is null.
9. **Week links.** Previous, Next and This week are plain links to `basePath?week=<Monday>`, each present only when the view has that week. No client state, no fetch.
10. **Beside Today, from 1760 px.** The frame's grid becomes rail, day, context, calendar: `grid-template-columns: auto minmax(420px, 560px) minmax(320px, 0.7fr) minmax(680px, 1.6fr)`. The context is one column again at this width (the side is a box, its two halves are nothing, as at 1024 px). The 2400 px tier is removed. Below 1760 px nothing changes, and the calendar is not on the Today page (it has its own page). The pane is the last child of the frame in the document, so the reading order is rail, day, context, calendar. It is sticky and as tall as the window, like the other columns.
11. **Planned blocks follow the screen.** On Today the pane's `planned` is the current plan's blocks that are not done or skipped, with the titles the screen shows, so pressing Not today or changing energy changes the calendar in the same render.
12. **The Week page.** `/v2/week` goes through the gate exactly as Today does (a synchronous `screenSource`, a real 404 when off, `requireLoopback` in the async child), reads `?week=`, and shows the rail (or the phone bar) and the pane filling the rest of the window at every width. `planned` is empty there. With a source that has no calendar it shows one sentence saying so.
13. **Navigation.** Today and Week are links (`/v2/today`, `/v2/week`) and the current one carries `aria-current="page"`. Quests and Money stay disabled.
14. **The phone layout of Today is unchanged**, and the tier tests are updated to say what is now true: at 1760 px the side is a box again, the template has four tracks, the last one is flexible and is the calendar's, and no 2400 px tier exists.
15. **The import boundary.** A test reads every file under `app/v2` and `app/lib/v2/view` and fails if one imports from `@/app/lib/v2/calendar` anything but `/types` or `/grid`.

**Steps**

- [ ] Write the failing tests: the pane rendered with `sampleWeek(null)` and one planned block (structure, labels, read only, not covered, planned chip, week links, now line), the stylesheet checks (container queries at 480 and 760, no colour literal, the 1760 tier, no 2400 tier), the import boundary, the Week page's gate.
- [ ] Run them and see them fail.
- [ ] Build the pane and `calendar.css`. Mount it in `today-client.tsx`. Change the wide tier in `v2.css`. Build the Week page. Turn the two nav items into links.
- [ ] Run this task's test files plus `__tests__/v2-fixtures.test.ts`, `__tests__/v2-appearance.test.ts` and `__tests__/v2-view-today.test.ts`; `npx eslint` on every file touched; `npx tsc --noEmit`.
- [ ] Report what could not be checked without a browser. The controller renders it at 2000 by 985, 1366, 1024 and phone width before this task is called done.

---

## After this stage

- **Stage 2, the tiled shell.** Panes that always fill the screen, dividers that resize, panes that dock against each other or stack as tabs, three saved arrangements, one saved layout per screen size. Its pure engine gets a written spec taken from the prototype the owner chose. Today is not restructured into panes until he has seen stage 1 and said yes.
- **Stage 3, editing the calendar**, against the engine's fake, after the engine's two open defects are fixed.
- **Stage 4, after the security release:** the Google adapter, layouts saved to the account, live data.
